"""Link downloader: validation rules, refusals and the job flow (network faked)."""
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import downloader, processing
from app.main import app

client = TestClient(app)


# ------------------------------------------------------------ validation
@pytest.mark.parametrize("url,site", [
    ("https://www.youtube.com/watch?v=abc", "youtube"),
    ("https://youtu.be/abc", "youtube"),
    ("https://m.youtube.com/shorts/abc", "youtube"),
    ("https://www.instagram.com/reel/abc/", "instagram"),
    ("https://instagram.com/p/abc/", "instagram"),
])
def test_accepts_supported_links(url, site):
    assert downloader.validate_url(url) == site


@pytest.mark.parametrize("url", [
    "",
    "not a url",
    "ftp://youtube.com/x",
    "https://evil.com/watch?v=1",
    "https://youtube.com.evil.com/x",  # look-alike host
    "https://notyoutube.com/x",
    "http://127.0.0.1:8000/api/algorithms",  # internal address (SSRF)
    "http://localhost/x",
    "https://user:pw@youtube.com/x",  # embedded credentials
])
def test_rejects_other_links(url):
    with pytest.raises(ValueError):
        downloader.validate_url(url)


def test_sony_liv_is_refused_with_a_reason():
    with pytest.raises(ValueError) as e:
        downloader.validate_url("https://www.sonyliv.com/shows/abc")
    assert "DRM" in str(e.value)


def test_info_endpoint_returns_400_for_refused_links():
    r = client.post("/api/download/info", json={"url": "https://www.sonyliv.com/movies/x"})
    assert r.status_code == 400 and "DRM" in r.json()["detail"]
    assert client.post("/api/download/info", json={"url": "https://example.com/v"}).status_code == 400


def test_start_requires_rights_confirmation():
    r = client.post("/api/download/start", json={"url": "https://youtu.be/abc"})
    assert r.status_code == 400 and "confirm" in r.json()["detail"].lower()


def test_sites_lists_limits_and_refusals():
    s = client.get("/api/download/sites").json()
    assert s["limits"]["max_height"] == 1080 and "Sony LIV" in s["refused"]


def test_check_single_video_rejects_playlists_live_and_long():
    ok = {"title": "t", "duration": 30}
    downloader._check_single_video(ok)
    for bad in ({"_type": "playlist"}, {"entries": [1]}, {"is_live": True}, {"duration": 99999}):
        with pytest.raises(ValueError):
            downloader._check_single_video(bad)


def test_friendly_errors():
    f = downloader.friendly_error
    assert "DRM" in f(Exception("ERROR: [x] DRM protected"))
    assert "login" in f(Exception("ERROR: [Instagram] abc: login required")).lower()
    assert "private" in f(Exception("ERROR: [youtube] abc: Private video")).lower()
    assert f(Exception("ERROR: [youtube] abc: Some odd failure")) == "Some odd failure"  # id prefix dropped


def test_safe_filename_strips_path_and_symbols():
    name = downloader._safe_name('../../etc/passwd: "evil"|*?', "mp4")
    assert "/" not in name and "\\" not in name and ".." not in name and name.endswith(".mp4")


# ------------------------------------------------------------- job flow
class FakeYDL:
    """Stands in for yt_dlp.YoutubeDL: 'downloads' a tiny generated clip."""
    outtmpl = None

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=False, process=True):
        if "playlist" in url:
            return {"_type": "playlist", "entries": [{}]}
        return {"title": "My: Test/Video?", "duration": 2, "uploader": "me", "thumbnail": None}

    def process_ie_result(self, raw, download=True):
        out = self.opts["outtmpl"].replace("%(ext)s", "mp4")
        subprocess.run([processing.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2",
                        "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        "-shortest", out], check=True)
        for hook in self.opts["progress_hooks"]:
            hook({"status": "finished"})


@pytest.fixture
def fake_ytdlp(monkeypatch):
    import yt_dlp

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)


def wait_job(job_id):
    for _ in range(100):
        s = client.get(f"/api/download/jobs/{job_id}").json()
        if s["status"] not in ("queued", "downloading", "processing"):
            return s
        time.sleep(0.2)
    raise AssertionError("download job timed out")


def test_download_registers_a_usable_video(fake_ytdlp):
    r = client.post("/api/download/start", json={"url": "https://youtu.be/abc", "confirm_rights": True})
    assert r.status_code == 200
    s = wait_job(r.json()["job_id"])
    assert s["status"] == "done", s
    v = s["video"]
    assert (v["width"], v["height"]) == (320, 180) and v["filename"] == "My TestVideo.mp4"

    # Saved file keeps a clean name and is the real video.
    from urllib.parse import unquote

    f = client.get(f"/api/download/{v['video_id']}/file")
    assert f.status_code == 200 and "My TestVideo.mp4" in unquote(f.headers["content-disposition"]) and len(f.content) > 1000
    # It is a normal video for the rest of the app: preview + a removal job work.
    assert client.get(f"/api/videos/{v['video_id']}/preview").status_code == 200
    assert client.get(f"/api/videos/{v['video_id']}/frame?t=0.5").status_code == 200


def test_playlist_links_fail_cleanly_and_leave_no_files(fake_ytdlp):
    before = {p.name for p in downloader.STORAGE.glob("*")} if downloader.STORAGE.exists() else set()
    r = client.post("/api/download/start", json={"url": "https://www.youtube.com/playlist?list=abc", "confirm_rights": True})
    s = wait_job(r.json()["job_id"])
    assert s["status"] == "error" and "single video" in s["error"]
    after = {p.name for p in downloader.STORAGE.glob("*")} if downloader.STORAGE.exists() else set()
    assert after == before


def test_file_endpoint_validates_ids():
    assert client.get("/api/download/..%2F..%2Fsecret/file").status_code in (400, 404)
    assert client.get("/api/download/" + "0" * 32 + "/file").status_code == 404
    assert client.get("/api/download/jobs/nope").status_code == 404


def test_quality_choice_controls_codec_preference():
    best, fast = downloader._base_opts("best")["format_sort"], downloader._base_opts("fast")["format_sort"]
    assert best[0].startswith("res:") and fast[0] == "vcodec:h264"
    assert downloader._base_opts("nonsense")["format_sort"] == best  # unknown -> best
    r = client.post("/api/download/start", json={"url": "https://youtu.be/abc", "confirm_rights": True, "quality": "huge"})
    assert r.status_code == 422  # only best / fast are accepted


def test_preview_fast_path_only_for_h264(tmp_path):
    def make(name, codec):
        p = tmp_path / name
        subprocess.run([processing.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=1",
                        "-c:v", codec, *(["-pix_fmt", "yuv420p"] if codec == "libx264" else []), str(p)], check=True)
        return p

    h264, mjpeg = make("a.mp4", "libx264"), make("b.avi", "mjpeg")
    assert processing._browser_playable(h264) and not processing._browser_playable(mjpeg)
    for src in (h264, mjpeg):
        out = tmp_path / (src.stem + "_prev.mp4")
        processing.make_preview(src, out)
        assert processing._browser_playable(out)  # either way the preview plays in a browser
