import { createHash } from "node:crypto";
import { config } from "./config.js";
import type { ResolvedClip } from "./clips.js";
import { complete, extractJson } from "./llm.js";

// Adversarial judge re-rank. A second, independent opinion on the clip set —
// the antidote to the selection model marking its own homework.
//
// One batched call (cheap: ~1 extra model call per episode, not per clip). The
// judge is shown ONLY each clip's actual transcript words — NOT the selection
// model's title, reason, or score — so it can't be anchored by the pitch. It's
// told to assume the clip is watched COLD by someone scrolling, to find the
// single biggest reason it would flop, and to be stingy. The final rank blends
// the two scores so a clip both models like floats up and a clip the judge
// guts sinks.

// finalScore = SELECTION_WEIGHT*score + (1-SELECTION_WEIGHT)*judgeScore.
// Judge-weighted, but the original signal still counts.
const SELECTION_WEIGHT = 0.35;

type RawVerdict = { index: number; judgeScore: number; critique: string; verdict: "keep" | "cut" };

/** A judge verdict, stripped of positional index — what we cache + apply. */
export type JudgeVerdict = { judgeScore: number; critique?: string; verdict: "keep" | "cut" };

/** Content key for a clip: a hash of its words, so cached verdicts survive
 *  reordering and only miss when the clip's actual content changes. */
export function clipKey(c: ResolvedClip): string {
  const norm = c.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

function buildPrompt(clips: ResolvedClip[]): string {
  const blocks = clips
    .map(
      (c, i) =>
        `--- CLIP ${i} (${Math.round(c.duration)}s${c.kind ? `, tagged "${c.kind}"` : ""}) ---\n${c.text}`,
    )
    .join("\n\n");

  return `You are a brutally honest social-media editor. Someone wants to post these short clips, cut from a live podcast for technical builders (AI agents, LLM tooling, dev tools, crypto). Your job is to judge how each would ACTUALLY perform if a stranger saw it cold while scrolling — no episode context, no setup, sound maybe off for the first second.

Be stingy. Most clips are mediocre out of context. For EACH clip:
- Find the single biggest reason it would FLOP as a standalone share: needs missing context, no hook in the first seconds, rambling with no payoff, ends mid-thought, inside-baseball jargon, or just not interesting.
- Then give an honest standalone shareability score 0-100. Reserve 80+ for clips that genuinely stop a scroll and make you want the full episode. Most should land 30-65.
- verdict "keep" if you'd actually post it, "cut" if not.

Judge ONLY the words below — there is deliberately no title or pitch to sway you. The text is auto speech-to-text, so read charitably through minor errors.

${blocks}

Return ONLY a JSON object: { "verdicts": [ { "index": <clip number>, "judgeScore": <0-100 int>, "critique": "<one sentence: the biggest knock>", "verdict": "keep"|"cut" } ] } with one entry per clip. Start with { and end with }.`;
}

/** Make the (batched) judge call and return verdicts keyed by clip content. */
export async function getVerdicts(clips: ResolvedClip[]): Promise<Record<string, JudgeVerdict>> {
  const out: Record<string, JudgeVerdict> = {};
  if (clips.length === 0) return out;
  const raw = await complete(buildPrompt(clips), config.judgeModel);
  const parsed = extractJson<{ verdicts?: RawVerdict[] }>(raw);
  const byIndex = new Map<number, RawVerdict>();
  for (const v of parsed.verdicts ?? []) {
    if (typeof v?.index === "number" && typeof v.judgeScore === "number") byIndex.set(v.index, v);
  }
  clips.forEach((c, i) => {
    const v = byIndex.get(i);
    if (!v) return;
    out[clipKey(c)] = {
      judgeScore: Math.max(0, Math.min(100, Math.round(v.judgeScore))),
      critique: typeof v.critique === "string" ? v.critique : undefined,
      verdict: v.verdict === "cut" ? "cut" : "keep",
    };
  });
  return out;
}

/** Fold cached/fresh verdicts into the clips, computing the blended finalScore. */
export function applyVerdicts(clips: ResolvedClip[], verdicts: Record<string, JudgeVerdict>): ResolvedClip[] {
  return clips.map(c => {
    const v = verdicts[clipKey(c)];
    if (!v) return { ...c, finalScore: c.score }; // unjudged: fall back to selection score
    return {
      ...c,
      judgeScore: v.judgeScore,
      critique: v.critique,
      verdict: v.verdict,
      finalScore: Math.round(SELECTION_WEIGHT * c.score + (1 - SELECTION_WEIGHT) * v.judgeScore),
    };
  });
}
