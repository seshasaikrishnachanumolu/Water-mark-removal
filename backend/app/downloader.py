"""Fetch a public video from a link (YouTube, Instagram) into the app.

Scope and limits, on purpose:
  * Only YouTube and Instagram hosts are accepted (allow-list, which also blocks
    server-side requests to arbitrary or internal addresses).
  * No logins, cookies or DRM handling. Private / login-only posts and
    DRM-protected streams (Sony LIV, Netflix...) fail with a clear message.
  * Single videos only (no playlists / channels), max 1080p, 60 minutes, 500MB.
  * The caller must confirm they own the video or have permission to download it.

The finished download is registered exactly like an upload (storage/<id>/original.*
plus a browser-friendly preview), so the watermark remover and the Studio Editor
can use it right away.

  GET    /api/download/sites                 supported / refused sites
  POST   /api/download/info                  title, duration, thumbnail for a link
  POST   /api/download/start                 start a download job
  GET    /api/download/jobs/{id}             progress
  DELETE /api/download/jobs/{id}             cancel
  GET    /api/download/{video_id}/file       save the full-quality file
"""
from __future__ import annotations

import importlib.util
import re
import shutil
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from typing import Literal

from pydantic import BaseModel

from . import processing

router = APIRouter(prefix="/api/download")

STORAGE = Path(__file__).resolve().parent.parent / "storage"
MAX_BYTES = 500 * 1024 * 1024
MAX_SECONDS = 3600
MAX_HEIGHT = 1080
ID_RE = re.compile(r"^[0-9a-f]{32}$")

SUPPORTED = {"youtube": ("youtube.com", "youtu.be"), "instagram": ("instagram.com",)}
REFUSED = {
    "sonyliv.com": "Sony LIV videos are DRM-protected subscription streams. This app can't download them. "
                   "If you own a copy of the file, upload it instead.",
}
CONFIRM_TEXT = "I own this video or have permission to download it."

dl_jobs: dict[str, dict] = {}
dl_executor = ThreadPoolExecutor(max_workers=2)


# ------------------------------------------------------------------ helpers
def available() -> bool:
    return importlib.util.find_spec("yt_dlp") is not None


def _host_is(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def validate_url(url: str) -> str:
    """Return the site name ("youtube" | "instagram") or raise ValueError with a user-facing reason."""
    url = (url or "").strip()
    if not url or len(url) > 2048:
        raise ValueError("Paste a video link.")
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        raise ValueError("That doesn't look like a valid https link.")
    host = p.hostname.lower().rstrip(".")
    for domain, reason in REFUSED.items():
        if _host_is(host, domain):
            raise ValueError(reason)
    for site, domains in SUPPORTED.items():
        if any(_host_is(host, d) for d in domains):
            return site
    raise ValueError("Only YouTube and Instagram links are supported.")


def friendly_error(e: Exception) -> str:
    raw = re.sub(r"\x1b\[[0-9;]*m", "", str(e))  # strip ANSI colour codes
    # "ERROR: [youtube] abc123: Private video" -> "Private video" (id is only dropped when followed by a colon)
    msg = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*(?:[\w\-]+:\s*)?)?", "", raw).strip()
    low = raw.lower()  # keyword checks use the full text
    if "drm" in low:
        return "This video is DRM-protected and can't be downloaded."
    if "sign in to confirm" in low or "not a bot" in low:
        return "YouTube asked for a sign-in check for this video. Try again later or use another video."
    if "login required" in low or "rate-limit reached" in low or "empty media response" in low or "log in" in low:
        return "Instagram requires a login to show this post. Only public posts that don't need a login can be downloaded."
    if "private" in low:
        return "This video is private."
    if "unavailable" in low or "not available" in low or "removed" in low:
        return "This video is unavailable (removed, region-locked or age-restricted)."
    if "unsupported url" in low:
        return "That link doesn't point to a single downloadable video."
    return msg[:220] or "Could not read that link."


QUALITY_SORT = {
    # Highest resolution up to the cap; H.264 wins ties (plays everywhere, decodes fast).
    "best": [f"res:{MAX_HEIGHT}", "vcodec:h264", "acodec:aac"],
    # H.264 first even at a lower resolution: ready in seconds, fast to edit.
    "fast": ["vcodec:h264", f"res:{MAX_HEIGHT}", "acodec:aac"],
}


def _base_opts(quality: str = "best") -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 2,
        "ffmpeg_location": processing.FFMPEG,
        # Never fall back to the generic extractor, which fetches arbitrary pages.
        "allowed_extractors": [r"(?i)youtube.*", r"(?i)instagram.*"],
        "max_filesize": MAX_BYTES,
        "format": f"bv*[height<={MAX_HEIGHT}]+ba/b[height<={MAX_HEIGHT}]/b",
        "format_sort": QUALITY_SORT.get(quality, QUALITY_SORT["best"]),
        "merge_output_format": "mp4",
    }

def _check_single_video(info: dict) -> None:
    if not info:
        raise ValueError("Could not read that link.")
    if info.get("_type") in ("playlist", "multi_video") or info.get("entries"):
        raise ValueError("Please paste a link to a single video, not a playlist or profile.")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise ValueError("Live streams can't be downloaded.")
    dur = info.get("duration")
    if dur and dur > MAX_SECONDS:
        raise ValueError(f"Videos longer than {MAX_SECONDS // 60} minutes aren't supported.")


def _describe(info: dict, site: str) -> dict:
    return {
        "site": site,
        "title": info.get("title") or "Video",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
    }


def _safe_name(title: str, ext: str) -> str:
    base = re.sub(r"[^\w\- ]+", "", title, flags=re.UNICODE).strip()[:80] or "video"
    return f"{base}.{ext}"


