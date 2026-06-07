import { extractFrame, type StackTile } from "./ffmpeg.js";
import { completeVision, extractJson } from "./llm.js";
import { config } from "./config.js";

// Mobile (9:16) composition — the "hard mode" the brief asked for: instead of
// letterboxing the wide call into a tall frame, ISOLATE the on-screen windows
// and stack them, captions burned over the seam.
//
// The slop.computer recording is a 1920×1080 *desktop*: every webcam, screen
// share and app is a draggable WINDOW whose title bar reads "CAMERA — <name>",
// "SCREEN — <name>", "BROWSER — <url>" or an app name (see slop-computer-live
// ui/TitleBar.tsx + Desktop.tsx titleFor()). That chrome is the trick — a vision
// pass reads each window's KIND, OWNER and box straight off the title bar, far
// more reliably than guessing face rectangles. Windows move clip-to-clip but not
// within a clip, so we detect once per clip (on a sampled mid-frame).
//
// Detection (expensive — a vision call) is split from composition (a pure
// function) so the windows can be cached once and the layout re-derived for free
// while tuning weights/rules. Composition mirrors slop's own MobileStage: a
// speaker's camera over a shared SCREEN (interview), two cameras 50/50, or a
// single tile full — caption band on the seam between tiles.

/** A detected desktop window. x/y/w/h (FRACTIONS [0,1] of the frame) is the
 *  VIDEO CONTENT box — for cameras it's DERIVED from the landmarks below.
 *
 *  Landmarks (the trick): every window has a purple title/menu bar across its
 *  top with three traffic-light dots (red/yellow/green) at the left, and a name
 *  card in the bottom-left. `titleBar` gives the top edge + the window WIDTH;
 *  `nameCard` gives the bottom edge; `dots` pins the top-left corner; `face` is
 *  the head. We detect these distinct, high-contrast landmarks (more reliable
 *  than guessing a window rectangle) and derive the content box from them.
 *  Cached in windows.json. */
export type WinKind = "camera" | "screen" | "app";
export type Rect = { x: number; y: number; w: number; h: number };
export type DetectedWindow = Rect & {
  kind: WinKind;
  label: string;
  face?: Rect;
  dots?: Rect;
  titleBar?: Rect;
  nameCard?: Rect;
};

/** A resolved 9:16 layout for one clip: stacked tiles (top→bottom) or null to
 *  signal the blur-pad fallback. `seamFrac` is where the caption band sits
 *  (fraction of height); `kind`/`speakers` are for logging. */
export type ClipLayout = {
  tiles: StackTile[] | null;
  seamFrac: number;
  kind: string;
  speakers: string[];
};

const DETECT_PROMPT = `This is a single frame from a recording of "slop.computer" — a live desktop where each participant's webcam, screen share and app is a draggable WINDOW on a dark 1920x1080 desktop.

EVERY window has these fixed LANDMARKS, which you should locate precisely:
  • TITLE BAR — a thin purple/magenta menu bar across the very TOP of the window, spanning the FULL window width. Its title reads "CAMERA — <name>", "SCREEN — <name>", "BROWSER — <url>", or an app name (CHAT, CHESS, WALLET, TODO, NOTES, GAS, QR, ENS, TRANSCRIPT).
  • DOTS — three small round traffic-light buttons (red ✕, yellow –, green +) at the LEFT end of the title bar. They mark the window's top-left corner.
  • NAME CARD — a small pill/label with the participant's handle/ENS (e.g. "binji", "austingriffith.eth") in the window's BOTTOM-LEFT corner. It marks the bottom edge.
  • FACE — for cameras, the person's head inside the video.

Use the landmarks geometrically: the TITLE BAR gives the top edge and the window WIDTH; trace straight down the left/right edges from the title bar to the NAME CARD to get the bottom edge.

Return ONLY a JSON array, one object per clearly-visible window. For a CAMERA:
{ "kind": "camera", "label": "<handle/ENS on the name card>",
  "dots": {"x":..,"y":..,"w":..,"h":..},      // the three coloured buttons (top-left)
  "titleBar": {"x":..,"y":..,"w":..,"h":..},   // the full menu bar across the top (width = window width)
  "face": {"x":..,"y":..,"w":..,"h":..},        // tight around the head
  "nameCard": {"x":..,"y":..,"w":..,"h":..} }   // the handle label in the bottom-left
For a SCREEN share or APP window:
{ "kind": "screen" | "app", "label": "<name or app>", "titleBar": {..}, "x":.., "y":.., "w":.., "h":.. }  // x/y/w/h = content area

- All coordinates are FRACTIONS [0,1] of the whole frame.
- Treat BROWSER and named apps as kind "app".
- Omit any single landmark you genuinely cannot see, but try hard to find the title bar (with its dots) and the name card for every camera.
- Skip windows mostly hidden behind another, and skip the desktop background, the top OS menu bar, and the dock.
- If you see no windows, return [].`;

