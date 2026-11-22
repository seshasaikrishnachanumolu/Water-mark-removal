import { animState, isActive } from "./timeline";

/**
 * Canvas 2D compositor. `renderFrame` is the ONE function used by both the live
 * preview and the exporter, so what you see is exactly what you export.
 *
 * Clips are drawn in local coordinates centred on (x*W, y*H); `scale` is applied
 * through the context transform so a clip's base size is its "scale = 1" size
 * (media: contain-fit to the canvas; text: measured; shapes: fraction of the canvas).
 */
const FILTERS_OK = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;
const scratch = typeof document !== "undefined" ? document.createElement("canvas") : null;
const GOLD = "#b08a3e";

// ---------------------------------------------------------------- sizing
function mediaNatural(clip, asset, el) {
  if (clip.kind === "image") return [el.naturalWidth || asset.width, el.naturalHeight || asset.height];
  return [el.videoWidth || asset.width, el.videoHeight || asset.height];
}

function textLayout(ctx, p, H) {
  const px = Math.max(8, p.fontSize * H);
  ctx.font = `${p.weight} ${px}px ${p.font}`;
  const lines = String(p.text || " ").split("\n");
  const pad = p.bg ? px * 0.3 : px * 0.1;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * px * 1.25 + pad * 2;
  return { px, lines, pad, w, h };
}

/** Base (scale = 1) size of a clip in canvas pixels, or null if not drawable yet. */
function baseSize(ctx, clip, asset, pool, W, H) {
  const p = clip.props;
  switch (clip.kind) {
    case "video":
    case "image": {
      const el = pool.get(clip, asset);
      const [nw, nh] = mediaNatural(clip, asset, el);
      if (!nw || !nh) return null;
      const cw = nw * (1 - p.crop.l - p.crop.r);
      const ch = nh * (1 - p.crop.t - p.crop.b);
      if (cw <= 0 || ch <= 0) return null;
      const fit = Math.min(W / cw, H / ch);
      return { w: cw * fit, h: ch * fit, el, nw, nh };
    }
    case "text": {
      const l = textLayout(ctx, p, H);
      return { w: l.w, h: l.h, layout: l };
    }
    case "emoji": {
      const s = Math.min(W, H) * 0.22;
      return { w: s, h: s };
    }
    default: {
      const s = Math.min(W, H) * 0.3;
      return { w: p.shape === "rect" ? s * 1.6 : s, h: s };
    }
  }
}

// ------------------------------------------------------------- drawing bits
function pathShape(ctx, shape, w, h) {
  const x = -w / 2, y = -h / 2;
  ctx.beginPath();
  switch (shape) {
    case "circle":
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "triangle":
      ctx.moveTo(0, y); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2); ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(0, y); ctx.lineTo(w / 2, 0); ctx.lineTo(0, h / 2); ctx.lineTo(-w / 2, 0); ctx.closePath();
      break;
    case "star": {
      const r = Math.min(w, h) / 2;
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const rr = i % 2 ? r * 0.42 : r;
        ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      break;
    }
    case "rounded":
      ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.18);
      break;
    default:
      ctx.rect(x, y, w, h);
  }
}

function applyMask(ctx, mask, w, h) {
  if (mask === "circle") pathShape(ctx, "circle", w, h);
  else if (mask === "rounded") pathShape(ctx, "rounded", w, h);
  else return;
  ctx.clip();
}

/** Simple RGB-distance chroma key. Returns a canvas with the key colour made transparent. */
function chromaKey(src, sx, sy, sw, sh, maxW, key) {
  const cw = Math.max(2, Math.min(maxW, Math.round(sw)));
  const ch = Math.max(2, Math.round((sh * cw) / sw));
  scratch.width = cw;
  scratch.height = ch;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
  const img = sctx.getImageData(0, 0, cw, ch);
  const d = img.data;
  const kr = parseInt(key.color.slice(1, 3), 16);
  const kg = parseInt(key.color.slice(3, 5), 16);
  const kb = parseInt(key.color.slice(5, 7), 16);
  const lo = key.tolerance * 441.67; // sqrt(3*255^2)
  const hi = lo + 40; // soft edge band
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - kr, d[i + 1] - kg, d[i + 2] - kb);
    if (dist < lo) d[i + 3] = 0;
    else if (dist < hi) d[i + 3] = (d[i + 3] * (dist - lo)) / (hi - lo);
  }
  sctx.putImageData(img, 0, 0);
  return scratch;
}

