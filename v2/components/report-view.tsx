"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { RichText } from "./rich-text";
import { useWorkspace } from "./workspace";

export function ReportView() {
  const params = useParams<{ id: string }>();
  const ws = useWorkspace();
  const report = ws.reports.find((item) => item.id === params?.id);
  const [tab, setTab] = useState<"overview" | "detail">("overview");
  const [score, setScore] = useState(0);
  const [barsReady, setBarsReady] = useState(false);

  useEffect(() => {
    if (!report) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setScore(report.score);
      setBarsReady(true);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 900);
      const eased = 1 - Math.pow(1 - progress, 3);
      setScore(Math.round(report.score * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const raf = requestAnimationFrame(() => setBarsReady(true));
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(raf);
    };
  }, [report]);

  if (ws.reportsLoading) {
    return (
      <section className="report-view">
        <p className="lede">正在从真实运行时读取报告…</p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="report-view">
        <p className="lede">{ws.reportsError || "这份报告不存在，或者已经被删除。"}</p>
        <button className="primary-btn" type="button" onClick={ws.openLibrary}>
          返回报告库
        </button>
      </section>
    );
  }

  return (
    <section className="report-view">
      <header className="report-head">
        <div className="report-head-main">
          <p className="eyebrow">检测报告</p>
          <h2>{report.product || report.brand} 的 AI 推荐情报</h2>
          <p className="report-meta">
            {report.date} · 2 个模型 · 6 个问题 · v{report.version}
          </p>
        </div>
        <div className="report-head-actions">
          <button className="ghost-btn" type="button" onClick={() => window.print()}>
            <Download />
            <span>导出</span>
          </button>
          <button
            className="primary-btn"
            type="button"
            onClick={() =>
              void ws.startRun({
                brand: report.brand,
                product: report.product,
                competitors: report.competitors,
                score: report.score
              })
            }
          >
            <RefreshCw />
            <span>重跑</span>
          </button>
          <button className="icon-btn report-exit" type="button" aria-label="退出报告" onClick={ws.openLibrary}>
            <X />
          </button>
        </div>
      </header>

      <div className="report-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={tab === "overview" ? "is-active" : ""}
          onClick={() => setTab("overview")}
        >
          总览
        </button>
        <button
          type="button"
          role="tab"
          className={tab === "detail" ? "is-active" : ""}
          onClick={() => setTab("detail")}
        >
          提问明细
        </button>
      </div>

      {tab === "overview" ? (
        <div className="report-panel">
          <section className="score-card">
            <div
              className="score-ring"
              style={{ background: `conic-gradient(var(--orange) 0 ${score}%, #e9e4db ${score}% 100%)` }}
            >
              <div>
                <strong>{score}</strong>
                <span>/ 100</span>
              </div>
            </div>
            <div className="score-copy">
              <p className="kicker">AI 推荐表现</p>
              <h3>{report.headline}</h3>
              <p>{report.summary}</p>
              <div className="metric-row">
                <div>
                  <span>主动推荐率</span>
                  <strong>{report.metrics.recommendRate}%</strong>
                </div>
                <div>
                  <span>首选率</span>
                  <strong>{report.metrics.firstChoiceRate}%</strong>
                </div>
                <div>
                  <span>样本</span>
                  <strong>{report.metrics.samples}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="block">
            <div className="block-head">
              <p className="kicker">竞品对比</p>
              <h3>AI 对产品和竞品的推荐差异</h3>
            </div>
            <div className="bars">
              {report.bars.map((bar) => (
                <div className="bar-row" key={bar.name}>
                  <b>
                    {bar.rank ? `#${bar.rank} ` : ""}
                    {bar.name}
                  </b>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ "--value": barsReady ? `${bar.value}%` : "0%" } as React.CSSProperties}
                    />
                  </div>
                  <strong>{bar.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <div className="split">
            <section className="block">
              <div className="block-head">
                <p className="kicker">定位判断</p>
                <h3>AI 如何理解你的产品</h3>
              </div>
              <div className="positioning">
                {report.positioning.map((item) => (
                  <div key={item.label}>
                    <span>{item.label}</span>
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="block">
              <div className="block-head">
                <p className="kicker">行动建议</p>
                <h3>最值得做的 3 件事</h3>
              </div>
              <ol className="actions">
                {report.actions.map((action, index) => (
                  <li key={action.title}>
                    <i>0{index + 1}</i>
                    <div>
                      <strong>{action.title}</strong>
                      <span>{action.why}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      ) : (
        <div className="report-panel">
          <div className="detail-list">
            {report.questions.map((question, index) => (
              <details className="detail-item" key={question.q} open={index === 0}>
                <summary>
                  <span className="detail-index">0{index + 1}</span>
                  <strong>{question.q}</strong>
                  <em>{question.score}</em>
                </summary>
                <div className="detail-body">
                  <div className="answer">
                    <b>DeepSeek Flash</b>
                    <RichText>{question.deepseek}</RichText>
                  </div>
                  <div className="answer">
                    <b>GLM 4.6v</b>
                    <RichText>{question.glm}</RichText>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
