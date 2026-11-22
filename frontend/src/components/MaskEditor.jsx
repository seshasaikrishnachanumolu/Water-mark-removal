import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { detectWatermark, frameUrl } from "../api";

/**
 * Lets the user mark the watermark on a still frame.
 *  - Box tool: drag a rectangle (committed into the mask on release)
 *  - Brush / Eraser: freehand painting
 *  - Auto-detect: asks the backend for a corner logo and fills its box
 * The mask lives in an offscreen-sized canvas at the frame's resolution; painted
 * pixels are exported as PNG alpha, which the backend scales to the video size.
 */
const MaskEditor = forwardRef(function MaskEditor({ videoId, duration, imageSrc }, ref) {
  const maskRef = useRef(null); // persistent mask (red, shown at 50% opacity)
  const draftRef = useRef(null); // transient box preview
  const drag = useRef(null);
  const [tool, setTool] = useState("box");
  const [brush, setBrush] = useState(24);
  const [time, setTime] = useState(0);
  const [frameT, setFrameT] = useState(0);
  const [dims, setDims] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [note, setNote] = useState("");

  // Debounce slider -> frame fetch.
  useEffect(() => {
    const id = setTimeout(() => setFrameT(time), 200);
    return () => clearTimeout(id);
  }, [time]);

  function onImgLoad(e) {
    const { naturalWidth: w, naturalHeight: h } = e.target;
    if (!dims || dims.w !== w || dims.h !== h) {
      setDims({ w, h });
      for (const c of [maskRef.current, draftRef.current]) {
        c.width = w;
        c.height = h;
      }
    }
  }

  const toLocal = (e) => {
    const c = draftRef.current;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };

  function stroke(from, to) {
    const ctx = maskRef.current.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = "#ff2d2d";
    ctx.lineWidth = brush * (maskRef.current.width / 1280);
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  function down(e) {
    if (!dims) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toLocal(e);
    drag.current = { start: p, last: p };
    if (tool !== "box") stroke(p, p);
  }

  function move(e) {
    if (!drag.current) return;
    const p = toLocal(e);
    if (tool === "box") {
      const ctx = draftRef.current.getContext("2d");
      const { start } = drag.current;
      ctx.clearRect(0, 0, dims.w, dims.h);
      ctx.fillStyle = "rgba(255,45,45,1)";
      ctx.fillRect(start.x, start.y, p.x - start.x, p.y - start.y);
    } else {
      stroke(drag.current.last, p);
    }
    drag.current.last = p;
  }

  function up() {
    if (!drag.current) return;
    if (tool === "box") {
      const { start, last } = drag.current;
      const ctx = maskRef.current.getContext("2d");
      ctx.fillStyle = "#ff2d2d";
      ctx.fillRect(start.x, start.y, last.x - start.x, last.y - start.y);
      draftRef.current.getContext("2d").clearRect(0, 0, dims.w, dims.h);
    }
    drag.current = null;
  }

  function clear() {
    maskRef.current?.getContext("2d").clearRect(0, 0, dims.w, dims.h);
    setNote("");
  }

  async function autoDetect() {
    setDetecting(true);
    setNote("");
    try {
      const { found, box } = await detectWatermark(videoId);
      if (!found) return setNote("No static logo found. Draw the area manually.");
      const ctx = maskRef.current.getContext("2d");
      ctx.fillStyle = "#ff2d2d";
      ctx.fillRect(box.x * dims.w, box.y * dims.h, box.w * dims.w, box.h * dims.h);
      setNote("Logo detected. Adjust with the brush or eraser if needed.");
    } catch (err) {
      setNote(err.message);
    } finally {
      setDetecting(false);
    }
  }

  useImperativeHandle(ref, () => ({
    /** PNG data URL of the mask, or null when nothing is painted. */
    getMask() {
      const c = maskRef.current;
      if (!c || !dims) return null;
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return c.toDataURL("image/png");
      return null;
    },
  }));

  const btn = (id, label) => (
    <button
      key={id}
      onClick={() => setTool(id)}
      className={`rounded-lg px-3 py-1.5 text-sm ${
        tool === id ? "bg-ink text-paper" : "bg-ink/10 text-ink/70 hover:bg-ink/15"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {btn("box", "Box")}
        {btn("brush", "Brush")}
        {btn("erase", "Eraser")}
        {tool !== "box" && (
          <label className="flex items-center gap-2 text-sm text-ink/65">
            Size
            <input type="range" min="4" max="120" value={brush} onChange={(e) => setBrush(+e.target.value)} />
          </label>
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        {!imageSrc && <button onClick={autoDetect} disabled={detecting} className="rounded-lg bg-sage text-white px-3 py-1.5 text-sm hover:bg-sage/90 disabled:opacity-50">
          {detecting ? "Detecting..." : "Auto-detect logo"}
        </button>}
        <button onClick={clear} className="rounded-lg bg-ink/10 px-3 py-1.5 text-sm hover:bg-ink/15">
          Clear
        </button>
      </div>
      {note && <p className="mb-2 text-sm text-amber-700">{note}</p>}

      <div className="relative w-full select-none overflow-hidden rounded-xl bg-black">
        <img src={imageSrc || frameUrl(videoId, frameT)} onLoad={onImgLoad} alt={imageSrc ? "Image" : "Video frame"} className="block w-full" draggable={false} />
        <canvas ref={maskRef} className="pointer-events-none absolute inset-0 h-full w-full opacity-50" />
        <canvas
          ref={draftRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="absolute inset-0 h-full w-full cursor-crosshair opacity-50 touch-none"
        />
      </div>

      {!imageSrc && <label className="mt-3 flex items-center gap-3 text-sm text-ink/65">
        Frame
        <input
          type="range"
          min="0"
          max={Math.max(duration - 0.1, 0)}
          step="0.1"
          value={time}
          onChange={(e) => setTime(+e.target.value)}
          className="flex-1"
        />
        {time.toFixed(1)}s
      </label>}
    </div>
  );
});

export default MaskEditor;
