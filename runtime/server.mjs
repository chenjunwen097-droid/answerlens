// AnswerLens runtime: HTTP + SSE + SQLite. All content comes from the real
// pipeline in pipeline.mjs; there is no mock data path.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runPipeline } from "./pipeline.mjs";
import { agentReply } from "./agents.mjs";

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RUNTIME_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_FILE = path.join(DATA_DIR, "answerlens.db");
const JSON_FILE = path.join(DATA_DIR, "answerlens.json");

let storage = "json";
let sqlite = null;

function initStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const { DatabaseSync } = require("node:sqlite");
    sqlite = new DatabaseSync(DB_FILE);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    storage = "sqlite";
  } catch {
    storage = "json";
    if (!fs.existsSync(JSON_FILE)) fs.writeFileSync(JSON_FILE, JSON.stringify({ reports: [] }));
  }
}

function readJson() {
  try {
    return JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  } catch {
    return { reports: [] };
  }
}

function saveReport(report) {
  const createdAt = new Date().toISOString();
  if (sqlite) {
    sqlite
      .prepare("INSERT OR REPLACE INTO reports (id, payload, created_at) VALUES (?, ?, ?)")
      .run(report.id, JSON.stringify(report), createdAt);
    return;
  }
  const data = readJson();
  data.reports = [report, ...data.reports.filter((item) => item.id !== report.id)];
  fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2));
}

function listReports() {
  if (sqlite) {
    return sqlite
      .prepare("SELECT payload FROM reports ORDER BY created_at DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(row.payload));
  }
  return readJson().reports;
}

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
        storage,
        version: "0.2.0",
        models: {
          deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
          glm: Boolean(process.env.GLM_API_KEY),
          search: Boolean(process.env.DEEPSEEK_API_KEY || process.env.SEARCH_API_KEY)
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
      response.end(JSON.stringify({ reports: listReports() }));
      return;
    }
    if (url.pathname === "/v1/reports" && request.method === "POST") {
      const report = await readBody(request);
      saveReport(report);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, id: report.id }));
      return;
    }
    if (url.pathname === "/v1/chat" && request.method === "POST") {
      const body = await readBody(request);
      const text = await agentReply({ message: body.message, report: body.report });
      const send = sse(response);
      for (const part of chunks(text)) {
        send({ type: "token", text: part });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const wantsAnalysis =
        !body.report && /(对比|比较|分析|推荐|哪个|怎么样|适合|检测)/.test(String(body.message || ""));
      if (wantsAnalysis) {
        send({
          type: "blocks",
          blocks: [
            {
              type: "plan",
              title: "准备开始检测",
              lines: ["先联网核对型号与背景", "生成 6 个买家问题，确认后才开始测试"],
              action: { key: "start-analysis", label: "开始检测" }
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
          send(event);
          if (event.type === "report") saved = event.report;
        }
      } catch (error) {
        send({ type: "error", message: error.message, retryable: false });
      }
      if (saved) saveReport(saved);
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

initStorage();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`answerlens-runtime listening on :${PORT} (storage=${storage})`);
});
