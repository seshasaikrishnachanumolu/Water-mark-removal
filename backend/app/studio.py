"""Studio Editor + AI suite API.

Isolated on purpose: this module only *adds* routes (mounted from main.py with
one include_router call) and keeps its own storage folder, job table and worker
pool, so nothing here can interfere with the watermark-removal pipeline.

  GET  /api/ai/capabilities         what is installed / usable right now
  POST /api/ai/captions             speech -> timed text segments   (faster-whisper)
  POST /api/ai/remove-background    image -> transparent PNG        (rembg, else GrabCut)
  POST /api/ai/enhance              video upscale + sharpen job     (ffmpeg)
  GET  /api/ai/jobs/{id}            job progress
  GET  /api/ai/jobs/{id}/result     enhanced video
  POST /api/ai/generate             501 until a generative provider is configured
  POST /api/export/transcode        browser-recorded WebM -> H.264 MP4/MOV
"""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from . import processing  # read-only reuse: ffmpeg path + probe()

router = APIRouter(prefix="/api")

WORK = Path(__file__).resolve().parent.parent / "storage" / "studio"
WORK.mkdir(parents=True, exist_ok=True)

MAX_VIDEO = 1024 * 1024 * 1024  # 1GB (editor exports can be large)
MAX_IMAGE = 25 * 1024 * 1024
ID_RE = re.compile(r"^[0-9a-f]{32}$")

ai_jobs: dict[str, dict] = {}
ai_executor = ThreadPoolExecutor(max_workers=1)  # separate from the remover's worker


# ----------------------------------------------------------------- helpers
def _has(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def save_upload(file: UploadFile, dest: Path, limit: int) -> int:
    """Stream an upload to disk in 1MB chunks, enforcing a size limit."""
    size = 0
    too_big = False
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                too_big = True
                break
            out.write(chunk)
    if too_big:
        dest.unlink(missing_ok=True)
        raise HTTPException(413, f"File exceeds the {limit // (1024 * 1024)}MB limit")
    return size


def _ext(file: UploadFile, allowed: set[str]) -> str:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"Unsupported file type. Allowed: {', '.join(sorted(allowed))}")
    return ext


