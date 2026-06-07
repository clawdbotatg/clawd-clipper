import { config } from "./config.js";
import type { CaptionToken } from "./refine.js";

// Build an ASS subtitle file for one clip's karaoke captions, in the
// slop.computer look: purple/pink words on a dark video, the word currently
// being spoken popping white (with a pink outline halo). ffmpeg's `ass` filter
// (libass) burns it in.
//
// Technique for "only the live word is white": for each on-screen line we emit
// one Dialogue event per word, each spanning that word's time, where only that
// word carries the white+pink override and the rest stay purple. The events
// tile the line's lifetime so exactly one word is ever lit.

const MAX_TOKENS_PER_LINE = 5; // keep lines short + readable for a cold scroll
const MAX_CHARS_PER_LINE = 26; // narrow enough that big text stays inside the frame
const GAP_SPLIT = 0.7; // a silence longer than this starts a new line

/** ASS timestamp: H:MM:SS.cc (centiseconds). */
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const p = (n: number) => n.toString().padStart(2, "0");
  // cs can round to 100; carry it.
  const csFixed = cs === 100 ? 0 : cs;
  const ssFixed = cs === 100 ? ss + 1 : ss;
  return `${h}:${p(m)}:${p(ssFixed)}.${p(csFixed)}`;
}

