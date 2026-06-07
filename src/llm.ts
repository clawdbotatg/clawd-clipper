import { readFile } from "node:fs/promises";
import { config } from "./config.js";

// Clip-selection model access. Prefer direct Anthropic (its key is the common
// local setup); fall back to Bankr's OpenClaw gateway (OpenAI-compatible,
// X-API-Key) — the same two-provider arrangement slop's meta-ai.ts uses.

async function callAnthropic(prompt: string, model: string): Promise<string | null> {
  if (!config.anthropicApiKey) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    // No `temperature`: newer Anthropic models reject it as deprecated
    // (slop's own meta-ai.ts likewise omits it on the direct path).
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.error("[llm] anthropic", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return null;
  }
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (json.content ?? [])
    .filter(c => c.type === "text")
    .map(c => c.text ?? "")
    .join("")
    .trim();
  return text || null;
}

async function callBankr(prompt: string): Promise<string | null> {
  if (!config.bankrApiKey) return null;
  const res = await fetch("https://llm.bankr.bot/v1/chat/completions", {
    method: "POST",
    headers: { "x-api-key": config.bankrApiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.bankrModel,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.error("[llm] bankr", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

export async function complete(prompt: string, model: string = config.anthropicModel): Promise<string> {
  const out = (await callAnthropic(prompt, model)) ?? (await callBankr(prompt));
  if (!out) throw new Error("no model available (set ANTHROPIC_API_KEY or BANKR_API_KEY)");
  return out;
}

/**
 * Vision completion: send a single image plus a text prompt and return the
 * model's text reply. Direct-Anthropic only — the only configured vision-capable
 * path (the Bankr text fallback isn't wired for images here), so this throws if
 * ANTHROPIC_API_KEY is unset. Used to detect participant-tile geometry from a
 * sampled video frame (see vertical.ts).
 */
export async function completeVision(
  prompt: string,
  imagePath: string,
  model: string = config.anthropicModel,
  mediaType: "image/png" | "image/jpeg" = "image/png",
): Promise<string> {
  if (!config.anthropicApiKey) throw new Error("vision needs ANTHROPIC_API_KEY (no vision fallback configured)");
  const data = (await readFile(imagePath)).toString("base64");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic vision ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (json.content ?? [])
    .filter(c => c.type === "text")
    .map(c => c.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("anthropic vision returned no text");
  return text;
}

/** Pull a JSON value out of the model's reply, tolerating ```fences``` and prose. */
export function extractJson<T>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();
  // Otherwise grab the outermost array/object.
  if (!s.startsWith("{") && !s.startsWith("[")) {
    const i = s.search(/[[{]/);
    if (i >= 0) s = s.slice(i);
  }
  return JSON.parse(s) as T;
}
