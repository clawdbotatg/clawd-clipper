import { spawn } from "node:child_process";
import { config } from "./config.js";
import { probeSize } from "./ffmpeg.js";

// Raw-pixel access to a frame, so detection can be DETERMINISTIC (sample exact
// colours, scan for fixed patterns) instead of asking a model to eyeball tiny
// UI elements. We decode the PNG to a flat rgb24 buffer via ffmpeg (no image
// library / native dep), then index it directly.

export type RgbFrame = {
  width: number;
  height: number;
  data: Buffer; // length width*height*3, row-major rgb24
};

/** Decode an image file to a flat rgb24 buffer (ffmpeg → rawvideo on stdout). */
export async function loadFrameRGB(path: string): Promise<RgbFrame> {
  const { width, height } = await probeSize(path);
  const data = await new Promise<Buffer>((resolve, reject) => {
    const ff = spawn(config.ffmpegBin, ["-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-loglevel", "error", "pipe:1"]);
    const chunks: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", c => chunks.push(c));
    ff.stderr.on("data", c => (err += c.toString()));
    ff.on("error", reject);
    ff.on("close", code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg rawvideo exited ${code}: ${err.slice(-300)}`))));
  });
  const expected = width * height * 3;
  if (data.length < expected) throw new Error(`short rawvideo buffer: got ${data.length}, expected ${expected}`);
  return { width, height, data };
}

/** [r,g,b] at integer (x,y); clamps to the frame edges. */
export function colorAt(f: RgbFrame, x: number, y: number): [number, number, number] {
  const cx = Math.max(0, Math.min(f.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(f.height - 1, Math.round(y)));
  const i = (cy * f.width + cx) * 3;
  return [f.data[i]!, f.data[i + 1]!, f.data[i + 2]!];
}

export const hex = ([r, g, b]: [number, number, number]) =>
  "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");

export type Box = { x: number; y: number; w: number; h: number };

// Window traffic-light colours, sampled from real frames (macOS-style):
//   red ≈ (255,94,84)  yellow ≈ (255,188,46)  green ≈ (40,199,64)
// Classify a pixel as 1=red, 2=yellow, 3=green, 0=other. The magenta title bar
// (≈212,16,166) is the main thing to exclude — it has HIGH blue, the red dot
// has LOW blue, so the blue bounds separate them.
//
// Each colour also gets a DIMMED band: slop renders UNFOCUSED windows at ~72%
// brightness, so their dots read ≈(191,69,67)/(184,135,36)/(30,142,50) and the
// bright-only thresholds miss them entirely. That made unfocused windows
// invisible to detection — and an undetected window below a focused one let the
// focused window's bottom trace run straight through it (the shafu0x split-
// screen bug). The dim bands are narrow and the red→yellow→green adjacency
// structure (findDotClusters) filters any stray video pixels they admit.
function classify(r: number, g: number, b: number): 0 | 1 | 2 | 3 {
  if (r > 215 && g >= 55 && g <= 140 && b >= 40 && b <= 130 && r - g > 95 && r - b > 105) return 1; // red
  if (r > 168 && g >= 40 && g <= 110 && b >= 35 && b <= 110 && r - g > 100 && r - b > 105) return 1; // red (dimmed)
  if (r > 225 && g >= 150 && g <= 215 && b < 105 && g - b > 80 && r - b > 135) return 2; // yellow
  if (r > 165 && g >= 110 && g < 170 && b < 80 && g - b > 75 && r - b > 125) return 2; // yellow (dimmed)
  if (r < 110 && g > 150 && b < 120 && g - r > 85 && g - b > 75) return 3; // green
  if (r < 85 && g > 118 && b < 95 && g - r > 85 && g - b > 70) return 3; // green (dimmed)
  return 0;
}

type Comp = Box & { cx: number; cy: number; count: number };

/** Connected components (4-conn) of a single colour label in `cls`. */
function components(cls: Uint8Array, W: number, H: number, color: number, minCount: number): Comp[] {
  const seen = new Uint8Array(W * H);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let p = 0; p < cls.length; p++) {
    if (cls[p] !== color || seen[p]) continue;
    let minx = W,
      miny = H,
      maxx = 0,
      maxy = 0,
      count = 0;
    stack.length = 0;
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % W;
      const qy = (q / W) | 0;
      count++;
      if (qx < minx) minx = qx;
      if (qx > maxx) maxx = qx;
      if (qy < miny) miny = qy;
      if (qy > maxy) maxy = qy;
      if (qx > 0 && cls[q - 1] === color && !seen[q - 1]) (seen[q - 1] = 1), stack.push(q - 1);
      if (qx < W - 1 && cls[q + 1] === color && !seen[q + 1]) (seen[q + 1] = 1), stack.push(q + 1);
      if (qy > 0 && cls[q - W] === color && !seen[q - W]) (seen[q - W] = 1), stack.push(q - W);
      if (qy < H - 1 && cls[q + W] === color && !seen[q + W]) (seen[q + W] = 1), stack.push(q + W);
    }
    const w = maxx - minx + 1;
    const h = maxy - miny + 1;
    if (count >= minCount && w >= 6 && h >= 6 && w <= 90 && h <= 90)
      comps.push({ x: minx, y: miny, w, h, cx: minx + w / 2, cy: miny + h / 2, count });
  }
  return comps;
}

/** Vertical overlap fraction of two components (0..1 of the smaller height). */
function vOverlap(a: Comp, b: Comp): number {
  const lo = Math.max(a.y, b.y);
  const hi = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, hi - lo) / Math.min(a.h, b.h);
}

/** Is `b` the next dot immediately to the right of `a` (adjacent, same row,
 *  similar size)? The dots sit a few px apart, all the same size. */
function rightOf(a: Comp, b: Comp): boolean {
  const gap = b.x - (a.x + a.w);
  return (
    gap >= -4 &&
    gap <= a.w * 0.9 &&
    vOverlap(a, b) > 0.4 &&
    Math.abs(a.h - b.h) <= Math.max(a.h, b.h) * 0.6 &&
    Math.abs(a.w - b.w) <= Math.max(a.w, b.w) * 0.7
  );
}

/**
 * Find every red→yellow→green traffic-light cluster, deterministically, by
 * pixel colour. Returns a tight box around each [red,yellow,green] triple.
 * Robust to the ✕/–/+ glyphs (they leave holes that don't affect the bbox) and
 * to small gaps between dots (matched by adjacency, not connectivity).
 */
export function findDotClusters(f: RgbFrame): Box[] {
  const { width: W, height: H, data } = f;
  const cls = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < cls.length; p++, i += 3) cls[p] = classify(data[i]!, data[i + 1]!, data[i + 2]!);
  const minCount = 50;
  const reds = components(cls, W, H, 1, minCount);
  const yellows = components(cls, W, H, 2, minCount);
  const greens = components(cls, W, H, 3, minCount);

  const out: Box[] = [];
  for (const r of reds) {
    const y = yellows.find(yy => rightOf(r, yy));
    if (!y) continue;
    const g = greens.find(gg => rightOf(y, gg));
    if (!g) continue;
    const x0 = Math.min(r.x, y.x, g.x);
    const y0 = Math.min(r.y, y.y, g.y);
    const x1 = Math.max(r.x + r.w, y.x + y.w, g.x + g.w);
    const y1 = Math.max(r.y + r.h, y.y + y.h, g.y + g.h);
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

// The window title/menu bar + frame magenta, sampled from real frames
// (≈190,55,160, a gradient). Distinct from the red dot by its HIGH blue.
// Second band: the same bar on an UNFOCUSED (dimmed ~72%) window reads
// ≈(104,33,91) — same hue, lower brightness — which the bright band misses,
// so the bar trace (and with it the whole window) failed for dimmed windows.
function isMagenta(r: number, g: number, b: number): boolean {
  if (r > 150 && g < 100 && b > 115 && b - g > 35 && r - g > 70) return true;
  return r > 88 && r <= 160 && g < 70 && b > 72 && r - g > 55 && b - g > 40;
}

/** Fraction of a vertical span at column `x` that is magenta. */
function colMagenta(f: RgbFrame, x: number, y0: number, y1: number): number {
  if (x < 0 || x >= f.width) return 0;
  let hit = 0;
  let n = 0;
  for (let y = Math.max(0, y0); y <= Math.min(f.height - 1, y1); y++, n++) {
    const i = (y * f.width + x) * 3;
    if (isMagenta(f.data[i]!, f.data[i + 1]!, f.data[i + 2]!)) hit++;
  }
  return n ? hit / n : 0;
}

/** Fraction of a horizontal span at row `y` that is magenta. */
function rowMagenta(f: RgbFrame, y: number, x0: number, x1: number): number {
  if (y < 0 || y >= f.height) return 0;
  let hit = 0;
  let n = 0;
  for (let x = Math.max(0, x0); x <= Math.min(f.width - 1, x1); x++, n++) {
    const i = (y * f.width + x) * 3;
    if (isMagenta(f.data[i]!, f.data[i + 1]!, f.data[i + 2]!)) hit++;
  }
  return n ? hit / n : 0;
}

/** One window resolved from a traffic-light cluster. `menuBar` is the title bar
 *  (top + width); `windowBox` is the full bounds (null bottom → couldn't trace).
 *  `isWindow` is false for clusters that are actually name-card icons (no bar). */
export type WindowTrace = {
  dots: Box;
  isWindow: boolean;
  menuBar?: Box;
  windowBox?: Box;
};

const MENU_MIN_RUN = 50; // a real bar (menu bar OR name-card pill) extends ≥ this px right of the dots

// The window FRAME is a 1px, 50%-alpha magenta border, so its on-screen colour
// = 0.5·(255,62,201) + 0.5·background. Over DARK video that's a dim purple
// (≈100,38,94); over a BRIGHT room it's bright pink (≈237,141,228). Absolute
// thresholds can't catch both. The invariant is its MAGENTA-NESS — pulled toward
// magenta (high red+blue, suppressed green) relative to neutral content — which
// holds at any brightness. (Neutral/skin/white backgrounds score ~0-15.)
function isFrameLine(r: number, g: number, b: number): boolean {
  const m = (r + b) / 2 - g; // magenta-ness
  return m > 33 && r > g + 22 && b > g + 18 && r + b > 90;
}

/** A traced vertical frame line, with the bottom corner if one was confirmed
 *  (the vertical line meets a horizontal bottom line of the same colour). */
export type FrameLine = { x: number; y0: number; y1: number; corner: { x: number; y: number } | null };

/**
 * Trace the two vertical FRAME lines down from the menu bar's left/right corners
 * until the purple ends, and find the bottom corners. At each row we search a
 * small x-window for the dim frame pixel; the line stops after a run of misses
 * (bridging small occlusions/anti-aliasing). At the line's end we look INWARD
 * for a horizontal frame line of the same colour — if present, that's a real
 * corner (painted); if the line is occluded/off-screen, corner is null.
 */
export function traceSideFrames(f: RgbFrame, menuBar: Box): { left: FrameLine | null; right: FrameLine | null } {
  const { width: W, height: H, data } = f;
  const yTop = menuBar.y + menuBar.h;
  const frameAt = (x: number, y: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const i = (y * W + x) * 3;
    return isFrameLine(data[i]!, data[i + 1]!, data[i + 2]!);
  };

  const traceDown = (cx: number): Omit<FrameLine, "corner"> | null => {
    const xs: number[] = [];
    let y0 = -1;
    let y1 = -1;
    let miss = 0;
    // Search a wide window (the dots can sit ~10px in from the frame, and a
    // neighbouring window may be just beyond), and take the frame column CLOSEST
    // to the corner — so we land on THIS window's edge, not a neighbour's.
    for (let y = yTop; y < H; y++) {
      let hit = -1;
      let bestDist = 99;
      for (let dx = -13; dx <= 13; dx++) {
        if (Math.abs(dx) < bestDist && frameAt(cx + dx, y)) ((hit = cx + dx), (bestDist = Math.abs(dx)));
      }
      if (hit >= 0) {
        if (y0 < 0) y0 = y;
        y1 = y;
        xs.push(hit);
        miss = 0;
      } else if (y0 >= 0 && ++miss > 12) break;
    }
    if (xs.length < 12) return null;
    xs.sort((a, b) => a - b);
    return { x: xs[xs.length >> 1]!, y0, y1 };
  };

  // Confirm a corner: from the line's bottom, a horizontal frame line of the
  // same colour must run INWARD (dir = +1 for the left side, -1 for the right).
  const cornerOf = (line: Omit<FrameLine, "corner"> | null, dir: number): { x: number; y: number } | null => {
    if (!line) return null;
    const y = line.y1;
    let run = 0;
    let started = false;
    for (let k = 2; k <= 60; k++) {
      const x = line.x + dir * k;
      let on = false;
      for (let dy = -2; dy <= 2 && !on; dy++) on = frameAt(x, y + dy);
      if (on) ((run++), (started = true));
      else if (started) break;
    }
    return run >= 12 ? { x: line.x, y } : null;
  };

  const L = traceDown(menuBar.x);
  const R = traceDown(menuBar.x + menuBar.w);
  return {
    left: L ? { ...L, corner: cornerOf(L, +1) } : null,
    right: R ? { ...R, corner: cornerOf(R, -1) } : null,
  };
}

export type WindowBottom = { y: number; score: number; leftX: number; rightX: number; leftEnd: number; rightEnd: number };

/**
 * Resolve a window's bottom by combining the two signals:
 *  - the SIDE traces give candidate bottom rows (where each side line ends), and
 *  - the real bottom has those corners joined by a HORIZONTAL frame line.
 * So among the side-end candidates (plus a horizontal-scan fallback) we pick the
 * row with the most horizontal frame-ridge coverage — that corroborates a corner
 * with an actual bottom border, rejecting a side that over-traced into the
 * desktop/another window (its end-row has no horizontal line).
 */
export function findWindowBottom(f: RgbFrame, menuBar: Box): WindowBottom {
  const { width: W, height: H, data } = f;
  const sides = traceWindowSides(f, menuBar);
  const mAt = (x: number, y: number): number => {
    if (x < 0 || x >= W || y < 0 || y >= H) return -999;
    const i = (y * W + x) * 3;
    return (data[i]! + data[i + 2]!) / 2 - data[i + 1]!;
  };
  const isEdge = (x: number, y: number) => {
    const m = mAt(x, y);
    return m >= 16 && m - Math.max(mAt(x, y - 6), mAt(x, y + 6)) > 9;
  };
  const x0 = menuBar.x + 4;
  const x1 = menuBar.x + menuBar.w - 4;
  const rowCov = (y: number) => {
    let hit = 0;
    let n = 0;
    for (let x = x0; x <= x1; x += 2) {
      n++;
      if (isEdge(x, y) || isEdge(x, y - 1) || isEdge(x, y + 1)) hit++;
    }
    return n ? hit / n : 0;
  };
  const yFloor = menuBar.y + menuBar.h + 30;
  // Among the side-end candidates, take the one best corroborated by a
  // horizontal frame line (tie → the shallower, more conservative one).
  let bestY = -1;
  let cov = 0;
  for (const y of [sides.leftEnd, sides.rightEnd]) {
    if (y < yFloor) continue;
    const c = rowCov(y);
    if (c > cov || (c === cov && (bestY < 0 || y < bestY))) ((cov = c), (bestY = y));
  }
  // Confidence = the STRONGER of: a horizontal bottom border (coverage), OR the
  // two side traces AGREEING on this bottom (each agreeing side is independent
  // evidence of the corner, so a faint border still reads high when both sides
  // confirm it).
  let score = cov;
  let bothAgree = false;
  if (bestY > 0) {
    const near = (e: number) => e >= yFloor && Math.abs(e - bestY) <= 40;
    const agree = (near(sides.leftEnd) ? 1 : 0) + (near(sides.rightEnd) ? 1 : 0);
    bothAgree = agree >= 2;
    if (agree >= 2) score = Math.max(score, 0.92);
    else if (agree >= 1) score = Math.max(score, 0.78);
  }
  // The horizontal full-width magenta border (findBottomLine) is the most DIRECT
  // evidence of the real bottom. The side traces fade out early over the window's
  // own video content (and can also OVER-run past the bottom, down through e.g. a
  // desktop icon dock below it). So we cross-check them against the border:
  //   - ONE side only, ending on no border of its own (cov below the horizontal
  //     line's confidence) → faint stub, usually far above the true edge (slicing
  //     a face): take the horizontal border.
  //   - BOTH sides agreeing AND a real border there (cov ≥ 0.5) → a true corner
  //     pair: trust it (it correctly beats a false early line INSIDE the window,
  //     e.g. a sub-toolbar/divider).
  //   - BOTH sides agreeing but on a row with NO border (cov < 0.5) while the
  //     horizontal scan found a confident border ABOVE them → the sides over-ran
  //     together past the bottom (the dock/desktop below shares the frame colour):
  //     pull up to the border. Guarded by `fb.y < bestY` + `fb.score ≥ 0.8` so a
  //     far-below desktop line (lower y, weaker) never wins.
  const fb = findBottomLine(f, menuBar);
  const weakSingle = !bothAgree && fb.y > 0 && fb.score >= 0.8 && fb.score > cov;
  const overshoot = bothAgree && cov < 0.5 && fb.y > 0 && fb.y < bestY && fb.score >= 0.8;
  if (weakSingle || overshoot) ((score = fb.score), (bestY = fb.y));
  else if ((bestY < 0 || score < 0.5) && fb.y > 0 && fb.score > score) ((score = fb.score), (bestY = fb.y));
  return { y: bestY, score: Math.round(score * 100) / 100, leftX: sides.leftX, rightX: sides.rightX, leftEnd: sides.leftEnd, rightEnd: sides.rightEnd };
}

export type BottomGuess = { y: number; score: number; xL: number; xR: number };

/**
 * Find the window's BOTTOM frame line. The window's left/right edges come from
 * the (rock-solid) menu bar, so we only search vertically. Each candidate row is
 * scored by how much of a horizontal FRAME-COLORED line spans the window width
 * (`isFrameLine` = magenta-shifted, over dark OR bright bg). The bottom border
 * is a near-full-width frame line; the video above it (even a magenta tunnel) is
 * only partial per row.
 *
 * NO positioning assumptions — windows go anywhere/any size and overlap by
 * z-order, so we do NOT bound by other windows. We scan the window's own column
 * and take the FIRST near-full-width frame line: that's its bottom border (the
 * far-below desktop ticker is never reached first). If none is found before the
 * frame edge, the bottom is occluded/undetectable (y = -1) — we don't invent one.
 */
export function findBottomLine(f: RgbFrame, menuBar: Box): BottomGuess {
  const { width: W, height: H, data } = f;
  const xL = Math.max(0, menuBar.x);
  const xR = Math.min(W - 1, menuBar.x + menuBar.w);
  const yTop = menuBar.y + menuBar.h;
  // Magenta-ness of a pixel = how far it's pulled toward magenta (high red+blue,
  // low green). The frame border is a horizontal RIDGE of this: more magenta than
  // the video above and the content below. Using a local ridge (not an absolute
  // threshold) catches a border that's bright over a white wall OR very faint
  // over dark-on-dark — both just need to stand out from their neighbours.
  const mAt = (x: number, y: number): number => {
    if (x < 0 || x >= W || y < 0 || y >= H) return -999;
    const i = (y * W + x) * 3;
    return (data[i]! + data[i + 2]!) / 2 - data[i + 1]!;
  };
  const isEdge = (x: number, y: number): boolean => {
    const m = mAt(x, y);
    return m >= 16 && m - Math.max(mAt(x, y - 6), mAt(x, y + 6)) > 9;
  };
  // Coverage of that ridge across the window width (inset off the side frames;
  // ±1 row slack). A real bottom border spans full width; a partial tunnel line
  // doesn't.
  const x0 = xL + 4;
  const x1 = xR - 4;
  const score = (y: number) => {
    let hit = 0;
    let n = 0;
    for (let x = x0; x <= x1; x += 2) {
      n++;
      if (isEdge(x, y) || isEdge(x, y - 1) || isEdge(x, y + 1)) hit++;
    }
    return n ? hit / n : 0;
  };
  const yMin = yTop + 50; // skip the menu bar + any sub-toolbar right under it
  const yMax = H - 1; // scan the window's whole column — no positioning bound
  // The bottom is the FIRST near-full-width frame line scanning down: a magenta
  // tunnel/wallpaper only makes PARTIAL lines (< HIGH) above the real edge, so
  // they're skipped, and the window's own bottom comes before any far-below
  // desktop feature. If none qualifies, the bottom is occluded → y = -1.
  const HIGH = 0.78;
  let maxS = 0;
  for (let y = yMin; y <= yMax; y++) {
    const s = score(y);
    if (s > maxS) maxS = s;
    if (s >= HIGH) return { y, score: Math.round(s * 100) / 100, xL, xR };
  }
  return { y: -1, score: Math.round(maxS * 100) / 100, xL, xR };
}

/** Trace the magenta bar left/right from a cluster's dots. Returns the bar's
 *  left/right edges and whether one exists (≥ MENU_MIN_RUN to the right). */
export function traceBar(f: RgbFrame, d: Box): { left: number; right: number; hasBar: boolean } {
  const by0 = d.y + 2;
  const by1 = d.y + d.h - 2;
  const cov = (x: number) => colMagenta(f, x, by0, by1);
  // GROUND TRUTH: every window has its red/yellow/green dots in the top-left,
  // and the window's LEFT edge sits right at the left of the dots — the dots ARE
  // the leftmost element. So the left edge is NOT searched for: it's the dots'
  // left, full stop. (Tracing left across magenta over-runs into a neighbour's
  // title bar or the desktop — e.g. it once walked 372px left of the dots and
  // drew a box over a region with no dots, looking like a phantom window.)
  //
  // Only the RIGHT edge is traced: walk out along the bar, and when magenta
  // coverage drops, DON'T assume the bar ended — probe up to `look` px ahead; if
  // the bar resumes, that dip was just noise (title text, a button, an icon) so
  // we jump past it and keep going. Only a sustained gap is the real edge. The
  // look-ahead stays under a typical inter-window gap so it can't merge into the
  // next window.
  const trace = (dir: 1 | -1, look: number): number => {
    let edge = dir > 0 ? d.x + d.w : d.x;
    let x = edge + dir;
    while (x >= 0 && x < f.width) {
      if (cov(x) > 0.35) {
        edge = x;
        x += dir;
        continue;
      }
      let resume = -1;
      for (let k = 1; k <= look; k++) {
        const xx = x + dir * k;
        if (xx < 0 || xx >= f.width) break;
        if (cov(xx) > 0.35) {
          resume = xx;
          break;
        }
      }
      if (resume < 0) break;
      x = resume;
    }
    return edge;
  };
  const right = trace(1, 36);
  const left = d.x; // ground truth: window left edge = left of the dots
  return { left, right, hasBar: right - (d.x + d.w) >= MENU_MIN_RUN };
}

export type SideTrace = { leftX: number; rightX: number; leftEnd: number; rightEnd: number };

/**
 * Trace the window's vertical SIDE frame lines down from the menu-bar corners.
 * A side line is magenta-shifted relative to the desktop OUTSIDE it — we test a
 * ONE-SIDED ridge (more magenta than ~5px to the outside) so a magenta video
 * INSIDE (e.g. a tunnel wallpaper) can't cancel it. Each side is followed down
 * (tracking small x drift, bridging faint/occluded gaps) until it ends — that's
 * the bottom corner. Returns each side's x and end-y (-1 if not traced).
 *
 * Why this matters: when a window's horizontal bottom border is faint or
 * occluded (a flush window below it), the side edges are usually still visible,
 * so they give the bottom where the horizontal scan can't.
 */
export function traceWindowSides(f: RgbFrame, menuBar: Box): SideTrace {
  const { width: W, height: H, data } = f;
  const m = (x: number, y: number): number => {
    if (x < 0 || x >= W || y < 0 || y >= H) return -999;
    const i = (y * W + x) * 3;
    return (data[i]! + data[i + 2]!) / 2 - data[i + 1]!;
  };
  const yTop = menuBar.y + menuBar.h;
  const traceSide = (cx: number, outDir: 1 | -1): { x: number; yEnd: number } => {
    const isFrame = (x: number, y: number) => m(x, y) >= 14 && m(x, y) - m(x + outDir * 5, y) > 9;
    // Search a FIXED ±7 window around the menu-bar corner — windows are
    // axis-aligned so the side is a straight vertical at a constant x. (Letting
    // the search drift per-row lets it wander onto an adjacent window's edge.)
    const colAt = (y: number): boolean => {
      for (let dx = -7; dx <= 7; dx++) if (isFrame(cx + dx, y)) return true;
      return false;
    };
    let yEnd = -1;
    let count = 0;
    let y = yTop;
    while (y < H) {
      if (colAt(y)) {
        yEnd = y;
        count++;
        y++;
        continue;
      }
      let ry = -1;
      for (let k = 1; k <= 12 && ry < 0; k++) if (colAt(y + k)) ry = y + k; // bridge only small gaps, so we don't run into stuff below
      if (ry < 0) break;
      yEnd = ry;
      count++;
      y = ry + 1;
    }
    return { x: cx, yEnd: count >= 12 ? yEnd : -1 };
  };
  const L = traceSide(menuBar.x, -1);
  const R = traceSide(menuBar.x + menuBar.w, 1);
  return { leftX: L.x, rightX: R.x, leftEnd: L.yEnd, rightEnd: R.yEnd };
}

/**
 * Resolve windows from red/yellow/green clusters.
 *
 * Every such cluster has a magenta bar to its right — but two KINDS produce one:
 * a window's TOP menu bar (spans the full window width), and a NAME-CARD pill in
 * the bottom-left (the handle background, narrower than the window). They're
 * indistinguishable in isolation (the name-card identicon is literally the same
 * red/yellow/green). So we pair them: a menu-bar at the top + the name-card
 * below it at the same left edge bracket the window — and the name card gives us
 * the BOTTOM edge (#2). Windows with no detected name card fall back to a
 * full-width magenta bottom-border scan (#1), which the tunnel wallpaper can't
 * fool (its rows are <10% magenta; a real border is full width).
 */
export function traceWindows(f: RgbFrame, clusters: Box[]): WindowTrace[] {
  const bars = clusters
    .map(d => ({ d, ...traceBar(f, d) }))
    .filter(b => b.hasBar)
    .sort((a, b) => a.d.y - b.d.y);

  // A name-card pill is NARROWER than its window (doesn't reach the right edge).
  const isNameCardFor = (top: (typeof bars)[number], cand: (typeof bars)[number]) =>
    cand !== top &&
    cand.d.y > top.d.y + 60 && // clearly below the menu bar
    cand.left >= top.left - 20 &&
    cand.left <= top.left + 200 && // same left region (a little inset)
    cand.right <= top.right - 40 && // narrower than the window → a pill, not a stacked window
    cand.d.y < top.d.y + (top.right - top.left) * 1.8; // within a plausible window height

  const used = new Set<(typeof bars)[number]>();
  const traces: WindowTrace[] = [];
  for (const top of bars) {
    if (used.has(top)) continue;
    const nameCard = bars.find(c => !used.has(c) && isNameCardFor(top, c));
    if (nameCard) used.add(nameCard);

    const y0 = top.d.y - 2;
    const menuBar: Box = { x: top.left, y: y0, w: top.right - top.left, h: top.d.h + 4 };

    // Bottom: when we have a name card, trace its magenta pill DOWN to its last
    // row — that line IS the window's bottom edge (no margin; adding one lands
    // the box in the dark below where there's no magenta). Else fall back to the
    // lowest near-full-width magenta border row (rejects the partial-coverage
    // tunnel + the narrower name-card pill).
    let bottom = -1;
    if (nameCard) {
      const lx = nameCard.left;
      const rx = Math.min(top.right, nameCard.left + 340);
      bottom = nameCard.d.y + nameCard.d.h;
      for (let y = nameCard.d.y; y < Math.min(f.height, nameCard.d.y + 50); y++) {
        if (rowMagenta(f, y, lx, rx) > 0.25) bottom = y;
      }
    } else {
      const x0 = top.left + 4;
      const x1 = top.right - 4;
      for (let y = y0 + 100; y < Math.min(f.height - 1, y0 + (top.right - top.left) * 1.8); y++) {
        if (rowMagenta(f, y, x0, x1) > 0.82) bottom = y;
      }
    }
    const windowBox: Box | undefined = bottom > y0 ? { x: top.left, y: y0, w: top.right - top.left, h: bottom - y0 } : undefined;
    traces.push({ dots: top.d, isWindow: true, menuBar, windowBox });
  }
  // Clusters consumed as name cards: report them as non-windows (orange).
  for (const nc of used) traces.push({ dots: nc.d, isWindow: false });
  // Clusters with no bar at all (rare) — also non-windows.
  for (const d of clusters) if (!bars.some(b => b.d === d)) traces.push({ dots: d, isWindow: false });
  return traces;
}

/** A window's pixel-exact geometry: the dots cluster, the title-bar left/right
 *  (= window left/right edges), the top (just above the bar) and the resolved
 *  bottom (-1 if it couldn't be found). All in FRAME PIXELS. */
export type PixelWindow = { dots: Box; left: number; right: number; top: number; bottom: number; bottomScore: number };

/**
 * Deterministic window geometry from a decoded frame — the validated pipeline:
 * find every red/yellow/green cluster, keep the ones with a title bar (a real
 * window, not a name-card icon), and resolve each box (left/right from the bar,
 * bottom from findWindowBottom). This is the SAME path the dots-mode debugger
 * draws, so what you verify on debug.html is exactly what production crops to.
 * Knows nothing about kind/label (that's title-bar TEXT — read by vision and
 * reconciled in vertical.ts).
 */
export function detectWindowsPixels(f: RgbFrame): PixelWindow[] {
  const out: PixelWindow[] = [];
  for (const d of findDotClusters(f)) {
    const bar = traceBar(f, d);
    if (!bar.hasBar) continue;
    const menuBar: Box = { x: bar.left, y: d.y - 2, w: bar.right - bar.left, h: d.h + 4 };
    const b = findWindowBottom(f, menuBar);
    out.push({ dots: d, left: bar.left, right: bar.right, top: d.y - 2, bottom: b.y, bottomScore: b.score });
  }
  // OCCLUSION CLAMP. A visible title bar is ground truth that ITS window owns
  // the pixels there — so window A's visible region can never extend past
  // window B's top when B's bar sits below A's top inside A's span. Without
  // this, A's side traces run straight through a window stacked below (the two
  // windows' side frames line up, and the tracer bridges the seam), the crop
  // swallows BOTH windows, and a "solo" tile renders as an accidental split
  // screen with the low solo captions over the bottom window's face (the
  // shafu0x bug). Clamping also RESCUES windows whose own bottom wasn't found
  // (bottom -1): the occluder's top is a hard upper bound.
  for (const a of out) {
    for (const b of out) {
      if (b === a) continue;
      const ovl = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (ovl < (a.right - a.left) * 0.4) continue; // barely overlapping columns — a side-by-side neighbour, not a stack
      if (b.top < a.top + 60) continue; // same row of windows, not below
      if (a.bottom > 0 && b.top >= a.bottom) continue; // B starts past A's (known) bottom
      a.bottom = b.top - 2;
      a.bottomScore = Math.max(a.bottomScore, 0.9); // structural evidence beats a faint border guess
    }
  }
  return out;
}
