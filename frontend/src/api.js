// Thin wrapper around the FastAPI backend (proxied through Vite at /api).

async function json(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).detail || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// XHR instead of fetch so we get upload progress events.
export function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      xhr.status >= 200 && xhr.status < 300
        ? resolve(body)
        : reject(new Error(body.detail || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error - is the backend running?"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const getAlgorithms = () => fetch("/api/algorithms").then(json);
export const detectWatermark = (id) => fetch(`/api/videos/${id}/detect`, { method: "POST" }).then(json);
export const frameUrl = (id, t) => `/api/videos/${id}/frame?t=${t}`;
export const previewUrl = (id) => `/api/videos/${id}/preview`;
export const resultUrl = (jobId, download = false) =>
  `/api/jobs/${jobId}/result${download ? "?download=1" : ""}`;

export const startJob = (body) =>
  fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json);

export const getJob = (id) => fetch(`/api/jobs/${id}`).then(json);
export const cancelJob = (id) => fetch(`/api/jobs/${id}`, { method: "DELETE" }).then(json);

export const startShort = (body) =>
  fetch("/api/shorts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json);

// ---------------------------------------------------------------- Studio / AI
// These talk to *new* routes only (/api/ai/*, /api/export/*); the remover endpoints
// above are untouched.
export const aiCapabilities = () => fetch("/api/ai/capabilities").then(json);

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

export const aiCaptions = (file, language) =>
  fetch("/api/ai/captions", { method: "POST", body: form({ file, ...(language ? { language } : {}) }) }).then(json);

export async function aiRemoveBackground(file) {
  const res = await fetch("/api/ai/remove-background", { method: "POST", body: form({ file }) });
  if (!res.ok) await json(res);
  return res.blob();
}

export const aiEnhance = (file, opts = {}) =>
  fetch("/api/ai/enhance", {
    method: "POST",
    body: form({ file, scale: opts.scale ?? 2, sharpen: opts.sharpen ?? 0.8, denoise: !!opts.denoise }),
  }).then(json);
export const aiJob = (id) => fetch(`/api/ai/jobs/${id}`).then(json);
export const aiJobResult = async (id) => (await fetch(`/api/ai/jobs/${id}/result`)).blob();

export async function transcodeExport(blob, { fmt, fps }) {
  const res = await fetch("/api/export/transcode", { method: "POST", body: form({ file: blob, fmt, fps }) });
  if (!res.ok) await json(res);
  return res.blob();
}

export async function removeImageWatermark(file, mask, algorithm, dilate) {
  const res = await fetch("/api/images/remove-watermark", {
    method: "POST",
    body: form({ file, mask, algorithm, dilate }),
  });
  if (!res.ok) await json(res);
  return res.blob();
}

export const aiRemoveBackgroundVideo = (file) =>
  fetch("/api/ai/remove-background-video", { method: "POST", body: form({ file }) }).then(json);


// ------------------------------------------------------------ link downloader
export const dlSites = () => fetch("/api/download/sites").then(json);
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json);
export const dlInfo = (url) => post("/api/download/info", { url });
export const dlStart = (url, confirm_rights, quality = "best") =>
  post("/api/download/start", { url, confirm_rights, quality });
export const dlJob = (id) => fetch(`/api/download/jobs/${id}`).then(json);
export const dlCancel = (id) => fetch(`/api/download/jobs/${id}`, { method: "DELETE" }).then(json);
export const dlFileUrl = (videoId) => `/api/download/${videoId}/file`;
