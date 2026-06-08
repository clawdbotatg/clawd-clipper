import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MOBILE_FRAME } from "./ffmpeg.js";

// Render a static slop.computer-style mobile DESKTOP as a PNG, to sit behind the
// stacked 9:16 speaker tiles (with the tiles padded so the desktop + title show).
// This recreates slop-computer-live's mobileMode look in POST: a magenta title
// bar ("SLOP.COMPUTER" in Silkscreen + logo), the dark purple gradient desktop
// with its dither/starfield/scanlines, the app-icon grid, and the SLOP watermark.
//
// We render real HTML/CSS with the actual icon assets via headless Chrome (one
// screenshot, cached) — far more faithful than redrawing it by hand, and the
// assets are bundled under assets/mobile so the clipper stays self-contained.

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/mobile");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// [iconFile, label] per desktop column — mirrors slop's IDLE_ICON_COLUMNS.
const COLUMNS: [string, string][][] = [
  [["chat", "CHAT"], ["video", "VIDEO"], ["mic", "AUDIO"], ["screen-sharing", "SCREEN"]],
  [["clock", "CLOCK"], ["card", "CARD"], ["research", "RESEARCH"], ["transcript", "TRANSCRIPT"]],
  [["glossary", "GLOSSARY"], ["notes", "NOTES"], ["todo", "TODO"], ["qr", "QR"]],
  [["paint", "NIFTY"], ["ninja", "ABI.NINJA"], ["gas", "GAS"], ["news", "NEWS"]],
  [["browser", "BROWSER"], ["wallet", "WALLET"], ["ens", "ENS"], ["music", "MUSIC"]],
  [["pong", "PONG"], ["chess", "CHESS"], ["worm", "WORM"]],
];

