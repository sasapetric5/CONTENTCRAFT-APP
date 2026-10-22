import type { Content, GenerateContentParameters } from "@google/genai";

type SafeAiResponse = {
  ok?: boolean;
  text?: string;
  code?: string;
};

export const generateContent = async (
  contents: string | Content[],
  config?: GenerateContentParameters["config"]
): Promise<string> => {
  const safeConfig: Record<string, unknown> = {};
  if (typeof config?.temperature === "number" && Number.isFinite(config.temperature)) {
    safeConfig.temperature = Math.min(1, Math.max(0, config.temperature));
  }
  if (typeof config?.systemInstruction === "string") {
    safeConfig.systemInstruction = config.systemInstruction.slice(0, 8000);
  } else if (
    config?.systemInstruction &&
    typeof config.systemInstruction === "object" &&
    "parts" in config.systemInstruction
  ) {
    const parts = (config.systemInstruction as { parts?: Array<{ text?: string }> }).parts;
    safeConfig.systemInstruction = Array.isArray(parts)
      ? parts.map(part => part?.text || "").join("\n").slice(0, 8000)
      : "";
  }

  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ contents, config: safeConfig }),
    });

    let result: SafeAiResponse;
    try {
      result = await response.json() as SafeAiResponse;
    } catch {
      throw new Error("AI_GATEWAY_INVALID_RESPONSE");
    }

    if (!response.ok || result.ok !== true || typeof result.text !== "string" || !result.text.trim()) {
      const code = typeof result.code === "string" ? result.code : "AI_GATEWAY_REQUEST_FAILED";
      throw new Error(code);
    }
    return result.text;
  } catch (error) {
    // Never include request credentials or raw upstream response details in client errors.
    if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error("AI_GATEWAY_UNAVAILABLE");
  }
};