const DOTS_PROMPT = `This is a single frame from the "slop.computer" desktop. Every open WINDOW has, at the very TOP-LEFT corner of its title bar, a cluster of THREE small same-sized buttons in a horizontal row: a RED button (✕), then a YELLOW button (–), then a GREEN button (+). This red-yellow-green trio is an exact, repeated UI pattern and is always the same small size.

Find EVERY red-yellow-green button cluster visible in the image — one per window, including windows partly hidden behind others, as long as the three buttons (or most of them) are visible.

Return ONLY a JSON array, one entry per cluster, each a TIGHT bounding box hugging the THREE buttons together (not the rest of the title bar):
[{ "x": <left>, "y": <top>, "w": <width>, "h": <height> }]
Coordinates are FRACTIONS [0,1] of the whole frame. Be precise: the box should sit exactly over the red, yellow and green buttons. Return [] if there are none.`;

/** Detect ONLY the red/yellow/green traffic-light clusters (one per window's
 *  top-left corner) — a focused pass to validate the most reliable landmark.
 *  Returns tight fractional boxes; tolerant of malformed output. */
export async function detectDots(opts: {
  source: string;
  framePath: string;
  startSec: number;
  endSec: number;
  reuseFrame?: boolean;
  log?: (m: string) => void;
}): Promise<Rect[]> {
  const log = opts.log ?? (() => {});
  try {
    const mid = (opts.startSec + opts.endSec) / 2;
    if (!opts.reuseFrame) await extractFrame(opts.source, mid, opts.framePath);
    const raw = await completeVision(DOTS_PROMPT, opts.framePath, config.anthropicModel);
    const lo = raw.indexOf("[");
    const hi = raw.lastIndexOf("]");
    const json = lo >= 0 && hi > lo ? raw.slice(lo, hi + 1) : raw;
    const arr = extractJson<{ x?: number; y?: number; w?: number; h?: number }[]>(json);
    if (!Array.isArray(arr)) return [];
    const out: Rect[] = [];
    for (const r of arr) {
      const { x, y, w, h } = r;
      if (![x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n))) continue;
      if (w! <= 0 || h! <= 0 || x! < 0 || y! < 0 || x! + w! > 1.04 || y! + h! > 1.04) continue;
      out.push({ x: x!, y: y!, w: w!, h: h! });
    }
    return out;
  } catch (err) {
    log(`dots detection failed (${err instanceof Error ? err.message : err})`);
    return [];
  }
}

