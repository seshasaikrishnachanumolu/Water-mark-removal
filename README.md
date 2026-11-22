# Clearframe

Remove watermarks from videos and images, edit in a browser studio, and export YouTube Shorts.
React + Tailwind frontend, FastAPI + OpenCV + ffmpeg backend.

| Route | What it is |
|---|---|
| `#/` | Landing page |
| `#/studio` | Watermark Remover: video and image tabs, one-click "Open in Studio Editor" |
| `#/editor` | Studio Editor: multi-track timeline, canvas, library, inspector, AI tools, export |
| `#/download` | Link Downloader: paste a YouTube or Instagram link, then save, clean or edit the video |

## Run locally (Windows PowerShell)

Backend (Python 3.10+; verified on 3.13):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r requirements-ai.txt     # optional: captions, AI background removal, LaMa
uvicorn app.main:app --port 8000
```

Frontend (Node 18+), second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 (the dev server proxies `/api` to port 8000).

## Run with Docker (one container, one port)

```bash
docker compose up --build        # http://localhost:8000
# AI extras (~1GB larger image): set WITH_AI: "1" in docker-compose.yml
```

The image builds the frontend and serves it from FastAPI as an unprivileged user, with a health
check. Uploads and the downloaded LaMa model live in named volumes. Both variants were built and
tested on Docker 29 (Python 3.12 image): the default image ran upload, watermark removal and Short
export; the `WITH_AI` image ran captions and background removal.

## Features

**Remover** (video and image): box/brush/eraser mask, auto-detect corner logos, Telea, Navier-Stokes
and LaMa engines, progress and cancel, side-by-side result, YouTube Short export
(1080x1920, 30/60 fps, center crop or blurred background, capped at 180s).

**Studio Editor**: video/audio/overlay/text tracks, drag, trim, snap, split, duplicate, undo/redo,
filmstrip thumbnails and waveforms, text/shape/emoji/template library, on-canvas move / resize /
rotate handles with centre snapping and guides, copy/paste, arrow-key nudge, layer ordering and
track reordering, canvas background colour, one-tap filters (Vivid, B&W, Sepia...), fade / zoom /
slide / pop in and out animations (audio fades too), inspector (transform, crop, mask, colour
grading, chroma key, volume, constant speed and **speed curves** with presets),
autosave to IndexedDB, export MP4/MOV/WebM or PNG/JPG at 720p-4K. Formats the browser can't play
(AVI, MKV...) are converted on import by the backend.

**Link Downloader** (`yt-dlp`, in `requirements.txt`): public YouTube and Instagram videos only.
Single videos up to 1080p, 60 minutes and 500MB. "Best quality" takes the highest resolution;
"Fast" prefers H.264 (often 720p) so it is ready in seconds. The user must confirm they own the
video or have permission. Only YouTube/Instagram hosts are accepted (no generic URLs). No logins or
cookies, so private and login-only Instagram posts fail with a clear message. Sony LIV and other
DRM-protected streaming services are refused by design. YouTube changes often: if downloads start
failing, update with `pip install -U yt-dlp`. Downloading can break a site's terms of service.

**AI tools** (`GET /api/ai/capabilities` shows what is installed):

| Tool | Needs | Notes |
|---|---|---|
| Auto captions | `faster-whisper` | Whisper "base" model downloads on first use |
| Background removal, photo | `rembg` (else weak GrabCut fallback) | |
| Background removal, video | `rembg` | First 30s at up to 720p, WebM with alpha |
| Upscale + sharpen | nothing | Classical Lanczos + unsharp, not a neural upscaler |
| LaMa inpainting | `onnxruntime` | ~200MB model auto-downloads to `backend/models/`. About 4s/frame on CPU |
| ProPainter | clone the repo, set `PROPAINTER_DIR` | Not tested |
| Text-to-video / generative FX | **not implemented** | Needs an external provider |

## Layout

```
backend/app/main.py         remover API, jobs, static serving
backend/app/processing.py   OpenCV/ffmpeg core, auto-detect, inpainting engines
backend/app/studio.py       editor + AI routes (separate router)
backend/app/maintenance.py  stale-file cleanup, rate limiting
backend/tests/              pytest (API + media)
frontend/src/editor/        store/ (Zustand), engine/ (compositor, exporter, timeline math), ui/
frontend/src/components/    remover UI
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `FILE_TTL_HOURS` | 6 | Delete uploads/results older than this |
| `RATE_LIMIT_PER_MIN` | 120 | POST requests per IP per minute (0 = off) |
| `CORS_ORIGINS` | localhost:5173 | Comma-separated origins if frontend is hosted separately |
| `WHISPER_MODEL` | base | faster-whisper model size |
| `REMBG_MODEL` | u2netp | rembg model for video (u2net = better, slower) |
| `LAMA_MODEL` | backend/models/lama_fp32.onnx | Path to the LaMa ONNX file |
| `PROPAINTER_DIR` | unset | ProPainter checkout |

## Tests

```powershell
cd backend;  pip install -r requirements-dev.txt;  pytest -q    # LaMa tests skip without onnxruntime
cd frontend; npm test
```

## Known limits

- Video export renders in real time in the browser (keep the tab visible), then the backend encodes H.264.
  The browser recorder can hiccup for a fraction of a second early in an export; a WebCodecs
  frame-by-frame exporter would remove that and is not built yet.
- Not in the editor yet: true cross-dissolve transitions between clips, keyframes, multi-select / grouping,
  stock media library, music library and voice-over recording, on-canvas text editing (edit text in the inspector).
- No user accounts: files are anonymous and auto-deleted after `FILE_TTL_HOURS`. Add auth before exposing publicly.
- Auto-detect is a frame-comparison heuristic, not a trained model. Moving or translucent logos need a manual mask.
- Only edit footage you own or have permission to modify.
