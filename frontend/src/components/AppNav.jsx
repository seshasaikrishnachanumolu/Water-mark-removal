/** Top-level mode switch shared by the remover and the editor. */
const LINKS = [
  ["#/studio", "Watermark Remover"],
  ["#/editor", "Studio Editor"],
  ["#/download", "Link Downloader"],
];

export default function AppNav({ current, dark = false }) {
  return (
    <nav aria-label="Tools" className="flex items-center gap-1">
      {LINKS.map(([href, label]) => {
        const active = href === current;
        return (
          <a
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              active
                ? dark ? "bg-gold text-ed-bg font-medium" : "bg-ink text-paper font-medium"
                : dark ? "text-ed-mute hover:text-ed-text" : "text-ink/65 hover:text-ink"
            }`}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
