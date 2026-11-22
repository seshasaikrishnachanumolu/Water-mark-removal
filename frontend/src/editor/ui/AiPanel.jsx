import { useEffect, useState } from "react";
import { aiCaptions, aiCapabilities, aiEnhance, aiJob, aiJobResult, aiRemoveBackground, aiRemoveBackgroundVideo } from "../../api";
import { importFile } from "../engine/assets";
import { getBlob } from "../engine/mediaStore";
import { textProps } from "../presets";
import { useEditor } from "../store/useEditor";

/**
 * AI tools. Every action:
 *   - checks /api/ai/capabilities first (disabled with a reason when unavailable),
 *   - sends the *selected clip's* source file to a new /api/ai/* route,
 *   - writes the result back as a normal editable asset/clip (so it's undoable and
 *     never touches the watermark-removal pipeline).
 */
export default function AiPanel({ notify }) {
  const [caps, setCaps] = useState(null);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const selId = useEditor((s) => s.selection);
  const clip = useEditor((s) => s.clips[selId]);
  const asset = useEditor((s) => (clip ? s.assets[clip.assetId] : null));

  useEffect(() => {
    aiCapabilities().then(setCaps).catch(() => notify("AI backend unreachable", "error"));
  }, [notify]);

  const blobOf = async () => {
    const stored = await getBlob(asset.id);
    return stored || (await (await fetch(asset.url)).blob());
  };
  const fileOf = async () => new File([await blobOf()], asset.name, { type: asset.kind === "image" ? "image/png" : "video/mp4" });

  async function run(name, fn) {
    setBusy(name);
    setProgress(0);
    try {
      await fn();
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy("");
    }
  }

  const captions = () =>
    run("captions", async () => {
      const { segments, language } = await aiCaptions(new File([await blobOf()], asset.name));
      const s = useEditor.getState();
      const srcEnd = clip.in + clip.duration * clip.speed;
      s.checkpoint();
      let n = 0;
      for (const seg of segments) {
        if (seg.end <= clip.in || seg.start >= srcEnd) continue; // outside the trimmed range
        const start = clip.start + (Math.max(seg.start, clip.in) - clip.in) / clip.speed;
        const end = clip.start + (Math.min(seg.end, srcEnd) - clip.in) / clip.speed;
        s.addClip(
          { kind: "text", trackType: "text", name: "Caption", start, duration: Math.max(0.3, end - start),
            props: textProps({ text: seg.text, fontSize: 0.045, bg: "rgba(0,0,0,0.62)", y: 0.86 }) },
          { silent: true },
        );
        n++;
      }
      notify(`Added ${n} caption blocks (${language}). Edit them like any text clip.`, "ok");
    });

  const removeBg = () =>
    run("bg", async () => {
      const png = await aiRemoveBackground(await fileOf());
      const a = await importFile(new File([png], asset.name.replace(/\.\w+$/, "") + "-cutout.png", { type: "image/png" }));
      const s = useEditor.getState();
      s.checkpoint();
      s.swapClipAsset(clip.id, a);
      notify("Background removed. The cut-out is transparent, so you can place it over anything.", "ok");
    });

  // Shared by the long-running video jobs: poll, fetch the result, swap it into the clip.
  async function finishJob(job_id, suffix, mime, okMsg) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const j = await aiJob(job_id);
      setProgress(j.progress);
      if (j.status === "error") throw new Error(j.error || "Job failed");
      if (j.status === "done") break;
    }
    const blob = await aiJobResult(job_id);
    const a = await importFile(new File([blob], asset.name.replace(/\.\w+$/, "") + suffix, { type: mime }));
    const s = useEditor.getState();
    s.checkpoint();
    s.swapClipAsset(clip.id, a);
    notify(okMsg, "ok");
  }

  const removeBgVideo = () =>
    run("bgv", async () => {
      const { job_id, max_seconds } = await aiRemoveBackgroundVideo(await fileOf());
      await finishJob(job_id, "-cutout.webm", "video/webm",
        `Subject isolated (first ${max_seconds}s, up to 720p). Place a background track underneath.`);
    });

  const enhance = () =>
    run("enhance", async () => {
      const { job_id } = await aiEnhance(await fileOf(), { scale: 2, sharpen: 0.8 });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const j = await aiJob(job_id);
        setProgress(j.progress);
        if (j.status === "error") throw new Error(j.error || "Enhance failed");
        if (j.status === "done") break;
      }
      const blob = await aiJobResult(job_id);
      const a = await importFile(new File([blob], asset.name.replace(/\.\w+$/, "") + "-2x.mp4", { type: "video/mp4" }));
      const s = useEditor.getState();
      s.checkpoint();
      s.swapClipAsset(clip.id, a);
      notify("Upscaled to 2x with sharpening.", "ok");
    });

  const isVideo = clip?.kind === "video";
  const isImage = clip?.kind === "image";
  const canCaption = clip && (clip.kind === "video" || clip.kind === "audio");

  const Card = ({ title, desc, onClick, enabled, reason, id }) => (
    <div className="mb-3 rounded-lg border border-ed-line bg-ed-raise p-3">
      <p className="text-sm font-medium text-ed-text">{title}</p>
      <p className="mt-1 text-xs text-ed-mute">{desc}</p>
      <button
        onClick={onClick}
        disabled={!enabled || !!busy}
        className="mt-3 rounded-md bg-gold px-3 py-1.5 text-xs font-semibold text-ed-bg disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy === id ? ((id === "enhance" || id === "bgv") && progress ? `Working ${Math.round(progress * 100)}%` : "Working...") : "Run"}
      </button>
      {!enabled && reason && <p className="mt-2 text-[11px] text-amber-300/90">{reason}</p>}
    </div>
  );

  const c = caps || {};
  return (
    <div>
      <p className="mb-3 text-xs text-ed-mute">
        {clip ? <>Selected: <span className="text-ed-text">{clip.name}</span></> : "Select a clip on the timeline to use these tools."}
      </p>
      <Card id="captions" title="Auto captions" desc="Transcribe speech into editable text clips on the Text track."
        onClick={captions} enabled={canCaption && c.captions?.available}
        reason={!canCaption ? "Select a video or audio clip." : !c.captions?.available ? c.captions?.hint : ""} />
      <Card id="bg" title="Remove background" desc="Cut out the subject of a photo as a transparent PNG."
        onClick={removeBg} enabled={isImage && c.background_removal?.available}
        reason={!isImage ? "Select an image clip. For green-screen video, use Chroma key in the inspector." : c.background_removal?.mode === "grabcut" ? "Using the basic fallback. Install rembg for better results." : ""} />
      <Card id="bgv" title="Remove background (video)" desc="AI green screen: isolates the subject on a transparent background. Processes up to 30 seconds at 720p."
        onClick={removeBgVideo} enabled={isVideo && c.video_background_removal?.available}
        reason={!isVideo ? "Select a video clip." : c.video_background_removal?.hint} />
      <Card id="enhance" title="Upscale and enhance" desc="2x upscale (up to 4K) with sharpening. Classical Lanczos pipeline."
        onClick={enhance} enabled={isVideo && c.enhance?.available}
        reason={!isVideo ? "Select a video clip." : ""} />
      <div className="rounded-lg border border-dashed border-ed-line p-3 opacity-70">
        <p className="text-sm font-medium text-ed-text">Generative FX</p>
        <p className="mt-1 text-xs text-ed-mute">Text-to-video, prompt-based background replacement and object insertion.</p>
        <p className="mt-2 text-[11px] text-amber-300/90">{c.generate?.hint || "Needs a generative provider."}</p>
      </div>
    </div>
  );
}
