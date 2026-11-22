import { useEffect, useRef } from "react";
import { hitTest, renderFrame, selectionGeometry } from "../engine/compositor";
import { MediaPool, syncMedia } from "../engine/mediaPool";
import { fmtTime, projectDuration } from "../engine/timeline";
import { useEditor } from "../store/useEditor";

const PREVIEW_MAX_W = 960;

/** Canvas preview + transport. Owns the playback clock and the render loop. */
export default function Preview() {
  const canvasRef = useRef(null);
  const poolRef = useRef(null);
  const drag = useRef(null);
  const guides = useRef(null); // {x, y}: show centre guide lines while snapped
  const project = useEditor((s) => s.project);
  const playing = useEditor((s) => s.playing);

  // Preview resolution is independent of the project size (everything is drawn in
  // relative units), so small clips still get a comfortably large preview.
  const W = Math.min(PREVIEW_MAX_W, Math.max(project.width, 720));
  const H = Math.round((W * project.height) / project.width);

  useEffect(() => {
    poolRef.current = new MediaPool();
    const ctx = canvasRef.current.getContext("2d");
    let raf;
    let last = performance.now();

    // The loop reads the store directly (getState) so playback never triggers React renders.
    const tick = (now) => {
      const s = useEditor.getState();
      let t = s.time;
      if (s.playing) {
        t += (now - last) / 1000;
        const end = projectDuration(s.clips);
        if (t >= end) {
          t = Math.max(0, end);
          s.setPlaying(false);
        }
        s.setTime(t);
      }
      last = now;
      poolRef.current.prune(s.clips);
      syncMedia(poolRef.current, s, t, useEditor.getState().playing);
      renderFrame(ctx, canvasRef.current.width, canvasRef.current.height, s, t, poolRef.current, {
        selection: s.selection,
        guides: guides.current,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      poolRef.current.dispose();
    };
  }, []);

  // Canvas pixel coords from a pointer event.
  const toCanvas = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvasRef.current.width) / r.width, y: ((e.clientY - r.top) * canvasRef.current.height) / r.height };
  };

  const SNAP = 0.012; // snap to the canvas centre within 1.2% of the canvas
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** Which handle (if any) is under canvas point p for the selected layer. */
  function handleAt(p) {
    const s = useEditor.getState();
    const c = canvasRef.current;
    if (!s.selection) return null;
    const g = selectionGeometry(c.getContext("2d"), c.width, c.height, s, s.time, poolRef.current, s.selection);
    if (!g) return null;
    const r = 12 * g.u;
    if (dist(p, g.knob) <= r) return { kind: "rotate", g };
    const i = g.corners.findIndex((k) => dist(p, k) <= r);
    return i >= 0 ? { kind: "scale", g, i } : null;
  }

  function down(e) {
    const s = useEditor.getState();
    const p = toCanvas(e);
    const c = canvasRef.current;
    const h = handleAt(p);
    if (h) {
      s.checkpoint();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { mode: h.kind, id: h.g.id, g: h.g, i: h.i, d0: dist({ x: h.g.cx, y: h.g.cy }, h.g.corners[h.i ?? 0]) };
      return;
    }
    const id = hitTest(c.getContext("2d"), c.width, c.height, s, s.time, poolRef.current, p.x, p.y);
    s.select(id);
    if (!id) return;
    s.checkpoint();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pr = s.clips[id].props;
    drag.current = { mode: "move", id, x: p.x, y: p.y, ox: pr.x, oy: pr.y };
  }

  function move(e) {
    const p = toCanvas(e);
    const c = canvasRef.current;
    const d = drag.current;
    const st = useEditor.getState();
    if (!d) {
      // Hover feedback: show what a drag would do.
      const h = handleAt(p);
      c.style.cursor = h ? (h.kind === "rotate" ? "grab" : "nwse-resize") : "default";
      return;
    }
    if (d.mode === "rotate") {
      let deg = (Math.atan2(p.y - d.g.cy, p.x - d.g.cx) * 180) / Math.PI + 90;
      deg = ((deg + 540) % 360) - 180; // -180..180
      const snapped = Math.round(deg / 45) * 45;
      if (Math.abs(deg - snapped) < 4) deg = snapped; // stick to 0/45/90...
      st.updateProps(d.id, { rotation: Math.round(deg * 10) / 10 });
    } else if (d.mode === "scale") {
      const next = d.g.scale * (dist(p, { x: d.g.cx, y: d.g.cy }) / d.d0);
      st.updateProps(d.id, { scale: Math.max(0.05, Math.min(8, Math.round(next * 100) / 100)) });
    } else {
      let nx = d.ox + (p.x - d.x) / c.width;
      let ny = d.oy + (p.y - d.y) / c.height;
      const gx = Math.abs(nx - 0.5) < SNAP, gy = Math.abs(ny - 0.5) < SNAP;
      if (gx) nx = 0.5;
      if (gy) ny = 0.5;
      guides.current = gx || gy ? { x: gx, y: gy } : null;
      st.updateProps(d.id, { x: nx, y: ny });
    }
  }

  function up() {
    drag.current = null;
    guides.current = null;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-ed-bg p-4">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label="Video preview. Click a layer to select it, drag to move it."
          className="max-h-full max-w-full touch-none rounded-sm bg-black shadow-2xl ring-1 ring-ed-line"
          style={{ aspectRatio: `${project.width} / ${project.height}` }}
        />
      </div>
      <Transport playing={playing} />
    </div>
  );
}

function Clock() {
  const time = useEditor((s) => s.time);
  const total = useEditor((s) => projectDuration(s.clips));
  return (
    <span className="font-mono text-xs tabular-nums text-ed-mute">
      <span className="text-ed-text">{fmtTime(time)}</span> / {fmtTime(total)}
    </span>
  );
}

function Transport({ playing }) {
  const setPlaying = useEditor((s) => s.setPlaying);
  const setTime = useEditor((s) => s.setTime);
  return (
    <div className="flex items-center justify-center gap-3 border-t border-ed-line bg-ed-panel py-2">
      <button onClick={() => setTime(0)} className="rounded px-2 py-1 text-ed-mute hover:text-ed-text" aria-label="Go to start" title="Go to start">⏮</button>
      <button
        onClick={() => {
          const s = useEditor.getState();
          if (!s.playing && s.time >= projectDuration(s.clips) - 0.05) s.setTime(0);
          setPlaying(!playing);
        }}
        className="grid h-9 w-9 place-items-center rounded-full bg-gold text-ed-bg hover:brightness-110"
        aria-label={playing ? "Pause" : "Play"}
        title="Play / pause (Space)"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <Clock />
    </div>
  );
}
