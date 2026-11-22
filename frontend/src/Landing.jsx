const STUDIO = "#/studio";

const features = [
  { t: "Auto-detect logos", d: "Finds static corner logos by comparing frames across the whole clip." },
  { t: "Box or brush", d: "Outline the mark precisely with a box, a soft brush and an eraser." },
  { t: "Fast or AI engines", d: "OpenCV for quick passes, LaMa or ProPainter for richer backgrounds." },
  { t: "Live progress", d: "Follow the render frame by frame, and cancel whenever you like." },
  { t: "Side-by-side review", d: "Play the original and the cleaned cut together before you download." },
  { t: "Audio preserved", d: "Your soundtrack is carried over into a clean H.264 MP4." },
];

const steps = [
  { n: "01", t: "Upload", d: "Drop in an MP4, MOV or AVI up to 500MB." },
  { n: "02", t: "Mark the watermark", d: "Let detection find it, or paint over it yourself." },
  { n: "03", t: "Render and download", d: "Compare the result, then save your clean video." },
];

function Brand() {
  return (
    <a href="#/" className="flex items-center gap-2 font-display text-xl font-semibold">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md border border-gold text-gold">
        <span className="h-3 w-3 rounded-sm border border-gold" />
      </span>
      Clearframe
    </a>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Brand />
        <nav aria-label="Main" className="hidden items-center gap-8 text-sm text-ink/70 md:flex">
          <a href="#features" className="hover:text-ink">Features</a>
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="#shorts" className="hover:text-ink">Shorts</a>
          <a href="#/editor" className="hover:text-ink">Studio Editor</a>
        </nav>
        <a href={STUDIO} className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper hover:bg-ink/85">
          Open studio
        </a>
      </header>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 lg:grid-cols-2 lg:pt-16">
        <div>
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-gold">Video watermark remover</p>
          <h1 className="text-5xl font-semibold leading-[1.05] sm:text-6xl">
            Give your footage <em className="font-medium text-gold">a clear frame</em> again.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink/70">
            Remove logos and overlays from video, rebuild the background with inpainting, and export a
            ready-to-post YouTube Short. All from one calm workspace.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a href={STUDIO} className="rounded-full bg-ink px-7 py-3 font-medium text-paper shadow-lg shadow-ink/20 hover:bg-ink/85">
              Start removing
            </a>
            <a href="#how" className="rounded-full border border-ink/20 px-7 py-3 font-medium hover:border-gold hover:text-gold">
              See how it works
            </a>
          </div>
          <p className="mt-6 text-sm text-ink/50">MP4, MOV and AVI · up to 500MB · no account needed</p>
        </div>

        <figure className="rounded-2xl border border-line bg-cream p-3 shadow-[0_30px_60px_-30px_rgb(29_36_51/0.4)]">
          <div className="scene" role="img" aria-label="A landscape clip where a corner logo fades away">
            <span className="mark">LOGO</span>
            <span className="sweep" />
          </div>
          <figcaption className="flex items-center justify-between px-2 pb-1 pt-3 text-sm text-ink/60">
            <span className="state-label font-medium text-ink" aria-hidden>
              <span className="before">Watermarked</span>
              <span className="after">Cleaned</span>
            </span>
            <span>Static logo removed with inpainting</span>
          </figcaption>
        </figure>
      </section>

      {/* Features */}
      <section id="features" className="border-y border-line bg-cream py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="max-w-xl text-4xl font-semibold">Everything you need, nothing you don't.</h2>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.t} className="bg-cream p-7">
                <span aria-hidden className="mb-4 block h-px w-8 bg-gold" />
                <h3 className="text-xl font-medium">{f.t}</h3>
                <p className="mt-2 leading-relaxed text-ink/65">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-4xl font-semibold">Three quiet steps.</h2>
        <ol className="mt-12 grid gap-10 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n}>
              <span className="font-display text-5xl text-gold/70">{s.n}</span>
              <h3 className="mt-3 text-xl font-medium">{s.t}</h3>
              <p className="mt-2 leading-relaxed text-ink/65">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Shorts */}
      <section id="shorts" className="border-t border-line bg-cream py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 md:grid-cols-2">
          <div className="order-2 md:order-1">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-gold">Built in</p>
            <h2 className="text-4xl font-semibold">Turn it into a YouTube Short.</h2>
            <p className="mt-5 max-w-md leading-relaxed text-ink/70">
              Export 1080×1920 at 30 or 60 fps, trimmed to three minutes. Fill the screen with a center
              crop, or keep the whole frame over a softly blurred backdrop.
            </p>
            <ul className="mt-6 space-y-2 text-ink/75">
              <li>· Center crop, no empty bars</li>
              <li>· Fit with blurred background, no crop</li>
              <li>· H.264 MP4, ready to upload</li>
            </ul>
          </div>
          <div className="order-1 flex justify-center md:order-2">
            <div className="phone" role="img" aria-label="Phone showing a video centered over a blurred background">
              <div className="screen">
                <div className="blur-bg" />
                <div className="fg" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="rounded-3xl bg-ink px-8 py-16 text-center text-paper">
          <h2 className="mx-auto max-w-2xl text-4xl font-semibold">Your footage, without the distraction.</h2>
          <a href={STUDIO} className="mt-8 inline-block rounded-full bg-gold px-8 py-3 font-medium text-ink hover:bg-gold/90">
            Open the studio
          </a>
        </div>
      </section>

      <footer className="border-t border-line py-8 text-center text-sm text-ink/50">
        Clearframe · Only edit footage you own or have permission to modify.
      </footer>
    </div>
  );
}
