import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractFrame, probeSize, type StackTile } from "./ffmpeg.js";
import { clipKey } from "./judge.js";
import { composeLayout, detectClipWindows, type DetectedWindow } from "./vertical.js";
import { fetchGeometryLog, windowsAt, type GeometryLog } from "./geometry.js";
import { fetchManifestByCid, resolveBySlug, cidOf, type EpisodeManifest } from "./resolve.js";
import { namesFromParticipants } from "./speakers.js";
import type { Clip } from "./clips.js";

// SIDE-BY-SIDE window-finder comparison page. For each clip it renders the SAME
// recorded frame twice:
//   LEFT  — the PIXEL detector's pick (what production uses): red/yellow/green
//           dot keying → window boxes, plus the chosen 9:16 crop tiles.
//   RIGHT — the GEOMETRY-LOG pick: the relay's logged slot rects replayed to the
//           clip's mid-frame, plus the crop tiles THAT would produce.
// An IoU (intersection-over-union) per matched window + a per-clip mean give a
// number for "how close are they"; the visuals let a human judge which frames
// best. This is a REVIEW tool — it does not change the production clip path
// (which is pixels-only unless CLIPPER_USE_GEOMETRY=1). When the upstream
// broadcast-coords rework lands (see slop-computer-live/ops/window-geometry.md),
// the geometry boxes should snap onto the pixel boxes and IoU should climb to ~1.
//
//   npx tsx src/compare.ts <slug> [--limit N] [--only RANK] [--manifest <cid>]
//   --manifest <cid>  skip the on-chain slug lookup; read the manifest directly
//                     (handy on a box without ALCHEMY, or to pin a known run)
// then open out/<slug>/compare.html. Reuses cached frames/ + windows.json from a
// prior `yarn clip <slug> --vertical` run; re-extracts any missing frame.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type R = { x: number; y: number; w: number; h: number };

/** IoU of two rects in the SAME units (here: frame fractions, 0..1). */
function iou(a: R, b: R): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Greedily pair pixel↔geometry windows by best IoU first, each used once.
 *  Returns matched pairs (with IoU) + the leftover indices on each side. */
function matchByIou(pix: DetectedWindow[], geo: DetectedWindow[]) {
  const pairs: { pi: number; gi: number; v: number }[] = [];
  pix.forEach((p, pi) => geo.forEach((g, gi) => pairs.push({ pi, gi, v: iou(p, g) })));
  pairs.sort((a, b) => b.v - a.v);
  const pUsed = new Set<number>();
  const gUsed = new Set<number>();
  const matched: { pi: number; gi: number; v: number }[] = [];
  for (const pr of pairs) {
    if (pr.v <= 0 || pUsed.has(pr.pi) || gUsed.has(pr.gi)) continue;
    pUsed.add(pr.pi);
    gUsed.add(pr.gi);
    matched.push(pr);
  }
  const pixUnmatched = pix.map((_, i) => i).filter(i => !pUsed.has(i));
  const geoUnmatched = geo.map((_, i) => i).filter(i => !gUsed.has(i));
  return { matched, pixUnmatched, geoUnmatched };
}

