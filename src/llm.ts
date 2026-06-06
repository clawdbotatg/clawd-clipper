import { config } from "./config.js";

// Clip-selection model access. Prefer direct Anthropic (its key is the common
// local setup); fall back to Bankr's OpenClaw gateway (OpenAI-compatible,
// X-API-Key) — the same two-provider arrangement slop's meta-ai.ts uses.

async function callAnthropic(prompt: string): Promise<string | null> {
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
      model: config.anthropicModel,
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
      temperature: 0.3,
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

export async function complete(prompt: string): Promise<string> {
  const out = (await callAnthropic(prompt)) ?? (await callBankr(prompt));
  if (!out) throw new Error("no clip-selection model available (set ANTHROPIC_API_KEY or BANKR_API_KEY)");
  return out;
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
