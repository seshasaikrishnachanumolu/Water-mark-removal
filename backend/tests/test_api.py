"""End-to-end API tests on tiny synthetic media. Run:  pytest -q   (from backend/)"""
import base64
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.maintenance import RateLimitMiddleware

W, H, N = 320, 180, 30


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


@pytest.fixture(scope="module")
def video_file(tmp_path_factory):
    """Moving gradient with a static white 'LOGO' in the bottom-right corner."""
    path = tmp_path_factory.mktemp("media") / "t.avi"
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 25, (W, H))
    for i in range(N):
        x = np.roll(np.tile(np.linspace(0, 255, W, dtype=np.uint8), (H, 1)), i * 6, axis=1)
        f = cv2.merge([x, 255 - x, np.full_like(x, (i * 8) % 255)])
        cv2.putText(f, "LOGO", (230, 168), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 3)
        out.write(f)
    out.release()
    return path


@pytest.fixture(scope="module")
def uploaded(client, video_file):
    r = client.post("/api/videos", files={"file": ("t.avi", video_file.read_bytes(), "video/avi")})
    assert r.status_code == 200, r.text
    return r.json()


def mask_data_url(box=(225, 140, 315, 178)):
    m = np.zeros((H, W, 4), np.uint8)
    x0, y0, x1, y1 = box
    m[y0:y1, x0:x1, 3] = 255
    return "data:image/png;base64," + base64.b64encode(cv2.imencode(".png", m)[1]).decode()


def wait(client, url, key="status", busy=("queued", "processing"), tries=200):
    for _ in range(tries):
        s = client.get(url).json()
        if s[key] not in busy:
            return s
        time.sleep(0.2)
    raise AssertionError("job timed out")


# ------------------------------------------------------------- remover
def test_upload_metadata(uploaded):
    assert (uploaded["width"], uploaded["height"], uploaded["frames"]) == (W, H, N)


def test_rejects_bad_extension(client):
    assert client.post("/api/videos", files={"file": ("a.txt", b"x")}).status_code == 400


def test_detects_corner_logo(client, uploaded):
    r = client.post(f"/api/videos/{uploaded['video_id']}/detect").json()
    assert r["found"] and r["box"]["x"] > 0.5 and r["box"]["y"] > 0.5


@pytest.mark.parametrize("algo", ["telea", "ns"])
def test_removal_job_removes_logo(client, uploaded, algo):
    r = client.post("/api/jobs", json={"video_id": uploaded["video_id"], "algorithm": algo, "mask": mask_data_url()})
    assert r.status_code == 200
    job = r.json()["job_id"]
    assert wait(client, f"/api/jobs/{job}")["status"] == "done"
    res = client.get(f"/api/jobs/{job}/result")
    assert res.status_code == 200 and res.headers["content-type"] == "video/mp4"


def test_unavailable_algorithm_is_rejected(client, uploaded):
    r = client.post("/api/jobs", json={"video_id": uploaded["video_id"], "algorithm": "propainter", "mask": mask_data_url()})
    assert r.status_code == 400


def test_empty_mask_is_rejected(client, uploaded):
    empty = "data:image/png;base64," + base64.b64encode(cv2.imencode(".png", np.zeros((H, W, 4), np.uint8))[1]).decode()
    assert client.post("/api/jobs", json={"video_id": uploaded["video_id"], "mask": empty}).status_code == 400


def test_path_traversal_blocked(client):
    assert client.get("/api/videos/..%2F..%2Fetc/preview").status_code in (400, 404)


# --------------------------------------------------------------- shorts
@pytest.mark.parametrize("layout,fps", [("crop", 30), ("blur", 60)])
def test_short_is_1080x1920(client, uploaded, tmp_path, layout, fps):
    r = client.post("/api/shorts", json={"video_id": uploaded["video_id"], "layout": layout, "fps": fps})
    job = r.json()["job_id"]
    assert wait(client, f"/api/jobs/{job}")["status"] == "done"
    out = tmp_path / "s.mp4"
    out.write_bytes(client.get(f"/api/jobs/{job}/result").content)
    cap = cv2.VideoCapture(str(out))
    assert (int(cap.get(3)), int(cap.get(4)), round(cap.get(5))) == (1080, 1920, fps)


# --------------------------------------------------------------- studio
def test_capabilities_shape(client):
    caps = client.get("/api/ai/capabilities").json()
    for key in ("captions", "background_removal", "video_background_removal", "enhance", "generate"):
        assert "available" in caps[key]
    assert caps["generate"]["available"] is False


def test_transcode_makes_even_h264_mp4(client, video_file, tmp_path):
    r = client.post("/api/export/transcode", files={"file": ("in.avi", video_file.read_bytes())}, data={"fmt": "mp4", "fps": "0"})
    assert r.status_code == 200
    out = tmp_path / "x.mp4"
    out.write_bytes(r.content)
    cap = cv2.VideoCapture(str(out))
    assert (int(cap.get(3)), int(cap.get(4))) == (W, H) and round(cap.get(5)) == 25  # fps=0 keeps source fps


def test_transcode_rejects_unknown_format(client, video_file):
    r = client.post("/api/export/transcode", files={"file": ("in.avi", video_file.read_bytes())}, data={"fmt": "avi"})
    assert r.status_code == 400


