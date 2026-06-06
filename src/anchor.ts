import type { Transcript, Word } from "./transcribe.js";

// Turn a verbatim transcript quote into a real [start,end] time span — the
// same hallucination-proof trick meta-ai.ts uses for chapters, but at word
// granularity. The model never emits timestamps; it copies a snippet, and we
// locate that snippet in the word-timed transcript. A quote that can't be
// found is reported as null and the caller drops the clip rather than guessing.

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

type Tok = { n: string; start: number; end: number };

function tokens(words: Word[]): Tok[] {
  const out: Tok[] = [];
  for (const w of words) {
    const n = norm(w.word);
    if (n) out.push({ n, start: w.start, end: w.end });
  }
  return out;
}

/**
 * Find the time span of `quote` within the transcript.
 * `prefer` biases the search:
 *   - "first": earliest match (use for the start quote)
 *   - "last":  latest match  (use for the end quote)
 * Exact contiguous token match wins; otherwise a sliding fuzzy match that
 * tolerates STT drift (>=70% of the quote's tokens present, in order-ish).
 */
export function findSpan(
  transcript: Transcript,
  quote: string,
  prefer: "first" | "last" = "first",
): { start: number; end: number } | null {
  const toks = tokens(transcript.words);
  const q = norm(quote).split(" ").filter(Boolean);
  if (q.length === 0 || toks.length < q.length) return null;

  const exact: { start: number; end: number }[] = [];
  for (let i = 0; i + q.length <= toks.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) {
      if (toks[i + j]!.n !== q[j]) {
        ok = false;
        break;
      }
    }
    if (ok) exact.push({ start: toks[i]!.start, end: toks[i + q.length - 1]!.end });
  }
  if (exact.length) return prefer === "last" ? exact[exact.length - 1]! : exact[0]!;

  // Fuzzy fallback: slide a window the length of the quote, score by how many
  // quote tokens appear in the window. Requires a strong majority so we don't
  // anchor to an unrelated line sharing a couple common words.
  if (q.length < 3) return null;
  const qset = new Set(q);
  let best: { start: number; end: number; score: number } | null = null;
  for (let i = 0; i + q.length <= toks.length; i++) {
    let hit = 0;
    for (let j = 0; j < q.length; j++) if (qset.has(toks[i + j]!.n)) hit++;
    const score = hit / q.length;
    const better = !best || (prefer === "last" ? score >= best.score : score > best.score);
    if (better && score >= 0.7) best = { start: toks[i]!.start, end: toks[i + q.length - 1]!.end, score };
  }
  return best ? { start: best.start, end: best.end } : null;
}
