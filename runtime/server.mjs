// AnswerLens runtime service.
//
// This is the long-lived process that Vercel cannot host. It owns:
//   · the agent/run streaming protocol the frontend consumes
//   · the SQLite store for reports and threads (single-user MVP)
//   · the seam where the DeepSeek Harness (dsh) runtime will be mounted
//
// Today it runs the deterministic mock pipeline; with model keys present the
// pipeline can be swapped for the real one without changing the API.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RUNTIME_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_FILE = path.join(DATA_DIR, "answerlens.db");
const JSON_FILE = path.join(DATA_DIR, "answerlens.json");

const STAGES = [
  { stage: "understand", label: "理解需求", detail: "提取品牌、型号、竞品与检测方向" },
  { stage: "research", label: "联网调研", detail: "DeepSeek Search · 核对型号与背景" },
  { stage: "questions", label: "设计问题", detail: "生成 6 个买家问题并校验覆盖" },
  { stage: "answers", label: "模型作答", detail: "DeepSeek Flash × 6 · GLM 4.6v × 6" },
  { stage: "judge", label: "逐条判定", detail: "五个维度 · 引用原句" },
  { stage: "report", label: "汇总报告", detail: "定位、竞品差距与行动建议" }
];

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
    sqlite.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    storage = "sqlite";
  } catch {
    storage = "json";
    if (!fs.existsSync(JSON_FILE)) fs.writeFileSync(JSON_FILE, JSON.stringify({ reports: [], messages: [] }));
  }
}

function readJson() {
  try {
    return JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  } catch {
    return { reports: [], messages: [] };
  }
}

function writeJson(data) {
  fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2));
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
  writeJson(data);
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

function buildReport(input) {
  const name = input.product || input.brand;
  const [c1, c2] = input.competitors;
  const base = input.score ?? 66;
  const questions = [
    `${name} 最适合哪类用户？为什么？`,
    `${name} 和 ${c1} 相比，核心优势是什么？`,
    `预算有限时，应该选 ${name} 还是 ${c1}？`,
    `${name} 有哪些被反复提到的短板？`,
    `长时间使用时，${name} 和 ${c2} 哪个更省心？`,
    `为什么用户会推荐 ${name}？`
  ].map((q, index) => ({
    q,
    score: Math.max(24, Math.min(96, base + (index % 3 === 0 ? 4 : index % 3 === 1 ? -3 : 1))),
    deepseek: `${name} 在${index % 2 === 0 ? "日常场景" : "对比场景"}里表现稳定，优势集中在${["屏幕与手感", "生态协同", "续航稳定性", "售后覆盖"][index % 4]}。`,
    glm: `${c1} 在${index % 2 === 0 ? "品牌认知" : "参数对比"}上更常被提及；如果用户更看重${["护眼与亮度", "多设备协同", "长期耐用", "价格透明"][index % 4]}，${name} 是更稳的选择。`
  }));
  return {
    id: input.id || randomUUID(),
    brand: input.brand,
    product: input.product || "",
    competitors: input.competitors,
    score: base,
    date: new Date().toISOString().slice(0, 10),
    version: input.version || 1,
    status: "complete",
    headline: base >= 70 ? "AI 已经把你列进推荐清单，但理由还不够稳定" : "AI 能理解产品，但推荐顺位仍然靠后",
    summary: `${name} 的 AI 推荐表现平均分为 ${base}/100，共分析 6 个决策问题和 12 条真实回答。`,
    metrics: { recommendRate: Math.round(base * 0.92), firstChoiceRate: Math.round(base * 0.46), samples: 12 },
    bars: [
      { name: input.brand, value: base, rank: 1 },
      { name: c1, value: Math.max(0, base - 8), rank: 2 },
      { name: c2, value: Math.max(0, base - 21), rank: 3 }
    ],
    positioning: [
      { label: "一句话定位", text: `AI 把 ${name} 理解为「均衡的日常选择」，但缺少一句可复述的定位。` },
      { label: "模型共识", text: "屏幕与手感被两个模型多次提到，是当前最清晰的共识。" },
      { label: "与竞品的关键差异", text: `面对 ${c1} 时，${name} 的优势更多来自长期体验，而不是单点参数。` }
    ],
    actions: [
      { title: "把「均衡」改写成可复述的一句话", why: "两个模型都在描述优势，但没有形成同一句定位。" },
      { title: `补齐 ${c1} 的真实对比页`, why: "用户在预算场景会直接比较，缺少对比内容会丢推荐顺位。" },
      { title: "强化第三方口碑与使用案例", why: "证据完整的回答更容易进入首选清单。" }
    ],
    questions
  };
}

function sse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  return (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("payload too large"));
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://localhost:${PORT}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "answerlens-runtime",
        storage,
        version: "0.1.0",
        models: {
          deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
          glm: Boolean(process.env.GLM_API_KEY),
          // DeepSeek Search runs on the DeepSeek key; Serper is only a fallback.
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
      const send = sse(response);
      const report = body.report;
      const text = report
        ? `这份报告里，${report.brand} 的最佳表现来自第 1 题。所有数字都来自报告中的逐条判定，没有重新生成。`
        : "我先按这个方案准备：会先联网核对型号与背景，再生成 6 个买家问题。问题可以编辑，确认后才会真正开始模型测试。";
      for (const chunk of text.match(/.{1,12}/g) || [text]) {
        send({ type: "token", text: chunk });
        await new Promise((resolve) => setTimeout(resolve, 24));
      }
      send({
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
      });
      send({ type: "done" });
      response.end();
      return;
    }
    if (url.pathname === "/v1/runs" && request.method === "POST") {
      const body = await readBody(request);
      const send = sse(response);
      for (let index = 0; index < STAGES.length; index += 1) {
        send({ type: "stage", ...STAGES[index], index, total: STAGES.length });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const report = buildReport({ ...body.brief, id: body.reportId });
      saveReport(report);
      send({ type: "report", report });
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
