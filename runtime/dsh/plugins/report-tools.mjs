import { defineTool } from "@deepseek-ai/dsh-tools";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeDir = path.resolve(process.env.ANSWERLENS_RUNTIME_DIR || "/app");
const { createReportStore } = await import(pathToFileURL(path.join(runtimeDir, "store.mjs")).href);

const store = createReportStore(process.env.DATA_DIR || "/data");

function requireReport(reportId, signal) {
  signal?.throwIfAborted();
  const report = store.get(String(reportId || ""));
  if (!report) throw new Error(`没有找到报告 ${reportId}`);
  return report;
}

function renderJson(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export const name = "answerlens-report-tools";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "list_reports",
      description:
        "列出 AnswerLens 已保存报告的精简目录。只用于发现真实 reportId；需要内容时必须继续调用 get_report。",
      parameters: {},
      output: {
        schema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              brand: { type: "string", required: true },
              product: { type: "string" },
              score: { type: "number" },
              date: { type: "string", required: true },
              version: { type: "number", required: true }
            }
          }
        },
        render: (_args, value) => renderJson(value)
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        exec.signal?.throwIfAborted();
        return store.list().map((report) => ({
          id: report.id,
          brand: report.brand,
          ...(report.product ? { product: report.product } : {}),
          ...(typeof report.score === "number" ? { score: report.score } : {}),
          date: report.date,
          version: report.version
        }));
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "get_report",
      description:
        "读取 AnswerLens 已保存的一份真实报告。用于回答报告分数、提问明细、模型原始回答、定位判断和行动建议问题。只能引用工具返回的内容。",
      parameters: {
        reportId: {
          type: "string",
          required: true,
          description: "报告的精确 id，来自当前报告上下文或 compare_reports 之外的已知 id"
        }
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderJson(value)
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return requireReport(args.reportId, exec.signal);
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "compare_reports",
      description:
        "读取两份真实报告的证据供比较。工具只返回原始报告，不生成比较结论；没有报告时必须如实说明，不能推测。",
      parameters: {
        reportIdA: { type: "string", required: true, description: "第一份报告的精确 id" },
        reportIdB: { type: "string", required: true, description: "第二份报告的精确 id" }
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderJson(value)
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return {
          reports: [
            requireReport(args.reportIdA, exec.signal),
            requireReport(args.reportIdB, exec.signal)
          ]
        };
      }
    })
  );
}
