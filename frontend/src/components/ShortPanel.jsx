import { useEffect, useState } from "react";
import { cancelJob, getJob, resultUrl, startShort } from "../api";

/** Convert to a 1080x1920 YouTube Short (max 180s, H.264 MP4). */
export default function ShortPanel({ video, cleanedJobId }) {
  const [layout, setLayout] = useState("blur");
  const [fps, setFps] = useState(30);
  const [useCleaned, setUseCleaned] = useState(true);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");

  const running = job && ["queued", "processing"].includes(job.status);
  const pct = job ? Math.min(100, (job.done / job.total) * 100) : 0;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => getJob(job.id).then(setJob).catch((e) => setError(e.message)), 500);
    return () => clearInterval(t);
  }, [job, running]);

  async function convert() {
    setError("");
    try {
      const { job_id } = await startShort({
        video_id: video.video_id,
        layout,
        fps,
        source_job_id: cleanedJobId && useCleaned ? cleanedJobId : null,
      });
      setJob({ id: job_id, status: "queued", done: 0, total: 1000 });
    } catch (e) {
      setError(e.message);
    }
  }

  const option = (value, title, desc) => (
    <label
      className={`flex-1 cursor-pointer rounded-xl border p-3 text-sm ${
        layout === value ? "border-gold bg-gold/10" : "border-line hover:border-gold"
      }`}
    >
      <input type="radio" name="layout" className="sr-only" checked={layout === value} onChange={() => setLayout(value)} />
      <span className="block font-medium">{title}</span>
      <span className="text-ink/65">{desc}</span>
    </label>
  );

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        {option("crop", "Center Crop (fill screen)", "Scales to 1920px tall and trims the left and right edges.")}
        {option("blur", "Fit with blurred background", "Whole video at 1080px wide over a blurred copy. No crop.")}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-sm text-ink/65">
          Frame rate
          <select
            value={fps}
            onChange={(e) => setFps(+e.target.value)}
            className="mt-1 block rounded-lg border border-line bg-white px-3 py-2 text-ink"
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>
        {cleanedJobId && (
          <label className="flex items-center gap-2 pb-2 text-sm text-ink/65">
            <input type="checkbox" checked={useCleaned} onChange={(e) => setUseCleaned(e.target.checked)} />
            Use the watermark-free video
          </label>
        )}
        {running ? (
          <button onClick={() => cancelJob(job.id)} className="rounded-lg bg-rose-800 text-white px-5 py-2 font-medium hover:bg-rose-700">
            Cancel
          </button>
        ) : (
          <button onClick={convert} className="rounded-lg bg-ink text-paper px-5 py-2 font-medium hover:bg-ink/85">
            Convert to YouTube Short
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-ink/50">Output: 1080x1920, H.264 MP4, trimmed to 180 seconds if longer.</p>

      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}

      {job && (
        <div className="mt-4" aria-live="polite">
          <div className="h-3 overflow-hidden rounded bg-ink/10">
            <div className="h-full bg-sage transition-all" style={{ width: `${job.status === "done" ? 100 : pct}%` }} />
          </div>
          <p className="mt-2 text-sm text-ink/65">
            {job.status === "queued" && "Queued..."}
            {job.status === "processing" && `Encoding ${pct.toFixed(0)}%`}
            {job.status === "done" && "Done"}
            {job.status === "cancelled" && "Cancelled"}
            {job.status === "error" && <span className="text-rose-700">Failed: {job.error}</span>}
          </p>
        </div>
      )}

      {job?.status === "done" && (
        <div className="mt-4 flex flex-col items-start gap-3">
          <video src={resultUrl(job.id)} controls className="max-h-[32rem] rounded-xl bg-black" />
          <a href={resultUrl(job.id, true)} className="rounded-lg bg-ink text-paper px-5 py-2 font-medium hover:bg-ink/85">
            Download Short
          </a>
        </div>
      )}
    </div>
  );
}
