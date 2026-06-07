import { CropBox, extractFrame } from "./ffmpeg.js";
import { completeVision, extractJson } from "./llm.js";
import { config } from "./config.js";
import { attributeWindow, type LiveLine } from "./speakers.js";

// Mobile (9:16) composition — the "hard mode" the brief asked for: instead of
// letterboxing the wide call into a tall frame, ISOLATE the speakers' on-screen
// video tiles and stack them, captions burned over the seam.
//
// slop.computer composites participants as a grid of rectangular tiles whose
// positions are dynamic (they reflow as people join/leave) but stable over any
// short span. So per clip we sample one frame, ask a vision model for each
// tile's box + the name on it, then match the clip's top speakers (recovered by
// speaker attribution) to their tiles. The result is a set of crop rectangles
// the ffmpeg compositor stacks. When detection or matching can't place the
// speakers, we return null boxes and the compositor falls back to blur-pad —
// so a vertical clip is always produced, never a crash.

/** Resolved 9:16 layout for one clip: the crop rectangles to stack (1 or 2), or
 *  null to signal the blur-pad fallback. `speakers` is for logging/debugging. */
export type ClipLayout = { boxes: CropBox[] | null; speakers: string[] };

// A detected participant tile in SOURCE PIXEL coordinates.
type Tile = { label: string; x: number; y: number; w: number; h: number };

const DETECT_PROMPT = `This is a single frame from a multi-participant video podcast ("slop.computer"). The frame is a composite of rectangular participant video tiles (camera feeds or avatar/initial tiles) arranged on a dark background, often with a small name/handle label drawn on each tile.

Return ONLY a JSON array, one object per participant video tile that is actually visible:
[{ "label": "<the name/handle text shown on the tile, or \"\" if none is legible>", "x": <left>, "y": <top>, "w": <width>, "h": <height> }]

x, y, w, h are FRACTIONS of the frame in [0,1]: (x,y) is the tile's top-left corner, (w,h) its size. Be as tight and accurate to the tile's real borders as you can. Include ONLY participant video tiles — NOT the page background, headers, sidebars, burned-in captions, or any other UI chrome. If you see no tiles, return [].`;

/** Round to an even integer (yuv420p needs even crop dims), clamped ≥ 0. */
const even = (n: number) => {
  const v = Math.max(0, Math.round(n));
  return v - (v % 2);
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Best tile for a speaker handle by fuzzy label match (either contains the
 *  other), or null if nothing resembles it (e.g. tile shows no readable name). */
function matchTile(tiles: Tile[], speaker: string): Tile | null {
  const ns = norm(speaker);
  if (!ns) return null;
  for (const t of tiles) {
    const nl = norm(t.label);
    if (nl && (nl === ns || nl.includes(ns) || ns.includes(nl))) return t;
  }
  return null;
}

/** Shrink a tile inward by `inset` on each side and convert to an even, in-frame
 *  pixel CropBox. The inset is the "ship loose" guard: detected boxes can be a
 *  touch generous, so we sacrifice a few % rather than risk catching a sliver of
 *  the neighbouring tile. */
function toCropBox(t: Tile, srcW: number, srcH: number, inset: number): CropBox {
  let x = even(t.x + t.w * inset);
  let y = even(t.y + t.h * inset);
  let w = even(t.w * (1 - 2 * inset));
  let h = even(t.h * (1 - 2 * inset));
  // Clamp so the crop stays inside the frame.
  if (x + w > srcW) w = even(srcW - x);
  if (y + h > srcH) h = even(srcH - y);
  return { x, y, w, h };
}

/** Vision-detect participant tiles in a frame; returns source-pixel boxes.
 *  Tolerant: any malformed/out-of-range entry is dropped, never thrown. */
async function detectTiles(framePath: string, srcW: number, srcH: number): Promise<Tile[]> {
  const raw = await completeVision(DETECT_PROMPT, framePath, config.anthropicModel);
  // Slice to the outermost [...] before parsing: the model sometimes appends a
  // sentence after the array, which would make a whole-remainder parse throw.
  const lo = raw.indexOf("[");
  const hi = raw.lastIndexOf("]");
  const json = lo >= 0 && hi > lo ? raw.slice(lo, hi + 1) : raw;
  const arr = extractJson<{ label?: string; x?: number; y?: number; w?: number; h?: number }[]>(json);
  if (!Array.isArray(arr)) return [];
  const tiles: Tile[] = [];
  for (const o of arr) {
    const { x, y, w, h } = o;
    if (![x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n))) continue;
    if (w! <= 0 || h! <= 0 || x! < 0 || y! < 0 || x! + w! > 1.02 || y! + h! > 1.02) continue;
    // Drop slivers — almost certainly UI chrome, not a participant tile.
    if (w! < 0.08 || h! < 0.08) continue;
    tiles.push({ label: typeof o.label === "string" ? o.label : "", x: x! * srcW, y: y! * srcH, w: w! * srcW, h: h! * srcH });
  }
  return tiles;
}

