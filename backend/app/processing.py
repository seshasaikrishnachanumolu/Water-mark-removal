"""Computer-vision core: probing, preview, watermark detection and inpainting.

Everything here is independent of FastAPI so it can be unit-tested or reused
from a CLI. Heavy / optional dependencies (PyTorch, LaMa) are imported lazily.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable, Optional

import cv2
import imageio_ffmpeg
import numpy as np

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()  # bundled static ffmpeg binary

# Called after each frame: (frames_done, frames_total). Return True to cancel.
ProgressCb = Callable[[int, int], bool]


# --------------------------------------------------------------------------
# Probing / preview
# --------------------------------------------------------------------------
def probe(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("Could not open video file")
    info = {
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "fps": float(cap.get(cv2.CAP_PROP_FPS)) or 25.0,
        "frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
    }
    cap.release()
    if info["width"] <= 0 or info["height"] <= 0:
        raise ValueError("Video has no decodable frames")
    info["duration"] = info["frames"] / info["fps"] if info["frames"] > 0 else 0.0
    return info


def _browser_playable(src: Path) -> bool:
    """True if the first video stream is 8-bit 4:2:0 H.264 (plays in every browser)."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(src)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    for line in r.stderr.splitlines():
        if "Stream #" in line and "Video:" in line:
            v = line.split("Video:", 1)[1].strip().lower()
            return v.startswith("h264") and "yuv420p" in v and "10le" not in v
    return False


def make_preview(src: Path, dst: Path, max_width: int = 1280) -> None:
    """Browser-friendly H.264 MP4 preview (MOV/AVI often can't play in <video>).

    Already-playable H.264 is only remuxed (seconds, even for long 1080p videos);
    anything else is transcoded and scaled to max_width.
    """
    if _browser_playable(src):
        remux = [FFMPEG, "-y", "-i", str(src), "-map", "0:v:0", "-c:v", "copy", "-an",
                 "-movflags", "+faststart", str(dst)]
        if subprocess.run(remux, capture_output=True).returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return
    cmd = [
        FFMPEG, "-y", "-i", str(src),
        "-vf", f"scale='min({max_width},iw)':-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(dst),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def extract_frame_jpeg(path: Path, t: float, max_width: int = 1280) -> bytes:
    cap = cv2.VideoCapture(str(path))
    cap.set(cv2.CAP_PROP_POS_MSEC, max(t, 0) * 1000)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise ValueError("Could not read frame")
    h, w = frame.shape[:2]
    if w > max_width:
        frame = cv2.resize(frame, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return buf.tobytes()


# --------------------------------------------------------------------------
# Automatic watermark detection (static overlays in corners)
# --------------------------------------------------------------------------
def detect_watermark(path: Path, samples: int = 24) -> Optional[dict]:
    """Find a static logo near a corner.

    Idea: a watermark stays fixed while the scene changes. Sample frames across
    the video, then keep pixels that (a) have low temporal variance and (b) lie
    on edges of the median frame. The strongest connected blob located in a
    corner region is returned as a normalized box {x, y, w, h} (0..1).
    """
    cap = cv2.VideoCapture(str(path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        cap.release()
        return None
    scale_w = 480  # analyse at low res for speed
    stack = []
    for idx in np.linspace(0, max(total - 2, 0), samples).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, fr = cap.read()
        if not ok:
            continue
        h, w = fr.shape[:2]
        fr = cv2.resize(fr, (scale_w, int(h * scale_w / w)), interpolation=cv2.INTER_AREA)
        stack.append(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY).astype(np.float32))
    cap.release()
    if len(stack) < 4:
        return None

    arr = np.stack(stack)
    std = arr.std(axis=0)
    median = np.median(arr, axis=0).astype(np.uint8)

    edges = cv2.Canny(cv2.GaussianBlur(median, (3, 3), 0), 60, 150)
    static = (std < 6.0).astype(np.uint8) * 255
    cand = cv2.bitwise_and(edges, static)
    # Join letters / logo strokes into one blob.
    cand = cv2.dilate(cand, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 9)), iterations=1)

    H, W = cand.shape
    # Only keep blobs whose center lies in a corner zone (outer 30%).
    zone = np.zeros_like(cand)
    cw, ch = int(W * 0.3), int(H * 0.3)
    for ys, xs in ((slice(0, ch), slice(0, cw)), (slice(0, ch), slice(W - cw, W)),
                   (slice(H - ch, H), slice(0, cw)), (slice(H - ch, H), slice(W - cw, W))):
        zone[ys, xs] = 255

    n, _, stats, cents = cv2.connectedComponentsWithStats(cand)
    best, best_score = None, 0.0
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        cx, cy = cents[i]
        if not zone[int(cy), int(cx)]:
            continue
        if bw > W * 0.4 or bh > H * 0.25 or area < 80:
            continue
        # Reward blobs that are dense in static edges, penalize huge ones.
        score = float(area)
        if score > best_score:
            best, best_score = (x, y, bw, bh), score
    if best is None:
        return None
    x, y, bw, bh = best
    pad = 4
    x0, y0 = max(x - pad, 0), max(y - pad, 0)
    x1, y1 = min(x + bw + pad, W), min(y + bh + pad, H)
    return {"x": x0 / W, "y": y0 / H, "w": (x1 - x0) / W, "h": (y1 - y0) / H}


# --------------------------------------------------------------------------
# Masks
# --------------------------------------------------------------------------
def decode_mask(png_bytes: bytes, width: int, height: int, dilate: int = 3) -> np.ndarray:
    """PNG (any size; non-zero alpha or non-black = masked) -> uint8 mask at video size."""
    arr = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if arr is None:
        raise ValueError("Invalid mask image")
    if arr.ndim == 3 and arr.shape[2] == 4:
        m = arr[:, :, 3]  # canvas exports paint in the alpha channel
    elif arr.ndim == 3:
        m = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)
    else:
        m = arr
    m = cv2.resize(m, (width, height), interpolation=cv2.INTER_NEAREST)
    m = (m > 127).astype(np.uint8) * 255
    if dilate > 0:  # cover anti-aliased logo edges
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate + 1, 2 * dilate + 1))
        m = cv2.dilate(m, k)
    if not m.any():
        raise ValueError("Mask is empty - select the watermark area first")
    return m


