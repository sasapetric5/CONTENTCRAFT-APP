/**
 * ContentCraft Pages AI gateway.
 * Uses only an explicitly enabled Cloudflare Workers AI binding.
 * Uses a model available on Workers Free; requests fail closed at free quota limits.
 * No Gemini or paid-provider fallback is used.
 */
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "vary": "Origin",
  },
});
const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 2048;

export async function onRequestOptions({ request }) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "allow": "POST, OPTIONS",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      "vary": "Origin",
    },
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
  }
  if (env.SAFE_AUTOMATON_AI_ENABLED !== "true") {
    return json({ ok: false, code: "AI_DISABLED_BY_OWNER" }, 503);
  }
  if (!env.AI || typeof env.AI.run !== "function") {
    return json({ ok: false, code: "CLOUDFLARE_AI_BINDING_MISSING" }, 503);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ ok: false, code: "REQUEST_TOO_LARGE" }, 413);
  let input;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, code: "REQUEST_TOO_LARGE" }, 413);
    }
    input = JSON.parse(raw);
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400);
  }

  const contents = input?.contents;
  if (!(typeof contents === "string" && contents.trim()) &&
      !(Array.isArray(contents) && contents.length > 0)) {
    return json({ ok: false, code: "INVALID_CONTENTS" }, 400);
  }
  const systemInstruction = typeof input?.config?.systemInstruction === "string"
    ? input.config.systemInstruction.slice(0, 8000) : "";
  const temperature = Number.isFinite(input?.config?.temperature)
    ? Math.min(1, Math.max(0, input.config.temperature)) : 0.7;
  const prompt = toPrompt(contents);
  try {
    const output = await env.AI.run("@cf/zai-org/glm-4.7-flash", {
      messages: [
        ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
        { role: "user", content: prompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature,
    });
    const text = output?.response ?? output?.result?.response;
    if (typeof text === "string" && text.trim()) {
      return json({ ok: true, provider: "cloudflare-workers-ai", model: "@cf/zai-org/glm-4.7-flash", text });
    }
    return json({ ok: false, code: "AI_EMPTY_OUTPUT" }, 502);
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const code = message.includes("quota") || message.includes("limit")
      ? "AI_QUOTA_UNAVAILABLE"
      : message.includes("auth") || message.includes("permission")
        ? "AI_BINDING_PERMISSION_ERROR" : "AI_PROVIDER_ERROR";
    return json({ ok: false, code }, 502);
  }
}

function toPrompt(contents) {
  if (typeof contents === "string") return contents.slice(0, 100000);
  return contents.map(item => {
    if (typeof item === "string") return item;
    const parts = Array.isArray(item?.parts)
      ? item.parts.filter(p => typeof p?.text === "string").map(p => p.text).join("\n")
      : typeof item?.text === "string" ? item.text : "";
    return `${item?.role === "model" ? "assistant" : "user"}: ${parts}`;
  }).join("\n").slice(0, 100000);
}
