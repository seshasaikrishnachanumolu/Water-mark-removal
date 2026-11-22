import { useEffect, useRef, useState } from "react";
import { getAlgorithms, removeImageWatermark } from "../api";
import { stageHandoff } from "../editor/engine/project";
import MaskEditor from "./MaskEditor";

const OK = [".png", ".jpg", ".jpeg", ".webp"];
const MAX = 25 * 1024 * 1024;

/** Still-image watermark removal: same mask editor and engines as the video flow. */
export default function ImageRemover() {
  const editor = useRef(null);
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [src, setSrc] = useState("");
  const [algorithms, setAlgorithms] = useState([]);
  const [algo, setAlgo] = useState("telea");
  const [dilate, setDilate] = useState(3);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {url, name}
  const [error, setError] = useState("");

  useEffect(() => {
    getAlgorithms().then((a) => setAlgorithms(a.filter((x) => x.id !== "propainter"))).catch(() => {});
  }, []);
  // Free object URLs when they're replaced / on unmount.
  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);
  // (The result URL is deliberately not revoked on unmount: the Studio Editor handoff reads it right after navigation.)

  function pick(f) {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!OK.includes(ext)) return setError("Please choose a PNG, JPG or WebP image.");
    if (f.size > MAX) return setError("Image is larger than 25MB.");
    setError("");
    setResult(null);
    setFile(f);
    setSrc(URL.createObjectURL(f));
  }

  async function run() {
    setError("");
    const mask = editor.current?.getMask();
    if (!mask) return setError("Mark the watermark first (box or brush).");
    setBusy(true);
    try {
      const blob = await removeImageWatermark(file, mask, algo, dilate);
      const dot = file.name.lastIndexOf(".");
      setResult({ url: URL.createObjectURL(blob), name: `${file.name.slice(0, dot)}-clean${file.name.slice(dot)}`, blob });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!file) {
    return (
      <div>
        <div
          role="button" tabIndex={0}
          onClick={() => input.current.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-ink/25 p-14 text-center transition hover:border-gold"
        >
          <p className="text-lg font-medium">Drop an image here or click to browse</p>
          <p className="mt-1 text-sm text-ink/65">PNG, JPG or WebP, up to 25MB</p>
          <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp,image/*" className="hidden" onChange={(e) => pick(e.target.files[0])} />
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">1. Select the watermark</h2>
          <button onClick={() => { setFile(null); setResult(null); }} className="text-sm text-ink/65 hover:text-ink">
            Choose another image
          </button>
        </div>
        <MaskEditor key={src} ref={editor} imageSrc={src} />
      </section>

      <section className="card">
        <h2 className="mb-2 text-lg font-medium">2. Remove</h2>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm text-ink/65">
            Algorithm
            <select value={algo} onChange={(e) => setAlgo(e.target.value)} disabled={busy}
              className="mt-1 block rounded-lg border border-line bg-white px-3 py-2 text-ink">
              {algorithms.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available}>
                  {a.label}{a.available ? "" : " (not installed)"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-ink/65">
            Mask expand ({dilate}px)
            <input type="range" min="0" max="15" value={dilate} onChange={(e) => setDilate(+e.target.value)} disabled={busy} className="mt-3 block" />
          </label>
          <button onClick={run} disabled={busy} className="rounded-lg bg-ink px-5 py-2 font-medium text-paper hover:bg-ink/85 disabled:opacity-50">
            {busy ? "Working..." : "Remove watermark"}
          </button>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
      </section>

      {result && (
        <section className="card">
          <h2 className="mb-2 text-lg font-medium">3. Result</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <figure>
              <img src={src} alt="Original" className="w-full rounded-xl bg-black" />
              <figcaption className="mt-1 text-center text-sm text-ink/65">Original</figcaption>
            </figure>
            <figure>
              <img src={result.url} alt="Cleaned" className="w-full rounded-xl bg-black" />
              <figcaption className="mt-1 text-center text-sm text-ink/65">Cleaned</figcaption>
            </figure>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <a href={result.url} download={result.name} className="rounded-lg bg-ink px-4 py-2 font-medium text-paper hover:bg-ink/85">
              Download image
            </a>
            <button onClick={() => stageHandoff(result.url, result.name, "image")}
              className="rounded-lg border border-gold px-4 py-2 font-medium text-gold hover:bg-gold/10">
              Open in Studio Editor
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