def _ffmpeg_progress(cmd: list[str], length: float, on_progress) -> tuple[int, str]:
    """Run ffmpeg, reporting progress (0..1). Returns (returncode, stderr tail)."""
    proc = subprocess.Popen(cmd + ["-progress", "pipe:1", "-nostats"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    tail: list[str] = []

    def drain():
        for line in proc.stderr:
            tail.append(line)
            del tail[:-15]

    threading.Thread(target=drain, daemon=True).start()
    for line in proc.stdout:
        if line.startswith("out_time_us="):
            try:
                on_progress(min(int(line.split("=")[1]) / 1_000_000 / max(length, 0.1), 1.0))
            except ValueError:
                pass
    proc.wait()
    return proc.returncode, "".join(tail)[-300:]


# ------------------------------------------------------------ capabilities
@router.get("/ai/capabilities")
def capabilities():
    return {
        "captions": {"available": _has("faster_whisper"),
                     "hint": "pip install faster-whisper (see requirements-ai.txt)"},
        "background_removal": {"available": True,
                               "mode": "rembg" if _has("rembg") else "grabcut",
                               "hint": "Install rembg for much better cut-outs"},
        "video_background_removal": {"available": _has("rembg"),
                                    "hint": "pip install rembg onnxruntime (see requirements-ai.txt)",
                                    "max_seconds": BG_VIDEO_MAX_SECONDS},
        "enhance": {"available": True, "mode": "lanczos + unsharp",
                    "hint": "Classical upscale. A neural upscaler can be plugged in here."},
        "generate": {"available": False,
                     "hint": "Needs a generative video/image provider (not configured)."},
        "transcode": {"available": True},
    }


# ---------------------------------------------------------------- captions
_whisper = None
_whisper_lock = threading.Lock()


@router.post("/ai/captions")
def captions(file: UploadFile = File(...), language: Optional[str] = Form(None)):
    if not _has("faster_whisper"):
        raise HTTPException(501, "Captions need faster-whisper: pip install faster-whisper")
    ext = _ext(file, {".mp4", ".mov", ".avi", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".ogg"})
    work = WORK / uuid.uuid4().hex
    work.mkdir(parents=True)
    try:
        src = work / f"in{ext}"
        save_upload(file, src, MAX_VIDEO)
        wav = work / "audio.wav"  # 16kHz mono is what Whisper expects
        r = subprocess.run([processing.FFMPEG, "-y", "-i", str(src), "-vn", "-ac", "1",
                            "-ar", "16000", str(wav)], capture_output=True)
        if r.returncode != 0 or not wav.exists():
            raise HTTPException(400, "No decodable audio track found")

        global _whisper
        with _whisper_lock:  # load once, share across requests
            if _whisper is None:
                from faster_whisper import WhisperModel
                _whisper = WhisperModel(os.environ.get("WHISPER_MODEL", "base"),
                                        device="cpu", compute_type="int8")
        # Hand Whisper raw samples so it never needs its own (version-sensitive) audio decoder.
        import wave

        with wave.open(str(wav), "rb") as wf:
            samples = np.frombuffer(wf.readframes(wf.getnframes()), np.int16).astype(np.float32) / 32768.0
        segments, info = _whisper.transcribe(samples, language=language or None, vad_filter=True)
        out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
               for s in segments if s.text.strip()]
        return {"language": info.language, "segments": out}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# -------------------------------------------------------- background removal
def _grabcut_cutout(data: bytes) -> bytes:
    """Model-free fallback: GrabCut seeded with an inset rectangle (subject near center)."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image")
    H, W = img.shape[:2]
    scale = min(1.0, 1000 / max(H, W))  # run GrabCut on a smaller copy for speed
    small = cv2.resize(img, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA)
    h, w = small.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    rect = (int(w * 0.05), int(h * 0.05), int(w * 0.9), int(h * 0.9))
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(small, mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    fg = cv2.GaussianBlur(fg, (0, 0), 2)  # soften edges
    alpha = cv2.resize(fg, (W, H), interpolation=cv2.INTER_LINEAR)
    rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha
    ok, buf = cv2.imencode(".png", rgba)
    return buf.tobytes()


@router.post("/ai/remove-background")
def remove_background(file: UploadFile = File(...)):
    _ext(file, {".png", ".jpg", ".jpeg", ".webp"})
    data = file.file.read(MAX_IMAGE + 1)
    if len(data) > MAX_IMAGE:
        raise HTTPException(413, "Image exceeds 25MB")
    if _has("rembg"):
        from rembg import remove
        png = remove(data)
    else:
        png = _grabcut_cutout(data)
    return Response(png, media_type="image/png")


# ----------------------------------------------------------------- enhance
def _run_enhance(job_id: str, src: Path, dst: Path, scale: float, sharpen: float, denoise: bool):
    job = ai_jobs[job_id]
    job["status"] = "processing"
    try:
        length = processing.probe(src)["duration"] or 1.0
        filters = []
        if denoise:
            filters.append("hqdn3d=2:1.5:3:2.5")
        # Cap the output width at 4K; keep dimensions even for H.264.
        filters.append(f"scale='min(3840,trunc(iw*{scale}/2)*2)':-2:flags=lanczos")
        if sharpen > 0:
            filters.append(f"unsharp=5:5:{sharpen}:5:5:0.0")
        cmd = [processing.FFMPEG, "-y", "-i", str(src), "-vf", ",".join(filters),
               "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
               "-map", "0:v:0", "-map", "0:a:0?", "-c:a", "copy", "-movflags", "+faststart", str(dst)]

        def on_progress(p: float):
            job["progress"] = p

        code, err = _ffmpeg_progress(cmd, length, on_progress)
        if code != 0:
            raise RuntimeError("ffmpeg failed: " + err)
        job["progress"], job["status"] = 1.0, "done"
    except Exception as e:
        traceback.print_exc()
        job["status"], job["error"] = "error", str(e)[:300]
    finally:
        src.unlink(missing_ok=True)


@router.post("/ai/enhance")
def enhance(file: UploadFile = File(...), scale: float = Form(2.0),
            sharpen: float = Form(0.8), denoise: bool = Form(False)):
    ext = _ext(file, {".mp4", ".mov", ".avi", ".webm", ".mkv"})
    scale = max(1.0, min(scale, 4.0))
    sharpen = max(0.0, min(sharpen, 2.0))
    job_id = uuid.uuid4().hex
    src, dst = WORK / f"{job_id}_in{ext}", WORK / f"{job_id}_out.mp4"
    save_upload(file, src, MAX_VIDEO)
    ai_jobs[job_id] = {"id": job_id, "status": "queued", "progress": 0.0, "error": None, "path": dst}
    ai_executor.submit(_run_enhance, job_id, src, dst, scale, sharpen, denoise)
    return {"job_id": job_id}


def _job(job_id: str) -> dict:
    if not ID_RE.match(job_id) or job_id not in ai_jobs:
        raise HTTPException(404, "Job not found")
    return ai_jobs[job_id]


@router.get("/ai/jobs/{job_id}")
def ai_job_status(job_id: str):
    j = _job(job_id)
    return {k: j[k] for k in ("id", "status", "progress", "error")}


@router.get("/ai/jobs/{job_id}/result")
def ai_job_result(job_id: str):
    j = _job(job_id)
    if j["status"] != "done" or not j["path"].exists():
        raise HTTPException(409, "Result not ready")
    return FileResponse(j["path"], media_type=j.get("media_type", "video/mp4"))


# ------------------------------------------------ video background removal
BG_VIDEO_MAX_SECONDS = 30
BG_VIDEO_MAX_SIDE = 720


def _run_bg_video(job_id: str, src: Path, dst: Path):
    """Per-frame matting with rembg -> VP9 WebM with an alpha channel."""
    job = ai_jobs[job_id]
    job["status"] = "processing"
    cap = None
    proc = None
    try:
        from rembg import new_session, remove

        info = processing.probe(src)
        fps = min(info["fps"], 30.0)
        k = min(1.0, BG_VIDEO_MAX_SIDE / max(info["width"], info["height"]))
        w, h = max(2, int(info["width"] * k) // 2 * 2), max(2, int(info["height"] * k) // 2 * 2)
        total = max(1, min(info["frames"] or 1, int(info["fps"] * BG_VIDEO_MAX_SECONDS)))
        session = new_session(os.environ.get("REMBG_MODEL", "u2netp"))  # small, CPU-friendly

        # ffmpeg reads raw RGBA frames from stdin and muxes the source audio.
        cmd = [processing.FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}",
               "-r", f"{fps}", "-i", "-", "-i", str(src), "-map", "0:v:0", "-map", "1:a:0?",
               "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
               "-deadline", "realtime", "-cpu-used", "5", "-auto-alt-ref", "0",
               "-c:a", "libopus", "-t", f"{total / info['fps']:.3f}", str(dst)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        cap = cv2.VideoCapture(str(src))
        stride = max(1.0, info["fps"] / fps)  # drop frames when the source is above 30 fps
        read, sent, acc = 0, 0, 0.0
        while read < total:
            ok, frame = cap.read()
            if not ok:
                break
            read += 1
            acc += 1.0
            if acc < stride - 1e-6:
                continue
            acc -= stride
            frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
            rgba = remove(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), session=session)
            proc.stdin.write(np.ascontiguousarray(np.asarray(rgba), dtype=np.uint8).tobytes())
            sent += 1
            job["progress"] = min(read / total, 0.99)
        proc.stdin.close()
        if proc.wait() != 0 or not dst.exists():
            raise RuntimeError("ffmpeg could not encode the result")
        job["progress"], job["status"] = 1.0, "done"
    except Exception as e:
        traceback.print_exc()
        job["status"], job["error"] = "error", str(e)[:300]
        if proc and proc.poll() is None:
            proc.kill()
    finally:
        if cap:
            cap.release()
        src.unlink(missing_ok=True)


@router.post("/ai/remove-background-video")
def remove_background_video(file: UploadFile = File(...)):
    if not _has("rembg"):
        raise HTTPException(501, "Video background removal needs rembg: pip install rembg onnxruntime")
    ext = _ext(file, {".mp4", ".mov", ".avi", ".webm", ".mkv"})
    job_id = uuid.uuid4().hex
    src, dst = WORK / f"{job_id}_in{ext}", WORK / f"{job_id}_out.webm"
    save_upload(file, src, MAX_VIDEO)
    ai_jobs[job_id] = {"id": job_id, "status": "queued", "progress": 0.0, "error": None,
                       "path": dst, "media_type": "video/webm"}
    ai_executor.submit(_run_bg_video, job_id, src, dst)
    return {"job_id": job_id, "max_seconds": BG_VIDEO_MAX_SECONDS}

# ------------------------------------------------- image watermark removal
@router.post("/images/remove-watermark")
def image_remove_watermark(file: UploadFile = File(...), mask: str = Form(...),
                           algorithm: str = Form("telea"), dilate: int = Form(3)):
    """Inpaint a masked region of a still image (same engines as the video remover)."""
    import base64

    ext = _ext(file, {".png", ".jpg", ".jpeg", ".webp"})
    if algorithm not in ("telea", "ns", "lama"):
        raise HTTPException(400, "algorithm must be telea, ns or lama")
    if algorithm == "lama" and not processing.lama_available():
        raise HTTPException(400, "LaMa is not installed (pip install -r requirements-ai.txt)")
    data = file.file.read(MAX_IMAGE + 1)
    if len(data) > MAX_IMAGE:
        raise HTTPException(413, "Image exceeds 25MB")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(400, "Could not decode image")
    alpha = None
    if img.ndim == 3 and img.shape[2] == 4:  # keep transparency of PNG/WebP
        alpha, img = img[:, :, 3], img[:, :, :3]
    elif img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    H, W = img.shape[:2]
    try:
        m = processing.decode_mask(base64.b64decode(mask.split(",", 1)[-1]), W, H, max(0, min(dilate, 25)))
    except Exception as e:
        raise HTTPException(400, f"Invalid mask: {e}")

    pad = 48 if algorithm == "lama" else 12
    x0, y0, x1, y1 = processing._roi_from_mask(m, pad, W, H)
    roi, roi_mask = img[y0:y1, x0:x1], np.ascontiguousarray(m[y0:y1, x0:x1])
    filled = (processing._inpaint_roi_lama(roi, roi_mask) if algorithm == "lama"
              else processing._inpaint_roi_cv(roi, roi_mask, algorithm))
    soft = cv2.GaussianBlur(roi_mask, (0, 0), 1.5).astype(np.float32)[..., None] / 255.0
    soft = np.maximum(soft, (roi_mask > 0)[..., None].astype(np.float32))
    out = img.copy()
    out[y0:y1, x0:x1] = (filled * soft + roi * (1 - soft)).astype(np.uint8)

    if alpha is not None:
        out = np.dstack([out, alpha])
    if ext in (".jpg", ".jpeg"):
        ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 95])
        return Response(buf.tobytes(), media_type="image/jpeg")
    ok, buf = cv2.imencode(".png", out)
    return Response(buf.tobytes(), media_type="image/png")


# ---------------------------------------------------------------- generate
@router.post("/ai/generate")
def generate():
    # Provider adapter goes here (e.g. a hosted text-to-video / inpainting API).
    raise HTTPException(501, "No generative provider is configured on this server")


# --------------------------------------------------------------- transcode
@router.post("/export/transcode")
def transcode(background: BackgroundTasks, file: UploadFile = File(...),
              fmt: str = Form("mp4"), fps: int = Form(30)):
    """Hybrid export: the browser renders + records (WebM), the server makes a clean H.264 file."""
    if fmt not in ("mp4", "mov"):
        raise HTTPException(400, "fmt must be mp4 or mov")
    fps = max(0, min(fps, 120))  # 0 = keep the source frame rate (used for format conversion)
    work = WORK / uuid.uuid4().hex
    work.mkdir(parents=True)
    background.add_task(shutil.rmtree, work, True)  # delete after the response is sent
    src = work / "in.bin"
    save_upload(file, src, MAX_VIDEO)
    dst = work / f"export.{fmt}"
    cmd = [processing.FFMPEG, "-y", "-i", str(src), *(["-r", str(fps)] if fps else []),
           "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",  # H.264 needs even dimensions
           "-map", "0:v:0", "-map", "0:a:0?",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        raise HTTPException(500, "Transcode failed: " + r.stderr[-200:])
    return FileResponse(dst, media_type="video/mp4" if fmt == "mp4" else "video/quicktime",
                        filename=f"export.{fmt}")
