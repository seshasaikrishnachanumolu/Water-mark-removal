import { useEffect, useState } from "react";
import { dlCancel, dlFileUrl, dlInfo, dlJob, dlSites, dlStart, previewUrl } from "../api";
import { stageHandoff } from "../editor/engine/project";
import AppNav from "./AppNav";

const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");

/** Paste a YouTube / Instagram link, preview it, download it, then clean or edit it. */
export default function DownloadPage() {
  const [url, setUrl] = useState("");
  const [sites, setSites] = useState(null);
  const [info, setInfo] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [quality, setQuality] = useState("best");
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    dlSites().then(setSites).catch(() => setError("Backend unreachable. Start it on port 8000."));
  }, []);

  const running = job && ["queued", "downloading", "processing"].includes(job.status);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => dlJob(job.id).then(setJob).catch((e) => setError(e.message)), 700);
    return () => clearInterval(t);
  }, [job, running]);

  async function lookup(e) {
    e.preventDefault();
    setError("");
    setInfo(null);
    setJob(null);
    setFetching(true);
    try {
      setInfo(await dlInfo(url.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setFetching(false);
    }
  }

  async function start() {
    setError("");
    try {
      const { job_id } = await dlStart(url.trim(), confirmed, quality);
      setJob({ id: job_id, status: "queued", progress: 0 });
    } catch (err) {
      setError(err.message);
    }
  }

  // Hand the downloaded video to the remover (it reads this on load).
  function openInRemover(video) {
    sessionStorage.setItem("clearframe.preload", JSON.stringify(video));
    window.location.hash = "#/studio";
  }

  const video = job?.status === "done" ? job.video : null;
  const pct = job ? Math.round((job.progress || 0) * 100) : 0;

  return (
    <>
      <header className="border-b border-line bg-cream">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <a href="#/" className="font-display text-xl font-semibold">Clearframe</a>
          <AppNav current="#/download" />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-semibold">Link Downloader</h1>
        <p className="mb-8 mt-1 text-ink/65">
          Paste a public YouTube or Instagram video link. Then save it, remove a watermark, or open it in the editor.
        </p>

        {error && (
          <div role="alert" className="mb-6 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
        )}

        <form onSubmit={lookup} className="card">
          <label htmlFor="video-url" className="mb-2 block text-sm font-medium">Video link</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="video-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2.5 text-ink"
              disabled={running}
            />
            <button type="submit" disabled={fetching || running || !url.trim()}
              className="rounded-lg bg-ink px-5 py-2.5 font-medium text-paper hover:bg-ink/85 disabled:opacity-50">
              {fetching ? "Looking up..." : "Find video"}
            </button>
          </div>
          {sites && (
            <p className="mt-3 text-xs text-ink/55">
              Works with: {sites.supported.join(", ")}. Up to {sites.limits.max_height}p and {sites.limits.max_minutes} minutes.
              Not supported: Sony LIV and other DRM-protected streaming services, private or login-only posts.
            </p>
          )}
        </form>

        {info && (
          <section className="card mt-6">
            <div className="flex gap-4">
              {info.thumbnail && (
                <img src={info.thumbnail} alt="" referrerPolicy="no-referrer" className="h-24 w-40 shrink-0 rounded-lg bg-black object-cover" />
              )}
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-gold">{info.site}</p>
                <h2 className="truncate text-lg font-medium" title={info.title}>{info.title}</h2>
                <p className="text-sm text-ink/60">{[info.uploader, fmt(info.duration)].filter(Boolean).join(" · ")}</p>
              </div>
            </div>

            {!video && (
              <>
                <fieldset className="mt-5" disabled={running}>
                  <legend className="mb-2 text-sm font-medium">Quality</legend>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {Object.entries(sites?.qualities || { best: "Best quality", fast: "Fast" }).map(([id, label]) => (
                      <label key={id} className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${quality === id ? "border-gold bg-gold/10" : "border-line"}`}>
                        <input type="radio" name="quality" value={id} checked={quality === id} onChange={() => setQuality(id)} className="mt-1" />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="mt-5 flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={running} className="mt-1" />
                  <span>{sites?.confirm_text || "I own this video or have permission to download it."}</span>
                </label>
                <p className="mt-1 pl-6 text-xs text-ink/55">
                  Downloading may break a site's terms or the owner's copyright. You are responsible for what you download.
                </p>
                <div className="mt-4 flex gap-3">
                  {running ? (
                    <button onClick={() => dlCancel(job.id)} className="rounded-lg bg-rose-800 px-5 py-2 font-medium text-white hover:bg-rose-700">Cancel</button>
                  ) : (
                    <button onClick={start} disabled={!confirmed} className="rounded-lg bg-ink px-5 py-2 font-medium text-paper hover:bg-ink/85 disabled:opacity-40">
                      Download video
                    </button>
                  )}
                </div>
              </>
            )}

            {job && !video && (
              <div className="mt-5" aria-live="polite">
                <div className="h-3 overflow-hidden rounded bg-ink/10">
                  <div className="h-full bg-sage transition-all" style={{ width: `${job.status === "processing" ? 100 : pct}%` }} />
                </div>
                <p className="mt-2 text-sm text-ink/65">
                  {job.status === "queued" && "Queued..."}
                  {job.status === "downloading" && `Downloading ${pct}%`}
                  {job.status === "processing" && "Preparing preview..."}
                  {job.status === "cancelled" && "Cancelled"}
                  {job.status === "error" && <span className="text-rose-700">Failed: {job.error}</span>}
                </p>
              </div>
            )}
          </section>
        )}

        {video && (
          <section className="card mt-6">
            <h2 className="mb-3 text-lg font-medium">Ready</h2>
            <video src={previewUrl(video.video_id)} controls className="max-h-80 w-full rounded-xl bg-black" />
            <p className="mt-1 text-xs text-ink/50">
              {video.width}x{video.height} · {video.fps.toFixed(0)} fps · {(video.size / 1048576).toFixed(1)} MB
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href={dlFileUrl(video.video_id)} download className="rounded-lg bg-ink px-4 py-2 font-medium text-paper hover:bg-ink/85">Save video</a>
              <button onClick={() => openInRemover(video)} className="rounded-lg border border-line px-4 py-2 font-medium hover:border-gold">
                Remove watermark
              </button>
              <button onClick={() => stageHandoff(dlFileUrl(video.video_id), video.filename)}
                className="rounded-lg border border-gold px-4 py-2 font-medium text-gold hover:bg-gold/10">
                Open in Studio Editor
              </button>
            </div>
            <p className="mt-3 text-xs text-ink/50">Downloads are deleted from the server after a few hours. Save the file if you want to keep it.</p>
          </section>
        )}
      </main>
    </>
  );
}
