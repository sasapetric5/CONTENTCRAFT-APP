import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/ai.js";

function request(body, extra = {}) {
  return new Request("https://contentcraft.example/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("AI remains disabled unless the owner explicitly enables it", async () => {
  const response = await onRequestPost({
    request: request({ contents: "hello" }),
    env: {},
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_DISABLED_BY_OWNER");
});

test("rejects cross-origin requests before contacting providers", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not call"); };
  try {
    const response = await onRequestPost({
      request: request({ contents: "hello" }, { origin: "https://evil.example" }),
      env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "test-secret" },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "ORIGIN_NOT_ALLOWED");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses only the server-side Gemini key and returns model text", async () => {
  const originalFetch = globalThis.fetch;
  let observedRequest;
  globalThis.fetch = async (url, options) => {
    observedRequest = { url: String(url), options };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Draft result" }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await onRequestPost({
      request: request({ contents: "Write a short draft" }),
      env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "server-secret" },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.text, "Draft result");
    assert.equal(body.provider, "gemini");
    assert.equal(observedRequest.options.headers["x-goog-api-key"], "server-secret");
    assert.equal(JSON.stringify(body).includes("server-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not silently call a paid fallback when Gemini free quota is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
  };
  try {
    const response = await onRequestPost({
      request: request({ contents: "hello" }),
      env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "server-secret" },
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "FREE_QUOTA_UNAVAILABLE");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports missing approved providers without exposing configuration", async () => {
  const response = await onRequestPost({
    request: request({ contents: "hello" }),
    env: { SAFE_AUTOMATON_AI_ENABLED: "true" },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "NO_APPROVED_FREE_PROVIDER");
});


test("OPTIONS preflight accepts same-origin and rejects cross-origin", async () => {
  const { onRequestOptions } = await import("../functions/api/ai.js");
  const good = await onRequestOptions({
    request: new Request("https://contentcraft.example/api/ai", {
      method: "OPTIONS", headers: { origin: "https://contentcraft.example" },
    }),
  });
  assert.equal(good.status, 204);
  const bad = await onRequestOptions({
    request: new Request("https://contentcraft.example/api/ai", {
      method: "OPTIONS", headers: { origin: "https://evil.example" },
    }),
  });
  assert.equal(bad.status, 403);
});

test("rejects malformed JSON and missing contents without provider calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not call"); };
  try {
    const malformed = await onRequestPost({
      request: request("{"), env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "test" },
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_JSON");
    const missing = await onRequestPost({
      request: request({}), env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "test" },
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "INVALID_CONTENTS");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects oversized request bodies before contacting providers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not call"); };
  try {
    const response = await onRequestPost({
      request: request({ contents: "x".repeat(270 * 1024) }),
      env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "test" },
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "REQUEST_TOO_LARGE");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Workers AI binding when configured and returns only generated text", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("Gemini must not be called without a key"); };
  try {
    const response = await onRequestPost({
      request: request({ contents: "Write a test draft" }),
      env: {
        SAFE_AUTOMATON_AI_ENABLED: "true",
        AI: { run: async (model, input) => {
          assert.equal(model, "@cf/meta/llama-3.1-8b-instruct");
          assert.equal(input.messages.at(-1).content, "Write a test draft");
          return { response: "Workers AI draft" };
        } },
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, "cloudflare-workers-ai");
    assert.equal(body.text, "Workers AI draft");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not expose provider error details or credentials in error responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "secret=test-secret internal detail" },
  }), { status: 403 });
  try {
    const response = await onRequestPost({
      request: request({ contents: "hello" }),
      env: { SAFE_AUTOMATON_AI_ENABLED: "true", GEMINI_API_KEY: "test-secret" },
    });
    const raw = await response.text();
    assert.equal(response.status, 503);
    assert.equal(raw.includes("test-secret"), false);
    assert.equal(raw.includes("internal detail"), false);
    assert.match(raw, /AUTH_OR_MODEL_ACCESS/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
