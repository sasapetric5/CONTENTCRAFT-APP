/**
 * ContentCraft server-side AI gateway prototype for Cloudflare Pages.
 *
 * Required server-side Pages secrets/vars:
 *   GEMINI_API_KEY (secret) — optional Gemini provider credential
 *   SAFE_AUTOMATON_AI_ENABLED="true" — explicit owner opt-in
 *
 * Optional binding:
 *   AI — Cloudflare Workers AI binding
 *
 * No key is accepted from the browser. No paid-provider fallback is implemented.
 */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
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
  const host = new URL(request.url).origin;
  if (origin && origin !== host) {
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

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, code: "REQUEST_TOO_LARGE" }, 413);
  }

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

  // Only allow a small safe subset of generation options from the browser.
  const config = {};
  if (Number.isFinite(input?.config?.temperature)) {
    config.temperature = Math.min(1, Math.max(0, input.config.temperature));
  }
  if (typeof input?.config?.systemInstruction === "string") {
    config.systemInstruction = input.config.systemInstruction.slice(0, 8000);
  }
  config.maxOutputTokens = MAX_OUTPUT_TOKENS;

  const attempts = [];
  // First use a configured Gemini credential, only with the explicitly approved model.
  // If quota is exhausted or the provider fails, do not switch to a paid model.
  if (typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 0) {
    const result = await tryGemini(env.GEMINI_API_KEY, contents, config);
    attempts.push({ provider: "gemini", code: result.code });
    if (result.ok) {
      return json({ ok: true, provider: "gemini", model: result.model, text: result.text });
    }
    if (result.status === 429 || result.status === 402) {
      return json({ ok: false, code: "FREE_QUOTA_UNAVAILABLE", attempts }, 429);
    }
  }

  // Workers AI is an optional binding; never enabled implicitly by this endpoint.
  if (env.AI && typeof env.AI.run === "function") {
    const prompt = toPrompt(contents);
    try {
      const output = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          ...(config.systemInstruction ? [{ role: "system", content: config.systemInstruction }] : []),
          { role: "user", content: prompt },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: config.temperature ?? 0.7,
      });
      const text = output?.response ?? output?.result?.response;
      if (typeof text === "string" && text.trim()) {
        return json({ ok: true, provider: "cloudflare-workers-ai", model: "@cf/meta/llama-3.1-8b-instruct", text });
      }
      attempts.push({ provider: "cloudflare-workers-ai", code: "EMPTY_OUTPUT" });
    } catch (error) {
      // Return only a safe diagnostic; never echo credentials or raw provider responses.
      attempts.push({ provider: "cloudflare-workers-ai", code: classifyError(error) });
    }
  }

  if (!attempts.length) {
    return json({ ok: false, code: "NO_APPROVED_FREE_PROVIDER", attempts: [] }, 503);
  }
  return json({ ok: false, code: "ALL_APPROVED_PROVIDERS_UNAVAILABLE", attempts }, 503);
}

async function tryGemini(apiKey, contents, config) {
  const model = "gemini-3.8-flash";
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: normalizeGeminiContents(contents),
          generationConfig: {
            temperature: config.temperature ?? 0.7,
            maxOutputTokens: config.maxOutputTokens,
          },
          ...(config.systemInstruction ? { systemInstruction: { parts: [{ text: config.systemInstruction }] } } : {}),
        }),
      }
    );
    if (!response.ok) {
      const status = response.status;
      return { ok: false, status, code: status === 429 ? "QUOTA_LIMIT" : status === 401 || status === 403 ? "AUTH_OR_MODEL_ACCESS" : `HTTP_${status}` };
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim();
    if (!text) return { ok: false, status: 502, code: "EMPTY_OUTPUT" };
    return { ok: true, model, text };
  } catch {
    return { ok: false, status: 502, code: "NETWORK_ERROR" };
  }
}

function normalizeGeminiContents(contents) {
  if (typeof contents === "string") return [{ role: "user", parts: [{ text: contents }] }];
  return contents.map(item => {
    if (typeof item === "string") return { role: "user", parts: [{ text: item }] };
    const role = item?.role === "model" ? "model" : "user";
    const parts = Array.isArray(item?.parts)
      ? item.parts.filter(p => typeof p?.text === "string").map(p => ({ text: p.text.slice(0, 50000) }))
      : typeof item?.text === "string" ? [{ text: item.text.slice(0, 50000) }] : [];
    return { role, parts };
  }).filter(item => item.parts.length);
}

function toPrompt(contents) {
  if (typeof contents === "string") return contents.slice(0, 100000);
  return contents.map(item => {
    if (typeof item === "string") return item;
    const parts = Array.isArray(item?.parts) ? item.parts.map(p => p?.text || "").join("\n") : item?.text || "";
    return `${item?.role || "user"}: ${parts}`;
  }).join("\n").slice(0, 100000);
}

function classifyError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("quota") || message.includes("limit")) return "QUOTA_LIMIT";
  if (message.includes("auth") || message.includes("permission")) return "AUTH_OR_BINDING";
  return "PROVIDER_ERROR";
}