/** Round to an even integer (yuv420p needs even crop dims), clamped ≥ 0. */
const even = (n: number) => {
  const v = Math.max(0, Math.round(n));
  return v - (v % 2);
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Best camera window for a speaker handle by fuzzy label match, or null. */
function matchCamera(cams: DetectedWindow[], speaker: string): DetectedWindow | null {
  const ns = norm(speaker);
  if (!ns) return null;
  for (const c of cams) {
    const nl = norm(c.label);
    if (nl && (nl === ns || nl.includes(ns) || ns.includes(nl))) return c;
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Whole window → even, in-frame pixel crop box, shrunk inward by `inset` — used
 *  for screens (we want the entire shared content, letterboxed by `contain`). */
function wholeCrop(win: Rect, srcW: number, srcH: number, inset: number): Rect {
  const px = { x: win.x * srcW, y: win.y * srcH, w: win.w * srcW, h: win.h * srcH };
  const x = even(px.x + px.w * inset);
  const y = even(px.y + px.h * inset);
  let w = even(px.w * (1 - 2 * inset));
  let h = even(px.h * (1 - 2 * inset));
  if (x + w > srcW) w = even(srcW - x);
  if (y + h > srcH) h = even(srcH - y);
  return { x, y, w, h };
}

/**
 * Crop for a CAMERA tile: the largest rect of the target cell's aspect ratio
 * (`cellAspect` = cellW/cellH) that fits the speaker's webcam, CENTRED on the
 * detected face. The catch the earlier versions hit: these webcams are small,
 * roughly-square windows, and the detected window box often bleeds past the real
 * edge into a NEIGHBOURING window — so cropping the window alone catches the
 * neighbour (binji's box grabs the app beside him; Austin's grabs binji).
 *
 * Fix: bound the crop's horizontal "lane" by the OTHER detected windows. The
 * crop can fill this window vertically, but it can never cross into a window
 * sitting to its left or right — using the data we already have to stop the
 * bleed regardless of a loose box. Centre on the face (window centre if none).
 */
function faceCrop(win: DetectedWindow, others: DetectedWindow[], cellAspect: number, srcW: number, srcH: number): Rect {
  const wx = win.x * srcW;
  const wy = win.y * srcH;
  const ww = win.w * srcW;
  const wh = win.h * srcH;
  const fcx = win.face ? (win.face.x + win.face.w / 2) * srcW : wx + ww / 2;
  const fcy = win.face ? (win.face.y + win.face.h / 2) * srcH : wy + wh / 2;

  // Horizontal lane around the face: start at this window's edges, then pull in
  // to any other window that shares this row and sits left/right of the face.
  let xL = wx;
  let xR = wx + ww;
  for (const o of others) {
    const ox = o.x * srcW;
    const ow = o.w * srcW;
    const oy = o.y * srcH;
    const oh = o.h * srcH;
    if (oy >= wy + wh || oy + oh <= wy) continue; // not in this row
    if (ox + ow <= fcx) xL = Math.max(xL, ox + ow); // neighbour to the left
    else if (ox >= fcx) xR = Math.min(xR, ox); // neighbour to the right
  }
  xL = Math.max(0, xL);
  xR = Math.min(srcW, xR);
  const yT = Math.max(0, wy);
  const yB = Math.min(srcH, wy + wh);

  // Largest cell-aspect rect inside the available lane, centred on the face.
  const availW = Math.max(2, xR - xL);
  const availH = Math.max(2, yB - yT);
  let ch = availH;
  let cw = ch * cellAspect;
  if (cw > availW) {
    cw = availW;
    ch = cw / cellAspect;
  }
  const x = even(clamp(fcx - cw / 2, xL, xR - cw));
  const y = even(clamp(fcy - ch / 2, yT, yB - ch));
  return { x, y, w: even(cw), h: even(ch) };
}

/**
 * Detect the desktop windows in a clip's mid-frame (one vision call). Returns
 * fractional-coordinate windows; tolerant — malformed/out-of-range/sliver
 * entries are dropped, and any error (frame grab / vision) returns [] so the
 * caller falls back to blur-pad. Cache the result (windows.json) — re-deriving
 * the layout from it is free.
 */
export async function detectClipWindows(opts: {
  source: string;
  framePath: string;
  startSec: number;
  endSec: number;
  reuseFrame?: boolean;
  log?: (m: string) => void;
}): Promise<DetectedWindow[]> {
  const log = opts.log ?? (() => {});
  try {
    const mid = (opts.startSec + opts.endSec) / 2;
    if (!opts.reuseFrame) await extractFrame(opts.source, mid, opts.framePath);
    const raw = await completeVision(DETECT_PROMPT, opts.framePath, config.anthropicModel);
    const lo = raw.indexOf("[");
    const hi = raw.lastIndexOf("]");
    const json = lo >= 0 && hi > lo ? raw.slice(lo, hi + 1) : raw;
    type RawRect = { x?: number; y?: number; w?: number; h?: number };
    type RawWin = RawRect & { kind?: string; label?: string; face?: RawRect; dots?: RawRect; titleBar?: RawRect; nameCard?: RawRect };
    const arr = extractJson<RawWin[]>(json);
    if (!Array.isArray(arr)) return [];
    const toRect = (r: RawRect | undefined): Rect | undefined => {
      if (!r || ![r.x, r.y, r.w, r.h].every(n => typeof n === "number" && Number.isFinite(n))) return undefined;
      if (r.w! <= 0 || r.h! <= 0 || r.x! < 0 || r.y! < 0 || r.x! + r.w! > 1.04 || r.y! + r.h! > 1.04) return undefined;
      return { x: r.x!, y: r.y!, w: r.w!, h: r.h! };
    };

    const wins: DetectedWindow[] = [];
    for (const o of arr) {
      const kind: WinKind = o.kind === "screen" ? "screen" : o.kind === "app" ? "app" : "camera";
      const titleBar = toRect(o.titleBar);
      const dots = toRect(o.dots);
      const nameCard = toRect(o.nameCard);
      const face = kind === "camera" ? toRect(o.face) : undefined;
      const obox = toRect(o);

      // Derive the content box. Cameras: from the landmarks — left/width/top from
      // the title bar, bottom from the name card; fall back to the model's own
      // box or face when a landmark is missing. Screens/apps: the given box.
      let box: Rect | undefined;
      if (kind === "camera" && titleBar) {
        const top = titleBar.y + titleBar.h; // content starts below the menu bar
        let bottom: number;
        if (nameCard) bottom = nameCard.y + nameCard.h;
        else if (obox) bottom = obox.y + obox.h;
        else if (face) bottom = face.y + face.h + face.h * 0.7;
        else bottom = top + titleBar.w; // square-ish guess
        if (bottom > top) box = { x: titleBar.x, y: top, w: titleBar.w, h: bottom - top };
      }
      if (!box && obox) box = obox;
      if (!box && titleBar) box = { x: titleBar.x, y: titleBar.y, w: titleBar.w, h: titleBar.h * 6 };
      if (!box || box.w < 0.05 || box.h < 0.05) continue; // missing or sliver — not a usable window

      wins.push({ kind, label: typeof o.label === "string" ? o.label : "", ...box, face, dots, titleBar, nameCard });
    }
    return wins;
  } catch (err) {
    log(`window detection failed (${err instanceof Error ? err.message : err})`);
    return [];
  }
}

const SCREEN_INSET = 0.015;
const OUT_W = 1080;
const OUT_H = 1920;

/**
 * Compose a clip's 9:16 layout from its detected windows + top speakers — a pure
 * function (no IO), mirroring slop's MobileStage. Hero content is a real SCREEN
 * share ONLY; apps (CHAT/QR/TRANSCRIPT/…) are deliberately NOT treated as hero —
 * pairing a face over the live-transcript window just fights our own captions.
 * Returns null tiles (→ blur-pad) when nothing usable resolves.
 */
export function composeLayout(
  wins: DetectedWindow[],
  speakers: string[],
  srcW: number,
  srcH: number,
): ClipLayout {
  const blur: ClipLayout = { tiles: null, seamFrac: 0.85, kind: "blur-pad", speakers };
  if (!wins.length) return blur;

  const cams = wins.filter(w => w.kind === "camera");
  const content = wins.find(w => w.kind === "screen") ?? null; // real screen shares only

  const matched: DetectedWindow[] = [];
  for (const sp of speakers) {
    const c = matchCamera(cams, sp);
    if (c && !matched.includes(c)) matched.push(c);
  }
  const primaryCam = matched[0] ?? cams[0] ?? null;
  const secondCam = matched[1] ?? cams.find(c => c !== primaryCam) ?? null;

  // A camera tile is cropped to its cell's exact aspect (1080 × weight·1920),
  // centred on the face. Screens take the whole window, letterboxed.
  const camTile = (w: DetectedWindow, weight: number): StackTile => ({
    ...faceCrop(
      w,
      wins.filter(o => o !== w),
      OUT_W / (weight * OUT_H),
      srcW,
      srcH,
    ),
    weight,
    fit: "cover",
  });
  const screenTile = (w: DetectedWindow, weight: number): StackTile => ({ ...wholeCrop(w, srcW, srcH, SCREEN_INSET), weight, fit: "contain" });

  // Speaker camera over a shared screen — slop's "interview" layout.
  if (content && primaryCam) {
    return { tiles: [camTile(primaryCam, 0.42), screenTile(content, 0.58)], seamFrac: 0.42, kind: "interview", speakers };
  }
  // Two speakers, no screen — stack their cameras 50/50.
  if (primaryCam && secondCam) {
    return { tiles: [camTile(primaryCam, 0.5), camTile(secondCam, 0.5)], seamFrac: 0.5, kind: "two-up", speakers };
  }
  // One camera — fill the frame, caption low so it stays off the face.
  if (primaryCam) {
    return { tiles: [camTile(primaryCam, 1)], seamFrac: 0.85, kind: "solo", speakers };
  }
  // No camera but a real screen — show it full.
  if (content) {
    return { tiles: [screenTile(content, 1)], seamFrac: 0.85, kind: "screen", speakers };
  }
  return blur;
}
