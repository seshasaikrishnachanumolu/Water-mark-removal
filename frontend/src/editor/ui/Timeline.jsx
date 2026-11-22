import { useMemo, useRef } from "react";
import { clipEnd, projectDuration, snapStart, trimLeftPatch, trimRightPatch } from "../engine/timeline";
import { useEditor } from "../store/useEditor";

const ROW_H = 46;
const RULER_H = 26;
const LABEL_W = 132;
const COLORS = { video: "#3d6ea5", image: "#7d63a8", audio: "#3f8a68", text: "#a9822f", shape: "#a95f3b", emoji: "#a95f3b" };

/** Multi-track timeline: ruler scrub, drag/trim/snap clips, drop from the library. */
export default function Timeline() {
  const tracks = useEditor((s) => s.tracks);
  const clips = useEditor((s) => s.clips);
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const setTime = useEditor((s) => s.setTime);
  const addTrack = useEditor((s) => s.addTrack);
  const contentRef = useRef(null);
  const total = Math.max(projectDuration(clips) + 8, 24);
  const width = total * zoom;

  const timeAt = (clientX) => (clientX - contentRef.current.getBoundingClientRect().left) / zoom;

  function scrub(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    useEditor.getState().setPlaying(false);
    setTime(Math.max(0, timeAt(e.clientX)));
    const move = (ev) => setTime(Math.max(0, timeAt(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onDrop(e, track) {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("application/x-asset");
    if (!assetId) return;
    useEditor.getState().addAssetClip(assetId, { trackId: track.id, start: Math.max(0, timeAt(e.clientX)) });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ed-panel">
      <div className="flex items-center gap-3 border-b border-ed-line px-3 py-1.5 text-xs text-ed-mute">
        <span className="font-medium text-ed-text">Timeline</span>
        <button onClick={() => addTrack("video")} className="rounded px-2 py-0.5 hover:bg-ed-raise hover:text-ed-text">+ Video track</button>
        <button onClick={() => addTrack("overlay")} className="rounded px-2 py-0.5 hover:bg-ed-raise hover:text-ed-text">+ Overlay</button>
        <button onClick={() => addTrack("audio")} className="rounded px-2 py-0.5 hover:bg-ed-raise hover:text-ed-text">+ Audio</button>
        <button onClick={() => {
            const s = useEditor.getState();
            const d = projectDuration(s.clips);
            const room = (contentRef.current?.parentElement?.clientWidth || 800) - 24;
            if (d > 0) s.setZoom(room / d);
          }} className="rounded px-2 py-0.5 hover:bg-ed-raise hover:text-ed-text" title="Zoom to fit the whole project">Fit</button>
        <label className="ml-auto flex items-center gap-2">
          Zoom
          <input type="range" min="20" max="240" value={zoom} onChange={(e) => setZoom(+e.target.value)} className="w-28 accent-gold" aria-label="Timeline zoom" />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex">
          {/* Track labels (stay put while the timeline scrolls sideways) */}
          <div className="shrink-0 border-r border-ed-line bg-ed-panel" style={{ width: LABEL_W }}>
            <div style={{ height: RULER_H }} className="border-b border-ed-line" />
            {tracks.map((t) => (
              <TrackLabel key={t.id} track={t} />
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto">
            <div ref={contentRef} className="relative" style={{ width }}>
              <Ruler total={total} zoom={zoom} onScrub={scrub} />
              {tracks.map((t) => (
                <div
                  key={t.id}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) {
                      useEditor.getState().select(null);
                      scrub(e);
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, t)}
                  className={`relative border-b border-ed-line ${t.hidden ? "opacity-40" : ""}`}
                  style={{ height: ROW_H }}
                  data-track={t.id}
                >
                  {Object.values(clips)
                    .filter((c) => c.trackId === t.id)
                    .map((c) => (
                      <ClipView key={c.id} clip={c} zoom={zoom} contentRef={contentRef} />
                    ))}
                </div>
              ))}
              <Playhead zoom={zoom} onScrub={scrub} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackLabel({ track }) {
  const toggle = useEditor((s) => s.toggleTrack);
  const btn = (on, label, key, title) => (
    <button
      onClick={() => toggle(track.id, key)}
      title={title}
      aria-pressed={on}
      className={`rounded px-1 text-[10px] ${on ? "bg-gold text-ed-bg" : "text-ed-mute hover:text-ed-text"}`}
    >
      {label}
    </button>
  );
  const move = useEditor((s) => s.moveTrack);
  return (
    <div style={{ height: ROW_H }} className="flex items-center justify-between border-b border-ed-line px-2 text-xs">
      <span className="truncate text-ed-text">{track.name}</span>
      <span className="flex gap-1">
        <button onClick={() => move(track.id, -1)} title="Move track up (drawn above)" aria-label={`Move ${track.name} up`} className="px-0.5 text-ed-mute hover:text-ed-text">?</button>
        <button onClick={() => move(track.id, 1)} title="Move track down" aria-label={`Move ${track.name} down`} className="px-0.5 text-ed-mute hover:text-ed-text">?</button>
        {track.type !== "text" && track.type !== "overlay" && btn(track.muted, "M", "muted", "Mute track")}
        {track.type !== "audio" && btn(track.hidden, "H", "hidden", "Hide track")}
      </span>
    </div>
  );
}

function Ruler({ total, zoom, onScrub }) {
  const step = zoom >= 120 ? 1 : zoom >= 50 ? 2 : 5;
  const marks = [];
  for (let s = 0; s <= total; s += step) marks.push(s);
  return (
    <div onPointerDown={onScrub} className="relative cursor-col-resize select-none border-b border-ed-line bg-ed-bg" style={{ height: RULER_H }}>
      {marks.map((s) => (
        <div key={s} className="absolute top-0 h-full border-l border-ed-line pl-1 text-[10px] leading-6 text-ed-mute" style={{ left: s * zoom }}>
          {s}s
        </div>
      ))}
    </div>
  );
}

function Playhead({ zoom, onScrub }) {
  const time = useEditor((s) => s.time);
  return (
    <div className="pointer-events-none absolute top-0 z-20 h-full" style={{ left: time * zoom }}>
      <div onPointerDown={onScrub} className="pointer-events-auto absolute -left-2 top-0 h-[26px] w-4 cursor-col-resize">
        <div className="mx-auto h-3 w-3 rotate-45 bg-gold" style={{ marginTop: 4 }} />
      </div>
      <div className="absolute left-0 top-0 h-full w-px bg-gold" />
    </div>
  );
}

function ClipView({ clip, zoom, contentRef }) {
  const selected = useEditor((s) => s.selection === clip.id);
  const asset = useEditor((s) => s.assets[clip.assetId]);

  /** Shared pointer-drag helper: calls onMove(dx seconds, event) until release. */
  function gesture(e, onMove) {
    e.stopPropagation();
    e.preventDefault();
    const s = useEditor.getState();
    s.select(clip.id);
    s.checkpoint();
    const x0 = e.clientX;
    const move = (ev) => onMove((ev.clientX - x0) / zoom, ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragBody(e) {
    const s0 = useEditor.getState();
    const orig = { ...s0.clips[clip.id] };
    gesture(e, (dx, ev) => {
      const s = useEditor.getState();
      // Edges to snap to: playhead, zero, every other clip's start/end.
      const edges = [0, s.time];
      for (const o of Object.values(s.clips)) if (o.id !== clip.id) edges.push(o.start, clipEnd(o));
      const start = snapStart(Math.max(0, orig.start + dx), orig.duration, edges, 8 / zoom);
      // Track under the pointer (all rows share one height).
      const rect = contentRef.current.getBoundingClientRect();
      const row = Math.floor((ev.clientY - rect.top - RULER_H) / ROW_H);
      const track = s.tracks[Math.max(0, Math.min(s.tracks.length - 1, row))];
      s.moveClip(clip.id, start, track?.id);
    });
  }

  function trimLeft(e) {
    const o = { ...useEditor.getState().clips[clip.id] };
    gesture(e, (dx) => {
      // Generated clips have no source media, so they can extend freely to time 0.
      // Media clips can't trim past the source start (in >= 0). Min length 0.1s.
      const noSource = o.kind === "text" || o.kind === "shape" || o.kind === "emoji" || o.kind === "image";
      const d = Math.max(-o.start, noSource ? -Infinity : -o.in / o.speed, Math.min(dx, o.duration - 0.1));
      useEditor.getState().updateClip(clip.id, trimLeftPatch(o, d, !noSource));
    });
  }

  function trimRight(e) {
    const o = { ...useEditor.getState().clips[clip.id] };
    const limit = asset && (o.kind === "video" || o.kind === "audio") && asset.duration
      ? (asset.duration - o.in) / o.speed
      : Infinity;
    gesture(e, (dx) => {
      useEditor.getState().updateClip(clip.id, trimRightPatch(o, Math.max(0.1, Math.min(o.duration + dx, limit))));
    });
  }

  // Filmstrip: stretch the asset's thumbnail strip so 1 source second = zoom/speed px,
  // then offset it by the trim-in point so trimmed clips show the right frames.
  const filmstrip =
    clip.kind === "video" && asset?.strip && asset.duration
      ? {
          backgroundImage: `linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,.1)), url(${asset.strip.url})`,
          backgroundSize: `100% 100%, ${(asset.duration * zoom) / clip.speed}px 100%`,
          backgroundPosition: `0 0, ${(-clip.in * zoom) / clip.speed}px 0`,
          backgroundRepeat: "no-repeat",
        }
      : null;

  return (
    <div
      onPointerDown={dragBody}
      role="button"
      tabIndex={0}
      aria-label={`${clip.kind} clip ${clip.name}`}
      className={`absolute top-1 flex cursor-grab items-center overflow-hidden rounded-md text-[11px] text-white active:cursor-grabbing ${
        selected ? "ring-2 ring-gold" : "ring-1 ring-black/40"
      }`}
      style={{ left: clip.start * zoom, width: Math.max(6, clip.duration * zoom), height: ROW_H - 8, background: COLORS[clip.kind], ...filmstrip }}
    >
      {asset?.peaks && (clip.kind === "audio" || clip.kind === "video") && (
        <Wave peaks={asset.peaks} from={clip.in} span={clip.duration * clip.speed} short={clip.kind === "video"} />
      )}
      <div onPointerDown={trimLeft} className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-black/30 hover:bg-white/50" />
      <span className="pointer-events-none relative z-10 truncate px-3 drop-shadow">
        {clip.kind === "text" ? clip.props.text.replace(/\n/g, " ") : clip.kind === "emoji" ? clip.props.emoji : clip.name}
        {clip.speed !== 1 ? ` · ${clip.speed}x` : ""}
      </span>
      <div onPointerDown={trimRight} className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-black/30 hover:bg-white/50" />
    </div>
  );
}


/** Mirrored waveform for the visible slice of the source (peaks are 20 per second). */
function Wave({ peaks, from, span, short }) {
  const { points, n } = useMemo(() => {
    const a = Math.max(0, Math.floor(from * 20));
    const b = Math.min(peaks.length, Math.ceil((from + span) * 20));
    let top = "", bottom = "";
    for (let i = a; i < b; i++) {
      const h = Math.max(2, peaks[i]) / 2;
      top += `${i - a},${50 - h} `;
      bottom = `${i - a},${50 + h} ` + bottom;
    }
    return { points: top + bottom, n: Math.max(1, b - a) };
  }, [peaks, from, span]);
  return (
    <svg aria-hidden className={`pointer-events-none absolute left-0 w-full ${short ? "bottom-0 h-1/3" : "top-0 h-full"}`}
      viewBox={`0 0 ${n} 100`} preserveAspectRatio="none">
      <polygon points={points} fill="rgba(255,255,255,0.6)" />
    </svg>
  );
}
