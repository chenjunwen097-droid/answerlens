import { buildReport } from "./data";
import type { ChatBlock, Report, RunStageEvent } from "./types";

export const STAGES = [
  { stage: "understand", label: "理解需求", detail: "提取品牌、型号、竞品与检测方向" },
  { stage: "research", label: "联网调研", detail: "DeepSeek Search · 核对型号与背景" },
  { stage: "questions", label: "设计问题", detail: "生成 6 个买家问题并校验覆盖" },
  { stage: "answers", label: "模型作答", detail: "DeepSeek Flash × 6 · GLM 4.6v × 6" },
  { stage: "judge", label: "逐条判定", detail: "五个维度 · 引用原句" },
  { stage: "report", label: "汇总报告", detail: "定位、竞品差距与行动建议" }
] as const;

export interface Brief {
  brand: string;
  product?: string;
  competitors: string[];
  score?: number;
}

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "blocks"; blocks: ChatBlock[] }
  | { type: "done" };

export type RunEvent =
  | ({ type: "stage" } & RunStageEvent)
  | { type: "report"; report: Report }
  | { type: "error"; message: string; retryable: boolean };

export interface AgentRuntime {
  readonly name: "mock" | "dsh";
  chat(input: { scope: unknown; message: string; report?: Report | null }): AsyncGenerator<ChatEvent>;
  run(input: { brief: Brief; reportId: string }): AsyncGenerator<RunEvent>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockRuntime implements AgentRuntime {
  readonly name = "mock" as const;

  async *chat(input: { scope: unknown; message: string; report?: Report | null }): AsyncGenerator<ChatEvent> {
    const report = input.report;
    const text = report
      ? `这份报告里，${report.brand} 的第 ${
          report.questions.reduce((best, item, index) => (item.score > report.questions[best].score ? index : best), 0) + 1
        } 题表现最好。所有数字都来自报告中的逐条判定，没有重新生成。`
      : "我先按这个方案准备：会先联网核对型号与背景，再生成 6 个买家问题。问题可以编辑，确认后才会真正开始模型测试。";
    for (const chunk of text.match(/.{1,12}/g) || [text]) {
      yield { type: "token", text: chunk };
      await sleep(24);
    }
    yield {
      type: "blocks",
      blocks: report
        ? [{ type: "text", text: "需要我把这道题的原始回答调出来对照吗？" }]
        : [
            {
              type: "plan",
              title: "准备开始检测",
              lines: ["预计耗时 3–5 分钟", "会消耗 1 次免费额度"],
              action: { key: "start-analysis", label: "开始检测" }
            }
          ]
    };
    yield { type: "done" };
  }

  async *run(input: { brief: Brief; reportId: string }): AsyncGenerator<RunEvent> {
    for (let index = 0; index < STAGES.length; index += 1) {
      const stage = STAGES[index];
      yield { type: "stage", stage: stage.stage, label: stage.label, index, total: STAGES.length };
      await sleep(650);
    }
    yield {
      type: "report",
      report: buildReport({
        id: input.reportId,
        brand: input.brief.brand,
        product: input.brief.product,
        competitors: input.brief.competitors,
        score: input.brief.score ?? 66
      })
    };
  }
}

/**
 * Adapter for the dsh `sdk` profile.
 *
 * The runtime is a separate long-lived Node service (Vercel cannot host it).
 * The contract below is intentionally thin: one JSON-RPC call per streamed
 * turn, newline-delimited JSON frames back. Align the method names with the
 * pinned @deepseek-ai/dsh version and cover them with contract tests before
 * switching `AGENT_RUNTIME_URL` on.
 */
class DshRuntime implements AgentRuntime {
  readonly name = "dsh" as const;
  constructor(private readonly baseUrl: string) {}

  private async *stream(method: string, params: unknown): AsyncGenerator<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.AGENT_RUNTIME_TOKEN
          ? { authorization: `Bearer ${process.env.AGENT_RUNTIME_TOKEN}` }
          : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(180_000)
    });
    if (!response.ok || !response.body) throw new Error(`runtime ${method} failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
        newline = buffer.indexOf("\n");
      }
    }
  }

  async *chat(input: { scope: unknown; message: string; report?: Report | null }): AsyncGenerator<ChatEvent> {
    for await (const frame of this.stream("agent.chat", input)) {
      if (frame.method === "chat.token") yield { type: "token", text: String(frame.text || "") };
      if (frame.method === "chat.blocks") yield { type: "blocks", blocks: (frame.blocks || []) as ChatBlock[] };
      if (frame.method === "chat.done") yield { type: "done" };
    }
  }

  async *run(input: { brief: Brief; reportId: string }): AsyncGenerator<RunEvent> {
    for await (const frame of this.stream("agent.run", input)) {
      if (frame.method === "run.stage") {
        yield {
          type: "stage",
          stage: String(frame.stage),
          label: String(frame.label),
          index: Number(frame.index),
          total: Number(frame.total)
        };
      }
      if (frame.method === "report.ready") yield { type: "report", report: frame.report as Report };
      if (frame.method === "run.error") {
        yield { type: "error", message: String(frame.message), retryable: Boolean(frame.retryable) };
      }
    }
  }
}

export function getRuntime(): AgentRuntime {
  const url = process.env.AGENT_RUNTIME_URL;
  return url ? new DshRuntime(url) : new MockRuntime();
}
