import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clip } from "./clips.js";

// Emit index.json (machine-readable, ranked) and index.html (a zero-dependency
// gallery that plays each clip inline, highest-scored first).

export type EpisodeIndex = {
  slug: string;
  name: string;
  manifestCid: string;
  generatedAt: string;
  clipCount: number;
  vertical?: boolean; // clips are 9:16 mobile (affects the gallery's card shape)
  clips: Clip[];
};

const mmss = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function writeGallery(opts: {
  outDir: string;
  slug: string;
  name: string;
  manifestCid: string;
  generatedAt: string;
  vertical?: boolean;
  clips: Clip[];
}): Promise<void> {
  const index: EpisodeIndex = {
    slug: opts.slug,
    name: opts.name,
    manifestCid: opts.manifestCid,
    generatedAt: opts.generatedAt,
    clipCount: opts.clips.length,
    vertical: opts.vertical,
    clips: opts.clips,
  };
  await writeFile(join(opts.outDir, "index.json"), JSON.stringify(index, null, 2));

  // Cache-buster: clips are overwritten in place each run, and browsers happily
  // serve a stale cached mp4 for the same path (even over file://). A per-run
  // query string forces a fresh load so re-renders are actually visible.
  const v = encodeURIComponent(opts.generatedAt);

  // Which 9:16 framings exist across the set → which switcher buttons to show.
  const hasV = opts.clips.some(c => c.mobileFile);
  const hasGeom = opts.clips.some(c => c.geomMobileFile);
  const hasAlt = opts.clips.some(c => c.altMobileFile);
  const toggle =
    opts.vertical && (hasV || hasGeom || hasAlt)
      ? `<div class="toggle">
        <button type="button" data-mode="h" class="active">🖥 16:9</button>
        ${hasV ? `<button type="button" data-mode="v">📱 9:16 · CV</button>` : ""}
        ${hasGeom ? `<button type="button" data-mode="geom">📱 9:16 · geometry</button>` : ""}
        ${hasAlt ? `<button type="button" data-mode="alt">📱 9:16 · alt</button>` : ""}
      </div>`
      : "";

  const cards = opts.clips
    .map(c => {
      // Carry every available framing as data-* on the player + download link so
      // the header switcher can flip all clips at once: 16:9 landscape (data-h),
      // 9:16 CV (data-v), 9:16 geometry (data-geom), 9:16 alt-composition (data-alt).
      const hUrl = `clips/${esc(c.file)}?v=${v}`;
      const variants: [string, string][] = [["h", hUrl]];
      if (c.mobileFile) variants.push(["v", `clips/${esc(c.mobileFile)}?v=${v}`]);
      if (c.geomMobileFile) variants.push(["geom", `clips/${esc(c.geomMobileFile)}?v=${v}`]);
      if (c.altMobileFile) variants.push(["alt", `clips/${esc(c.altMobileFile)}?v=${v}`]);
      const dataAttrs = variants.map(([k, u]) => ` data-${k}="${u}"`).join("");
      return `
    <article class="clip">
      <div class="vid"><video controls preload="none" src="${hUrl}"${dataAttrs}></video></div>
      <div class="meta">
        <div class="row">
          <span class="score${c.verdict === "cut" ? " cut" : ""}">${c.finalScore ?? c.score}</span>
          <h2>${esc(c.title)}</h2>
        </div>
        ${
          c.speaker
            ? `<p class="speaker">🎤 ${esc(c.speaker)}${c.speakers && c.speakers.length > 1 ? ` <span class="shares">(${c.speakers.map(s => `${esc(s.speaker)} ${s.pct}%`).join(" · ")})</span>` : ""}</p>`
            : ""
        }
        ${
          c.judgeScore != null
            ? `<p class="scores">pick ${c.score} · judge ${c.judgeScore}${c.verdict === "cut" ? ` · <span class="verdict">judge would cut</span>` : ""}</p>`
            : ""
        }
        <p class="reason">${esc(c.reason)}</p>
        ${c.critique ? `<p class="critique">⚖︎ ${esc(c.critique)}</p>` : ""}
        ${
          c.tweetShort || c.tweetMedium || c.tweetLong
            ? `<div class="tweets">${
                c.tweetShort
                  ? `<div class="tw"><div class="tw-h"><span>short</span><button class="copy" data-copy="${esc(c.tweetShort)}">copy</button></div><p class="tw-t">${esc(c.tweetShort)}</p></div>`
                  : ""
              }${
                c.tweetMedium
                  ? `<div class="tw"><div class="tw-h"><span>medium</span><button class="copy" data-copy="${esc(c.tweetMedium)}">copy</button></div><p class="tw-t">${esc(c.tweetMedium)}</p></div>`
                  : ""
              }${
                c.tweetLong
                  ? `<div class="tw"><div class="tw-h"><span>long</span><button class="copy" data-copy="${esc(c.tweetLong)}">copy</button></div><p class="tw-t">${esc(c.tweetLong)}</p></div>`
                  : ""
              }</div>`
            : ""
        }
        <p class="tags">${c.kind ? `<b>${esc(c.kind)}</b> · ` : ""}${c.tags.map(esc).join(" · ")}</p>
        <p class="time">${mmss(c.start)}–${mmss(c.end)} · ${c.duration}s · <a href="${hUrl}"${dataAttrs} download>download</a> · <a href="clips/${esc(c.srt)}?v=${v}">srt</a></p>
        ${
          c.captionText
            ? `<details><summary>captions (burned, corrected)</summary><p class="text caps">${esc(c.captionText)}</p></details>`
            : ""
        }
        <details><summary>raw transcript</summary><p class="text">${esc(c.text)}</p></details>
      </div>
    </article>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>clips · ${esc(opts.name || opts.slug)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0e10; color: #e8e8ea; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 24px; border-bottom: 1px solid #26262b; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .sub { color: #8a8a93; font-size: 12px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; padding: 24px; }
  .clip { background: #161619; border: 1px solid #26262b; border-radius: 10px; overflow: hidden; }
  .vid { background: #000; aspect-ratio: 16 / 9; }
  body.mobile .vid { aspect-ratio: 9 / 16; }
  .vid video { width: 100%; height: 100%; display: block; object-fit: contain; }
  .toggle { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  .toggle button { font: inherit; cursor: pointer; background: #1b1b20; color: #e8e8ea; border: 1px solid #3a3a42; border-radius: 6px; padding: 4px 11px; }
  .toggle button:hover { border-color: #7dd3fc; }
  .toggle button.active { border-color: #7dd3fc; background: #143; color: #d6ffe8; }
  .meta { padding: 12px 14px 14px; }
  .row { display: flex; align-items: baseline; gap: 10px; }
  .row h2 { margin: 0; font-size: 14px; line-height: 1.3; }
  .score { flex: none; font-weight: 700; color: #0e0e10; background: #7dd3fc; border-radius: 6px; padding: 1px 8px; font-size: 13px; }
  .score.cut { background: #f0a0a0; }
  .scores { color: #6f6f78; font-size: 11px; margin: 6px 0 0; }
  .speaker { color: #7dd3fc; font-size: 12px; margin: 6px 0 0; }
  .speaker .shares { color: #6f6f78; }
  .verdict { color: #f0a0a0; }
  .reason { color: #c4c4cc; margin: 8px 0 6px; }
  .critique { color: #d8b48a; font-size: 12px; margin: 4px 0; }
  .tags { color: #8a8a93; font-size: 12px; margin: 4px 0; }
  .tags b { color: #7dd3fc; }
  .time { color: #6f6f78; font-size: 12px; margin: 6px 0 0; }
  .time a { color: #9aa6ff; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #8a8a93; font-size: 12px; }
  .text { color: #b0b0b8; font-size: 12px; white-space: pre-wrap; }
  .text.caps { color: #e0a8ec; }
  .tweets { margin: 8px 0 2px; display: grid; gap: 6px; }
  .tw { background: #1d1320; border: 1px solid #3a2740; border-radius: 8px; padding: 7px 9px; }
  .tw-h { display: flex; justify-content: space-between; align-items: center; color: #c98fe0; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
  .tw-t { margin: 0; color: #ecddf2; font-size: 12.5px; line-height: 1.45; }
  .copy { cursor: pointer; background: #3a2740; color: #f0d8fa; border: 0; border-radius: 5px; padding: 2px 9px; font: inherit; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .copy:hover { background: #4d3357; }
</style>
</head>
<body>
<header>
  <h1>${esc(opts.name || opts.slug)} — ${opts.clips.length} clips</h1>
  <div class="sub">slop.computer/${esc(opts.slug)} · sorted by predicted shareability · generated ${esc(opts.generatedAt)}</div>
  ${toggle}
</header>
<main>
${cards}
</main>
${
  opts.vertical
    ? `<script>
(function () {
  var buttons = document.querySelectorAll(".toggle button[data-mode]");
  if (!buttons.length) return;
  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var mode = btn.getAttribute("data-mode");
      document.body.classList.toggle("mobile", mode !== "h");
      buttons.forEach(function (b) { b.classList.toggle("active", b === btn); });
      // Each clip carries only the framings it has; fall back to landscape (h).
      document.querySelectorAll("[data-h]").forEach(function (el) {
        var url = el.getAttribute("data-" + mode) || el.getAttribute("data-h");
        if (el.tagName === "VIDEO") { el.pause(); el.src = url; el.load(); }
        else { el.setAttribute("href", url); }
      });
    });
  });
})();
</script>`
    : ""
}
<script>
(function () {
  document.querySelectorAll(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(text).then(function () {
        var prev = b.textContent;
        b.textContent = "copied!";
        setTimeout(function () { b.textContent = prev; }, 1200);
      });
    });
  });
})();
</script>
</body>
</html>`;
  await writeFile(join(opts.outDir, "index.html"), html);
}
