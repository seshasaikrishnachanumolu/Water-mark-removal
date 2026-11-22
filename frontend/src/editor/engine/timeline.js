// Pure timeline helpers (no React, no DOM) so they are easy to test and reuse
// from both the live preview and the exporter.

export const clipEnd = (c) => c.start + c.duration;

export function projectDuration(clips) {
  let end = 0;
  for (const id in clips) end = Math.max(end, clipEnd(clips[id]));
  return end;
}

export const isActive = (c, t) => t >= c.start && t < clipEnd(c);

// ---------------------------------------------------------------- speed curves
// A curve is [{t: 0..1, v: speed}] sorted by t, piecewise linear over the clip's
// timeline length. Without a curve the clip plays at constant `clip.speed`.
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Curve with explicit points at t=0 and t=1 so lookups never fall off the ends. */
function norm(curve) {
  const pts = [...curve].sort((a, b) => a.t - b.t);
  if (pts[0].t > 0) pts.unshift({ t: 0, v: pts[0].v });
  if (pts[pts.length - 1].t < 1) pts.push({ t: 1, v: pts[pts.length - 1].v });
  return pts;
}

function valueAt(pts, u) {
  u = clamp01(u);
  for (let i = 1; i < pts.length; i++) {
    if (u <= pts[i].t) {
      const span = pts[i].t - pts[i - 1].t || 1;
      return pts[i - 1].v + ((pts[i].v - pts[i - 1].v) * (u - pts[i - 1].t)) / span;
    }
  }
  return pts[pts.length - 1].v;
}

/** Area under the curve from 0 to x (exact, piecewise linear). */
function integrate(pts, x) {
  x = clamp01(x);
  let area = 0;
  for (let i = 1; i < pts.length && x > pts[i - 1].t; i++) {
    const u0 = pts[i - 1].t, v0 = pts[i - 1].v;
    const ux = Math.min(x, pts[i].t);
    area += ((v0 + valueAt(pts, ux)) / 2) * (ux - u0);
  }
  return area;
}

export const curveMean = (curve) => integrate(norm(curve), 1);

/** Sub-curve covering [a, b] of the original (b may exceed 1: the last value is held). */
export function sliceCurve(curve, a, b) {
  const pts = norm(curve);
  const out = [{ t: 0, v: valueAt(pts, a) }];
  for (const p of pts) if (p.t > a + 1e-6 && p.t < b - 1e-6) out.push({ t: (p.t - a) / (b - a), v: p.v });
  out.push({ t: 1, v: valueAt(pts, b) });
  return out;
}

/** Instantaneous playback speed at timeline time t. */
export function speedAt(c, t) {
  return c.curve ? valueAt(norm(c.curve), (t - c.start) / c.duration) : c.speed;
}

/** Time inside the source media that corresponds to timeline time t. */
export function sourceTime(c, t) {
  if (!c.curve) return c.in + (t - c.start) * c.speed;
  return c.in + c.duration * integrate(norm(c.curve), (t - c.start) / c.duration);
}

/** Patch for trimming the clip's left edge by d seconds (d < 0 extends it). */
export function trimLeftPatch(o, d, hasSource) {
  const patch = { start: o.start + d, duration: o.duration - d, in: 0 };
  if (!hasSource) return patch;
  // Extending left (d < 0) reaches before the first sample, so use the opening speed.
  patch.in = o.curve ? (d < 0 ? o.in + d * speedAt(o, o.start) : sourceTime(o, o.start + d)) : o.in + d * o.speed;
  if (o.curve) {
    patch.curve = sliceCurve(o.curve, d / o.duration, 1);
    patch.speed = curveMean(patch.curve);
  }
  return patch;
}

/** Patch for setting the clip's length (right-edge trim). */
export function trimRightPatch(o, duration) {
  const patch = { duration };
  if (o.curve) {
    patch.curve = sliceCurve(o.curve, 0, duration / o.duration);
    patch.speed = curveMean(patch.curve);
  }
  return patch;
}

/** Which track types may hold which clip kinds. */
export function trackAccepts(trackType, kind) {
  switch (kind) {
    case "video":
    case "image":
      return trackType === "video" || trackType === "overlay";
    case "audio":
      return trackType === "audio";
    case "text":
      return trackType === "text";
    default: // shape, emoji
      return trackType === "overlay";
  }
}

/** Video and audio tracks are sequential (no overlap); overlay/text may stack. */
export const trackIsSequential = (type) => type === "video" || type === "audio";

/**
 * Nearest start >= `start` where [start, start+duration) does not collide with
 * another clip on the same track.
 */
export function resolveFreeStart(clips, trackId, selfId, start, duration) {
  const others = Object.values(clips)
    .filter((c) => c.trackId === trackId && c.id !== selfId)
    .sort((a, b) => a.start - b.start);
  let s = Math.max(0, start);
  for (let pass = 0; pass <= others.length; pass++) {
    const hit = others.find((o) => s < clipEnd(o) - 1e-6 && s + duration > o.start + 1e-6);
    if (!hit) break;
    s = clipEnd(hit);
  }
  return s;
}

/** Snap `time` (or `time + duration`) to nearby edges. Returns the adjusted start. */
export function snapStart(start, duration, edges, threshold) {
  let best = null;
  for (const e of edges) {
    for (const [probe, offset] of [[start, 0], [start + duration, duration]]) {
      const d = Math.abs(probe - e);
      if (d <= threshold && (best === null || d < best.d)) best = { d, start: e - offset };
    }
  }
  return best ? Math.max(0, best.start) : start;
}

export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}


// ------------------------------------------------------------------ animations
// Per-clip in/out animations (CapCut style). Pure so the preview, exporter and tests agree.
export const ANIM_TYPES = [
  ["none", "None"],
  ["fade", "Fade"],
  ["zoom", "Zoom"],
  ["slide", "Slide"],
  ["pop", "Pop"],
];
const ease = (u) => u * u * (3 - 2 * u);
const easeOutBack = (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);

/** Returns {alpha, scale, dy} multipliers for clip `c` at timeline time t (dy is a fraction of canvas height). */
export function animState(c, t) {
  const out = { alpha: 1, scale: 1, dy: 0 };
  const p = c.props || {};
  const part = (a, u, dir) => {
    if (!a || a.type === "none") return;
    u = Math.max(0, Math.min(1, u));
    if (u >= 1) return;
    const e = ease(u);
    switch (a.type) {
      case "fade": out.alpha *= e; break;
      case "zoom": out.scale *= 0.6 + 0.4 * e; out.alpha *= e; break;
      case "slide": out.dy += (1 - e) * 0.12 * dir; out.alpha *= e; break;
      case "pop": out.scale *= dir > 0 ? Math.max(0, easeOutBack(u)) : 0.5 + 0.5 * e; out.alpha *= Math.min(1, e * 1.5); break;
    }
  };
  const half = c.duration / 2;
  const din = Math.min(p.animIn?.dur ?? 0.5, half);
  const dout = Math.min(p.animOut?.dur ?? 0.5, half);
  if (din > 0) part(p.animIn, (t - c.start) / din, 1);
  if (dout > 0) part(p.animOut, (c.start + c.duration - t) / dout, -1);
  return out;
}