/**
 * Resolve one clip's 9:16 layout: who's talking → which tiles → crop boxes.
 *
 * Picks up to the top two speakers in the window. If both map to distinct tiles,
 * stacks them (primary on top). If exactly two tiles exist regardless of labels,
 * uses both. If only one speaker/tile resolves, fills the frame with that single
 * tile. Otherwise returns null boxes → blur-pad fallback. Any error (frame grab
 * or detection) also degrades to blur-pad rather than failing the clip.
 */
export async function resolveClipLayout(opts: {
  source: string;
  srcW: number;
  srcH: number;
  framePath: string;
  startSec: number;
  endSec: number;
  live: LiveLine[];
  offsetMs: number | null;
  inset?: number;
  reuseFrame?: boolean; // skip re-extracting if the frame png already exists
  log?: (m: string) => void;
}): Promise<ClipLayout> {
  const log = opts.log ?? (() => {});
  const inset = opts.inset ?? 0.04;

  // Top speakers in the window (empty if we couldn't align the live transcript).
  const info =
    opts.offsetMs == null
      ? { primary: null, shares: [] as { speaker: string }[] }
      : attributeWindow(opts.live, opts.offsetMs, opts.startSec, opts.endSec);
  const speakers = info.shares.slice(0, 2).map(s => s.speaker);

  try {
    const mid = (opts.startSec + opts.endSec) / 2;
    if (!opts.reuseFrame) await extractFrame(opts.source, mid, opts.framePath);
    const tiles = await detectTiles(opts.framePath, opts.srcW, opts.srcH);
    if (!tiles.length) {
      log(`no tiles detected → blur-pad`);
      return { boxes: null, speakers };
    }

    const box = (t: Tile) => toCropBox(t, opts.srcW, opts.srcH, inset);

    // Try to place the top two speakers onto distinct tiles.
    const matched = speakers.map(sp => matchTile(tiles, sp));
    if (matched.length >= 2 && matched[0] && matched[1] && matched[0] !== matched[1]) {
      log(`stacking ${speakers[0]} / ${speakers[1]} (matched tiles)`);
      return { boxes: [box(matched[0]), box(matched[1])], speakers };
    }
    // Exactly two tiles in the room: stack both (primary on top if we know it).
    if (tiles.length === 2) {
      const top = matched[0] ?? tiles[0]!;
      const bot = tiles.find(t => t !== top) ?? tiles[1]!;
      log(`stacking the two visible tiles`);
      return { boxes: [box(top), box(bot)], speakers };
    }
    // One speaker resolves (or only one tile exists): single tile, full frame.
    const single = matched.find(Boolean) ?? (tiles.length === 1 ? tiles[0]! : null);
    if (single) {
      log(`single tile (${single.label || "primary speaker"})`);
      return { boxes: [box(single)], speakers };
    }
    // Ambiguous: many tiles, none matched. Don't guess — blur-pad.
    log(`${tiles.length} tiles, no speaker match → blur-pad`);
    return { boxes: null, speakers };
  } catch (err) {
    log(`layout detection failed (${err instanceof Error ? err.message : err}) → blur-pad`);
    return { boxes: null, speakers };
  }
}
