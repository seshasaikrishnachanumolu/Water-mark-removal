import { useEditor } from "../store/useEditor";
import { getBlob, loadProject, saveBlob, saveProject } from "./mediaStore";
import { importFile } from "./assets";

const HANDOFF_KEY = "clearframe.handoff";

/** Debounced autosave of the project JSON (media blobs are saved at import time). */
export function startAutosave() {
  let timer;
  const persist = () => {
    const s = useEditor.getState();
    const assets = Object.fromEntries(
      Object.entries(s.assets).map(([id, { url: _u, ...meta }]) => [id, meta]),
    );
    saveProject({ project: s.project, tracks: s.tracks, clips: s.clips, assets }).catch(() => {});
  };
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.tracks === prev.tracks && s.clips === prev.clips && s.assets === prev.assets && s.project === prev.project) return;
    clearTimeout(timer);
    timer = setTimeout(persist, 800);
  });
  // Changes made during boot (e.g. a handed-off video) happened before we subscribed.
  persist();
  return () => {
    clearTimeout(timer);
    unsub();
  };
}

/** Rebuild the last project: re-create object URLs from the blobs stored in IndexedDB. */
export async function restoreProject() {
  const saved = await loadProject();
  if (!saved) return false;
  const assets = {};
  for (const [id, meta] of Object.entries(saved.assets || {})) {
    const blob = await getBlob(id);
    if (blob) assets[id] = { ...meta, url: URL.createObjectURL(blob) };
  }
  // Drop clips whose media is gone.
  const clips = Object.fromEntries(
    Object.entries(saved.clips).filter(([, c]) => !c.assetId || assets[c.assetId]),
  );
  useEditor.getState().hydrate({ project: saved.project, tracks: saved.tracks, clips, assets });
  return true;
}

/** "Open in Studio Editor": the remover stores a pointer to the cleaned file, we pull it in. */
export function stageHandoff(url, name, kind = "video") {
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ url, name, kind }));
  window.location.hash = "#/editor";
}

export async function consumeHandoff() {
  const raw = sessionStorage.getItem(HANDOFF_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(HANDOFF_KEY); // one-shot
  const { url, name } = JSON.parse(raw);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load the cleaned video from the server");
  const blob = await res.blob();
  const file = new File([blob], name, { type: blob.type || "video/mp4" });
  const asset = await importFile(file, name);
  const id = useEditor.getState().addAssetClip(asset.id);
  return { asset, clipId: id };
}

export { saveBlob };