/** Copy the current video frame into a per-element canvas (capped at 1280 wide). */
function cacheFrame(el) {
  const k = Math.min(1, 1280 / el.videoWidth);
  const w = Math.max(2, Math.round(el.videoWidth * k)), h = Math.max(2, Math.round(el.videoHeight * k));
  const cv = el.__last || (el.__last = document.createElement("canvas"));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  cv.getContext("2d").drawImage(el, 0, 0, w, h);
}

function filterString(p, W) {
  const f = [];
  if (p.brightness !== 1) f.push(`brightness(${p.brightness})`);
  if (p.contrast !== 1) f.push(`contrast(${p.contrast})`);
  if (p.saturation !== 1) f.push(`saturate(${p.saturation})`);
  if (p.sepia) f.push(`sepia(${p.sepia})`);
  if (p.grayscale) f.push(`grayscale(${p.grayscale})`);
  if (p.hue) f.push(`hue-rotate(${p.hue}deg)`);
  if (p.blur > 0) f.push(`blur(${(p.blur * W) / 1000}px)`);
  return f.length ? f.join(" ") : "none";
}

function drawClip(ctx, W, H, clip, asset, pool, opts, t) {
  const p = clip.props;
  const base = baseSize(ctx, clip, asset, pool, W, H);
  if (!base) return;
  const { w, h } = base;
  const an = animState(clip, t); // fade / zoom / slide / pop in and out

  ctx.save();
  ctx.translate(p.x * W, (p.y + an.dy) * H);
  ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.scale(p.scale * an.scale, p.scale * an.scale);
  ctx.globalAlpha = p.opacity * an.alpha;
  if (FILTERS_OK) ctx.filter = filterString(p, W);

  if (clip.kind === "video" || clip.kind === "image") {
    const { el, nw, nh } = base;
    const ready = clip.kind === "image" ? el.complete : el.readyState >= 2;
    // Export mode: remember the last decoded frame and show it while the element is
    // seeking or stalled, instead of flashing black.
    let src = null;
    if (ready) {
      src = el;
      if (opts.hold && clip.kind === "video") cacheFrame(el);
    } else if (opts.hold && el.__last) {
      src = el.__last;
    }
    if (src) {
      const k = src === el ? 1 : src.width / nw; // cached frames may be downscaled
      applyMask(ctx, p.mask, w, h);
      const sx = nw * p.crop.l * k, sy = nh * p.crop.t * k;
      const sw = nw * (1 - p.crop.l - p.crop.r) * k, sh = nh * (1 - p.crop.t - p.crop.b) * k;
      if (p.chroma.on) {
        ctx.drawImage(chromaKey(src, sx, sy, sw, sh, opts.chromaMax, p.chroma), -w / 2, -h / 2, w, h);
      } else {
        ctx.drawImage(src, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
      }
    }  } else if (clip.kind === "text") {
    const { px, lines, pad } = base.layout;
    if (p.bg) {
      ctx.fillStyle = p.bg;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, px * 0.25);
      ctx.fill();
    }
    ctx.font = `${p.weight} ${px}px ${p.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    lines.forEach((line, i) => {
      const y = -h / 2 + pad + px * 1.25 * (i + 0.5);
      if (p.strokeWidth > 0) {
        ctx.lineWidth = p.strokeWidth * px;
        ctx.strokeStyle = p.stroke;
        ctx.strokeText(line, 0, y);
      }
      ctx.fillStyle = p.color;
      ctx.fillText(line, 0, y);
    });
  } else if (clip.kind === "emoji") {
    ctx.font = `${w * 0.85}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.emoji, 0, h * 0.04);
  } else {
    pathShape(ctx, p.shape, w, h);
    ctx.fillStyle = p.fill;
    ctx.fill();
  }
  ctx.restore();
}

