"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useWorkspace } from "./workspace";

export function LibraryView() {
  const ws = useWorkspace();
  const [filter, setFilter] = useState<"all" | "high" | "low">("all");
  const reports = ws.reports.filter((report) => {
    if (filter === "high") return report.score >= 70;
    if (filter === "low") return report.score < 70;
    return true;
  });

  return (
    <section className="library-view">
      <header className="view-head">
        <div>
          <p className="eyebrow">报告库</p>
          <h2>你的 AI 推荐情报</h2>
          <p className="lede">所有检测结果都在这里，可以回看、对比、继续追问。</p>
        </div>
        <div className="view-actions">
          <div className="segmented">
            {(["all", "high", "low"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={filter === key ? "is-active" : ""}
                onClick={() => setFilter(key)}
              >
                {key === "all" ? "全部" : key === "high" ? "≥70" : "<70"}
              </button>
            ))}
          </div>
          <button className="primary-btn" type="button" onClick={ws.newConversation}>
            <Plus />
            <span>新建检测</span>
          </button>
        </div>
      </header>

      <div className="report-grid">
        {reports.map((report) => (
          <button
            key={report.id}
            className="report-card"
            type="button"
            onClick={() => ws.openReport(report.id)}
          >
            <div className="report-card-top">
              <div>
                <h3>{report.product || report.brand}</h3>
                <p>{report.competitors.join(" · ")}</p>
              </div>
              <div className="report-score">
                {report.score}
                <span>/100</span>
              </div>
            </div>
            <div className="report-card-foot">
              <span className={`tag ${report.score >= 70 ? "is-ok" : ""}`}>v{report.version}</span>
              <span className="tag">{report.date}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