def _video_dir(video_id: str) -> Path:
    if not ID_RE.match(video_id):
        raise HTTPException(400, "Invalid id")
    d = STORAGE / video_id
    if not d.is_dir():
        raise HTTPException(404, "Video not found (downloads are deleted after a few hours)")
    return d


# ---------------------------------------------------------------------- API
class UrlRequest(BaseModel):
    url: str


class StartRequest(BaseModel):
    url: str
    confirm_rights: bool = False
    quality: Literal["best", "fast"] = "best"


@router.get("/sites")
def sites():
    return {
        "available": available(),
        "supported": ["YouTube", "Instagram (public posts only)"],
        "refused": {"Sony LIV": REFUSED["sonyliv.com"]},
        "qualities": {"best": f"Best quality (up to {MAX_HEIGHT}p, can take a few minutes to prepare)",
                      "fast": "Fast (H.264, often 720p, ready in seconds)"},
        "limits": {"max_height": MAX_HEIGHT, "max_minutes": MAX_SECONDS // 60, "max_mb": MAX_BYTES // (1024 * 1024)},
        "confirm_text": CONFIRM_TEXT,
    }


def _need_ytdlp():
    if not available():
        raise HTTPException(501, "The downloader needs yt-dlp: pip install -r requirements.txt")


@router.post("/info")
def info(req: UrlRequest):
    _need_ytdlp()
    try:
        site = validate_url(req.url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL({**_base_opts(), "skip_download": True}) as ydl:
            raw = ydl.extract_info(req.url.strip(), download=False, process=False)
        _check_single_video(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # yt_dlp.utils.DownloadError and friends
        raise HTTPException(400, friendly_error(e))
    return _describe(raw, site)


def _run(job_id: str, url: str, site: str, quality: str = "best") -> None:
    import yt_dlp

    job = dl_jobs[job_id]
    job["status"] = "downloading"
    vid = uuid.uuid4().hex
    d = STORAGE / vid
    try:
        d.mkdir(parents=True, exist_ok=True)

        def hook(h):
            if job["cancel"]:
                raise yt_dlp.utils.DownloadCancelled()
            if h.get("status") == "downloading":
                total = h.get("total_bytes") or h.get("total_bytes_estimate")
                parts = max(1, len((h.get("info_dict") or {}).get("requested_formats") or [1]))
                if total:
                    frac = min(1.0, h.get("downloaded_bytes", 0) / total)
                    job["progress"] = min(0.95, (job["streams_done"] + frac) / parts)
            elif h.get("status") == "finished":
                job["streams_done"] += 1

        opts = {**_base_opts(quality), "outtmpl": str(d / "original.%(ext)s"), "progress_hooks": [hook]}
        with yt_dlp.YoutubeDL(opts) as ydl:
            raw = ydl.extract_info(url, download=False, process=False)
            _check_single_video(raw)
            job["title"] = raw.get("title") or "Video"
            ydl.process_ie_result(raw, download=True)

        files = [p for p in d.glob("original.*") if p.suffix not in (".part", ".ytdl")]
        if not files:
            raise ValueError(f"The video is larger than {MAX_BYTES // (1024 * 1024)}MB or couldn't be downloaded.")
        src = files[0]
        if src.stat().st_size > MAX_BYTES:
            raise ValueError(f"The video is larger than {MAX_BYTES // (1024 * 1024)}MB.")
        job["status"] = "processing"
        meta = processing.probe(src)
        processing.make_preview(src, d / "preview.mp4")
        (d / "title.txt").write_text(job["title"], encoding="utf-8")
        job["video"] = {"video_id": vid, "filename": _safe_name(job["title"], src.suffix.lstrip(".")),
                        "size": src.stat().st_size, **meta}
        job["progress"], job["status"] = 1.0, "done"
    except yt_dlp.utils.DownloadCancelled:
        job["status"] = "cancelled"
        shutil.rmtree(d, ignore_errors=True)
    except Exception as e:
        traceback.print_exc()
        job["status"], job["error"] = "error", friendly_error(e)
        shutil.rmtree(d, ignore_errors=True)


@router.post("/start")
def start(req: StartRequest):
    _need_ytdlp()
    if not req.confirm_rights:
        raise HTTPException(400, f"Please confirm: \"{CONFIRM_TEXT}\"")
    try:
        site = validate_url(req.url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    job_id = uuid.uuid4().hex
    dl_jobs[job_id] = {"id": job_id, "status": "queued", "progress": 0.0, "streams_done": 0, "error": None,
                       "cancel": False, "title": None, "video": None}
    dl_executor.submit(_run, job_id, req.url.strip(), site, req.quality)
    return {"job_id": job_id}


def _job(job_id: str) -> dict:
    if not ID_RE.match(job_id) or job_id not in dl_jobs:
        raise HTTPException(404, "Job not found")
    return dl_jobs[job_id]


@router.get("/jobs/{job_id}")
def job_status(job_id: str):
    j = _job(job_id)
    return {k: j[k] for k in ("id", "status", "progress", "error", "title", "video")}


@router.delete("/jobs/{job_id}")
def cancel(job_id: str):
    _job(job_id)["cancel"] = True
    return {"ok": True}


@router.get("/{video_id}/file")
def file(video_id: str):
    d = _video_dir(video_id)
    src = next((p for p in d.glob("original.*")), None)
    if not src:
        raise HTTPException(404, "File missing")
    title_file = d / "title.txt"
    title = title_file.read_text(encoding="utf-8") if title_file.exists() else "video"
    return FileResponse(src, filename=_safe_name(title, src.suffix.lstrip(".")))
