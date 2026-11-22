import { transcodeExport } from "../../api";
import { uid, useEditor } from "../store/useEditor";
import { saveBlob } from "./mediaStore";

const kindOf = (type, name = "") => {
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  // Some browsers leave .mkv / .avi / .wmv untyped.
  return /\.(avi|mkv|wmv|flv|mpg|mpeg|m4v|3gp)$/i.test(name) ? "video" : null;
};

/** Read duration / pixel size without decoding the whole file. */
function probeMedia(kind, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out reading the file")), 15000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("This browser can't decode that file."));
    };
    if (kind === "image") {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
      };
      img.onerror = fail;
      img.src = url;
      return;
    }
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve({ width: el.videoWidth || 0, height: el.videoHeight || 0, duration: el.duration || 0 });
    };
    el.onerror = fail;
    el.src = url;
  });
}

/**
 * Register a File/Blob as a library asset. The blob goes to IndexedDB (disk-backed),
 * and the editor only ever holds an object URL, never the bytes in JS memory.
 * Video the browser can't decode (AVI, MKV, odd codecs) is converted to H.264 MP4 by
 * the backend first. `onStatus` receives short progress messages for the UI.
 */
export async function importFile(file, name, onStatus) {
  const kind = kindOf(file.type, file.name);
  if (!kind) throw new Error(`Unsupported file type: ${file.type || file.name}`);

  let blob = file;
  let url = URL.createObjectURL(blob);
  let meta;
  try {
    try {
      meta = await probeMedia(kind, url);
    } catch (err) {
      if (kind !== "video") throw err;
      onStatus?.("Converting to MP4 on the server...");
      URL.revokeObjectURL(url);
      const mp4 = await transcodeExport(file, { fmt: "mp4", fps: 0 });
      blob = new File([mp4], (name || file.name).replace(/\.\w+$/, "") + ".mp4", { type: "video/mp4" });
      url = URL.createObjectURL(blob);
      meta = await probeMedia(kind, url);
    }
    const id = uid();
    await saveBlob(id, blob);
    const asset = { id, kind, name: name || blob.name || file.name, url, ...meta };
    useEditor.getState().addAsset(asset);
    // Decorations are generated in the background so import feels instant.
    decorate(asset, blob);
    return asset;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

// ----------------------------------------------------------- thumbnails + waveform
const STRIP_FRAMES = 10;
const STRIP_H = 56;

async function decorate(asset, blob) {
  const patch = (p) => useEditor.getState().patchAsset(asset.id, p);
  try {
    if (asset.kind === "video" && asset.duration > 0) patch({ strip: await filmstrip(asset) });
  } catch { /* purely cosmetic */ }
  try {
    if (asset.kind !== "image" && blob.size < 80 * 1024 * 1024) patch({ peaks: await waveform(blob, asset.duration) });
  } catch { /* no audio track, or too long to decode: skip */ }
}

/** One wide JPEG made of evenly spaced frames; the timeline stretches it over the clip. */
async function filmstrip(asset) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = asset.url;
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = rej;
    setTimeout(rej, 10000);
  });
  const fw = Math.round((STRIP_H * asset.width) / asset.height) || 100;
  const canvas = document.createElement("canvas");
  canvas.width = fw * STRIP_FRAMES;
  canvas.height = STRIP_H;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < STRIP_FRAMES; i++) {
    const seeked = new Promise((res) => {
      v.onseeked = res;
      setTimeout(res, 2000);
    });
    v.currentTime = Math.min(asset.duration - 0.05, ((i + 0.5) / STRIP_FRAMES) * asset.duration);
    await seeked;
    ctx.drawImage(v, i * fw, 0, fw, STRIP_H);
  }
  v.removeAttribute("src");
  v.load();
  return { url: canvas.toDataURL("image/jpeg", 0.6), w: canvas.width, h: STRIP_H };
}

/** Peak amplitudes (0..100), 20 per second. */
async function waveform(blob, duration) {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    const bins = Math.max(1, Math.ceil((duration || buf.duration) * 20));
    const per = Math.max(1, Math.floor(ch.length / bins));
    const peaks = new Array(bins);
    for (let b = 0; b < bins; b++) {
      let m = 0;
      for (let i = b * per, end = Math.min(ch.length, i + per); i < end; i += 8) m = Math.max(m, Math.abs(ch[i]));
      peaks[b] = Math.round(Math.min(1, m) * 100);
    }
    return peaks;
  } finally {
    ctx.close();
  }
}
