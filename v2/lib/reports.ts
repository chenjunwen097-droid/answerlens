import type { Report } from "./types";

export function parseReportsPayload(payload: unknown): Report[] {
  if (!payload || typeof payload !== "object" || !("reports" in payload)) {
    throw new Error("报告接口返回格式不正确");
  }
  const reports = (payload as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) throw new Error("报告接口没有返回报告列表");
  return reports.filter(isReport);
}

function isReport(value: unknown): value is Report {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<Report>;
  return (
    typeof report.id === "string" &&
    typeof report.brand === "string" &&
    Array.isArray(report.competitors) &&
    typeof report.score === "number" &&
    Array.isArray(report.questions)
  );
}
