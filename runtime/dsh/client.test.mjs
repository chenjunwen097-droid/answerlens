import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentPrompt, runDshReply, verifiedBrief } from "./client.mjs";
import { createReportStore, nextReportVersion } from "../store.mjs";

describe("dsh contract mapping", () => {
  it("increments report versions from persisted records", () => {
    assert.equal(nextReportVersion([], "品牌", ""), 1);
    assert.equal(
      nextReportVersion(
        [
          { brand: "品牌", product: "", version: 1 },
          { brand: "品牌", product: "", version: 2 },
          { brand: "品牌", product: "另一款", version: 8 }
        ],
        "品牌",
        ""
      ),
      3
    );
  });

  it("accepts only brief fields that appear in the user message", () => {
    const message = "对比小米14和iPhone 17 Pro在屏幕护眼上的表现";
    assert.deepEqual(
      verifiedBrief(
        {
          brand: "小米14",
          competitors: ["iPhone 17 Pro"],
          directions: ["屏幕护眼"]
        },
        message
      ),
      {
        brand: "小米14",
        competitors: ["iPhone 17 Pro"],
        directions: ["屏幕护眼"]
      }
    );
    assert.equal(
      verifiedBrief(
        { brand: "小米15", competitors: ["iPhone 17 Pro"] },
        message
      ),
      null
    );
  });

  it("adds report evidence instructions without exposing server paths", () => {
    const prompt = buildAgentPrompt({
      message: "第 2 题为什么低？",
      report: {
        id: "report-1",
        brand: "小米",
        product: "小米14",
        score: 72
      },
      history: [
        { role: "user", text: "看一下这份报告" },
        { role: "assistant", text: "你想先看哪一部分？" }
      ]
    });
    assert.match(prompt, /id=report-1/);
    assert.match(prompt, /get_report/);
    assert.match(prompt, /此前对话/);
    assert.doesNotMatch(prompt, /Users/);
    assert.doesNotMatch(prompt, /worktrees/);
  });

  it(
    "runs a real dsh orchestrator turn",
    { skip: process.env.RUN_DSH_CONTRACT !== "1" },
    async () => {
      const result = await runDshReply({
        message: "对比小米14和iPhone 17 Pro在屏幕护眼上的表现"
      });
      assert.ok(result.text.length > 10);
      assert.ok(["小米", "小米14"].includes(result.brief?.brand));
      assert.deepEqual(result.brief?.competitors, ["iPhone 17 Pro"]);
    }
  );

  it(
    "routes a report question through the report agent and real report store",
    { skip: process.env.RUN_DSH_CONTRACT !== "1" },
    async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "answerlens-report-contract-"));
      const previous = process.env.DATA_DIR;
      process.env.DATA_DIR = dataDir;
      const report = {
        id: "contract-report",
        brand: "测试品牌",
        product: "测试产品",
        competitors: ["竞品甲"],
        score: 73,
        date: "2026-10-29",
        version: 1,
        status: "complete",
        headline: "测试标题",
        summary: "只用于验证真实工具链路。",
        metrics: { recommendRate: 50, firstChoiceRate: 25, samples: 2 },
        bars: [],
        positioning: [],
        actions: [],
        questions: [
          { q: "问题一", score: 70, deepseek: "回答一", glm: "回答一" },
          { q: "问题二", score: 73, deepseek: "回答二", glm: "回答二" }
        ]
      };
      const reportStore = createReportStore(dataDir);
      try {
        reportStore.save(report);
        const result = await runDshReply({
          message: "这份报告第 2 题得了多少分？只回答分数和对应问题。",
          report
        });
        assert.equal(result.trace.subagentsStarted, 0);
        assert.equal(result.trace.reportAgentUsed, true);
        assert.match(result.text, /73/);
        assert.doesNotMatch(result.text, /字段|recommendations|JSON/i);
      } finally {
        reportStore.close();
        if (previous === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previous;
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  );
});