# --------------------------------------------------------------------------
# Inpainting engines
# --------------------------------------------------------------------------
# LaMa runs through onnxruntime (no PyTorch needed). The ~200MB model is downloaded once
# on first use into backend/models/ (override with LAMA_MODEL=/path/to/lama_fp32.onnx).
LAMA_URL = "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx"
LAMA_SIZE = 512  # the exported model has a fixed 512x512 input
_lama_session = None
_lama_lock = threading.Lock()


def lama_available() -> bool:
    try:
        import onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


def _lama_model_path() -> Path:
    env = os.environ.get("LAMA_MODEL")
    return Path(env) if env else Path(__file__).resolve().parent.parent / "models" / "lama_fp32.onnx"


def _get_lama():
    global _lama_session
    with _lama_lock:
        if _lama_session is None:
            import urllib.request
            import onnxruntime as ort

            path = _lama_model_path()
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".part")
                urllib.request.urlretrieve(LAMA_URL, tmp)  # download to a temp name, then rename
                tmp.replace(path)
            _lama_session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        return _lama_session

def propainter_dir() -> Optional[Path]:
    d = os.environ.get("PROPAINTER_DIR")
    if d and (Path(d) / "inference_propainter.py").exists():
        return Path(d)
    return None


def available_algorithms() -> list[dict]:
    return [
        {"id": "telea", "label": "Fast Inpainting (OpenCV Telea)", "available": True},
        {"id": "ns", "label": "Fast Inpainting (OpenCV Navier-Stokes)", "available": True},
        {"id": "lama", "label": "AI Temporal Inpainting (LaMa + temporal smoothing)",
         "available": lama_available(),
         "hint": "pip install onnxruntime (see requirements-ai.txt). The model downloads on first use.",
         "note": "Best quality, but slow on CPU (about 4 seconds per frame). Fine for images and short clips; use Fast for long videos."},
        {"id": "propainter", "label": "AI Temporal Inpainting (ProPainter)",
         "available": propainter_dir() is not None,
         "hint": "Clone ProPainter and set the PROPAINTER_DIR env var"},
    ]


