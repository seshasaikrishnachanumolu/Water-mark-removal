import { useRef } from "react";
import { previewUrl, resultUrl } from "../api";
import { stageHandoff } from "../editor/engine/project";

/** Side-by-side original vs. cleaned video with synced playback + download. */
export default function ResultView({ videoId, jobId }) {
  const a = useRef(null);
  const b = useRef(null);

  const both = (fn) => [a.current, b.current].forEach(fn);
  const playPause = () =>
    both((v) => {
      if (a.current.paused) v.play();
      else v.pause();
    });
  const restart = () =>
    both((v) => {
      v.currentTime = 0;
    });

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2">
        <figure>
          <video ref={a} src={previewUrl(videoId)} muted loop className="w-full rounded-xl bg-black" />
          <figcaption className="mt-1 text-center text-sm text-ink/65">Original</figcaption>
        </figure>
        <figure>
          <video ref={b} src={resultUrl(jobId)} muted loop className="w-full rounded-xl bg-black" />
          <figcaption className="mt-1 text-center text-sm text-ink/65">Cleaned</figcaption>
        </figure>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button onClick={playPause} className="rounded-lg bg-ink/10 px-4 py-2 hover:bg-ink/15">
          Play / pause both
        </button>
        <button onClick={restart} className="rounded-lg bg-ink/10 px-4 py-2 hover:bg-ink/15">
          Restart
        </button>
        <a href={resultUrl(jobId, true)} className="rounded-lg bg-ink text-paper px-4 py-2 font-medium hover:bg-ink/85">
          Download MP4
        </a>
        <button
          onClick={() => stageHandoff(resultUrl(jobId), "cleaned.mp4")}
          className="rounded-lg border border-gold px-4 py-2 font-medium text-gold hover:bg-gold/10"
        >
          Open in Studio Editor
        </button>
      </div>
    </div>
  );
}
