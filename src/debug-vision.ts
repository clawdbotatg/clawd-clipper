import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { probeSize } from "./ffmpeg.js";
import { clipKey } from "./judge.js";
import { composeLayout, detectClipWindows, type DetectedWindow } from "./vertical.js";
import { findDotClusters, findWindowBottom, loadFrameRGB, traceBar } from "./pixels.js";
import type { Clip } from "./clips.js";

// Visual debugger for the 9:16 vision pass. For each clip it overlays, on the
// exact frame the detector saw:
//   - every DETECTED window (translucent fill + border, coloured by kind, with
//     its title-bar label) — what the vision model returned, and
//   - the CHOSEN crop tiles (bright dashed outline, TOP/BOTTOM) — what actually
//     gets cropped into the mobile stack after inset.
// So we can see, side by side, where detection is loose (box too wide, catching
// a neighbour) vs. where the crop lands. Run:
//   npx tsx src/debug-vision.ts <slug>
// then open out/<slug>/debug.html. Reads windows.json + frames/ + index.json
// from a prior `yarn clip <slug> --vertical` run (no model calls, instant).

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KIND_COLOR: Record<string, string> = {
  camera: "#36d399", // green
  screen: "#60a5fa", // blue
  app: "#9ca3af", // grey
};

async function main() {
  // usage: npx tsx src/debug-vision.ts <slug> [--force] [--only <rank>] [--limit <N>]
  //   --force      re-detect windows (vision call) for the targeted clips
  //   --only <N>   target only clip rank N — fast single-clip iteration
  //   --limit <N>  target only the first N ranked clips (and render only those)
  const argv = process.argv.slice(2);
  const numAfter = (flag: string): number | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : null;
  };
  const slug = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--only" && argv[i - 1] !== "--limit");
  if (!slug) throw new Error("usage: npx tsx src/debug-vision.ts <slug> [--force] [--only <rank>] [--limit <N>]");
  const force = argv.includes("--force");
  const dotsMode = argv.includes("--dots");
  const only = numAfter("--only");
  const limit = numAfter("--limit");
  // A clip is "targeted" (detected + rendered) per --only / --limit, else all.
  const targeted = (rank: number) => (only != null ? rank === only : limit != null ? rank <= limit : true);
  const outDir = resolve(process.cwd(), "out", slug);

  const index = JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as { name: string; clips: Clip[] };
  const { width: srcW, height: srcH } = await probeSize(join(outDir, "source.mp4"));
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const framesDir = join(outDir, "frames");
  await mkdir(framesDir, { recursive: true });

  // ── "find-the-menu" mode ────────────────────────────────────────────────
  // Find the red/yellow/green traffic-light clusters DETERMINISTICALLY by pixel
  // colour (see pixels.findDotClusters) and draw a white box over each — exact,
  // not a model guess. Instant, so we scan fresh every render.
  if (dotsMode) {
    const targetClips = index.clips.filter(c => targeted(c.rank));
    type Win = {
      dots: { x: number; y: number; w: number; h: number };
      left: number;
      right: number;
      top: number;
      bottom: number;
      score: number;
      leftX: number;
      rightX: number;
      leftEnd: number;
      rightEnd: number;
    };
    type ClipResult = { wins: Win[]; orphanDots: { x: number; y: number; w: number; h: number }[] };
    const byClip: Record<string, ClipResult> = {};
    for (const c of targetClips) {
      const key = clipKey(c);
      try {
        const frame = await loadFrameRGB(join(framesDir, `${key}.png`));
        const clusters = findDotClusters(frame);
        // Window = a cluster with a menu bar. The menu bar spans the full window
        // width, so its left/right ARE the window edges (rock-solid). We only
        // need to find the bottom.
        const bars = clusters
          .map(d => ({ d, ...traceBar(frame, d) }))
          .filter(b => b.hasBar)
          .map(b => ({ d: b.d, left: b.left, right: b.right, top: b.d.y - 2, h: b.d.h + 4 }));
        const wins: Win[] = bars.map(bar => {
          const menuBar = { x: bar.left, y: bar.top, w: bar.right - bar.left, h: bar.h };
          const b = findWindowBottom(frame, menuBar);
          return { dots: bar.d, left: bar.left, right: bar.right, top: bar.top, bottom: b.y, score: b.score, leftX: b.leftX, rightX: b.rightX, leftEnd: b.leftEnd, rightEnd: b.rightEnd };
        });
        const orphanDots = clusters.filter(d => !bars.some(b => b.d === d));
        byClip[key] = { wins, orphanDots };
        console.log(`  #${c.rank} ${wins.length} windows [${wins.map(w => w.score.toFixed(2)).join(" ")}] — ${c.title.slice(0, 36)}`);
      } catch (err) {
        console.log(`  #${c.rank} skipped (${err instanceof Error ? err.message : err})`);
      }
    }

    const box = (b: { x: number; y: number; w: number; h: number }, cls: string) =>
      `<div class="${cls}" style="left:${pct(b.x / srcW)};top:${pct(b.y / srcH)};width:${pct(b.w / srcW)};height:${pct(b.h / srcH)};"></div>`;
    const vline = (x: number, y0: number, y1: number) =>
      `<div class="frameline" style="left:${pct((x - 1) / srcW)};top:${pct(y0 / srcH)};width:${pct(3 / srcW)};height:${pct((y1 - y0) / srcH)};"></div>`;
    const corner = (x: number, y: number) =>
      `<div class="corner" style="left:${pct((x - 6) / srcW)};top:${pct((y - 6) / srcH)};width:${pct(12 / srcW)};height:${pct(12 / srcH)};"></div>`;

    const cards = targetClips
      .filter(clip => byClip[clipKey(clip)])
      .map(clip => {
        const key = clipKey(clip);
        const { wins, orphanDots } = byClip[key]!;
        const marks =
          wins
            .map(w => {
              const ok = w.bottom > 0;
              const sides = ok
                ? vline(w.left, w.top, w.bottom) + vline(w.right, w.top, w.bottom) + corner(w.left, w.bottom) + corner(w.right, w.bottom)
                : "";
              const bottomLine = ok
                ? `<div class="bottomline" style="left:${pct(w.left / srcW)};top:${pct((w.bottom - 1) / srcH)};width:${pct((w.right - w.left) / srcW)};height:${pct(3 / srcH)};"></div>` +
                  `<div class="score" style="left:${pct((w.left + 5) / srcW)};top:${pct((w.bottom + 4) / srcH)};">${w.score.toFixed(2)}</div>`
                : "";
              return (
                box({ x: w.left, y: w.top, w: w.right - w.left, h: w.dots.h + 4 }, "menubox") +
                sides +
                bottomLine +
                box(w.dots, "dotbox")
              );
            })
            .join("\n") + orphanDots.map(d => box(d, "dotbox orphan")).join("\n");
        return `
      <article class="clip">
        <div class="head"><span class="rank">#${clip.rank}</span><h2>${esc(clip.title)}</h2><span class="kind">${wins.length} windows</span></div>
        <div class="frame"><img src="frames/${key}.png" alt="" />${marks}</div>
      </article>`;
      })
      .join("\n");

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dots debug · ${esc(index.name || slug)}</title>
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin: 0; background: #0e0e10; color: #e8e8ea; font: 13px/1.5 ui-monospace, Menlo, monospace; }
  header { padding: 18px 24px; border-bottom: 1px solid #26262b; }
  header h1 { margin: 0 0 6px; font-size: 16px; }
  .legend span { margin-right: 14px; } .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  main { display: flex; flex-direction: column; align-items: center; gap: 28px; padding: 24px; }
  .clip { width: 100%; max-width: 1200px; background: #161619; border: 1px solid #26262b; border-radius: 10px; overflow: hidden; }
  .head { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; }
  .head h2 { margin: 0; font-size: 13px; flex: 1; }
  .rank { font-weight: 700; color: #0e0e10; background: #7dd3fc; border-radius: 5px; padding: 0 7px; }
  .kind { color: #8a8a93; font-size: 11px; }
  .frame { position: relative; aspect-ratio: ${srcW} / ${srcH}; background: #000; }
  .frame img { width: 100%; height: 100%; display: block; }
  .dotbox { position: absolute; border: 2px solid #fff; background: rgba(255,255,255,0.28); box-shadow: 0 0 0 1px #000; }
  .dotbox.orphan { border-color: #f97316; background: rgba(249,115,22,0.25); }
  .menubox { position: absolute; border: 2px solid #cbd5e1; background: rgba(203,213,225,0.22); }
  .frameline { position: absolute; background: #22d3ee; box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
  .corner { position: absolute; background: #22d3ee; border: 2px solid #0e7490; border-radius: 2px; }
  .bottomline { position: absolute; background: #fde047; box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
  .score { position: absolute; color: #fde047; font-size: 11px; font-weight: 700; text-shadow: 0 0 3px #000, 0 0 3px #000; }
</style></head>
<body>
<header>
  <h1>${esc(index.name || slug)} — window box (menu-bar sides + found bottom)</h1>
  <div class="legend">
    <span><i class="sw" style="background:#fff"></i>red/yellow/green</span>
    <span><i class="sw" style="background:#f97316"></i>dots, no menu bar</span>
    <span><i class="sw" style="background:#cbd5e1"></i>menu bar</span>
    <span><i class="sw" style="background:#22d3ee"></i>sides + corners</span>
    <span><i class="sw" style="background:#fde047"></i>bottom + score</span>
  </div>
</header>
<main>${cards}</main>
</body></html>`;
    const dest = join(outDir, "debug.html");
    await writeFile(dest, html);
    console.log(`✓ wrote ${dest}`);
    console.log(`  open file://${dest}`);
    return;
  }

  const windowsPath = join(outDir, "windows.json");
  let windows: Record<string, DetectedWindow[]> = {};
  try {
    windows = JSON.parse(await readFile(windowsPath, "utf8")) as Record<string, DetectedWindow[]>;
  } catch {
    /* none yet */
  }

  // (Re)detect targeted clips so we can iterate on the vision without re-cutting.
  const targets = index.clips.filter(c => targeted(c.rank) && (force || !windows[clipKey(c)]));
  for (const c of targets) {
    const key = clipKey(c);
    console.log(`  detecting #${c.rank} ${c.title.slice(0, 40)}…`);
    windows[key] = await detectClipWindows({
      source: join(outDir, "source.mp4"),
      framePath: join(framesDir, `${key}.png`),
      startSec: c.start,
      endSec: c.end,
    });
  }
  if (targets.length) await writeFile(windowsPath, JSON.stringify(windows, null, 2));

  const land = (r: { x: number; y: number; w: number; h: number } | undefined, cls: string, label: string) =>
    r
      ? `<div class="box ${cls}" style="left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)};"><span class="tag ${cls}-tag">${label}</span></div>`
      : "";

  const cards = index.clips
    .filter(clip => targeted(clip.rank) && windows[clipKey(clip)])
    .map(clip => {
      const key = clipKey(clip);
      const wins = windows[key]!;
      const speakers = (clip.speakers ?? []).slice(0, 2).map(s => s.speaker);
      const layout = composeLayout(wins, speakers, srcW, srcH);

      // Detected windows + their landmarks: the derived content box (green/blue/
      // grey by kind), plus title bar, dots, face and name card so we can verify
      // each landmark is found correctly.
      const winBoxes = wins
        .map(w => {
          const color = KIND_COLOR[w.kind] ?? "#e879f9";
          const marks =
            land(w.titleBar, "titlebar", "menu bar") +
            land(w.dots, "dots", "dots") +
            land(w.nameCard, "namecard", "name"); // face box dropped — vision's was unreliable & unused
          return `<div class="box win" style="left:${pct(w.x)};top:${pct(w.y)};width:${pct(w.w)};height:${pct(w.h)};border-color:${color};background:${color}22;">
            <span class="tag" style="background:${color}">${esc(w.kind)}${w.label ? " · " + esc(w.label) : ""}</span>
          </div>${marks}`;
        })
        .join("\n");

      // Chosen crop tiles — pixel coords → % of source.
      const tileBoxes = (layout.tiles ?? [])
        .map((t, i) => {
          const pos = i === 0 ? "TOP" : i === 1 ? "BOTTOM" : `TILE ${i + 1}`;
          return `<div class="box tile" style="left:${pct(t.x / srcW)};top:${pct(t.y / srcH)};width:${pct(t.w / srcW)};height:${pct(t.h / srcH)};">
            <span class="tag tile-tag">${pos} · ${esc(t.fit)} · w${t.weight}</span>
          </div>`;
        })
        .join("\n");

      return `
      <article class="clip">
        <div class="head">
          <span class="rank">#${clip.rank}</span>
          <h2>${esc(clip.title)}</h2>
          <span class="kind">${esc(layout.kind)}${speakers.length ? " · " + esc(speakers.join(" / ")) : ""}</span>
        </div>
        <div class="frame">
          <img src="frames/${key}.png" alt="" />
          ${winBoxes}
          ${tileBoxes}
        </div>
      </article>`;
    })
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vision debug · ${esc(index.name || slug)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0e10; color: #e8e8ea; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 20px 24px; border-bottom: 1px solid #26262b; }
  header h1 { margin: 0 0 6px; font-size: 16px; }
  .legend span { margin-right: 14px; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  main { display: flex; flex-direction: column; align-items: center; gap: 28px; padding: 24px; }
  .clip { width: 100%; max-width: 1100px; }
  .clip { background: #161619; border: 1px solid #26262b; border-radius: 10px; overflow: hidden; }
  .head { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; }
  .head h2 { margin: 0; font-size: 13px; flex: 1; }
  .rank { font-weight: 700; color: #0e0e10; background: #7dd3fc; border-radius: 5px; padding: 0 7px; }
  .kind { color: #e879f9; font-size: 11px; }
  .frame { position: relative; aspect-ratio: ${srcW} / ${srcH}; background: #000; }
  .frame img { width: 100%; height: 100%; display: block; }
  .box { position: absolute; border: 2px solid; }
  .box .tag { position: absolute; top: 0; left: 0; font-size: 10px; padding: 1px 5px; color: #0b0b0c; font-weight: 700; white-space: nowrap; }
  .tile { border: 3px dashed #fde047; background: transparent; }
  .tile .tile-tag { position: absolute; bottom: 0; top: auto; left: 0; background: #fde047; color: #0b0b0c; }
  .face { border: 2px solid #e879f9; background: transparent; }
  .face .face-tag { position: absolute; bottom: 0; top: auto; left: 0; background: #e879f9; color: #0b0b0c; font-size: 9px; }
  .titlebar { border: 2px solid #fb923c; background: #fb923c22; }
  .titlebar .titlebar-tag { background: #fb923c; color: #0b0b0c; font-size: 9px; }
  .dots { border: 2px solid #ef4444; background: transparent; }
  .dots .dots-tag { background: #ef4444; color: #fff; font-size: 9px; }
  .namecard { border: 2px solid #22d3ee; background: #22d3ee22; }
  .namecard .namecard-tag { position: absolute; bottom: 0; top: auto; left: 0; background: #22d3ee; color: #0b0b0c; font-size: 9px; }
</style></head>
<body>
<header>
  <h1>${esc(index.name || slug)} — vision debug</h1>
  <div class="legend">
    <span><i class="sw" style="background:#36d399"></i>camera</span>
    <span><i class="sw" style="background:#60a5fa"></i>screen</span>
    <span><i class="sw" style="background:#9ca3af"></i>app</span>
    <span><i class="sw" style="background:#fb923c"></i>menu bar</span>
    <span><i class="sw" style="background:#ef4444"></i>dots</span>
    <span><i class="sw" style="background:#e879f9"></i>face</span>
    <span><i class="sw" style="background:#22d3ee"></i>name card</span>
    <span><i class="sw" style="background:#fde047"></i>chosen crop tile (dashed)</span>
  </div>
</header>
<main>
${cards}
</main>
</body></html>`;

  const dest = join(outDir, "debug.html");
  await writeFile(dest, html);
  console.log(`✓ wrote ${dest}`);
  console.log(`  open file://${dest}`);
}

main().catch(err => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
