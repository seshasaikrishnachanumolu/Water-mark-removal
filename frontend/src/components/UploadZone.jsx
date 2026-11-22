import { useRef, useState } from "react";

const MAX = 500 * 1024 * 1024;
const OK_EXT = [".mp4", ".mov", ".avi"];

/** Drag-and-drop / click-to-browse upload box with validation and progress. */
export default function UploadZone({ onFile, progress, busy }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");

  function pick(file) {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!OK_EXT.includes(ext)) return setError("Please choose an MP4, MOV or AVI file.");
    if (file.size > MAX) return setError("File is larger than 500MB.");
    setError("");
    onFile(file);
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a video"
        onClick={() => !busy && input.current.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy) pick(e.dataTransfer.files[0]);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-14 text-center transition ${
          over ? "border-gold bg-gold/10" : "border-ink/25 hover:border-gold"
        }`}
      >
        <p className="text-lg font-medium">Drop a video here or click to browse</p>
        <p className="mt-1 text-sm text-ink/65">MP4, MOV or AVI, up to 500MB</p>
        {busy && (
          <div className="mt-6 w-full max-w-sm">
            <div className="h-2 overflow-hidden rounded bg-ink/10">
              <div className="h-full bg-gold transition-all" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="mt-2 text-sm text-ink/65">
              {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : "Preparing preview..."}
            </p>
          </div>
        )}
        <input
          ref={input}
          type="file"
          accept=".mp4,.mov,.avi,video/*"
          className="hidden"
          onChange={(e) => pick(e.target.files[0])}
        />
      </div>
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
    </div>
  );
}
