"use strict";

const { callChat, errorDetails, providerConfig, resolveModel } = require("./_lib/model");
const { activeProvider, researchConfigured, searchWeb } = require("./_lib/research");

// Only the models this service actually depends on. DeepSeek serves every
// "utility" step, GLM serves the second tested model and image extraction.
const PROBES = [
  { key: "deepseek", label: "DeepSeek Flash", provider: "deepseek", role: "utility" },
  { key: "glm", label: "GLM 4.6v", provider: "glm", role: "tested" }
];

const PROBE_TIMEOUT_MS = 12000;
const PROBE_MAX_TOKENS = 16;
const PROBE_MESSAGES = [
  { role: "system", content: "只回复两个字：可用" },
  { role: "user", content: "ping" }
];

async function probeModel(probe, { callChatImpl = callChat } = {}) {
  const configured = Boolean(providerConfig(probe.provider).apiKey);
  const model = resolveModel(probe.provider, probe.role);
  const base = { label: probe.label, provider: probe.provider, role: probe.role, model, configured };
  if (!configured) {
    return { ...base, ok: false, code: "model_not_configured", latencyMs: null };
  }
  const startedAt = Date.now();
  try {
    const completion = await callChatImpl({
      provider: probe.provider,
      role: probe.role,
      messages: PROBE_MESSAGES,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      timeoutMs: PROBE_TIMEOUT_MS,
      extraBody: { thinking: { type: "disabled" } }
    });
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - startedAt,
      finishReason: String(completion?.finishReason || ""),
      sample: String(completion?.message?.content || "").slice(0, 20)
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - startedAt,
      ...errorDetails(error)
    };
  }
}

async function probeModels({ callChatImpl } = {}) {
  const results = await Promise.all(
    PROBES.map((probe) => probeModel(probe, { callChatImpl }))
  );
  const models = {};
  results.forEach((result, index) => {
    models[PROBES[index].key] = result;
  });
  const healthy = results.every((result) => result.ok);
  return {
    models,
    healthy,
    summary: results
      .map(
        (result) =>
          `${result.label} ${result.ok ? "✓" : "✗"}${
            Number.isFinite(result.latencyMs) ? ` ${result.latencyMs}ms` : ""
          }`
      )
      .join(" · ")
  };
}

// A search probe tells us whether the SearXNG gateway is actually answering,
// which a "variable is set" check can never do.
async function probeSearch({ searchImpl = searchWeb } = {}) {
  const configured = researchConfigured();
  const provider = activeProvider();
  if (!configured && !provider) {
    return { configured: false, ok: false, status: "not_configured", latencyMs: null };
  }
  const startedAt = Date.now();
  const outcome = await searchImpl("AnswerLens 健康检查");
  const latencyMs = Date.now() - startedAt;
  const status = String(outcome?.status || "failed");
  return {
    configured: true,
    provider: outcome?.provider || (provider ? provider.name : "searxng"),
    ok: status === "ok" || status === "empty",
    status,
    code: String(outcome?.code || ""),
    resultCount: (outcome?.results || []).length,
    latencyMs,
    error: String(outcome?.error || "").slice(0, 160)
  };
}

module.exports = async (req, res) => {
  const url = String(req.url || "");
  const skipProbe = /[?&]probe=0\b/.test(url) || req.query?.probe === "0";
  const research = researchConfigured();
  const base = {
    ok: true,
    service: "answerlens",
    checkedAt: new Date().toISOString(),
    research
  };

  if (skipProbe) {
    res.status(200).json({
      ...base,
      healthy: null,
      probed: false,
      search: { configured: research, ok: null, status: "skipped" },
      models: Object.fromEntries(
        PROBES.map((probe) => [
          probe.key,
          {
            label: probe.label,
            provider: probe.provider,
            role: probe.role,
            model: resolveModel(probe.provider, probe.role),
            configured: Boolean(providerConfig(probe.provider).apiKey)
          }
        ])
      )
    });
    return;
  }

  const result = await probeModels();
  const search = await probeSearch();
  res.status(200).json({
    ...base,
    healthy: result.healthy && search.ok,
    probed: true,
    summary: `${result.summary} · 搜索 ${search.ok ? "✓" : "✗"}${
      Number.isFinite(search.latencyMs) ? ` ${search.latencyMs}ms` : ""
    }`,
    models: result.models,
    search
  });
};

module.exports.PROBES = PROBES;
module.exports.probeModel = probeModel;
module.exports.probeModels = probeModels;
module.exports.probeSearch = probeSearch;
