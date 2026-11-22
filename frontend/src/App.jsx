import { useEffect, useRef, useState } from "react";
import { cancelJob, getAlgorithms, getJob, previewUrl, startJob, uploadVideo } from "./api";
import UploadZone from "./components/UploadZone";
import MaskEditor from "./components/MaskEditor";
import ResultView from "./components/ResultView";
import ShortPanel from "./components/ShortPanel";
import AppNav from "./components/AppNav";
import ImageRemover from "./components/ImageRemover";

export default function App() {
  const editor = useRef(null);
  const [video, setVideo] = useState(null); // upload response (id + metadata)
  const [upProgress, setUpProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [algorithms, setAlgorithms] = useState([]);
  const [algo, setAlgo] = useState("telea");
  const [dilate, setDilate] = useState(3);
  const [job, setJob] = useState(null); // {id, status, done, total, error}
  const [error, setError] = useState("");
  const [mode, setMode] = useState("video"); // "video" | "image"

  // A video handed over from the Link Downloader is already on the server: open it directly.
  useEffect(() => {
    const raw = sessionStorage.getItem("clearframe.preload");
    if (!raw) return;
    sessionStorage.removeItem("clearframe.preload");
    try {
      setVideo(JSON.parse(raw));
    } catch {
      /* ignore a corrupt hand-off */
    }
  }, []);

  useEffect(() => {
    getAlgorithms().then(setAlgorithms).catch(() => setError("Backend unreachable. Start it on port 8000."));
  }, []);

  // Poll job progress until it finishes.
  useEffect(() => {
    if (!job || !["queued", "processing"].includes(job.status)) return;
    const t = setInterval(async () => {
      try {
        const s = await getJob(job.id);
        setJob(s);
      } catch (e) {
        setError(e.message);
      }
    }, 500);
    return () => clearInterval(t);
  }, [job]);

  async function onFile(file) {
    setError("");
    setUploading(true);
    setUpProgress(0);
    try {
      setVideo(await uploadVideo(file, setUpProgress));
      setJob(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function render() {
    setError("");
    const mask = editor.current?.getMask();
    if (!mask) return setError("Mark the watermark first (box, brush or auto-detect).");
    try {
      const { job_id } = await startJob({ video_id: video.video_id, algorithm: algo, mask, dilate });
      setJob({ id: job_id, status: "queued", done: 0, total: video.frames });
    } catch (e) {
      setError(e.message);
    }
  }

  const running = job && ["queued", "processing"].includes(job.status);
  const pct = job && job.total ? Math.min(100, (job.done / job.total) * 100) : 0;

  return (
    <>
    <header className="border-b border-line bg-cream">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <a href="#/" className="font-display text-xl font-semibold">Clearframe</a>
          <AppNav current="#/studio" />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-semibold">Watermark Remover</h1>
      <p className="mb-5 mt-1 text-ink/65">Mark the logo and let inpainting rebuild the background.</p>
      <div role="tablist" aria-label="Media type" className="mb-8 inline-flex rounded-full border border-line bg-cream p-1">
        {[["video", "Video"], ["image", "Image"]].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={mode === id} onClick={() => { setMode(id); setError(""); }}
            className={`rounded-full px-5 py-1.5 text-sm ${mode === id ? "bg-ink text-paper" : "text-ink/65 hover:text-ink"}`}>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {mode === "image" ? (
        <ImageRemover />
      ) : !video ? (
        <UploadZone onFile={onFile} progress={upProgress} busy={uploading} />
      ) : (
        <div className="space-y-8">
          <section className="card">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-medium">1. Original</h2>
              <button onClick={() => { setVideo(null); setJob(null); }} className="text-sm text-ink/65 hover:text-ink">
                Choose another video
              </button>
            </div>
            <video src={previewUrl(video.video_id)} controls className="max-h-80 w-full rounded-xl bg-black" />
            <p className="mt-1 text-xs text-ink/50">
              {video.filename} · {video.width}x{video.height} · {video.fps.toFixed(1)} fps · {video.frames} frames
            </p>
          </section>

          <section className="card">
            <h2 className="mb-2 text-lg font-medium">2. Select the watermark</h2>
            <MaskEditor ref={editor} videoId={video.video_id} duration={video.duration} />
          </section>

          <section className="card">
            <h2 className="mb-2 text-lg font-medium">3. Remove</h2>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm text-ink/65">
                Algorithm
                <select
                  value={algo}
                  onChange={(e) => setAlgo(e.target.value)}
                  disabled={running}
                  className="mt-1 block rounded-lg border border-line bg-white px-3 py-2 text-ink"
                >
                  {algorithms.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.available}>
                      {a.label}
                      {a.available ? "" : " (not installed)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-ink/65">
                Mask expand ({dilate}px)
                <input type="range" min="0" max="15" value={dilate} onChange={(e) => setDilate(+e.target.value)} disabled={running} className="mt-3 block" />
              </label>
              {running ? (
                <button onClick={() => cancelJob(job.id)} className="rounded-lg bg-rose-800 text-white px-5 py-2 font-medium hover:bg-rose-700">
                  Cancel
                </button>
              ) : (
                <button onClick={render} className="rounded-lg bg-ink text-paper px-5 py-2 font-medium hover:bg-ink/85">
                  Remove watermark
                </button>
              )}
            </div>
            {(() => {
              const cur = algorithms.find((a) => a.id === algo);
              if (!cur) return null;
              if (!cur.available) return <p className="mt-2 text-xs text-amber-700">{cur.hint}</p>;
              return cur.note ? <p className="mt-2 text-xs text-ink/65">{cur.note}</p> : null;
            })()}

            {job && (
              <div className="mt-6" aria-live="polite">
                <div className="h-3 overflow-hidden rounded bg-ink/10">
                  <div className="h-full bg-sage transition-all" style={{ width: `${job.status === "done" ? 100 : pct}%` }} />
                </div>
                <p className="mt-2 text-sm text-ink/65">
                  {job.status === "queued" && "Queued..."}
                  {job.status === "processing" && `Frame ${job.done} / ${job.total} (${pct.toFixed(0)}%)`}
                  {job.status === "done" && "Done"}
                  {job.status === "cancelled" && "Cancelled"}
                  {job.status === "error" && <span className="text-rose-700">Failed: {job.error}</span>}
                </p>
              </div>
            )}
          </section>

          {job?.status === "done" && (
            <section className="card">
              <h2 className="mb-2 text-lg font-medium">4. Result</h2>
              <ResultView videoId={video.video_id} jobId={job.id} />
            </section>
          )}

          <section className="card">
            <h2 className="mb-2 text-lg font-medium">{job?.status === "done" ? "5." : "4."} YouTube Short (optional)</h2>
            <ShortPanel key={video.video_id} video={video} cleanedJobId={job?.status === "done" ? job.id : null} />
          </section>
        </div>
      )}
    </main>
    </>
  );
}
