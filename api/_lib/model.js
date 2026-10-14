"use strict";

const DEFAULTS = {
  deepseek: {
    base: "https://api.deepseek.com",
    agentModel: "deepseek-flash",
    judgeModel: "deepseek-flash",
    utilityModel: "deepseek-flash",
    testedModel: "deepseek-flash"
  },
  glm: {
    base: "https://open.bigmodel.cn/api/paas/v4/",
    testedModel: "glm-4.6v",
    visionModel: "glm-4.6v"
  }
};

function completionUrl(base, provider) {
  const trimmed = String(base || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (provider === "deepseek" && /^https:\/\/api\.deepseek\.com$/i.test(trimmed)) {
    return `${trimmed}/v1/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
}

function providerConfig(provider, env = process.env) {
  if (provider === "deepseek") {
    return {
      provider,
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_API_BASE || DEFAULTS.deepseek.base
    };
  }
  if (provider === "glm") {
    return {
      provider,
      apiKey: env.GLM_API_KEY,
      baseUrl: env.GLM_API_BASE || DEFAULTS.glm.base
    };
  }
  throw new Error(`Unsupported model provider: ${provider}`);
}

function resolveModel(provider, role, explicitModel, env = process.env) {
  if (explicitModel) return explicitModel;
  if (provider === "deepseek") {
    if (role === "agent") return env.DEEPSEEK_AGENT_MODEL || DEFAULTS.deepseek.agentModel;
    if (role === "judge") return env.DEEPSEEK_JUDGE_MODEL || DEFAULTS.deepseek.judgeModel;
    if (role === "tested") return env.DEEPSEEK_TESTED_MODEL || DEFAULTS.deepseek.testedModel;
    return env.DEEPSEEK_UTILITY_MODEL || DEFAULTS.deepseek.utilityModel;
  }
  if (provider === "glm") {
    if (role === "vision") {
      return env.GLM_VISION_MODEL || env.GLM_TESTED_MODEL || DEFAULTS.glm.visionModel;
    }
    return env.GLM_TESTED_MODEL || DEFAULTS.glm.testedModel;
  }
  throw new Error(`Unsupported model provider: ${provider}`);
}

async function callChat({
  provider,
  role = "default",
  model,
  messages,
  maxTokens = 1200,
  temperature = 0.2,
  responseFormat,
  tools,
  toolChoice,
  extraBody,
  timeoutMs = 45000
}) {
  const config = providerConfig(provider);
  if (!config.apiKey) {
    const error = new Error(`Missing ${provider.toUpperCase()} API key`);
    error.code = "model_not_configured";
    throw error;
  }

  const resolvedModel = resolveModel(provider, role, model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(completionUrl(config.baseUrl, provider), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(extraBody || {})
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        `${provider} request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.provider = provider;
      error.model = resolvedModel;
      throw error;
    }
    if (!payload?.choices?.[0]?.message) {
      throw new Error(`${provider} returned an empty completion`);
    }
    return {
      provider,
      model: payload.model || resolvedModel,
      message: payload.choices[0].message,
      finishReason: String(payload.choices[0].finish_reason || ""),
      usage: payload.usage || null
    };
  } catch (error) {
    if (error.name === "AbortError") {
      error.code = "model_timeout";
      error.message = `${provider} request timed out`;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonContent(content) {
  if (content && typeof content === "object") return content;
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Model returned invalid JSON");
  }
}

function errorDetails(error) {
  return {
    code: error?.code || "unknown_error",
    status: Number.isFinite(error?.status) ? error.status : null,
    provider: error?.provider || null,
    model: error?.model || null,
    message: String(error?.message || "Unknown model error")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500)
  };
}

module.exports = {
  DEFAULTS,
  callChat,
  completionUrl,
  errorDetails,
  parseJsonContent,
  providerConfig,
  resolveModel
};
