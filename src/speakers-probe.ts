import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveBySlug } from "./resolve.js";
import type { Transcript } from "./transcribe.js";
import { alignToVideo, attributeWindow, fetchLiveTranscript, namesFromParticipants } from "./speakers.js";

// Standalone diagnostic — proves speaker attribution end-to-end against the
// cached artifacts of a prior run, WITHOUT touching the main pipeline. Run:
//   npx tsx src/speakers-probe.ts <slug>
// Requires out/<slug>/transcript.json and out/<slug>/index.json to exist.

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error("usage: npx tsx src/speakers-probe.ts <slug>");
  const outDir = resolve(process.cwd(), "out", slug);

  const whisper = JSON.parse(await readFile(join(outDir, "transcript.json"), "utf8")) as Transcript;
  const index = JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as {
    clips: { rank: number; title: string; start: number; end: number }[];
  };

  console.log(`\n▸ resolving ${slug} for live transcript CID…`);
  const ep = await resolveBySlug(slug);
  const tcid = ep.manifest.transcript?.cid;
  if (!tcid) throw new Error("manifest has no transcript.cid");
  console.log(`  transcript: ${tcid}`);

  const names = namesFromParticipants(ep.manifest.participants);
  const live = await fetchLiveTranscript(tcid, names);
  console.log(`  ${live.length} live spoken lines`);
  const speakers = [...new Set(live.map(l => l.speaker))];
  console.log(`  speakers seen: ${speakers.join(", ")}`);

  const align = alignToVideo(live, whisper);
  console.log(
    `\n▸ alignment: offset=${align.offsetMs == null ? "FAILED" : (align.offsetMs / 1000).toFixed(1) + "s"} ` +
      `· matches=${align.matches} · IQR spread=${(align.spreadMs / 1000).toFixed(2)}s (low = confident)`,
  );
  if (align.offsetMs == null) {
    console.log("  not enough matches to align — bailing");
    return;
  }

  console.log(`\n▸ dominant speaker per clip:`);
  for (const c of index.clips) {
    const info = attributeWindow(live, align.offsetMs, c.start, c.end);
    const shares = info.shares.map(s => `${s.speaker} ${s.pct}%`).join(", ");
    console.log(`  #${String(c.rank).padStart(2)} ${(info.primary ?? "—").padEnd(16)} ${c.title}`);
    if (info.shares.length > 1) console.log(`       (${shares})`);
  }
}

main().catch(err => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
