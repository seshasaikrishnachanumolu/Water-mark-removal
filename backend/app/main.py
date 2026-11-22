"""FastAPI backend for the watermark remover.

Endpoints
  POST /api/videos                 upload a video (<=500MB) -> metadata
  GET  /api/videos/{id}/preview    browser-playable H.264 preview (range requests)
  GET  /api/videos/{id}/frame?t=   JPEG still used by the mask editor
  POST /api/videos/{id}/detect     auto-detect a corner logo -> normalized box
  GET  /api/algorithms             available inpainting engines
  POST /api/jobs                   start processing (video_id + mask + algorithm)
  GET  /api/jobs/{job_id}          progress (frames done / total)
  DELETE /api/jobs/{job_id}        cancel
  GET  /api/jobs/{job_id}/result   stream the cleaned MP4 (add ?download=1 to download)
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import threading
import traceback
import uuid
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import processing
from .maintenance import RateLimitMiddleware, start_cleanup

STORAGE = Path(__file__).resolve().parent.parent / "storage"
STORAGE.mkdir(exist_ok=True)
MAX_BYTES = 500 * 1024 * 1024
ALLOWED_EXT = {".mp4", ".mov", ".avi"}
ID_RE = re.compile(r"^[0-9a-f]{32}$")

@asynccontextmanager
async def lifespan(_app):
    STORAGE.mkdir(parents=True, exist_ok=True)
    # Delete uploads/results older than FILE_TTL_HOURS (default 6).
    start_cleanup(STORAGE, int(float(os.environ.get("FILE_TTL_HOURS", "6")) * 3600))
    yield


app = FastAPI(title="Watermark Remover API", lifespan=lifespan)
# CORS_ORIGINS="https://a.com,https://b.com" for a separate-origin deployment.
_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(RateLimitMiddleware, per_minute=int(os.environ.get("RATE_LIMIT_PER_MIN", "120")))




# Studio Editor + AI suite: separate module, adds routes only.
from .studio import router as studio_router  # noqa: E402

from .downloader import router as download_router  # noqa: E402

app.include_router(studio_router)
app.include_router(download_router)

# One worker: inpainting is CPU/GPU heavy, so jobs run one at a time (queued).
executor = ThreadPoolExecutor(max_workers=1)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


# ----------------------------------------------------------------- helpers
def video_dir(video_id: str) -> Path:
    if not ID_RE.match(video_id):  # blocks path traversal
        raise HTTPException(400, "Invalid id")
    d = STORAGE / video_id
    if not d.is_dir():
        raise HTTPException(404, "Video not found")
    return d


def original_path(d: Path) -> Path:
    for p in d.glob("original.*"):
        return p
    raise HTTPException(404, "Original missing")


def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


# ------------------------------------------------------------------ videos
@app.post("/api/videos")
def upload_video(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, "Only MP4, MOV and AVI files are supported")

    vid = uuid.uuid4().hex
    d = STORAGE / vid
    d.mkdir(parents=True, exist_ok=True)  # storage/ may have been cleaned away while running
    dest = d / f"original{ext}"
    size = 0
    try:
        with dest.open("wb") as out:  # stream to disk, never hold 500MB in RAM
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, "File exceeds the 500MB limit")
                out.write(chunk)
        info = processing.probe(dest)
        processing.make_preview(dest, d / "preview.mp4")
    except HTTPException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, f"Could not process video: {e}")
    return {"video_id": vid, "filename": file.filename, "size": size, **info}


@app.get("/api/videos/{video_id}/preview")
def preview(video_id: str):
    # FileResponse supports HTTP Range, so <video> seeking works.
    return FileResponse(video_dir(video_id) / "preview.mp4", media_type="video/mp4")


@app.get("/api/videos/{video_id}/frame")
def frame(video_id: str, t: float = 0.0):
    try:
        data = processing.extract_frame_jpeg(original_path(video_dir(video_id)), t)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return Response(data, media_type="image/jpeg")


@app.post("/api/videos/{video_id}/detect")
def detect(video_id: str):
    box = processing.detect_watermark(original_path(video_dir(video_id)))
    return {"found": box is not None, "box": box}


@app.get("/api/algorithms")
def algorithms():
    return processing.available_algorithms()


# -------------------------------------------------------------------- jobs
class JobRequest(BaseModel):
    video_id: str
    algorithm: Literal["telea", "ns", "lama", "propainter"] = "telea"
    mask: str  # PNG as data URL / base64; painted pixels (alpha or non-black) = remove
    dilate: int = 3


def _run_job(job_id: str, src: Path, dst: Path, mask, algorithm: str):
    job = jobs[job_id]
    job["status"] = "processing"

    def progress(done: int, total: int) -> bool:
        job["done"], job["total"] = done, total
        return job["cancel"]

    try:
        processing.process_video(src, dst, mask, algorithm, progress)
        job["status"] = "cancelled" if job["cancel"] else "done"
    except Exception as e:  # surface failure to the UI
        traceback.print_exc()
        job["status"], job["error"] = "error", str(e)[:300]


@app.post("/api/jobs")
def create_job(req: JobRequest):
    d = video_dir(req.video_id)
    src = original_path(d)
    algo = next((a for a in processing.available_algorithms() if a["id"] == req.algorithm), None)
    if not algo or not algo["available"]:
        raise HTTPException(400, f"Algorithm '{req.algorithm}' is not available. {algo.get('hint', '') if algo else ''}")
    try:
        info = processing.probe(src)
        payload = req.mask.split(",", 1)[-1]
        mask = processing.decode_mask(base64.b64decode(payload), info["width"], info["height"],
                                      max(0, min(req.dilate, 25)))
    except Exception as e:
        raise HTTPException(400, f"Invalid mask: {e}")

    job_id = uuid.uuid4().hex
    dst = d / f"result_{job_id}.mp4"
    with jobs_lock:
        jobs[job_id] = {"id": job_id, "video_id": req.video_id, "status": "queued",
                        "done": 0, "total": info["frames"], "error": None,
                        "cancel": False, "path": dst}
    executor.submit(_run_job, job_id, src, dst, mask, req.algorithm)
    return {"job_id": job_id}


class ShortRequest(BaseModel):
    video_id: str
    layout: Literal["crop", "blur"] = "blur"
    fps: Literal[30, 60] = 30
    source_job_id: Optional[str] = None  # convert a cleaned result instead of the original


def _run_short(job_id: str, src: Path, dst: Path, layout: str, fps: int):
    job = jobs[job_id]
    job["status"] = "processing"

    def progress(done: int, total: int) -> bool:
        job["done"], job["total"] = done, total
        return job["cancel"]

    try:
        processing.make_short(src, dst, layout, fps, progress)
        job["status"] = "cancelled" if job["cancel"] else "done"
    except Exception as e:
        traceback.print_exc()
        job["status"], job["error"] = "error", str(e)[:300]


@app.post("/api/shorts")
def create_short(req: ShortRequest):
    d = video_dir(req.video_id)
    src = original_path(d)
    if req.source_job_id:
        prev = get_job(req.source_job_id)
        if prev["video_id"] != req.video_id or prev["status"] != "done":
            raise HTTPException(400, "Source job is not a finished result of this video")
        src = prev["path"]
    job_id = uuid.uuid4().hex
    dst = d / f"short_{job_id}.mp4"
    with jobs_lock:
        jobs[job_id] = {"id": job_id, "video_id": req.video_id, "status": "queued",
                        "done": 0, "total": 1000, "error": None, "cancel": False,
                        "path": dst, "filename": "short.mp4"}
    executor.submit(_run_short, job_id, src, dst, req.layout, req.fps)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    j = get_job(job_id)
    return {k: j[k] for k in ("id", "status", "done", "total", "error")}


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    get_job(job_id)["cancel"] = True
    return {"ok": True}


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str, download: bool = False):
    j = get_job(job_id)
    if j["status"] != "done" or not j["path"].exists():
        raise HTTPException(409, "Result not ready")
    return FileResponse(
        j["path"], media_type="video/mp4",
        filename=j.get("filename", "cleaned.mp4") if download else None,
        content_disposition_type="attachment" if download else "inline",
    )


# Single-container deployment: if the frontend has been built (npm run build), serve it
# from the same origin. Registered last so every /api route above keeps priority.
_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _dist.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
