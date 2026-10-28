import { describe, expect, it } from "vitest";
import { buildReport, parseBrief, seedReports } from "../lib/data";
import { getRuntime } from "../lib/runtime";
import { searchConfigured } from "../lib/search";

describe("report domain", () => {
  it("builds six questions and three ranked bars", () => {
    const report = buildReport({
      id: "r1",
      brand: "小米",
      product: "小米 14",
      competitors: ["iPhone 17 Pro", "华为 Mate 70"],
      score: 72
    });
    expect(report.questions).toHaveLength(6);
    expect(report.bars).toHaveLength(3);
    expect(report.bars.map((bar) => bar.rank)).toEqual([1, 2, 3]);
    expect(report.summary).toContain("72/100");
    expect(report.questions.every((question) => question.score >= 24 && question.score <= 96)).toBe(true);
  });

  it("ships six seed reports without duplicate ids", () => {
    const ids = new Set(seedReports.map((report) => report.id));
    expect(seedReports).toHaveLength(6);
    expect(ids.size).toBe(6);
  });

  it("parses a known brand out of a free-form message", () => {
    expect(parseBrief("对比小米 14 和 iPhone 17 Pro 的屏幕").brand).toBe("小米");
    expect(parseBrief("完全陌生的东西")).toMatchObject({ brand: "你的品牌" });
  });
});

describe("runtime and providers", () => {
  it("requires a runtime URL instead of falling back to mock data", () => {
    delete process.env.AGENT_RUNTIME_URL;
    expect(() => getRuntime()).toThrow(/AGENT_RUNTIME_URL/);
  });

  it("does not report a search provider without keys", () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SEARCH_API_KEY;
    expect(searchConfigured()).toBe(false);
  });
});
