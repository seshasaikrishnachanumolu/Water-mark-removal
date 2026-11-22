import { animState, isActive, sourceTime, speedAt } from "./timeline";

/**
 * One <video>/<audio>/<img> element per *clip* (not per asset), so two clips
 * from the same file can play different moments at once. The preview and the
 * exporter each own a pool; the exporter's pool also routes audio into a
 * MediaStreamDestination so sound ends up in the recording.
 */
export class MediaPool {
  constructor({ audioCtx = null, dest = null } = {}) {
    this.map = new Map();
    this.audioCtx = audioCtx;
    this.dest = dest;
  }

  get(clip, asset) {
    let el = this.map.get(clip.id);
    if (el && el.__src !== asset.url) {
      this.#dispose(el);
      el = null;
    }
    if (!el) {
      if (clip.kind === "image") {
        el = new Image();
      } else {
        el = document.createElement(clip.kind === "audio" ? "audio" : "video");
        el.preload = "auto";
        el.playsInline = true;
      }
      el.__src = asset.url;
      el.src = asset.url;
      if (this.audioCtx && clip.kind !== "image") {
        // A media element can only be captured once; this pool owns it for good.
        this.audioCtx.createMediaElementSource(el).connect(this.dest);
      }
      this.map.set(clip.id, el);
    }
    return el;
  }

  /** Drop elements whose clips no longer exist. */
  prune(clips) {
    for (const [id, el] of this.map) {
      if (!clips[id]) {
        this.#dispose(el);
        this.map.delete(id);
      }
    }
  }

  #dispose(el) {
    if (el.pause) el.pause();
    el.removeAttribute?.("src");
    el.load?.();
  }

  dispose() {
    for (const el of this.map.values()) this.#dispose(el);
    this.map.clear();
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Align every audible/visible media element with timeline time `t`.
 * Playing: let elements run and only correct drift. Paused/scrubbing: seek exactly.
 */
export function syncMedia(pool, state, t, playing, { drift = 0.3 } = {}) {
  const { clips, assets, tracks } = state;
  for (const clip of Object.values(clips)) {
    if (clip.kind !== "video" && clip.kind !== "audio") continue;
    const asset = assets[clip.assetId];
    if (!asset) continue;
    const track = tracks.find((tr) => tr.id === clip.trackId);
    const el = pool.get(clip, asset);

    if (!isActive(clip, t)) {
      if (!el.paused) el.pause();
      continue;
    }
    const target = sourceTime(clip, t);
    el.playbackRate = clamp(speedAt(clip, t), 0.0625, 16);
    // In the exporter the element feeds a WebAudio node; muting would silence the recording.
    // Fade in/out animations also fade the sound (like CapCut).
    el.volume = track?.muted ? 0 : clamp(clip.props.volume * animState(clip, t).alpha, 0, 1);

    if (playing) {
      if (el.paused) el.play().catch(() => {});
      if (Math.abs(el.currentTime - target) > drift) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
    }
  }
}

/** Resolve once every active video element has decoded the frame at time t. */
export async function seekAll(pool, state, t) {
  const waits = [];
  for (const clip of Object.values(state.clips)) {
    if (!isActive(clip, t) || (clip.kind !== "video" && clip.kind !== "image")) continue;
    const asset = state.assets[clip.assetId];
    if (!asset) continue;
    const el = pool.get(clip, asset);
    if (clip.kind === "image") {
      waits.push(el.decode ? el.decode().catch(() => {}) : Promise.resolve());
      continue;
    }
    waits.push(
      new Promise((resolve) => {
        const done = () => resolve();
        const go = () => {
          el.addEventListener("seeked", done, { once: true });
          el.currentTime = sourceTime(clip, t);
          setTimeout(done, 3000);
        };
        el.readyState >= 1 ? go() : el.addEventListener("loadedmetadata", go, { once: true });
      }),
    );
  }
  await Promise.all(waits);
}


/** Resolve once every active media element has buffered enough to play smoothly (or after a timeout). */
export async function waitBuffered(pool, state, t, timeoutMs = 5000) {
  const waits = [];
  for (const clip of Object.values(state.clips)) {
    if (!isActive(clip, t) || (clip.kind !== "video" && clip.kind !== "audio")) continue;
    const asset = state.assets[clip.assetId];
    if (!asset) continue;
    const el = pool.get(clip, asset);
    if (el.readyState >= 3) continue;
    waits.push(new Promise((resolve) => {
      el.addEventListener("canplay", resolve, { once: true });
      setTimeout(resolve, timeoutMs);
    }));
  }
  await Promise.all(waits);
}
