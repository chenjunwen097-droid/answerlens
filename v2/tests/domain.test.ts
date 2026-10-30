import { describe, expect, it } from "vitest";
import { parseReportsPayload } from "../lib/reports";
import { getRuntime } from "../lib/runtime";
import { searchConfigured } from "../lib/search";

describe("report domain", () => {
  it("accepts only report-shaped rows from the runtime response", () => {
    const reports = parseReportsPayload({
      reports: [
        {
          id: "test-report",
          brand: "品牌",
          competitors: ["竞品"],
          score: 50,
          questions: []
        },
        { id: "broken" }
      ]
    });
    expect(reports.map((report) => report.id)).toEqual(["test-report"]);
  });

  it("rejects a malformed report payload", () => {
    expect(() => parseReportsPayload({ rows: [] })).toThrow(/格式/);
    expect(() => parseReportsPayload({ reports: null })).toThrow(/报告列表/);
  });
});

describe("runtime and providers", () => {
  it("requires a runtime URL instead of falling back to mock data", () => {
    delete process.env.AGENT_RUNTIME_URL;
    expect(() => getRuntime()).toThrow(/AGENT_RUNTIME_URL/);
  });

  it("does not report a search provider without keys", () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(searchConfigured()).toBe(false);
  });
});
