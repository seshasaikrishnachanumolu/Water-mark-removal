import { create } from "zustand";
import {
  clipEnd,
  curveMean,
  isActive,
  resolveFreeStart,
  sliceCurve,
  sourceTime,
  trackAccepts,
  trackIsSequential,
} from "../engine/timeline";

/**
 * Single source of truth for the editor.
 *
 *   assets  { id: {id, kind, name, url, duration, width, height} }   media library
 *   tracks  [ {id, type, name, muted, hidden} ]  index 0 = top of the UI = drawn on top
 *   clips   { id: {id, trackId, kind, assetId, name, start, duration, in, speed, props} }
 *   time / playing / zoom / selection   transient UI + playback state
 *   past / future   undo-redo snapshots of {tracks, clips}
 *
 * Playback `time` lives here too, but only tiny components subscribe to it
 * (playhead, clock). The render loop reads it via getState() to avoid React renders.
 */
export const uid = () => crypto.randomUUID();

export const defaultProps = () => ({
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  volume: 1,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  blur: 0,
  crop: { l: 0, r: 0, t: 0, b: 0 },
  sepia: 0,
  grayscale: 0,
  hue: 0,
  z: 0, // layer order within a track (higher = on top)
  animIn: { type: "none", dur: 0.5 },
  animOut: { type: "none", dur: 0.5 },
  mask: "none", // none | circle | rounded
  chroma: { on: false, color: "#00ff00", tolerance: 0.35 },
});

const baseTracks = () => [
  { id: uid(), type: "text", name: "Text", muted: false, hidden: false },
  { id: uid(), type: "overlay", name: "Overlay", muted: false, hidden: false },
  { id: uid(), type: "video", name: "Video", muted: false, hidden: false },
  { id: uid(), type: "audio", name: "Audio", muted: false, hidden: false },
];

