import { useRef, useState } from "react";
import { transcodeExport } from "../../api";
import { exportStill, exportVideo, outputSize } from "../engine/exporter";
import { projectDuration } from "../engine/timeline";
import { useEditor } from "../store/useEditor";

const QUALITY = [["720p", 720], ["1080p (Full HD)", 1080], ["4K (heavy)", 2160]];
const FORMATS = [
  ["mp4", "MP4 (H.264)"],
  ["mov", "MOV (H.264)"],
  ["webm", "WebM (no server step)"],
  ["png", "Image: PNG (current frame)"],
  ["jpg", "Image: JPG (current frame)"],
];

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export default function ExportModal({ onClose, notify }) {
  const [quality, setQuality] = useState(1080);
  const [fmt, setFmt] = useState("mp4");
  const [fps, setFps] = useState(30);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const abort = useRef(null);
  const busy = !!stage;
  const isImage = fmt === "png" || fmt === "jpg";

  async function start() {
    const state = useEditor.getState();
    const { width, height } = outputSize(state.project, quality);
    abort.current = new AbortController();
    try {
      if (isImage) {
        setStage("Rendering frame");
        const blob = await exportStill({
          state, time: state.time, width, height,
          type: fmt === "png" ? "image/png" : "image/jpeg",
        });
        download(blob, `frame.${fmt}`);
      } else {
        if (projectDuration(state.clips) <= 0) throw new Error("The timeline is empty");
        setStage("Rendering (keep this tab visible)");
        const { blob } = await exportVideo({
          state, width, height, fps, signal: abort.current.signal, onProgress: setProgress,
        });
        if (fmt === "webm") {
          download(blob, "export.webm");
        } else {
          setStage("Encoding H.264 on the server");
          setProgress(1);
          try {
            download(await transcodeExport(blob, { fmt, fps }), `export.${fmt}`);
          } catch (e) {
            download(blob, "export.webm");
            notify(`Server encode failed (${e.message}). Saved the WebM recording instead.`, "error");
          }
        }
      }
      notify("Export finished", "ok");
      onClose();
    } catch (e) {
      if (e.name !== "AbortError") notify(e.message, "error");
    } finally {
      setStage("");
      setProgress(0);
    }
  }

  const sel = "mt-1 block w-full rounded-md border border-ed-line bg-ed-bg px-2 py-2 text-sm text-ed-text";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Export">
      <div className="w-full max-w-md rounded-xl border border-ed-line bg-ed-panel p-6 text-ed-text shadow-2xl">
        <h2 className="mb-4 text-xl">Export</h2>
        <div className="grid grid-cols-2 gap-4">
          <label className="col-span-2 text-xs text-ed-mute">Format
            <select className={sel} value={fmt} disabled={busy} onChange={(e) => setFmt(e.target.value)}>
              {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-ed-mute">Resolution
            <select className={sel} value={quality} disabled={busy} onChange={(e) => setQuality(+e.target.value)}>
              {QUALITY.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {!isImage && (
            <label className="text-xs text-ed-mute">Frame rate
              <select className={sel} value={fps} disabled={busy} onChange={(e) => setFps(+e.target.value)}>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </label>
          )}
        </div>
        {!isImage && (
          <p className="mt-3 text-xs text-ed-mute">
            Video renders in real time in your browser, so a 1-minute project takes about a minute. Keep this tab in the foreground.
          </p>
        )}

        {busy && (
          <div className="mt-4" aria-live="polite">
            <div className="h-2 overflow-hidden rounded bg-ed-raise">
              <div className="h-full bg-gold transition-all" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="mt-2 text-xs text-ed-mute">{stage}</p>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={() => (busy ? abort.current?.abort() : onClose())}
            className="rounded-md px-4 py-2 text-sm text-ed-mute hover:text-ed-text"
          >
            {busy ? "Cancel" : "Close"}
          </button>
          {!busy && (
            <button onClick={start} className="rounded-md bg-gold px-5 py-2 text-sm font-semibold text-ed-bg hover:brightness-110">
              Export
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
