"use strict";

const { runAgentTurn } = require("./_lib/agent");
const { errorDetails } = require("./_lib/model");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    if (!messages.length) {
      res.status(400).json({ error: "messages_required" });
      return;
    }
    for (const message of messages) {
      if (typeof message?.content !== "string" || message.content.length > 4000) {
        res.status(400).json({ error: "invalid_message" });
        return;
      }
    }

    const result = await runAgentTurn({ messages, state: body.state || {} });
    res.status(200).json({
      ok: true,
      reply: result.reply,
      blocks: result.blocks || [],
      actions: result.actions,
      state: result.state,
      reportState: result.state.reportState
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent_failed",
        ...errorDetails(error)
      })
    );
    const configured = error.code !== "model_not_configured";
    res.status(configured ? 502 : 503).json({
      ok: false,
      error: configured ? "agent_failed" : "model_not_configured",
      message: configured ? "AI 助手暂时不可用，请稍后重试。" : "模型服务尚未配置。"
    });
  }
};