const ROT_OFFSET = 34; // rotation knob distance above the top edge (px at 960w)

/** Selection box in canvas pixels: centre, size, rotation, corner positions and rotation knob. */
export function selectionGeometry(ctx, W, H, state, t, pool, id) {
  const clip = state.clips[id];
  if (!clip || !isActive(clip, t)) return null;
  const size = baseSize(ctx, clip, state.assets[clip.assetId], pool, W, H);
  if (!size) return null;
  const p = clip.props;
  const w = size.w * p.scale, h = size.h * p.scale;
  const a = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx = p.x * W, cy = p.y * H;
  const at = (lx, ly) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos });
  const u = Math.max(1, W / 960);
  return {
    id, cx, cy, w, h, u, rotation: p.rotation, scale: p.scale,
    corners: [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)],
    knob: at(0, -h / 2 - ROT_OFFSET * u),
    top: at(0, -h / 2),
  };
}

function drawHandles(ctx, g) {
  const { u } = g;
  ctx.save();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  g.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath(); // stem to the rotation knob
  ctx.moveTo(g.top.x, g.top.y);
  ctx.lineTo(g.knob.x, g.knob.y);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  for (const c of g.corners) {
    ctx.beginPath();
    ctx.rect(c.x - 5 * u, c.y - 5 * u, 10 * u, 10 * u);
    ctx.fill();
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(g.knob.x, g.knob.y, 6 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawGuides(ctx, W, H, guides) {
  ctx.save();
  ctx.strokeStyle = "#ff4d8d";
  ctx.lineWidth = Math.max(1, W / 960);
  ctx.setLineDash([6, 6]);
  if (guides.x) { ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); }
  if (guides.y) { ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); }
  ctx.restore();
}
/** Visual clips active at t, ordered bottom -> top (the paint order). */
function paintOrder({ tracks, clips }, t) {
  const out = [];
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    if (tr.hidden || tr.type === "audio") continue;
    out.push(
      ...Object.values(clips)
        .filter((c) => c.trackId === tr.id && isActive(c, t))
        .sort((a, b) => (a.props.z ?? 0) - (b.props.z ?? 0) || a.start - b.start),
    );
  }
  return out;
}

export function renderFrame(ctx, W, H, state, t, pool, opts = {}) {
  const o = { chromaMax: 640, selection: null, ...opts };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (FILTERS_OK) ctx.filter = "none";
  ctx.fillStyle = state.project?.background || "#000";
  ctx.fillRect(0, 0, W, H);

  for (const clip of paintOrder(state, t)) {
    const asset = state.assets[clip.assetId];
    if ((clip.kind === "video" || clip.kind === "image") && !asset) continue;
    drawClip(ctx, W, H, clip, asset, pool, o, t);
  }

  if (o.selection) {
    const g = selectionGeometry(ctx, W, H, state, t, pool, o.selection);
    if (g) drawHandles(ctx, g);
  }
  if (o.guides) drawGuides(ctx, W, H, o.guides);
}

/** Topmost clip under canvas point (x, y), or null. Used for click-to-select on the canvas. */
export function hitTest(ctx, W, H, state, t, pool, x, y) {
  const order = paintOrder(state, t).reverse();
  for (const clip of order) {
    const asset = state.assets[clip.assetId];
    if ((clip.kind === "video" || clip.kind === "image") && !asset) continue;
    const size = baseSize(ctx, clip, asset, pool, W, H);
    if (!size) continue;
    const p = clip.props;
    const a = (-p.rotation * Math.PI) / 180;
    const dx = x - p.x * W, dy = y - p.y * H;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= (size.w * p.scale) / 2 && Math.abs(ly) <= (size.h * p.scale) / 2) return clip.id;
  }
  return null;
}
