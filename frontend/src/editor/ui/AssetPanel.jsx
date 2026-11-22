import { useRef, useState } from "react";
import { importFile } from "../engine/assets";
import { EMOJIS, SHAPES, SHAPE_COLORS, TEMPLATES, TEXT_PRESETS } from "../presets";
import { useEditor } from "../store/useEditor";
import AiPanel from "./AiPanel";

const TABS = [
  ["media", "Media"],
  ["text", "Text"],
  ["shapes", "Shapes"],
  ["emoji", "Emoji"],
  ["templates", "Templates"],
  ["ai", "AI"],
];

export default function AssetPanel({ notify }) {
  const [tab, setTab] = useState("media");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-ed-line p-2">
        {TABS.map(([id, label]) => (
          <button
            key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-md px-2.5 py-1 text-xs ${tab === id ? "bg-gold text-ed-bg" : "text-ed-mute hover:bg-ed-raise hover:text-ed-text"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "media" && <Media notify={notify} />}
        {tab === "text" && <TextTab />}
        {tab === "shapes" && <ShapesTab />}
        {tab === "emoji" && <EmojiTab />}
        {tab === "templates" && <TemplatesTab />}
        {tab === "ai" && <AiPanel notify={notify} />}
      </div>
    </div>
  );
}

function Media({ notify }) {
  const assets = useEditor((s) => s.assets);
  const addAssetClip = useEditor((s) => s.addAssetClip);
  const input = useRef(null);
  const [over, setOver] = useState(false);

  async function addFiles(files) {
    for (const f of files) {
      try {
        const a = await importFile(f, undefined, (m) => notify(m, "ok"));
        addAssetClip(a.id);
      } catch (e) {
        notify(`${f.name}: ${e.message}`, "error");
      }
    }
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); addFiles([...e.dataTransfer.files]); }}
        onClick={() => input.current.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && input.current.click()}
        className={`mb-4 cursor-pointer rounded-lg border border-dashed p-5 text-center text-xs ${over ? "border-gold bg-gold/10" : "border-ed-line hover:border-gold"}`}
      >
        <p className="font-medium text-ed-text">Upload media</p>
        <p className="mt-1 text-ed-mute">Video, audio or images. Drop files or click.</p>
        <input ref={input} type="file" multiple accept="video/*,audio/*,image/*" className="hidden"
          onChange={(e) => { addFiles([...e.target.files]); e.target.value = ""; }} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {Object.values(assets).map((a) => (
          <div
            key={a.id} draggable
            onDragStart={(e) => e.dataTransfer.setData("application/x-asset", a.id)}
            className="group relative overflow-hidden rounded-md bg-ed-raise ring-1 ring-ed-line"
            title="Drag onto the timeline"
          >
            <div className="grid aspect-video place-items-center bg-black text-2xl">
              {a.kind === "image" && <img src={a.url} alt="" className="h-full w-full object-cover" />}
              {a.kind === "video" && <video src={a.url} muted preload="metadata" className="h-full w-full object-cover" />}
              {a.kind === "audio" && <span aria-hidden>🎵</span>}
            </div>
            <p className="truncate px-2 py-1 text-[11px] text-ed-mute">{a.name}</p>
            <button
              onClick={() => addAssetClip(a.id)}
              className="absolute right-1 top-1 rounded bg-gold px-1.5 py-0.5 text-xs font-semibold text-ed-bg opacity-0 group-hover:opacity-100 focus:opacity-100"
              aria-label={`Add ${a.name} to timeline`}
            >
              +
            </button>
          </div>
        ))}
      </div>
      {!Object.keys(assets).length && <p className="text-center text-xs text-ed-mute">Your library is empty.</p>}
    </div>
  );
}

function TextTab() {
  const addClip = useEditor((s) => s.addClip);
  return (
    <div className="grid grid-cols-2 gap-2">
      {TEXT_PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => addClip({ kind: "text", trackType: "text", duration: 4, ...p.def })}
          className="rounded-lg border border-ed-line bg-ed-raise p-3 text-center hover:border-gold"
        >
          <span className="block text-2xl text-ed-text" style={{ fontFamily: p.def.props.font, fontWeight: p.def.props.weight }}>{p.sample}</span>
          <span className="mt-1 block text-[11px] text-ed-mute">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

function ShapesTab() {
  const addClip = useEditor((s) => s.addClip);
  return (
    <div className="grid grid-cols-3 gap-2">
      {SHAPES.map((shape, i) => (
        <button
          key={shape}
          onClick={() => addClip({ kind: "shape", trackType: "overlay", name: shape, duration: 5, props: { shape, fill: SHAPE_COLORS[i % SHAPE_COLORS.length] } })}
          className="grid aspect-square place-items-center rounded-lg border border-ed-line bg-ed-raise hover:border-gold"
          aria-label={`Add ${shape}`}
        >
          <svg viewBox="-12 -12 24 24" className="h-9 w-9" fill={SHAPE_COLORS[i % SHAPE_COLORS.length]}>
            {shape === "rect" && <rect x="-10" y="-7" width="20" height="14" />}
            {shape === "rounded" && <rect x="-10" y="-9" width="20" height="18" rx="4" />}
            {shape === "circle" && <circle r="10" />}
            {shape === "triangle" && <polygon points="0,-10 10,9 -10,9" />}
            {shape === "diamond" && <polygon points="0,-10 10,0 0,10 -10,0" />}
            {shape === "star" && <polygon points="0,-10 3,-3 10,-3 4.5,2 6.5,9 0,5 -6.5,9 -4.5,2 -10,-3 -3,-3" />}
          </svg>
        </button>
      ))}
    </div>
  );
}

function EmojiTab() {
  const addClip = useEditor((s) => s.addClip);
  return (
    <div className="grid grid-cols-6 gap-1">
      {EMOJIS.map((e) => (
        <button
          key={e}
          onClick={() => addClip({ kind: "emoji", trackType: "overlay", name: e, duration: 4, props: { emoji: e } })}
          className="rounded-md p-1.5 text-2xl hover:bg-ed-raise" aria-label={`Add emoji ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function TemplatesTab() {
  const addClip = useEditor((s) => s.addClip);
  const checkpoint = useEditor((s) => s.checkpoint);
  return (
    <div className="space-y-2">
      {TEMPLATES.map((t) => (
        <button
          key={t.label}
          onClick={() => {
            checkpoint(); // one undo step for the whole template
            const start = useEditor.getState().time;
            t.clips.forEach((c) => addClip({ ...c, start }, { silent: true }));
          }}
          className="block w-full rounded-lg border border-ed-line bg-ed-raise p-3 text-left hover:border-gold"
        >
          <span className="block text-sm text-ed-text">{t.label}</span>
          <span className="text-xs text-ed-mute">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}
