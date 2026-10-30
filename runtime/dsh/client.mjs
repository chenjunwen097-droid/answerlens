import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness, validatedSessionEvent } from "@deepseek-ai/dsh-sdk-client";

const dshDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.dirname(dshDir);
const patchFile = path.join(dshDir, "patch.yml");
const dshHomeRoot = process.env.DSH_HOME_DIR || path.join(dshDir, ".runtime-home");
const sessionCwd = path.join(dshDir, "workspace");

const compact = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s\-_/·,，。.!！?？:：;；"'“”‘’()（）[\]【】]/g, "");

export function verifiedBrief(args, sourceMessage) {
  if (!args || typeof args !== "object") return null;
  const brand = String(args.brand || "").trim();
  const product = String(args.product || "").trim();
  const competitors = [
    ...new Set(
      (Array.isArray(args.competitors) ? args.competitors : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  ].slice(0, 3);
  const directions = [
    ...new Set(
      (Array.isArray(args.directions) ? args.directions : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  ].slice(0, 6);
  const other = String(args.other || "").trim();
  const source = compact(sourceMessage);

  if (!brand || competitors.length === 0 || !source.includes(compact(brand))) return null;
  if (competitors.some((item) => !source.includes(compact(item)))) return null;
  if (product && !source.includes(compact(product))) return null;
  if (directions.some((item) => !source.includes(compact(item)))) return null;
  if (other && !source.includes(compact(other))) return null;

  return {
    brand,
    ...(product ? { product } : {}),
    competitors,
    ...(directions.length ? { directions } : {}),
    ...(other ? { other } : {})
  };
}

export function buildAgentPrompt({ message, report, history = [] }) {
  const transcript = history
    .slice(-12)
    .map((item) => `${item.role === "user" ? "用户" : "AnswerLens"}：${String(item.text || "").trim()}`)
    .filter((line) => !line.endsWith("："))
    .join("\n");
  const reportContext = report
    ? [
        `当前报告：id=${report.id}；品牌=${report.brand}；产品=${report.product || "未填写"}；综合分=${
          report.score ?? "无"
        }。`,
        "回答任何报告事实前，先调用 get_report 读取精确内容。不要依赖对话摘要猜数字。"
      ].join("\n")
    : "";

  return [
    reportContext,
    transcript ? `此前对话（只用于理解上下文，不能当作报告证据）：\n${transcript}` : "",
    `本轮用户消息：${String(message || "").trim()}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseToolCallArguments(value) {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return null;
  }
}

export async function runDshReply({ message, report = null, history = [] }) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY 未配置");

  let brief = null;
  let subagentsStarted = 0;
  let reportAgentUsed = false;
  fs.mkdirSync(dshHomeRoot, { recursive: true });
  const requestHome = fs.mkdtempSync(path.join(dshHomeRoot, "request-"));
  let harness = null;

  try {
    harness = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patchFile],
      dshHome: requestHome,
      processCwd: dshDir,
      cwd: sessionCwd,
      env: {
        ...process.env,
        ANSWERLENS_RUNTIME_DIR: runtimeDir,
        ANSWERLENS_ACTIVE_PRESET: report ? "report-agent" : "orchestrator",
        DATA_DIR: process.env.DATA_DIR || "/data",
        DSH_TELEMETRY_DISABLED: "1",
        DSH_PERMISSION_MODE: "read-only"
      },
      provider: "deepseek-official",
      model: process.env.DSH_MODEL || "deepseek-flash",
      reasoningEffort: "off",
      maxTokens: Number(process.env.DSH_MAX_TOKENS || 1800),
      initializeTimeoutMs: 20_000,
      requestTimeoutMs: 45_000,
      shutdownTimeoutMs: 1_500,
      disposeEofGraceMs: 2_000,
      disposeGraceMs: 1_500
    });
    const result = await harness.run(buildAgentPrompt({ message, report, history }), {
      onNotification(notification) {
        if (notification.method === "subagent.started") subagentsStarted += 1;
        if (notification.method !== "session.event") return;
        let event;
        try {
          event = validatedSessionEvent(notification.params.event);
        } catch {
          return;
        }
        if (event.type === "agent-preset/selected" && event.data.agentPreset === "report-agent") {
          reportAgentUsed = true;
        }
        if (event.type === "system/message") {
          const promptText = Array.isArray(event.data.message?.content)
            ? event.data.message.content
                .filter((item) => item?.type === "text")
                .map((item) => item.text)
                .join("")
            : "";
          if (promptText.includes("报告助手")) reportAgentUsed = true;
        }
        if (event.type !== "tool/call" || event.data.name !== "prepare_analysis") return;
        const args = parseToolCallArguments(event.data.arguments);
        brief = verifiedBrief(args, message) || brief;
      }
    });

    const text = String(result.finalResponse || "").trim();
    if (!text) throw new Error("dsh 没有返回可展示的回答");
    return {
      text,
      brief,
      trace: { subagentsStarted, reportAgentUsed }
    };
  } finally {
    if (harness) await harness.close();
    fs.rmSync(requestHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
