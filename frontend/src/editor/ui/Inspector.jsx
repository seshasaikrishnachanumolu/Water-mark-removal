import { useEditor } from "../store/useEditor";
import { ANIM_TYPES } from "../engine/timeline";
import { FILTER_PRESETS, FONTS, SHAPES, SHAPE_COLORS, SPEED_PRESETS } from "../presets";

function Slider({ label, value, min, max, step = 0.01, onChange, fmt }) {
  const checkpoint = useEditor((s) => s.checkpoint);
  return (
    <label className="mb-3 block text-xs text-ed-mute">
      <span className="flex justify-between">
        {label}
        <span className="tabular-nums text-ed-text">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onPointerDown={checkpoint}
        onChange={(e) => onChange(+e.target.value)}
        className="mt-1 w-full accent-gold"
      />
    </label>
  );
}

function Section({ title, children }) {
  return (
    <section className="border-b border-ed-line px-4 py-3">
      <h3 className="mb-3 font-sans text-[11px] font-semibold uppercase tracking-wider text-ed-mute">{title}</h3>
      {children}
    </section>
  );
}

function SpeedCurve({ clip }) {
  const { setSpeedCurve, checkpoint } = useEditor.getState();
  const W = 240, H = 90, MAX = 4;
  const pts = clip.curve;
  const x = (t) => 6 + t * (W - 12);
  const y = (v) => H - 8 - (Math.min(v, MAX) / MAX) * (H - 16);

  function drag(e, i) {
    e.preventDefault();
    checkpoint();
    const svg = e.currentTarget.ownerSVGElement;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const v = ((H - 8 - ((ev.clientY - r.top) / r.height) * H) / (H - 16)) * MAX;
      const next = pts.map((p, j) => (j === i ? { ...p, v: Math.max(0.25, Math.min(MAX, v)) } : p));
      useEditor.getState().setSpeedCurve(clip.id, next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="mb-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md bg-ed-bg" role="img" aria-label="Speed curve. Drag the points up or down.">
        <line x1="6" x2={W - 6} y1={y(1)} y2={y(1)} stroke="#2a3242" strokeDasharray="3 3" />
        <polyline fill="none" stroke="#b08a3e" strokeWidth="2" points={pts.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")} />
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r="6" fill="#e8eaf0" stroke="#b08a3e" strokeWidth="2"
            className="cursor-ns-resize" onPointerDown={(e) => drag(e, i)}>
            <title>{p.v.toFixed(2)}x</title>
          </circle>
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-ed-mute">Drag points up (faster) or down (slower). Dashed line = 1x.</p>
      <button className={btn} onClick={() => { checkpoint(); setSpeedCurve(clip.id, null); }}>Back to constant speed</button>
    </div>
  );
}

const btn = "rounded-md bg-ed-raise px-3 py-1.5 text-xs text-ed-text hover:bg-ed-line";

export default function Inspector() {
  const id = useEditor((s) => s.selection);
  const clip = useEditor((s) => s.clips[id]);
  const { updateProps, updateClip, setSpeed, checkpoint, splitAtPlayhead, duplicateClip, deleteClip } = useEditor.getState();

  if (!clip) {
    return (
      <div className="p-4 text-sm text-ed-mute">
        <p className="mb-2 font-medium text-ed-text">Inspector</p>
        Select a clip on the timeline or click a layer in the preview to edit its properties.
      </div>
    );
  }

  const p = clip.props;
  const set = (patch) => updateProps(id, patch);
  const visual = clip.kind !== "audio";
  const media = clip.kind === "video" || clip.kind === "audio";
  const pct = (v) => `${Math.round(v * 100)}%`;

  return (
    <div className="text-ed-text">
      <div className="flex flex-wrap gap-2 border-b border-ed-line px-4 py-3">
        <button className={btn} onClick={splitAtPlayhead} title="Split at playhead (S)">Split</button>
        <button className={btn} onClick={() => duplicateClip(id)} title="Duplicate (Ctrl+D)">Duplicate</button>
        <button className={btn} onClick={() => useEditor.getState().copyClip()} title="Copy (Ctrl+C), paste with Ctrl+V">Copy</button>
        <button className={`${btn} !text-rose-300`} onClick={() => deleteClip(id)} title="Delete (Del)">Delete</button>
      </div>

      {clip.kind === "text" && (
        <Section title="Text">
          <textarea
            value={p.text} rows={3}
            onFocus={checkpoint}
            onChange={(e) => set({ text: e.target.value })}
            className="mb-3 w-full rounded-md border border-ed-line bg-ed-bg p-2 text-sm"
            aria-label="Text content"
          />
          <label className="mb-3 block text-xs text-ed-mute">Font
            <select value={p.font} onChange={(e) => { checkpoint(); set({ font: e.target.value }); }}
              className="mt-1 block w-full rounded-md border border-ed-line bg-ed-bg px-2 py-1.5 text-ed-text" style={{ fontFamily: p.font }}>
              {!FONTS.some(([, v]) => v === p.font) && <option value={p.font}>Custom</option>}
              {FONTS.map(([n, v]) => <option key={n} value={v} style={{ fontFamily: v }}>{n}</option>)}
            </select>
          </label>
          <div className="mb-3 flex gap-2">
            <button className={`${btn} ${p.weight >= 700 ? "!bg-gold !text-ed-bg" : ""}`} aria-pressed={p.weight >= 700}
              onClick={() => { checkpoint(); set({ weight: p.weight >= 700 ? 400 : 700 }); }}><b>B</b></button>
          </div>
          <Slider label="Size" value={p.fontSize} min={0.02} max={0.3} onChange={(v) => set({ fontSize: v })} fmt={pct} />
          <div className="mb-3 flex items-center gap-3 text-xs text-ed-mute">
            <label className="flex items-center gap-2">Color
              <input type="color" value={p.color} onChange={(e) => set({ color: e.target.value })} aria-label="Text color" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!p.bg} onChange={(e) => { checkpoint(); set({ bg: e.target.checked ? "rgba(0,0,0,0.62)" : null }); }} />
              Background
            </label>
          </div>
          <Slider label="Outline" value={p.strokeWidth} min={0} max={0.3} onChange={(v) => set({ strokeWidth: v })} fmt={pct} />
        </Section>
      )}

      {clip.kind === "shape" && (
        <Section title="Shape">
          <div className="mb-3 flex flex-wrap gap-2">
            {SHAPES.map((s) => (
              <button key={s} onClick={() => { checkpoint(); set({ shape: s }); }}
                className={`${btn} ${p.shape === s ? "!bg-gold !text-ed-bg" : ""}`}>{s}</button>
            ))}
          </div>
          <div className="flex gap-2">
            {SHAPE_COLORS.map((c) => (
              <button key={c} onClick={() => { checkpoint(); set({ fill: c }); }} aria-label={`Fill ${c}`}
                className={`h-6 w-6 rounded-full ring-2 ${p.fill === c ? "ring-gold" : "ring-transparent"}`} style={{ background: c }} />
            ))}
          </div>
        </Section>
      )}

      {visual && (
        <Section title="Layer order">
          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={() => useEditor.getState().arrange(id, "front")}>Bring to front</button>
            <button className={btn} onClick={() => useEditor.getState().arrange(id, "up")}>Forward</button>
            <button className={btn} onClick={() => useEditor.getState().arrange(id, "down")}>Backward</button>
            <button className={btn} onClick={() => useEditor.getState().arrange(id, "back")}>Send to back</button>
          </div>
          <p className="mt-2 text-[11px] text-ed-mute">Orders layers within a track. Upper tracks always sit above lower ones.</p>
        </Section>
      )}

      {visual && (
        <Section title="Transform">
          <Slider label="Scale" value={p.scale} min={0.1} max={4} onChange={(v) => set({ scale: v })} fmt={pct} />
          <Slider label="Rotation" value={p.rotation} min={-180} max={180} step={1} onChange={(v) => set({ rotation: v })} fmt={(v) => `${v}Â°`} />
          <Slider label="Opacity" value={p.opacity} min={0} max={1} onChange={(v) => set({ opacity: v })} fmt={pct} />
          <div className="grid grid-cols-2 gap-x-3">
            <Slider label="Position X" value={p.x} min={-0.2} max={1.2} onChange={(v) => set({ x: v })} fmt={pct} />
            <Slider label="Position Y" value={p.y} min={-0.2} max={1.2} onChange={(v) => set({ y: v })} fmt={pct} />
          </div>
          <label className="block text-xs text-ed-mute">Mask
            <select value={p.mask} onChange={(e) => { checkpoint(); set({ mask: e.target.value }); }}
              className="mt-1 block w-full rounded-md border border-ed-line bg-ed-bg px-2 py-1.5 text-ed-text">
              <option value="none">None</option>
              <option value="circle">Circle</option>
              <option value="rounded">Rounded rectangle</option>
            </select>
          </label>
        </Section>
      )}

      {(clip.kind === "video" || clip.kind === "image") && (
        <>
          <Section title="Crop">
            {["l", "r", "t", "b"].map((k) => (
              <Slider key={k} label={{ l: "Left", r: "Right", t: "Top", b: "Bottom" }[k]} value={p.crop[k]} min={0} max={0.45}
                onChange={(v) => set({ crop: { ...p.crop, [k]: v } })} fmt={pct} />
            ))}
          </Section>
          <Section title="Filters">
            <div className="grid grid-cols-4 gap-2">
              {FILTER_PRESETS.map((f) => (
                <button key={f.label} className={btn} onClick={() => { checkpoint(); set(f.v); }}>{f.label}</button>
              ))}
            </div>
          </Section>
          <Section title="Color grading">
            <Slider label="Brightness" value={p.brightness} min={0.2} max={2} onChange={(v) => set({ brightness: v })} />
            <Slider label="Contrast" value={p.contrast} min={0.2} max={2} onChange={(v) => set({ contrast: v })} />
            <Slider label="Saturation" value={p.saturation} min={0} max={3} onChange={(v) => set({ saturation: v })} />
            <Slider label="Warmth (sepia)" value={p.sepia ?? 0} min={0} max={1} onChange={(v) => set({ sepia: v })} fmt={pct} />
            <Slider label="Hue shift" value={p.hue ?? 0} min={-180} max={180} step={1} onChange={(v) => set({ hue: v })} fmt={(v) => `${v}°`} />
            <Slider label="Black and white" value={p.grayscale ?? 0} min={0} max={1} onChange={(v) => set({ grayscale: v })} fmt={pct} />
            <Slider label="Blur" value={p.blur} min={0} max={20} step={0.5} onChange={(v) => set({ blur: v })} fmt={(v) => `${v}px`} />
            <button className={btn} onClick={() => { checkpoint(); set({ ...FILTER_PRESETS[0].v, blur: 0 }); }}>Reset</button>
          </Section>
          <Section title="Green screen (chroma key)">
            <label className="mb-3 flex items-center gap-2 text-xs text-ed-mute">
              <input type="checkbox" checked={p.chroma.on} onChange={(e) => { checkpoint(); set({ chroma: { ...p.chroma, on: e.target.checked } }); }} />
              Remove key color
              <input type="color" value={p.chroma.color} onChange={(e) => set({ chroma: { ...p.chroma, color: e.target.value } })} aria-label="Key color" />
            </label>
            <Slider label="Tolerance" value={p.chroma.tolerance} min={0.05} max={0.8} onChange={(v) => set({ chroma: { ...p.chroma, tolerance: v } })} fmt={pct} />
          </Section>
        </>
      )}

      {media && (
        <Section title="Audio and speed">
          <Slider label="Volume" value={p.volume} min={0} max={1} onChange={(v) => set({ volume: v })} fmt={pct} />
          <Slider label="Speed" value={clip.speed} min={0.25} max={4} step={0.05}
            onChange={(v) => setSpeed(id, v)} fmt={(v) => `${v.toFixed(2)}x${clip.curve ? " avg" : ""}`} />
          <div className="mb-3 flex gap-2">
            {[0.5, 1, 1.5, 2].map((v) => (
              <button key={v} className={btn} onClick={() => { checkpoint(); setSpeed(id, v); }}>{v}x</button>
            ))}
          </div>
          <p className="mb-2 text-xs text-ed-mute">Speed curves</p>
          <div className="mb-3 flex flex-wrap gap-2">
            {SPEED_PRESETS.map((p) => (
              <button key={p.label} className={btn} onClick={() => { checkpoint(); useEditor.getState().setSpeedCurve(id, p.curve); }}>{p.label}</button>
            ))}
          </div>
          {clip.curve && <SpeedCurve clip={clip} />}
        </Section>
      )}

      <Section title="Animation">
        {[["animIn", "In"], ["animOut", "Out"]].map(([key, label]) => {
          const a = p[key] || { type: "none", dur: 0.5 };
          return (
            <div key={key} className="mb-3">
              <div className="flex items-center gap-2">
                <span className="w-8 text-xs text-ed-mute">{label}</span>
                <div className="flex flex-wrap gap-1">
                  {ANIM_TYPES.map(([type, name]) => (
                    <button key={type} aria-pressed={a.type === type}
                      className={`rounded px-2 py-1 text-xs ${a.type === type ? "bg-gold text-ed-bg" : "bg-ed-raise text-ed-text hover:bg-ed-line"}`}
                      onClick={() => { checkpoint(); set({ [key]: { ...a, type } }); }}>{name}</button>
                  ))}
                </div>
              </div>
              {a.type !== "none" && (
                <div className="mt-2 pl-10">
                  <Slider label="Length" value={a.dur} min={0.1} max={2} step={0.05} onChange={(v) => set({ [key]: { ...a, dur: v } })} fmt={(v) => `${v.toFixed(2)}s`} />
                </div>
              )}
            </div>
          );
        })}
      </Section>
      <Section title="Timing">
        <label className="block text-xs text-ed-mute">Duration (s)
          <input
            type="number" min="0.1" step="0.1" value={clip.duration.toFixed(2)}
            onFocus={checkpoint}
            onChange={(e) => updateClip(id, { duration: Math.max(0.1, +e.target.value || 0.1) })}
            className="mt-1 block w-full rounded-md border border-ed-line bg-ed-bg px-2 py-1.5 text-ed-text"
          />
        </label>
      </Section>
    </div>
  );
}
