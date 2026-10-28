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
  readonly name: "mock" | "remote";
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
 * Adapter for the remote runtime service.
 *
 * The runtime is a separate long-lived Node service (Vercel cannot host it).
 * It currently runs the deterministic pipeline and will host the dsh agents
 * behind the same SSE contract. One POST per turn, `data: {...}` frames back.
 */
class RemoteRuntime implements AgentRuntime {
  readonly name = "remote" as const;
  constructor(private readonly baseUrl: string) {}

  private async *stream(pathname: string, payload: unknown): AsyncGenerator<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.AGENT_RUNTIME_TOKEN
          ? { authorization: `Bearer ${process.env.AGENT_RUNTIME_TOKEN}` }
          : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000)
    });
    if (!response.ok || !response.body) throw new Error(`runtime ${pathname} failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (line) yield JSON.parse(line.slice(6)) as Record<string, unknown>;
        split = buffer.indexOf("\n\n");
      }
    }
  }

  async *chat(input: { scope: unknown; message: string; report?: Report | null }): AsyncGenerator<ChatEvent> {
    for await (const frame of this.stream("/v1/chat", input)) {
      if (frame.type === "token") yield { type: "token", text: String(frame.text || "") };
      if (frame.type === "blocks") yield { type: "blocks", blocks: (frame.blocks || []) as ChatBlock[] };
      if (frame.type === "done") yield { type: "done" };
    }
  }

  async *run(input: { brief: Brief; reportId: string }): AsyncGenerator<RunEvent> {
    for await (const frame of this.stream("/v1/runs", input)) {
      if (frame.type === "stage") {
        yield {
          type: "stage",
          stage: String(frame.stage),
          label: String(frame.label),
          index: Number(frame.index),
          total: Number(frame.total)
        };
      }
      if (frame.type === "report") yield { type: "report", report: frame.report as Report };
      if (frame.type === "error") {
        yield { type: "error", message: String(frame.message), retryable: Boolean(frame.retryable) };
      }
    }
  }
}

export function getRuntime(): AgentRuntime {
  const url = process.env.AGENT_RUNTIME_URL;
  return url ? new RemoteRuntime(url) : new MockRuntime();
}