/** Escape text for an ASS Dialogue field (braces start override blocks; \n is special). */
function esc(text: string): string {
  return text
    .replace(/\\/g, "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Group tokens into on-screen lines: bounded by word count, char count, or a speech gap. */
function groupLines(tokens: CaptionToken[], maxChars: number): CaptionToken[][] {
  const lines: CaptionToken[][] = [];
  let cur: CaptionToken[] = [];
  let chars = 0;
  for (const tk of tokens) {
    const prev = cur[cur.length - 1];
    const gap = prev ? tk.start - prev.end : 0;
    const tooMany = cur.length >= MAX_TOKENS_PER_LINE;
    const tooWide = chars + tk.text.length + 1 > maxChars && cur.length > 0;
    if (cur.length && (gap > GAP_SPLIT || tooMany || tooWide)) {
      lines.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(tk);
    chars += tk.text.length + 1;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * Build the full .ass for a clip. `tokens` carry absolute (episode) times;
 * `clipStart` shifts them to the clip-relative timeline the burned video uses.
 *
 * `opts.vertical` switches to the 9:16 mobile layout: a tall, narrow (1080-wide)
 * frame where the captions sit over the SEAM between stacked tiles, rather than
 * along the bottom. `opts.seamFrac` (0..1 of height) is where that seam is — it
 * moves with the layout (0.5 for an even two-up stack, ~0.34 for a speaker-over-
 * screen interview, ~0.85 for a single full tile so the caption stays low). Text
 * is sized off the (smaller) width and lines wrap shorter to fit the frame.
 */
export function buildAss(
  tokens: CaptionToken[],
  clipStart: number,
  width: number,
  height: number,
  opts: { vertical?: boolean; seamFrac?: number; speakerSpans?: { speaker: string; start: number; end: number }[] } = {},
): string {
  const { font, scale, marginV: marginVFrac, box, boxColor, boxAlpha, base, active, outline, glow } = config.caption;
  const vertical = opts.vertical ?? false;
  // Landscape sizes off height; vertical sizes off the (limiting) width so big
  // text still fits the 1080-wide frame.
  const fontSize = vertical ? Math.round(width * 0.06) : Math.round(height * scale);
  // Bottom-centre (2) for landscape; middle-centre (5) parks vertical captions
  // on the seam between the two stacked tiles.
  const align = vertical ? 5 : 2;
  const outlineW = Math.max(2, Math.round(fontSize * 0.12));
  const shadow = Math.max(1, Math.round(fontSize * 0.05));
  const marginV = Math.round(height * marginVFrac);
  const marginH = Math.round(width * 0.06);
  // Menlo is monospace: every glyph advances the same width (~0.6em), so a
  // line's pixel width — and thus the background band — is computable exactly.
  const charW = fontSize * 0.6;
  // Captions don't auto-wrap (WrapStyle 2), so cap chars-per-line at whatever
  // actually fits the usable width at this font size — that way bumping the
  // font (CLIPPER_CAPTION_SCALE) can never push a line off the sides; it just
  // breaks into more lines. The constant is only an upper bound for readability.
  const fitChars = Math.floor((width - 2 * marginH) / charW);
  const maxChars = Math.min(vertical ? 22 : MAX_CHARS_PER_LINE, fitChars);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment: 2 = bottom-centre (landscape), 5 = middle-centre (vertical).
    // Bold on. BorderStyle 1 = outline+drop shadow.
    `Style: Slop,${font},${fontSize},${base},${active},${outline},&H64000000,-1,0,0,0,100,100,0,0,1,${outlineW},${shadow},${align},${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  // Per-word override tags. The live word goes white with a pink outline halo;
  // the rest sit in the resting purple with the dark legibility outline.
  const liveTag = `{\\c${active}\\3c${glow}}`;
  const restTag = `{\\c${base}\\3c${outline}}`;

  // A translucent band behind each line, sized to the line, so the captions sit
  // on their own surface instead of fighting the busy video underneath (which
  // can make a bright highlighted word look like it's floating above the rest).
  const cx = Math.round(width / 2);
  const bandH = Math.round(fontSize * 1.5);
  const padX = Math.round(fontSize * 0.45);
  // Vertical: captions sit on the layout's seam (seamFrac of height), so they
  // land between tiles instead of over a face. Landscape: the band's bottom edge
  // sits at the text baseline (style MarginV), nudged down for descenders.
  const seamY = Math.round(height * (opts.seamFrac ?? 0.5));
  const bandTopY = vertical
    ? seamY - Math.round(bandH / 2)
    : height - marginV + Math.round(fontSize * 0.28) - bandH;
  // Vertical text is anchored explicitly to the seam (middle-centre via \\pos),
  // overriding the style's centred placement so it tracks seamY exactly.
  const posPrefix = vertical ? `{\\an5\\pos(${cx},${seamY})}` : "";

  function bandEvent(line: CaptionToken[], from: number, to: number): string {
    const chars = line.reduce((n, tk) => n + tk.text.length, 0) + (line.length - 1); // glyphs + inter-word spaces
    const w = Math.round(chars * charW) + padX * 2;
    // \an7 (top-left) + \pos + an origin-based rect is the deterministic way to
    // place an ASS drawing — libass's bbox anchoring on drawings is unreliable.
    const tags = `\\an7\\pos(${cx - Math.round(w / 2)},${bandTopY})\\bord0\\shad0\\1c${boxColor}\\1a${boxAlpha}\\p1`;
    const draw = `m 0 0 l ${w} 0 l ${w} ${bandH} l 0 ${bandH}`;
    return `Dialogue: 0,${assTime(from)},${assTime(to)},Slop,,0,0,0,,{${tags}}${draw}{\\p0}`;
  }

  const events: string[] = [];
  for (const line of groupLines(tokens, maxChars)) {
    const lineStart = line[0]!.start - clipStart;
    const lineEnd = line[line.length - 1]!.end - clipStart;
    // Background band first (Layer 0), so the text (Layer 1) sits on top of it.
    if (box) events.push(bandEvent(line, lineStart, lineEnd));

    // Highlight slots that tile [lineStart, lineEnd] with NO overlap and NO
    // skips. A word lights when it starts and holds until the NEXT word begins
    // (the accurate advance point). The catch: whisper sometimes stamps an
    // emphasised word's start almost on top of the next word's, which used to
    // collapse its slot so we dropped it — skipping a real, often important,
    // word. So we give every word a minimum hold and push later starts forward
    // to make room. To guarantee that borrowing never spills past the line (and
    // collides with the next one), the per-word minimum SHRINKS when a line is
    // too short for all its words — so n words always fit exactly in the line.
    // (whisper's word END is deliberately ignored: it frequently overshoots and
    // would swallow later words.)
    const n = line.length;
    const dur = lineEnd - lineStart;
    const minHold = Math.min(0.14, dur / n); // floor per word, shrunk to fit the line
    const starts = new Array<number>(n);
    starts[0] = lineStart;
    for (let i = 1; i < n; i++) {
      const natural = line[i]!.start - clipStart;
      // at least minHold after the previous start, but never so far that the
      // remaining (n-i) words can't each still get minHold before lineEnd.
      starts[i] = Math.min(Math.max(natural, starts[i - 1]! + minHold), lineEnd - minHold * (n - i));
    }
    for (let i = 0; i < n; i++) {
      const segStart = starts[i]!;
      const segEnd = i + 1 < n ? starts[i + 1]! : lineEnd;
      const text = line.map((tk, j) => `${j === i ? liveTag : restTag}${esc(tk.text)}`).join(" ");
      events.push(`Dialogue: 1,${assTime(segStart)},${assTime(segEnd)},Slop,,0,0,0,,${posPrefix}${text}`);
    }
  }

  // Speaker nameplate: a small label pinned near the top that tracks WHO is
  // talking, switching as the dominant speaker changes (clip-relative spans from
  // speakers.ts). Layer 2 so it always sits above the captions, and parked high
  // so it never collides with the bottom (landscape) or seam (vertical) text.
  const spans = opts.speakerSpans ?? [];
  if (spans.length) {
    const nameSize = Math.max(18, Math.round(fontSize * 0.6));
    const nameY = Math.round(height * (vertical ? 0.05 : 0.07));
    const nbord = Math.max(2, Math.round(nameSize * 0.14));
    for (const sp of spans) {
      // White + bold on a dark outline so the handle reads over a busy frame.
      const tags = `\\an8\\pos(${cx},${nameY})\\fs${nameSize}\\b1\\c${active}\\3c${outline}\\bord${nbord}\\shad${shadow}`;
      events.push(`Dialogue: 2,${assTime(sp.start)},${assTime(sp.end)},Slop,,0,0,0,,{${tags}}${esc(sp.speaker)}`);
    }
  }

  return `${header}\n${events.join("\n")}\n`;
}
