import { useCallback, useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { consumeHandoff, restoreProject, startAutosave } from "./engine/project";
import { projectDuration } from "./engine/timeline";
import { useEditor } from "./store/useEditor";
import AssetPanel from "./ui/AssetPanel";
import ExportModal from "./ui/ExportModal";
import Inspector from "./ui/Inspector";
import Preview from "./ui/Preview";
import Timeline from "./ui/Timeline";

const RATIOS = [
  ["16:9", 1920, 1080],
  ["9:16", 1080, 1920],
  ["1:1", 1080, 1080],
  ["4:5", 1080, 1350],
];

export default function EditorPage() {
  const [ready, setReady] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState(null);
  const project = useEditor((s) => s.project);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);

  const notify = useCallback((msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // Boot: restore the saved project, then pull in a cleaned video handed over by the remover.
  useEffect(() => {
    let stop = () => {};
    (async () => {
      try {
        await restoreProject();
        const handed = await consumeHandoff();
        if (handed) notify("Your cleaned video is on the timeline.", "ok");
      } catch (e) {
        notify(e.message, "error");
      }
      setReady(true);
      stop = startAutosave();
    })();
    return () => {
      stop();
      useEditor.getState().setPlaying(false);
    };
  }, [notify]);

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === "Space") {
        e.preventDefault();
        if (!s.playing && s.time >= projectDuration(s.clips) - 0.05) s.setTime(0);
        s.setPlaying(!s.playing);
      } else if (e.key.toLowerCase() === "s" && !mod) s.splitAtPlayhead();
      else if ((e.key === "Delete" || e.key === "Backspace") && s.selection) s.deleteClip(s.selection);
      else if (mod && e.key.toLowerCase() === "d" && s.selection) { e.preventDefault(); s.duplicateClip(s.selection); }
      else if (mod && e.key.toLowerCase() === "c" && s.selection) s.copyClip();
      else if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); s.pasteClip(); }
      else if (s.selection && e.key.startsWith("Arrow") && s.clips[s.selection]) {
        // Nudge the selected layer: 0.5% of the canvas, 5% with Shift.
        e.preventDefault();
        const step = e.shiftKey ? 0.05 : 0.005;
        const p = s.clips[s.selection].props;
        s.checkpoint();
        s.updateProps(s.selection, {
          x: p.x + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0),
          y: p.y + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0),
        });
      }
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); s.redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ratio = RATIOS.find(([, w, h]) => w === project.width && h === project.height)?.[0] ?? "custom";
  const tb = "rounded-md px-2.5 py-1.5 text-sm text-ed-mute hover:bg-ed-raise hover:text-ed-text disabled:opacity-30";

  return (
    <div className="flex h-screen flex-col bg-ed-bg text-ed-text">
      <header className="flex items-center gap-4 border-b border-ed-line bg-ed-panel px-4 py-2">
        <a href="#/" className="font-display text-lg font-semibold">Clearframe</a>
        <AppNav current="#/editor" dark />
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ed-mute">
            Canvas
            <select
              value={ratio}
              onChange={(e) => {
                const r = RATIOS.find(([n]) => n === e.target.value);
                if (r) useEditor.getState().setProject({ width: r[1], height: r[2] });
              }}
              className="rounded-md border border-ed-line bg-ed-bg px-2 py-1 text-ed-text"
              aria-label="Canvas aspect ratio"
            >
              {ratio === "custom" && <option value="custom">Custom</option>}
              {RATIOS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-ed-mute">
            Background
            <input type="color" value={project.background || "#000000"} aria-label="Canvas background color"
              onChange={(ev) => useEditor.getState().setProject({ background: ev.target.value })}
              className="h-7 w-8 cursor-pointer rounded border border-ed-line bg-transparent" />
          </label>
          <button className={tb} disabled={!canUndo} onClick={() => useEditor.getState().undo()} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button className={tb} disabled={!canRedo} onClick={() => useEditor.getState().redo()} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
          <button
            className={tb}
            onClick={() => { if (confirm("Start a new project? The current one will be cleared.")) useEditor.getState().reset(); }}
          >
            New
          </button>
          <button onClick={() => setExporting(true)} className="rounded-md bg-gold px-4 py-1.5 text-sm font-semibold text-ed-bg hover:brightness-110">
            Export
          </button>
        </div>
      </header>

      {!ready ? (
        <div className="grid flex-1 place-items-center text-ed-mute">Loading project...</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_300px] grid-rows-[minmax(0,1fr)_300px]">
          <aside className="row-span-1 min-h-0 border-r border-ed-line bg-ed-panel"><AssetPanel notify={notify} /></aside>
          <main className="min-h-0"><Preview /></main>
          <aside className="min-h-0 overflow-y-auto border-l border-ed-line bg-ed-panel"><Inspector /></aside>
          <div className="col-span-3 min-h-0 border-t border-ed-line"><Timeline /></div>
        </div>
      )}

      {exporting && <ExportModal onClose={() => setExporting(false)} notify={notify} />}
      {toast && (
        <div role="status" className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-sm shadow-xl ${toast.type === "error" ? "bg-rose-900 text-rose-100" : "bg-sage text-white"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
