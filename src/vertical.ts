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

/** A detected desktop window, coordinates as FRACTIONS [0,1] of the frame
 *  (content area only — title bar/border excluded). Cached in windows.json. */
export type WinKind = "camera" | "screen" | "app";
export type DetectedWindow = { kind: WinKind; label: string; x: number; y: number; w: number; h: number };

/** A resolved 9:16 layout for one clip: stacked tiles (top→bottom) or null to
 *  signal the blur-pad fallback. `seamFrac` is where the caption band sits
 *  (fraction of height); `kind`/`speakers` are for logging. */
export type ClipLayout = {
  tiles: StackTile[] | null;
  seamFrac: number;
  kind: string;
  speakers: string[];
};

const DETECT_PROMPT = `This is a single frame from a recording of "slop.computer" — a live desktop where each participant's webcam, screen share and app is a draggable WINDOW on a dark 1920x1080 desktop. Every window has a TITLE BAR across its top (with small ✕ – + buttons at the left) reading one of:
  "CAMERA — <name>"   → a person's live webcam
  "SCREEN — <name>"   → a shared screen / desktop / demo
  "BROWSER — <url>"   → a web browser, or an app name like CHAT, CHESS, WALLET, TODO, NOTES, GAS, QR, ENS, TRANSCRIPT

Return ONLY a JSON array, one object per clearly-visible window:
[{ "kind": "camera" | "screen" | "app", "label": "<the name after the dash (a handle/ENS like \"binji\" or \"austingriffith.eth\"), or the app name; \"\" if unreadable>", "x": <left>, "y": <top>, "w": <width>, "h": <height> }]

- kind: "camera" or "screen" from the title-bar verb; treat BROWSER and named apps (CHAT, QR, ENS, TRANSCRIPT, …) as "app".
- x,y,w,h are FRACTIONS [0,1] of the frame for the window's VIDEO CONTENT AREA only — the region BELOW the title bar and INSIDE the window border. Do NOT include the title bar or borders; make the box TIGHT to the actual webcam/content, not the surrounding desktop.
- Skip windows mostly hidden behind another window, and skip the desktop background, menu bar, and dock.
- If you see no windows, return [].`;

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

/** Fractional window → even, in-frame pixel crop box, shrunk inward by `inset`
 *  on each side — the "ship loose" guard against catching a neighbour or border.
 *  Screens get a smaller inset so demo content survives. */
function crop(win: DetectedWindow, srcW: number, srcH: number, inset: number): { x: number; y: number; w: number; h: number } {
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
    const arr = extractJson<{ kind?: string; label?: string; x?: number; y?: number; w?: number; h?: number }[]>(json);
    if (!Array.isArray(arr)) return [];
    const wins: DetectedWindow[] = [];
    for (const o of arr) {
      const { x, y, w, h } = o;
      if (![x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n))) continue;
      if (w! <= 0 || h! <= 0 || x! < 0 || y! < 0 || x! + w! > 1.02 || y! + h! > 1.02) continue;
      if (w! < 0.06 || h! < 0.06) continue; // sliver — chrome, not a window
      const kind: WinKind = o.kind === "screen" ? "screen" : o.kind === "app" ? "app" : "camera";
      wins.push({ kind, label: typeof o.label === "string" ? o.label : "", x: x!, y: y!, w: w!, h: h! });
    }
    return wins;
  } catch (err) {
    log(`window detection failed (${err instanceof Error ? err.message : err})`);
    return [];
  }
}

const CAM_INSET = 0.05;
const SCREEN_INSET = 0.015;

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

  const camTile = (w: DetectedWindow, weight: number): StackTile => ({ ...crop(w, srcW, srcH, CAM_INSET), weight, fit: "cover" });
  const screenTile = (w: DetectedWindow, weight: number): StackTile => ({ ...crop(w, srcW, srcH, SCREEN_INSET), weight, fit: "contain" });

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
