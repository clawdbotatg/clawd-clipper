import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clipKey } from "./judge.js";
import { colorAt, findBottomLine, findDotClusters, hex, loadFrameRGB, traceBar, type RgbFrame } from "./pixels.js";
import type { Clip } from "./clips.js";

// Pixel-digging lab for the red/yellow/green window-corner detector. Lets me
// SAMPLE exact colours from a frame to calibrate, then SCAN deterministically.
//   npx tsx src/dotscan.ts <slug> frame <rank>            → resolve frame path
//   npx tsx src/dotscan.ts <slug> grid  <rank> <x> <y> <w> <h> [step]  → hex grid
//   npx tsx src/dotscan.ts <slug> point <rank> <x> <y>    → single pixel

async function frameFor(slug: string, rank: number): Promise<{ path: string; f: RgbFrame }> {
  const outDir = resolve(process.cwd(), "out", slug);
  const index = JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as { clips: Clip[] };
  const clip = index.clips.find(c => c.rank === rank);
  if (!clip) throw new Error(`no clip rank ${rank}`);
  const path = join(outDir, "frames", `${clipKey(clip)}.png`);
  const f = await loadFrameRGB(path);
  return { path, f };
}

async function main() {
  const [slug, cmd, rankStr, ...rest] = process.argv.slice(2);
  if (!slug || !cmd) throw new Error("usage: npx tsx src/dotscan.ts <slug> <frame|grid|point> <rank> [...]");
  const rank = Number(rankStr ?? 1);
  const { path, f } = await frameFor(slug, rank);

  if (cmd === "frame") {
    console.log(`${path}  (${f.width}x${f.height})`);
    return;
  }

  if (cmd === "scan") {
    const boxes = findDotClusters(f);
    console.log(`${boxes.length} dot clusters in ${path} (${f.width}x${f.height}):`);
    for (const b of boxes) console.log(`  x=${b.x} y=${b.y} w=${b.w} h=${b.h}  (center ${Math.round(b.x + b.w / 2)},${Math.round(b.y + b.h / 2)})`);
    console.log(`chrome:`);
    const bars = boxes
      .map(d => ({ d, ...traceBar(f, d) }))
      .filter(b => b.hasBar)
      .map(b => ({ d: b.d, left: b.left, right: b.right, top: b.d.y - 2, h: b.d.h + 4 }));
    for (const d of boxes) {
      const bar = bars.find(b => b.d === d);
      if (!bar) {
        console.log(`  dots(${d.x},${d.y}) — no menu bar`);
        continue;
      }
      const menuBar = { x: bar.left, y: bar.top, w: bar.right - bar.left, h: bar.h };
      const b = findBottomLine(f, menuBar);
      console.log(`  dots(${d.x},${d.y}) box x${bar.left}-${bar.right} top${bar.top} bottom y${b.y} score ${b.score}`);
    }
    return;
  }

  if (cmd === "point") {
    const [x, y] = rest.map(Number);
    console.log(`(${x},${y}) = ${hex(colorAt(f, x!, y!))}`);
    return;
  }

  if (cmd === "grid") {
    const [x, y, w, h, stepStr] = rest.map(Number);
    const step = stepStr || 6;
    console.log(`grid @ (${x},${y}) ${w}x${h} step ${step}  — frame ${f.width}x${f.height}`);
    for (let yy = y!; yy < y! + h!; yy += step) {
      let row = `${String(yy).padStart(4)} `;
      for (let xx = x!; xx < x! + w!; xx += step) row += hex(colorAt(f, xx, yy)) + " ";
      console.log(row);
    }
    return;
  }

  throw new Error(`unknown cmd ${cmd}`);
}

main().catch(err => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
