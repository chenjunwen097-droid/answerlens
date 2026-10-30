// AnswerLens runtime: HTTP + SSE + SQLite. All content comes from the real
// pipeline in pipeline.mjs; there is no mock data path.
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { runPipeline } from "./pipeline.mjs";
import { agentReply } from "./agents.mjs";
import { createReportStore, nextReportVersion } from "./store.mjs";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RUNTIME_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const store = createReportStore(DATA_DIR);
const VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error("payload too large"));
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  return (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function chunks(text, size = 14) {
  const parts = String(text).match(new RegExp(`[\\s\\S]{1,${size}}`, "g"));
  return parts || [String(text)];
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "answerlens-runtime",
        storage: store.storage,
        version: VERSION,
        agentEngine: process.env.AGENT_ENGINE === "dsh" ? "dsh" : "legacy",
        models: {
          deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
          glm: Boolean(process.env.GLM_API_KEY),
          search: Boolean(process.env.DEEPSEEK_API_KEY)
        }
      })
    );
    return;
  }

  if (!url.pathname.startsWith("/v1/")) {
    response.writeHead(404).end("not found");
    return;
  }
  if (!TOKEN || request.headers.authorization !== `Bearer ${TOKEN}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  try {
    if (url.pathname === "/v1/reports" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reports: store.list() }));
      return;
    }
    if (url.pathname === "/v1/reports" && request.method === "POST") {
      const report = await readBody(request);
      store.save(report);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, id: report.id }));
      return;
    }
    if (url.pathname === "/v1/chat" && request.method === "POST") {
      const body = await readBody(request);
      const result =
        process.env.AGENT_ENGINE === "dsh"
          ? await (await import("./dsh/client.mjs")).runDshReply({
              message: body.message,
              report: body.report,
              history: body.history
            })
          : await agentReply({ message: body.message, report: body.report });
      const send = sse(response);
      for (const part of chunks(result.text)) {
        send({ type: "token", text: part });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      if (result.brief) {
        send({
          type: "blocks",
          blocks: [
            {
              type: "plan",
              title: "准备开始检测",
              lines: [
                `检测对象：${result.brief.brand}${result.brief.product ? ` · ${result.brief.product}` : ""}`,
                `竞品：${result.brief.competitors.join(" · ")}`,
                ...(result.brief.directions?.length
                  ? [`检测方向：${result.brief.directions.join(" · ")}`]
                  : []),
                ...(result.brief.other ? [`其他补充：${result.brief.other}`] : []),
                "确认后生成 6 个买家问题，并调用两组被测模型作答"
              ],
              action: { key: "start-analysis", label: "开始检测", brief: result.brief }
            }
          ]
        });
      }
      send({ type: "done" });
      response.end();
      return;
    }
    if (url.pathname === "/v1/runs" && request.method === "POST") {
      const body = await readBody(request);
      const send = sse(response);
      let saved = null;
      try {
        for await (const event of runPipeline({ brief: body.brief, reportId: body.reportId || randomUUID() })) {
          if (event.type === "report") {
            const report = {
              ...event.report,
              version: nextReportVersion(
                store.list(),
                event.report.brand,
                event.report.product
              )
            };
            send({ ...event, report });
            saved = report;
          } else {
            send(event);
          }
        }
      } catch (error) {
        send({ type: "error", message: error.message, retryable: false });
      }
      if (saved) store.save(saved);
      response.end();
      return;
    }
    response.writeHead(404).end("not found");
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    } else {
      response.end();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`answerlens-runtime listening on :${PORT} (storage=${store.storage})`);
});
