import { renderFrame } from "./compositor";
import { MediaPool, seekAll, syncMedia, waitBuffered } from "./mediaPool";
import { projectDuration } from "./timeline";

/**
 * Hybrid export:
 *   1. The browser renders every frame with the same compositor as the preview and
 *      records canvas + mixed audio with MediaRecorder (real time, WebM or MP4).
 *   2. For MP4/MOV the recording is sent to /api/export/transcode, which produces a
 *      constant-frame-rate H.264/AAC file.
 *
 * Note: rendering is real time and browsers throttle background tabs, so the
 * export dialog asks the user to keep the tab visible.
 */

/** Output size for a quality preset, preserving the project's aspect ratio. */
export function outputSize(project, shortSide) {
  const k = shortSide / Math.min(project.width, project.height);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(project.width * k), height: even(project.height * k) };
}

function pickMime() {
  const list = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

export async function exportVideo({ state, width, height, fps, onProgress, signal }) {
  const duration = projectDuration(state.clips);
  if (duration <= 0) throw new Error("The timeline is empty");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const pool = new MediaPool({ audioCtx, dest });

  const stream = canvas.captureStream(fps);
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));

  const mime = pickMime();
  const pixels = width * height;
  const recorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: Math.min(60_000_000, Math.round(pixels * fps * 0.12)),
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => (recorder.onstop = res));

  try {
    await audioCtx.resume();
    await seekAll(pool, state, 0); // make sure frame 0 is decoded before we start the clock
    await waitBuffered(pool, state, 0); // ...and that playback will not stall right after it
    syncMedia(pool, state, 0, true);
    recorder.start(1000);

    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const tick = (now) => {
        if (signal?.aborted) return reject(new DOMException("Export cancelled", "AbortError"));
        const t = (now - t0) / 1000;
        if (t >= duration) return resolve();
        // Large drift tolerance: re-seeking mid-recording causes visible stalls.
        syncMedia(pool, state, t, true, { drift: 1.0 });
        renderFrame(ctx, width, height, state, t, pool, { chromaMax: 1280, hold: true });
        onProgress?.(t / duration);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    recorder.stop();
    await stopped;
    onProgress?.(1);
    return { blob: new Blob(chunks, { type: recorder.mimeType || "video/webm" }), mime: recorder.mimeType };
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    pool.dispose();
    audioCtx.close();
  }
}

/** Render the frame under the playhead to PNG/JPG. */
export async function exportStill({ state, time, width, height, type = "image/png", quality = 0.95 }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const pool = new MediaPool();
  try {
    await seekAll(pool, state, time);
    renderFrame(canvas.getContext("2d"), width, height, state, time, pool, { chromaMax: 1920 });
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Encode failed"))), type, quality));
  } finally {
    pool.dispose();
  }
}