async function main() {
  const argv = process.argv.slice(2);
  const numAfter = (flag: string): number | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : null;
  };
  const strAfter = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const slug = argv.find(
    (a, i) => !a.startsWith("--") && !["--only", "--limit", "--manifest"].includes(argv[i - 1] ?? ""),
  );
  if (!slug) throw new Error("usage: npx tsx src/compare.ts <slug> [--limit N] [--only RANK] [--manifest <cid>]");
  const only = numAfter("--only");
  const limit = numAfter("--limit");
  const manifestCid = strAfter("--manifest");
  const targeted = (rank: number) => (only != null ? rank === only : limit != null ? rank <= limit : true);

  const outDir = resolve(process.cwd(), "out", slug);
  const framesDir = join(outDir, "frames");
  await mkdir(framesDir, { recursive: true });
  const source = join(outDir, "source.mp4");

  const index = JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as { name: string; clips: Clip[] };
  const { width: srcW, height: srcH } = await probeSize(source);

  // Production pixel pick (cached). Re-detect any targeted clip we're missing.
  const windowsPath = join(outDir, "windows.json");
  let windows: Record<string, DetectedWindow[]> = {};
  try {
    windows = JSON.parse(await readFile(windowsPath, "utf8")) as Record<string, DetectedWindow[]>;
  } catch {
    /* none yet */
  }

  // Geometry log (best-effort): resolve slug → manifest.geometry.cid → fetch log.
  // Optional — older episodes have none; chain access may be absent on a box.
  let geomLog: GeometryLog | null = null;
  let geomNames: Record<string, string> = {};
  let geomNote = "";
  try {
    let manifest: EpisodeManifest;
    if (manifestCid) {
      manifest = await fetchManifestByCid(cidOf(manifestCid));
    } else {
      manifest = (await resolveBySlug(slug)).manifest;
    }
    geomNames = namesFromParticipants(manifest.participants);
    if (manifest.geometry?.cid) {
      geomLog = await fetchGeometryLog(cidOf(manifest.geometry.cid));
      if (geomLog.videoStartMs == null) {
        geomNote = "geometry log has no videoStartMs header — can't time-align; geometry column omitted.";
        geomLog = null;
      } else {
        geomNote = `geometry log: ${geomLog.events.length} events, t0=${new Date(geomLog.videoStartMs).toISOString()}`;
      }
    } else {
      geomNote = "manifest has no geometry.cid — pixel column only.";
    }
  } catch (err) {
    geomNote = `geometry unavailable (${err instanceof Error ? err.message : err}) — pixel column only.`;
  }
  console.log(`  ${geomNote}`);

  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const KIND_COLOR: Record<string, string> = { camera: "#36d399", screen: "#60a5fa", app: "#9ca3af" };

  // One frame's overlay: detected window boxes (coloured by kind) + chosen crop
  // tiles (dashed). `accent` tints the tile outline so the two columns read apart.
  const overlay = (wins: DetectedWindow[], tiles: StackTile[] | null, accent: string) => {
    const winBoxes = wins
      .map(w => {
        const color = KIND_COLOR[w.kind] ?? "#e879f9";
        return `<div class="box" style="left:${pct(w.x)};top:${pct(w.y)};width:${pct(w.w)};height:${pct(w.h)};border-color:${color};background:${color}22;">
          <span class="tag" style="background:${color}">${esc(w.kind)}${w.label ? " · " + esc(w.label) : ""}</span>
        </div>`;
      })
      .join("\n");
    const tileBoxes = (tiles ?? [])
      .map((t, i) => {
        const pos = i === 0 ? "TOP" : i === 1 ? "BOTTOM" : `TILE ${i + 1}`;
        return `<div class="box tile" style="left:${pct(t.x / srcW)};top:${pct(t.y / srcH)};width:${pct(t.w / srcW)};height:${pct(t.h / srcH)};border-color:${accent};">
          <span class="tag tile-tag" style="background:${accent}">${pos} · ${esc(t.fit)}</span>
        </div>`;
      })
      .join("\n");
    return winBoxes + tileBoxes;
  };

  const targetClips = index.clips.filter(c => targeted(c.rank)).sort((a, b) => a.rank - b.rank);
  const iouValues: number[] = [];
  const cards: string[] = [];

  for (const clip of targetClips) {
    const key = clipKey(clip);
    const framePath = join(framesDir, `${key}.png`);
    const mid = (clip.start + clip.end) / 2;

    // Pixel pick: cached if present, else detect now (writes the frame too).
    let pix = windows[key];
    if (!pix) {
      console.log(`  detecting (pixel) #${clip.rank} ${clip.title.slice(0, 40)}…`);
      pix = await detectClipWindows({ source, framePath, startSec: clip.start, endSec: clip.end });
      windows[key] = pix;
    } else if (!existsSync(framePath)) {
      await extractFrame(source, mid, framePath);
    }

    // Geometry pick: replay the log to the clip's mid wall-clock.
    const geo: DetectedWindow[] =
      geomLog && geomLog.videoStartMs != null
        ? windowsAt(geomLog, mid * 1000 + geomLog.videoStartMs, geomNames)
        : [];

    const speakers = (clip.speakers ?? []).slice(0, 2).map(s => s.speaker);
    const pixLayout = composeLayout(pix, speakers, srcW, srcH);
    const geoLayout = geo.length ? composeLayout(geo, speakers, srcW, srcH) : null;

    // IoU summary for this clip.
    const { matched, pixUnmatched, geoUnmatched } = matchByIou(pix, geo);
    const meanIou = matched.length ? matched.reduce((s, m) => s + m.v, 0) / matched.length : 0;
    if (geo.length) iouValues.push(meanIou);
    const iouLabel = !geomLog
      ? "—"
      : geo.length === 0
        ? "no geometry windows at this time"
        : `mean IoU ${meanIou.toFixed(2)} · ${matched.length} matched · ${pixUnmatched.length} pixel-only · ${geoUnmatched.length} geom-only`;

    const geoColumn = !geomLog
      ? ""
      : `<div class="col">
          <div class="colhead">GEOMETRY LOG <span class="badge geo">${geo.length} win</span></div>
          <div class="frame"><img src="frames/${key}.png" alt="" loading="lazy" />${overlay(geo, geoLayout?.tiles ?? null, "#f87171")}</div>
        </div>`;

    cards.push(`
      <article class="clip">
        <div class="head">
          <span class="rank">#${clip.rank}</span>
          <h2>${esc(clip.title)}</h2>
          <span class="iou ${meanIou >= 0.6 ? "good" : meanIou > 0 ? "mid" : "bad"}">${iouLabel}</span>
        </div>
        <div class="cols ${geomLog ? "two" : "one"}">
          <div class="col">
            <div class="colhead">PIXEL DETECTOR <span class="badge pix">${pix.length} win</span> <span class="muted">${esc(pixLayout.kind)}${speakers.length ? " · " + esc(speakers.join(" / ")) : ""}</span></div>
            <div class="frame"><img src="frames/${key}.png" alt="" loading="lazy" />${overlay(pix, pixLayout.tiles, "#fde047")}</div>
          </div>
          ${geoColumn}
        </div>
      </article>`);
  }
  // Persist any freshly-detected pixel windows so a rerun is instant.
  await writeFile(windowsPath, JSON.stringify(windows, null, 2));

  const overallIou = iouValues.length ? iouValues.reduce((s, v) => s + v, 0) / iouValues.length : null;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>window-finder compare · ${esc(index.name || slug)}</title>
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin: 0; background: #0e0e10; color: #e8e8ea; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 18px 24px; border-bottom: 1px solid #26262b; position: sticky; top: 0; background: #0e0e10ee; backdrop-filter: blur(4px); z-index: 5; }
  header h1 { margin: 0 0 6px; font-size: 16px; }
  .sub { color: #8a8a93; font-size: 12px; }
  .overall { font-size: 13px; color: #e8e8ea; }
  .overall b { color: #fde047; }
  .legend { margin-top: 6px; } .legend span { margin-right: 14px; }
  .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  main { display: flex; flex-direction: column; align-items: center; gap: 26px; padding: 24px; }
  .clip { width: 100%; max-width: 1500px; background: #161619; border: 1px solid #26262b; border-radius: 10px; overflow: hidden; }
  .head { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; }
  .head h2 { margin: 0; font-size: 13px; flex: 1; }
  .rank { font-weight: 700; color: #0e0e10; background: #7dd3fc; border-radius: 5px; padding: 0 7px; }
  .iou { font-size: 11px; padding: 1px 8px; border-radius: 5px; white-space: nowrap; }
  .iou.good { background: #14532d; color: #86efac; } .iou.mid { background: #4a3a12; color: #fde047; } .iou.bad { background: #4c1d1d; color: #fca5a5; }
  .cols { display: grid; gap: 2px; } .cols.two { grid-template-columns: 1fr 1fr; } .cols.one { grid-template-columns: 1fr; }
  @media (max-width: 1000px) { .cols.two { grid-template-columns: 1fr; } }
  .col { background: #000; }
  .colhead { padding: 6px 10px; font-size: 11px; letter-spacing: 0.04em; background: #1c1c20; border-bottom: 1px solid #26262b; }
  .badge { font-size: 10px; padding: 0 6px; border-radius: 4px; margin-left: 4px; } .badge.pix { background:#36d399; color:#04240f; } .badge.geo { background:#f87171; color:#2a0a0a; }
  .muted { color: #8a8a93; margin-left: 6px; }
  .frame { position: relative; aspect-ratio: ${srcW} / ${srcH}; background: #000; }
  .frame img { width: 100%; height: 100%; display: block; }
  .box { position: absolute; border: 2px solid; }
  .box .tag { position: absolute; top: 0; left: 0; font-size: 10px; padding: 1px 5px; color: #0b0b0c; font-weight: 700; white-space: nowrap; }
  .tile { border-style: dashed; border-width: 3px; background: transparent; }
  .tile .tile-tag { position: absolute; bottom: 0; top: auto; left: 0; color: #0b0b0c; }
</style></head>
<body>
<header>
  <h1>${esc(index.name || slug)} — window-finder comparison</h1>
  <div class="sub">PIXEL detector (production) vs GEOMETRY log replay · same frame, same crop logic. Pick which framing looks best per clip.</div>
  <div class="overall">${overallIou != null ? `overall mean IoU across ${iouValues.length} clips: <b>${overallIou.toFixed(2)}</b> (1.0 = identical boxes; low = the two disagree)` : `<span class="sub">${esc(geomNote)}</span>`}</div>
  <div class="legend">
    <span><i class="sw" style="background:#36d399"></i>camera</span>
    <span><i class="sw" style="background:#60a5fa"></i>screen</span>
    <span><i class="sw" style="background:#9ca3af"></i>app</span>
    <span><i class="sw" style="background:#fde047"></i>pixel crop tile</span>
    <span><i class="sw" style="background:#f87171"></i>geometry crop tile</span>
  </div>
</header>
<main>
${cards.join("\n")}
</main>
</body></html>`;

  const dest = join(outDir, "compare.html");
  await writeFile(dest, html);
  console.log(`✓ wrote ${dest}`);
  if (overallIou != null) console.log(`  overall mean IoU: ${overallIou.toFixed(2)} across ${iouValues.length} clips`);
  console.log(`  open file://${dest}`);
}

main().catch(err => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
