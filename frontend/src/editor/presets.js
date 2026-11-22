// Built-in library content: text styles, shapes, emojis and one-click templates.

export const textProps = (o = {}) => ({
  text: "Your text",
  fontSize: 0.07, // fraction of canvas height
  color: "#ffffff",
  weight: 700,
  font: "Inter, system-ui, sans-serif",
  bg: null,
  stroke: "#000000",
  strokeWidth: 0,
  ...o,
});

export const TEXT_PRESETS = [
  { label: "Title", sample: "Aa", def: { name: "Title", props: textProps({ text: "Add a title", fontSize: 0.11, font: "Fraunces, Georgia, serif", y: 0.45 }) } },
  { label: "Subtitle", sample: "Aa", def: { name: "Subtitle", props: textProps({ text: "Subtitle goes here", fontSize: 0.055, weight: 500, y: 0.58 }) } },
  { label: "Caption", sample: "Aa", def: { name: "Caption", props: textProps({ text: "Caption text", fontSize: 0.045, bg: "rgba(0,0,0,0.62)", y: 0.86 }) } },
  { label: "Outline", sample: "Aa", def: { name: "Outline", props: textProps({ text: "BIG IMPACT", fontSize: 0.12, font: "Impact, Haettenschweiler, sans-serif", weight: 400, strokeWidth: 0.12, color: "#ffd24a" }) } },
  { label: "Gold serif", sample: "Aa", def: { name: "Serif", props: textProps({ text: "Elegant", fontSize: 0.1, font: "Fraunces, Georgia, serif", weight: 600, color: "#e0b866" }) } },
  { label: "Handwritten", sample: "Aa", def: { name: "Script", props: textProps({ text: "Hello!", fontSize: 0.1, font: "'Segoe Script','Brush Script MT',cursive", weight: 400 }) } },
];

export const SHAPES = ["rect", "rounded", "circle", "triangle", "diamond", "star"];
export const SHAPE_COLORS = ["#b08a3e", "#55766a", "#e4572e", "#2e86ab", "#f6f1e7", "#1d2433"];

export const EMOJIS = [
  "😀", "😂", "😍", "😎", "🥳", "🤩", "😭", "🔥", "✨", "💯", "❤️", "👍",
  "👏", "🙌", "🎉", "🎬", "🎵", "⭐", "🌈", "☀️", "🌙", "⚡", "💥", "🚀",
  "🏆", "🎯", "💡", "📍", "✅", "❌", "➡️", "🔔",
];

/** Templates add several clips at once, positioned relative to the playhead. */
export const TEMPLATES = [
  {
    label: "Lower third",
    hint: "Name bar with a title",
    clips: [
      { kind: "shape", trackType: "overlay", name: "Bar", duration: 5, props: { shape: "rect", fill: "#b08a3e", x: 0.25, y: 0.84, scale: 1.4, opacity: 0.95 } },
      { kind: "text", trackType: "text", name: "Name", duration: 5, props: textProps({ text: "Your Name\nYour title", fontSize: 0.045, x: 0.25, y: 0.84, color: "#1d2433", weight: 600 }) },
    ],
  },
  {
    label: "Title card",
    hint: "Centered title + subtitle",
    clips: [
      { kind: "text", trackType: "text", name: "Title", duration: 4, props: textProps({ text: "The Big Idea", fontSize: 0.13, font: "Fraunces, Georgia, serif", y: 0.44 }) },
      { kind: "text", trackType: "text", name: "Subtitle", duration: 4, props: textProps({ text: "A short supporting line", fontSize: 0.05, weight: 500, y: 0.6, color: "#e0b866" }) },
    ],
  },
  {
    label: "Social call-out",
    hint: "Emoji + punchy caption",
    clips: [
      { kind: "emoji", trackType: "overlay", name: "Emoji", duration: 3, props: { emoji: "🔥", x: 0.5, y: 0.35, scale: 1.4 } },
      { kind: "text", trackType: "text", name: "Caption", duration: 3, props: textProps({ text: "Follow for more", fontSize: 0.06, bg: "rgba(0,0,0,0.65)", y: 0.8 }) },
    ],
  },
];

/** Speed-curve presets: points are {t: 0..1 along the clip, v: playback speed}. */
export const SPEED_PRESETS = [
  { label: "Ramp up", curve: [{ t: 0, v: 0.5 }, { t: 1, v: 2.5 }] },
  { label: "Ramp down", curve: [{ t: 0, v: 2.5 }, { t: 1, v: 0.5 }] },
  { label: "Montage", curve: [{ t: 0, v: 1 }, { t: 0.3, v: 1 }, { t: 0.4, v: 3 }, { t: 0.6, v: 3 }, { t: 0.7, v: 1 }, { t: 1, v: 1 }] },
  { label: "Hero time", curve: [{ t: 0, v: 1 }, { t: 0.35, v: 1 }, { t: 0.5, v: 0.3 }, { t: 0.65, v: 1 }, { t: 1, v: 1 }] },
  { label: "Bullet", curve: [{ t: 0, v: 2 }, { t: 0.5, v: 0.25 }, { t: 1, v: 2 }] },
];


/** One-tap looks (CapCut "Filters"). Each sets the colour props; Original resets them. */
export const FILTER_PRESETS = [
  { label: "Original", v: { brightness: 1, contrast: 1, saturation: 1, sepia: 0, grayscale: 0, hue: 0 } },
  { label: "Vivid", v: { brightness: 1.05, contrast: 1.15, saturation: 1.6, sepia: 0, grayscale: 0, hue: 0 } },
  { label: "Warm", v: { brightness: 1.05, contrast: 1.05, saturation: 1.2, sepia: 0.25, grayscale: 0, hue: -8 } },
  { label: "Cool", v: { brightness: 1, contrast: 1.05, saturation: 1.1, sepia: 0, grayscale: 0, hue: 18 } },
  { label: "B&W", v: { brightness: 1, contrast: 1.15, saturation: 1, sepia: 0, grayscale: 1, hue: 0 } },
  { label: "Sepia", v: { brightness: 1, contrast: 1, saturation: 1, sepia: 0.85, grayscale: 0, hue: 0 } },
  { label: "Faded", v: { brightness: 1.1, contrast: 0.8, saturation: 0.75, sepia: 0.12, grayscale: 0, hue: 0 } },
  { label: "Drama", v: { brightness: 0.9, contrast: 1.45, saturation: 1.25, sepia: 0, grayscale: 0, hue: 0 } },
];

export const FONTS = [
  ["Inter", "Inter, system-ui, sans-serif"],
  ["Fraunces", "Fraunces, Georgia, serif"],
  ["Georgia", "Georgia, serif"],
  ["Impact", "Impact, Haettenschweiler, sans-serif"],
  ["Courier", "\"Courier New\", monospace"],
  ["Script", "\"Segoe Script\", \"Brush Script MT\", cursive"],
  ["Arial Black", "\"Arial Black\", Arial, sans-serif"],
];