const snapshot = (s) => structuredClone({ tracks: s.tracks, clips: s.clips });
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export const useEditor = create((set, get) => ({
  project: { width: 1920, height: 1080, fps: 30, background: "#000000" },
  assets: {},
  tracks: baseTracks(),
  clips: {},
  clipboard: null,
  selection: null,
  time: 0,
  playing: false,
  zoom: 70, // pixels per second
  past: [],
  future: [],

  // ---- transient state --------------------------------------------------
  setTime: (t) => set({ time: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (zoom) => set({ zoom: Math.max(20, Math.min(240, zoom)) }),
  select: (selection) => set({ selection }),
  setProject: (patch) => set((s) => ({ project: { ...s.project, ...patch } })),

  // ---- history ----------------------------------------------------------
  checkpoint: () => set((s) => ({ past: [...s.past.slice(-49), snapshot(s)], future: [] })),
  undo: () =>
    set((s) => {
      if (!s.past.length) return {};
      const prev = s.past[s.past.length - 1];
      return {
        ...prev,
        past: s.past.slice(0, -1),
        future: [...s.future, snapshot(s)],
        selection: prev.clips[s.selection] ? s.selection : null,
      };
    }),
  redo: () =>
    set((s) => {
      if (!s.future.length) return {};
      const next = s.future[s.future.length - 1];
      return { ...next, future: s.future.slice(0, -1), past: [...s.past, snapshot(s)] };
    }),

  // ---- assets -----------------------------------------------------------
  addAsset: (asset) => set((s) => ({ assets: { ...s.assets, [asset.id]: asset } })),
  patchAsset: (id, patch) =>
    set((s) => (s.assets[id] ? { assets: { ...s.assets, [id]: { ...s.assets[id], ...patch } } } : {})),

  /** Place a library asset on a track. Returns the new clip id. */
  addAssetClip: (assetId, { trackId, start } = {}) => {
    const s = get();
    const a = s.assets[assetId];
    if (!a) return null;
    s.checkpoint();

    const wanted = a.kind === "audio" ? "audio" : a.kind === "video" ? "video" : "overlay";
    let track = s.tracks.find((t) => t.id === trackId && trackAccepts(t.type, a.kind));
    track = track || s.tracks.find((t) => t.type === wanted);
    const duration = a.kind === "image" ? 5 : a.duration || 5;

    let at = start;
    if (at === undefined) {
      const mine = Object.values(s.clips).filter((c) => c.trackId === track.id);
      at = trackIsSequential(track.type) ? Math.max(0, ...mine.map(clipEnd)) : s.time;
    }
    if (trackIsSequential(track.type)) at = resolveFreeStart(s.clips, track.id, null, at, duration);

    const id = uid();
    const clip = {
      id, trackId: track.id, kind: a.kind, assetId, name: a.name,
      start: at, duration, in: 0, speed: 1, curve: null, props: defaultProps(),
    };
    const firstVisual = !Object.keys(s.clips).length && a.width && a.kind !== "audio";
    set((st) => ({
      clips: { ...st.clips, [id]: clip },
      selection: id,
      // First visual asset defines the canvas aspect ratio (like CapCut), capped at 1920.
      project: firstVisual
        ? (() => {
            const k = 1920 / Math.max(a.width, a.height);
            return { ...st.project, width: even(a.width * Math.min(1, k)), height: even(a.height * Math.min(1, k)) };
          })()
        : st.project,
    }));
    return id;
  },

  /** Add a generated clip (text / shape / emoji). `def` = {kind, name, duration, props, trackType} */
  addClip: (def, { silent = false } = {}) => {
    const s = get();
    if (!silent) s.checkpoint();
    const track = s.tracks.find((t) => t.type === def.trackType);
    const id = uid();
    set((st) => ({
      clips: {
        ...st.clips,
        [id]: {
          id, trackId: track.id, kind: def.kind, assetId: null, name: def.name,
          start: def.start ?? st.time, duration: def.duration ?? 4, in: 0, speed: 1, curve: null,
          props: { ...defaultProps(), ...def.props },
        },
      },
      selection: id,
    }));
    return id;
  },

  // ---- clip editing (callers checkpoint at gesture start) ---------------
  updateClip: (id, patch) =>
    set((s) => (s.clips[id] ? { clips: { ...s.clips, [id]: { ...s.clips[id], ...patch } } } : {})),

  updateProps: (id, patch) =>
    set((s) =>
      s.clips[id]
        ? { clips: { ...s.clips, [id]: { ...s.clips[id], props: { ...s.clips[id].props, ...patch } } } }
        : {},
    ),

  moveClip: (id, start, trackId) =>
    set((s) => {
      const c = s.clips[id];
      if (!c) return {};
      const target = s.tracks.find((t) => t.id === trackId);
      const tr = target && trackAccepts(target.type, c.kind) ? target : s.tracks.find((t) => t.id === c.trackId);
      let st = Math.max(0, start);
      if (trackIsSequential(tr.type)) st = resolveFreeStart(s.clips, tr.id, id, st, c.duration);
      return { clips: { ...s.clips, [id]: { ...c, start: st, trackId: tr.id } } };
    }),

  /** Constant speed. Keeps the same slice of source media: faster => shorter clip. */
  setSpeed: (id, speed) =>
    set((s) => {
      const c = s.clips[id];
      if (!c) return {};
      const sp = Math.max(0.25, Math.min(4, speed));
      const span = c.duration * (c.curve ? curveMean(c.curve) : c.speed); // source seconds covered
      return { clips: { ...s.clips, [id]: { ...c, curve: null, speed: sp, duration: Math.max(0.1, span / sp) } } };
    }),

  /** Variable speed (ramps / montage). Pass null to go back to constant speed. */
  setSpeedCurve: (id, curve) =>
    set((s) => {
      const c = s.clips[id];
      if (!c) return {};
      const span = c.duration * (c.curve ? curveMean(c.curve) : c.speed);
      const mean = curve ? curveMean(curve) : c.curve ? curveMean(c.curve) : c.speed;
      return { clips: { ...s.clips, [id]: { ...c, curve, speed: mean, duration: Math.max(0.1, span / mean) } } };
    }),

  swapClipAsset: (id, asset) =>
    set((s) => ({
      assets: { ...s.assets, [asset.id]: asset },
      clips: s.clips[id] ? { ...s.clips, [id]: { ...s.clips[id], assetId: asset.id, name: asset.name, kind: asset.kind } } : s.clips,
    })),

  splitAtPlayhead: () => {
    const s = get();
    const t = s.time;
    const sel = s.clips[s.selection];
    const targets = sel && isActive(sel, t) ? [sel] : Object.values(s.clips).filter((c) => isActive(c, t));
    const valid = targets.filter((c) => t - c.start > 0.05 && clipEnd(c) - t > 0.05);
    if (!valid.length) return;
    s.checkpoint();
    const next = { ...s.clips };
    for (const c of valid) {
      const x = (t - c.start) / c.duration;
      const right = {
        ...structuredClone(c), id: uid(), start: t,
        in: sourceTime(c, t), duration: clipEnd(c) - t,
      };
      const left = { ...c, duration: t - c.start };
      if (c.curve) { // each half keeps its own slice of the speed curve
        left.curve = sliceCurve(c.curve, 0, x);
        left.speed = curveMean(left.curve);
        right.curve = sliceCurve(c.curve, x, 1);
        right.speed = curveMean(right.curve);
      }
      next[c.id] = left;
      next[right.id] = right;
    }
    set({ clips: next });
  },

  duplicateClip: (id) => {
    const s = get();
    const c = s.clips[id];
    if (!c) return;
    s.checkpoint();
    const track = s.tracks.find((t) => t.id === c.trackId);
    let start = clipEnd(c);
    if (trackIsSequential(track.type)) start = resolveFreeStart(s.clips, c.trackId, null, start, c.duration);
    const copy = { ...structuredClone(c), id: uid(), start };
    set({ clips: { ...s.clips, [copy.id]: copy }, selection: copy.id });
  },

  deleteClip: (id) => {
    const s = get();
    if (!s.clips[id]) return;
    s.checkpoint();
    const { [id]: _gone, ...rest } = s.clips;
    set({ clips: rest, selection: s.selection === id ? null : s.selection });
  },

  // ---- tracks -----------------------------------------------------------
  toggleTrack: (id, key) =>
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, [key]: !t[key] } : t)) })),

  addTrack: (type) => {
    const s = get();
    s.checkpoint();
    const count = s.tracks.filter((t) => t.type === type).length + 1;
    const track = { id: uid(), type, name: `${type[0].toUpperCase()}${type.slice(1)} ${count}`, muted: false, hidden: false };
    // New visual tracks go above the existing ones of that type; audio goes last.
    const idx = type === "audio" ? s.tracks.length : Math.max(0, s.tracks.findIndex((t) => t.type === type));
    const tracks = [...s.tracks];
    tracks.splice(idx, 0, track);
    set({ tracks });
  },

  // ---- layers, clipboard, nudge ------------------------------------------
  /** Reorder within the clip's track. dir: "front" | "back" | "up" | "down". */
  arrange: (id, dir) => {
    const s = get();
    const c = s.clips[id];
    if (!c) return;
    s.checkpoint();
    const mates = Object.values(s.clips).filter((o) => o.trackId === c.trackId);
    const zs = mates.map((o) => o.props.z ?? 0);
    const z = c.props.z ?? 0;
    const next = dir === "front" ? Math.max(...zs) + 1 : dir === "back" ? Math.min(...zs) - 1 : dir === "up" ? z + 1.5 : z - 1.5;
    set({ clips: { ...s.clips, [id]: { ...c, props: { ...c.props, z: next } } } });
  },

  /** Move a whole track up/down in the stack (up = drawn on top). */
  moveTrack: (id, delta) => {
    const s = get();
    const i = s.tracks.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.tracks.length) return;
    s.checkpoint();
    const tracks = [...s.tracks];
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    set({ tracks });
  },

  copyClip: () => {
    const s = get();
    if (s.clips[s.selection]) set({ clipboard: structuredClone(s.clips[s.selection]) });
  },

  /** Paste the copied clip at the playhead on its original track (or a compatible one). */
  pasteClip: () => {
    const s = get();
    const src = s.clipboard;
    if (!src) return;
    const track = s.tracks.find((t) => t.id === src.trackId) || s.tracks.find((t) => trackAccepts(t.type, src.kind));
    if (!track) return;
    s.checkpoint();
    let start = s.time;
    if (trackIsSequential(track.type)) start = resolveFreeStart(s.clips, track.id, null, start, src.duration);
    const copy = { ...structuredClone(src), id: uid(), trackId: track.id, start };
    set({ clips: { ...s.clips, [copy.id]: copy }, selection: copy.id });
  },
  // ---- project lifecycle ------------------------------------------------
  hydrate: (data) =>
    set({
      project: { background: "#000000", ...data.project }, tracks: data.tracks, assets: data.assets,
      clips: Object.fromEntries(Object.entries(data.clips).map(([k, c]) => [k, { ...c, props: { ...defaultProps(), ...c.props } }])),
      selection: null, time: 0, playing: false, past: [], future: [],
    }),
  reset: () =>
    set({
      project: { width: 1920, height: 1080, fps: 30, background: "#000000" }, assets: {}, tracks: baseTracks(), clips: {}, clipboard: null,
      selection: null, time: 0, playing: false, past: [], future: [],
    }),
}));

// Dev-only handle for debugging and browser tests (stripped from production builds).
if (import.meta.env?.DEV && typeof window !== "undefined") window.__editor = useEditor;