// Deterministic starfield (no Math.random — keep renders reproducible).
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHtml(W: number, H: number): string {
  const TB = MOBILE_FRAME.titleBarH;
  const ICON = 72,
    COLP = 100,
    ROWP = 108,
    INSET_X = 26,
    INSET_Y = 18,
    LABEL = 15;
  const icon = (f: string) => pathToFileURL(join(ASSETS, "icons", `${f}.png`)).href;
  const logo = pathToFileURL(join(ASSETS, "logo-mark.png")).href;

  const rnd = mulberry32(1337);
  let stars = "";
  for (let i = 0; i < 100; i++) {
    const x = Math.floor(rnd() * W),
      y = Math.floor(rnd() * H),
      bright = rnd() < 0.08;
    const s = bright ? 4 : 2,
      o = bright ? 0.85 : 0.5;
    stars += `<div style="position:absolute;left:${x}px;top:${y}px;width:${s}px;height:${s}px;background:#fff;opacity:${o};border-radius:50%"></div>`;
  }

  const dither = encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='6' height='6'><rect width='1' height='1' x='0' y='0' fill='#7c4dff' fill-opacity='0.7'/><rect width='1' height='1' x='3' y='3' fill='#3fcfff' fill-opacity='0.5'/></svg>`,
  );

  const iconCols = COLUMNS.map((col, ci) => {
    const cells = col
      .map(
        ([f, label]) =>
          `<div style="display:flex;flex-direction:column;align-items:center;width:${ICON}px">
            <img src="${icon(f)}" width="${ICON}" height="${ICON}" style="image-rendering:pixelated;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.65));opacity:0.88"/>
            <div style="font-family:Silkscreen,monospace;font-size:${LABEL}px;letter-spacing:0.04em;color:#7878a0;text-shadow:0 1px 2px rgba(0,0,0,0.85);margin-top:3px;white-space:nowrap">${label}</div>
          </div>`,
      )
      .join("");
    return `<div style="position:absolute;left:${INSET_X + ci * COLP}px;top:${TB + INSET_Y}px;display:flex;flex-direction:column;gap:${ROWP - ICON - LABEL - 4}px">${cells}</div>`;
  }).join("");

  // Full "SLOPCOMPUTER" watermark (matches slop's SLOP_ASCII), shown across the
  // bottom desktop strip.
  const ascii = `███████╗██╗      ██████╗ ██████╗  ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗   ██╗████████╗███████╗██████╗
██╔════╝██║     ██╔═══██╗██╔══██╗██╔════╝██╔═══██╗████╗ ████║██╔══██╗██║   ██║╚══██╔╝██╔════╝██╔══██╗
███████╗██║     ██║   ██║██████╔╝██║     ██║   ██║██╔████╔██║██████╔╝██║   ██║   ██║   █████╗  ██████╔╝
╚════██║██║     ██║   ██║██╔═══╝ ██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██║   ██║   ██║   ██╔══╝  ██╔══██╗
███████║███████╗╚██████╔╝██║██╗  ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ╚██████╔╝   ██║   ███████╗██║  ██║
╚══════╝╚══════╝ ╚═════╝ ╚═╝╚═╝   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝      ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝`;

  return `<!doctype html><html><head><meta charset="utf-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  .bg{position:absolute;inset:0;background:radial-gradient(circle at 50% 30%,#14091e 0%,#06030d 70%,#000 100%)}
  .wash{position:absolute;inset:0;background:radial-gradient(ellipse 70% 50% at 50% 30%,rgba(124,77,255,0.12) 0%,transparent 70%)}
  .dither{position:absolute;inset:0;opacity:0.45;background-image:url("data:image/svg+xml,${dither}");background-size:14px 14px;image-rendering:pixelated}
  .scan{position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0,transparent 4px,rgba(0,0,0,0.18) 4px,rgba(0,0,0,0.18) 6px);mix-blend-mode:multiply}
  .title{position:absolute;top:0;left:0;right:0;height:${TB}px;display:flex;align-items:center;justify-content:center;gap:16px;
    background:linear-gradient(180deg,#ff3ec9 0%,#7c4dff 100%);border-bottom:1px solid rgba(0,0,0,0.6);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.35),inset 0 -1px 0 rgba(0,0,0,0.35),0 2px 10px rgba(255,62,201,0.45)}
  .title img{width:60px;height:60px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))}
  .title span{font-family:Silkscreen,monospace;font-weight:700;font-size:48px;letter-spacing:0.18em;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.55)}
  .wm{position:absolute;left:0;right:0;bottom:78px;display:flex;justify-content:center;font-family:ui-monospace,Menlo,monospace;font-size:15px;line-height:1;color:#ff3ec9;opacity:0.22;text-shadow:0 0 6px rgba(255,62,201,0.25)}
  .wm pre{margin:0;white-space:pre}
</style></head>
<body>
  <div class="bg"></div><div class="wash"></div><div class="dither"></div>
  <div>${stars}</div>
  ${iconCols}
  <div class="scan"></div>
  <div class="title"><img src="${logo}"/><span>SLOP.COMPUTER</span></div>
  <div class="wm"><pre>${ascii}</pre></div>
</body></html>`;
}

const exists = (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false);

/**
 * Render (and cache) the mobile desktop background PNG at the full frame size.
 * Returns the PNG path, or null if rendering failed (caller then renders without
 * a background — the clip still cuts, just full-frame stacked tiles).
 */
export async function renderMobileBackground(
  destPng: string,
  opts: { force?: boolean; htmlPath?: string; log?: (m: string) => void } = {},
): Promise<string | null> {
  const log = opts.log ?? (() => {});
  if (!opts.force && (await exists(destPng))) return destPng;
  if (!(await exists(CHROME))) {
    log(`no Chrome at ${CHROME} — skipping desktop background`);
    return null;
  }
  const W = MOBILE_FRAME.W;
  const H = MOBILE_FRAME.H;
  const htmlPath = opts.htmlPath ?? destPng.replace(/\.png$/, ".html");
  await writeFile(htmlPath, buildHtml(W, H));
  try {
    await new Promise<void>((res, rej) => {
      const p = spawn(CHROME, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1",
        `--window-size=${W},${H}`,
        "--virtual-time-budget=4000",
        `--screenshot=${destPng}`,
        pathToFileURL(htmlPath).href,
      ]);
      let err = "";
      p.stderr.on("data", d => (err += d));
      p.on("error", rej);
      p.on("close", c => (c === 0 ? res() : rej(new Error(`chrome exited ${c}: ${err.slice(-300)}`))));
    });
    if (!(await exists(destPng))) throw new Error("screenshot produced no file");
    return destPng;
  } catch (err) {
    log(`desktop background render failed (${err instanceof Error ? err.message : err})`);
    return null;
  }
}
