import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clip } from "./clips.js";

// Emit index.json (machine-readable, ranked) and index.html (a zero-dependency
// gallery that plays each clip inline, highest-scored first).

export type EpisodeIndex = {
  slug: string;
  name: string;
  manifestCid: string;
  generatedAt: string;
  clipCount: number;
  clips: Clip[];
};

const mmss = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function writeGallery(opts: {
  outDir: string;
  slug: string;
  name: string;
  manifestCid: string;
  generatedAt: string;
  clips: Clip[];
}): Promise<void> {
  const index: EpisodeIndex = {
    slug: opts.slug,
    name: opts.name,
    manifestCid: opts.manifestCid,
    generatedAt: opts.generatedAt,
    clipCount: opts.clips.length,
    clips: opts.clips,
  };
  await writeFile(join(opts.outDir, "index.json"), JSON.stringify(index, null, 2));

  const cards = opts.clips
    .map(
      c => `
    <article class="clip">
      <div class="vid"><video controls preload="none" src="clips/${esc(c.file)}"></video></div>
      <div class="meta">
        <div class="row">
          <span class="score">${c.score}</span>
          <h2>${esc(c.title)}</h2>
        </div>
        <p class="reason">${esc(c.reason)}</p>
        <p class="tags">${c.kind ? `<b>${esc(c.kind)}</b> · ` : ""}${c.tags.map(esc).join(" · ")}</p>
        <p class="time">${mmss(c.start)}–${mmss(c.end)} · ${c.duration}s · <a href="clips/${esc(c.file)}" download>download</a> · <a href="clips/${esc(c.srt)}">srt</a></p>
        <details><summary>transcript</summary><p class="text">${esc(c.text)}</p></details>
      </div>
    </article>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>clips · ${esc(opts.name || opts.slug)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0e10; color: #e8e8ea; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 24px; border-bottom: 1px solid #26262b; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .sub { color: #8a8a93; font-size: 12px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; padding: 24px; }
  .clip { background: #161619; border: 1px solid #26262b; border-radius: 10px; overflow: hidden; }
  .vid { background: #000; aspect-ratio: 16 / 9; }
  .vid video { width: 100%; height: 100%; display: block; }
  .meta { padding: 12px 14px 14px; }
  .row { display: flex; align-items: baseline; gap: 10px; }
  .row h2 { margin: 0; font-size: 14px; line-height: 1.3; }
  .score { flex: none; font-weight: 700; color: #0e0e10; background: #7dd3fc; border-radius: 6px; padding: 1px 8px; font-size: 13px; }
  .reason { color: #c4c4cc; margin: 8px 0 6px; }
  .tags { color: #8a8a93; font-size: 12px; margin: 4px 0; }
  .tags b { color: #7dd3fc; }
  .time { color: #6f6f78; font-size: 12px; margin: 6px 0 0; }
  .time a { color: #9aa6ff; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #8a8a93; font-size: 12px; }
  .text { color: #b0b0b8; font-size: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<header>
  <h1>${esc(opts.name || opts.slug)} — ${opts.clips.length} clips</h1>
  <div class="sub">slop.computer/${esc(opts.slug)} · sorted by predicted shareability · generated ${esc(opts.generatedAt)}</div>
</header>
<main>
${cards}
</main>
</body>
</html>`;
  await writeFile(join(opts.outDir, "index.html"), html);
}