def _roi_from_mask(mask: np.ndarray, pad: int, W: int, H: int) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask > 0)
    return (max(xs.min() - pad, 0), max(ys.min() - pad, 0),
            min(xs.max() + 1 + pad, W), min(ys.max() + 1 + pad, H))


def _inpaint_roi_cv(roi: np.ndarray, roi_mask: np.ndarray, method: str) -> np.ndarray:
    flag = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS
    return cv2.inpaint(roi, roi_mask, 3, flag)


def _inpaint_roi_lama(roi: np.ndarray, roi_mask: np.ndarray) -> np.ndarray:
    """LaMa on a crop: pad to a square (reflect), run at 512x512, scale back, un-pad."""
    sess = _get_lama()
    h, w = roi.shape[:2]
    side = max(h, w)
    ph, pw = side - h, side - w
    pad = (0, ph, 0, pw)  # bottom / right only
    img = cv2.copyMakeBorder(roi, *pad, cv2.BORDER_REFLECT_101)
    msk = cv2.copyMakeBorder(roi_mask, *pad, cv2.BORDER_CONSTANT, value=0)
    interp = cv2.INTER_AREA if side > LAMA_SIZE else cv2.INTER_CUBIC
    img = cv2.resize(img, (LAMA_SIZE, LAMA_SIZE), interpolation=interp)
    msk = cv2.resize(msk, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_NEAREST)

    x = img[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255.0  # BGR -> RGB, NCHW
    m = (msk > 127).astype(np.float32)[None, None]
    out = sess.run(None, {"image": x, "mask": m})[0][0].transpose(1, 2, 0)
    if out.max() <= 1.5:  # some exports return 0..1, others 0..255
        out = out * 255.0
    out = np.clip(out, 0, 255).astype(np.uint8)[:, :, ::-1]
    out = cv2.resize(out, (side, side), interpolation=cv2.INTER_CUBIC)[:h, :w]
    # Keep original pixels outside the hole so LaMa's resampling can't soften the rest.
    keep = (roi_mask == 0)[..., None]
    return np.where(keep, roi, out)

def process_video(src: Path, dst: Path, mask: np.ndarray, algorithm: str,
                  progress: ProgressCb) -> None:
    """Remove the masked region from every frame and write an H.264 MP4 to dst."""
    if algorithm == "propainter":
        return _process_propainter(src, dst, mask, progress)

    cap = cv2.VideoCapture(str(src))
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1

    # Work on a cropped region of interest (much faster than full frames).
    # AI models get extra context around the hole.
    pad = 48 if algorithm == "lama" else 12
    x0, y0, x1, y1 = _roi_from_mask(mask, pad, W, H)
    roi_mask = np.ascontiguousarray(mask[y0:y1, x0:x1])
    hole = roi_mask > 0
    ring = ~cv2.dilate(roi_mask, np.ones((3, 3), np.uint8)).astype(bool)  # known pixels

    tmp = dst.with_suffix(".raw.mp4")
    writer = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    if not writer.isOpened():
        raise RuntimeError("Could not open video writer")

    prev_in: Optional[np.ndarray] = None
    prev_fill: Optional[np.ndarray] = None
    done = 0
    cancelled = False
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            roi = frame[y0:y1, x0:x1]

            if algorithm == "lama":
                filled = _inpaint_roi_lama(roi, roi_mask)
            else:
                filled = _inpaint_roi_cv(roi, roi_mask, algorithm)

            # Temporal smoothing against flicker: when the surrounding (known)
            # pixels barely changed since the previous frame, blend the new fill
            # with the previous one. On cuts / fast motion, reset.
            if algorithm == "lama" and prev_in is not None and prev_fill is not None:
                diff = float(np.abs(roi.astype(np.int16) - prev_in.astype(np.int16))[ring].mean()) \
                    if ring.any() else 255.0
                if diff < 8.0:
                    blended = cv2.addWeighted(filled, 0.5, prev_fill, 0.5, 0)
                    filled = np.where(hole[..., None], blended, filled)
            prev_in, prev_fill = roi.copy(), filled.copy()

            out = frame.copy()
            # Feather the seam so the patch doesn't show a hard edge.
            soft = cv2.GaussianBlur(roi_mask, (0, 0), 1.5).astype(np.float32)[..., None] / 255.0
            soft = np.maximum(soft, hole[..., None].astype(np.float32))
            out[y0:y1, x0:x1] = (filled * soft + roi * (1 - soft)).astype(np.uint8)
            writer.write(out)

            done += 1
            if progress(done, total):
                cancelled = True
                break
    finally:
        cap.release()
        writer.release()

    if cancelled:
        tmp.unlink(missing_ok=True)
        return
    _finalize(tmp, src, dst)


def _finalize(raw: Path, original: Path, dst: Path) -> None:
    """Re-encode to H.264 (browser-playable) and copy the original audio track."""
    cmd = [
        FFMPEG, "-y", "-i", str(raw), "-i", str(original),
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    finally:
        raw.unlink(missing_ok=True)


SHORT_W, SHORT_H, SHORT_MAX_SECONDS = 1080, 1920, 180


def short_filter(layout: str, fps: int) -> str:
    """ffmpeg filter graph that outputs 1080x1920 at the requested fps."""
    fill = f"scale={SHORT_W}:{SHORT_H}:force_original_aspect_ratio=increase,crop={SHORT_W}:{SHORT_H}"
    if layout == "crop":
        # Scale to cover the frame, then trim the overflow evenly left/right.
        return f"{fill},setsar=1,fps={fps},format=yuv420p"
    # "blur": the sharp video sits centered at full width over a blurred copy.
    # The background is blurred at 1/4 size (cheap) and scaled back up.
    return (
        f"split[a][b];"
        f"[a]scale={SHORT_W // 4}:{SHORT_H // 4}:force_original_aspect_ratio=increase,"
        f"crop={SHORT_W // 4}:{SHORT_H // 4},gblur=sigma=10,scale={SHORT_W}:{SHORT_H}[bg];"
        f"[b]scale={SHORT_W}:{SHORT_H}:force_original_aspect_ratio=decrease,"
        f"scale=trunc(iw/2)*2:trunc(ih/2)*2[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps},format=yuv420p"
    )


def make_short(src: Path, dst: Path, layout: str, fps: int, progress: ProgressCb) -> None:
    """Export a 1080x1920 H.264/AAC MP4 capped at 180s. Progress is in 0..1000 units."""
    import threading

    info = probe(src)
    length = min(info["duration"] or SHORT_MAX_SECONDS, SHORT_MAX_SECONDS)
    cmd = [
        FFMPEG, "-y", "-i", str(src), "-t", str(SHORT_MAX_SECONDS),
        "-vf", short_filter(layout, fps),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(fps),
        "-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(dst),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stderr_tail: list[str] = []

    def drain():  # keep stderr from filling the pipe; keep the tail for errors
        for line in proc.stderr:
            stderr_tail.append(line)
            del stderr_tail[:-15]

    threading.Thread(target=drain, daemon=True).start()
    cancelled = False
    for line in proc.stdout:
        if line.startswith("out_time_us="):
            try:
                secs = int(line.split("=")[1]) / 1_000_000
            except ValueError:
                continue
            if progress(int(min(secs / length, 1.0) * 1000), 1000):
                cancelled = True
                proc.terminate()
                break
    proc.wait()
    if cancelled:
        dst.unlink(missing_ok=True)
        return
    if proc.returncode != 0:
        dst.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg failed: " + "".join(stderr_tail)[-200:])
    progress(1000, 1000)


def _process_propainter(src: Path, dst: Path, mask: np.ndarray, progress: ProgressCb) -> None:
    """Run the official ProPainter repo as a subprocess (no per-frame progress)."""
    pdir = propainter_dir()
    if pdir is None:
        raise RuntimeError("ProPainter not configured (set PROPAINTER_DIR)")
    work = dst.parent / (dst.stem + "_pp")
    work.mkdir(exist_ok=True)
    mask_path = work / "mask.png"
    cv2.imwrite(str(mask_path), mask)
    out_dir = work / "out"
    cmd = [sys.executable, "inference_propainter.py", "--video", str(src),
           "--mask", str(mask_path), "--output", str(out_dir), "--fp16"]
    progress(0, 1)
    subprocess.run(cmd, cwd=str(pdir), check=True, capture_output=True)
    result = out_dir / src.stem / "inpaint_out.mp4"
    if not result.exists():
        raise RuntimeError("ProPainter produced no output")
    _finalize(result, src, dst)
    progress(1, 1)