def test_enhance_doubles_resolution(client, video_file, tmp_path):
    job = client.post("/api/ai/enhance", files={"file": ("t.avi", video_file.read_bytes())}, data={"scale": "2"}).json()["job_id"]
    assert wait(client, f"/api/ai/jobs/{job}")["status"] == "done"
    out = tmp_path / "e.mp4"
    out.write_bytes(client.get(f"/api/ai/jobs/{job}/result").content)
    cap = cv2.VideoCapture(str(out))
    assert (int(cap.get(3)), int(cap.get(4))) == (W * 2, H * 2)


def test_background_removal_returns_rgba_png(client, tmp_path):
    img = np.full((120, 160, 3), (30, 160, 60), np.uint8)
    cv2.circle(img, (80, 60), 30, (240, 240, 240), -1)
    ok, png = cv2.imencode(".png", img)
    r = client.post("/api/ai/remove-background", files={"file": ("a.png", png.tobytes())})
    assert r.status_code == 200
    out = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_UNCHANGED)
    assert out.shape == (120, 160, 4)


def test_image_watermark_removal(client):
    img = np.tile(np.linspace(40, 200, 200, dtype=np.uint8), (100, 1))
    img = cv2.merge([img, img, img])
    cv2.putText(img, "WM", (120, 90), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 3)
    ok, png = cv2.imencode(".png", img)
    m = np.zeros((100, 200, 4), np.uint8)
    m[60:98, 110:195, 3] = 255
    mask = "data:image/png;base64," + base64.b64encode(cv2.imencode(".png", m)[1]).decode()
    r = client.post("/api/images/remove-watermark", files={"file": ("a.png", png.tobytes())}, data={"mask": mask})
    assert r.status_code == 200
    out = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    assert (out[60:98, 110:195] > 235).sum() == 0  # the white text is gone


def test_generate_is_honestly_unavailable(client):
    assert client.post("/api/ai/generate").status_code == 501


def test_unknown_ai_job_404(client):
    assert client.get("/api/ai/jobs/nope").status_code == 404


# ---------------------------------------------------------- maintenance
def test_rate_limiter_returns_429():
    from fastapi import FastAPI

    mini = FastAPI()

    @mini.post("/api/ping")
    def ping():
        return {"ok": True}

    mini.add_middleware(RateLimitMiddleware, per_minute=3)
    c = TestClient(mini)
    codes = [c.post("/api/ping").status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]


def test_cleanup_sweeps_old_folders_but_keeps_studio(tmp_path):
    import os
    from app.maintenance import start_cleanup

    old, fresh, studio = tmp_path / "old", tmp_path / "fresh", tmp_path / "studio"
    for d in (old, fresh, studio):
        d.mkdir()
    long_ago = time.time() - 10_000
    os.utime(old, (long_ago, long_ago))
    os.utime(studio, (long_ago, long_ago))
    start_cleanup(tmp_path, ttl_seconds=60, interval=3600)
    time.sleep(0.5)
    assert not old.exists() and fresh.exists() and studio.exists()


# ----------------------------------------------------------------- LaMa (optional)
lama = pytest.mark.skipif(
    not __import__("app.processing", fromlist=["x"]).lama_available(), reason="onnxruntime not installed"
)


@lama
def test_lama_image_removal(client):
    img = np.tile(np.linspace(40, 200, 200, dtype=np.uint8), (100, 1))
    img = cv2.merge([img, img, img])
    cv2.putText(img, "WM", (120, 90), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 3)
    ok, png = cv2.imencode(".png", img)
    m = np.zeros((100, 200, 4), np.uint8)
    m[60:98, 110:195, 3] = 255
    mask = "data:image/png;base64," + base64.b64encode(cv2.imencode(".png", m)[1]).decode()
    r = client.post("/api/images/remove-watermark", files={"file": ("a.png", png.tobytes())},
                    data={"mask": mask, "algorithm": "lama"})
    assert r.status_code == 200
    out = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    assert (out[60:98, 110:195] > 235).sum() < 40  # white text gone (a few bright gradient pixels may remain)
    assert np.array_equal(out[:50], img[:50])  # untouched area is bit-identical


@lama
def test_lama_video_job(client, uploaded):
    r = client.post("/api/jobs", json={"video_id": uploaded["video_id"], "algorithm": "lama", "mask": mask_data_url()})
    assert r.status_code == 200
    t0 = time.time()
    s = wait(client, f"/api/jobs/{r.json()['job_id']}", tries=3000)  # CPU LaMa can take ~1-2s per frame
    print(f"lama video: {N} frames in {time.time() - t0:.0f}s -> {s}")
    assert s["status"] == "done", s



# ------------------------------------------------------------ regression
def test_upload_survives_missing_storage_folder(client, video_file):
    """If storage/ is deleted while the server runs (cleanup, antivirus, manual), uploads must still work."""
    import shutil
    from app.main import STORAGE

    shutil.rmtree(STORAGE, ignore_errors=True)
    assert not STORAGE.exists()
    r = client.post("/api/videos", files={"file": ("t.avi", video_file.read_bytes(), "video/avi")})
    assert r.status_code == 200, r.text
    # The editor's work folder must self-heal too.
    r = client.post("/api/export/transcode", files={"file": ("in.avi", video_file.read_bytes())}, data={"fmt": "mp4"})
    assert r.status_code == 200, r.text
