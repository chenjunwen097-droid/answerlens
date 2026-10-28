"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, Coffee, CupSoda, ListChecks, Smartphone, Sparkles } from "lucide-react";
import { parseBrief } from "@/lib/data";
import type { ChatBlock } from "@/lib/types";
import { useWorkspace } from "./workspace";

const SUGGESTIONS = [
  {
    icon: Smartphone,
    text: "对比小米 14 和 iPhone 17 Pro 在屏幕体验上的差异，重点看护眼和户外亮度"
  },
  { icon: Coffee, text: "分析瑞幸和库迪的生椰拿铁，在口感和性价比上用户会怎么选" },
  { icon: CupSoda, text: "帮我看看喜茶和林里在清爽果茶这个场景里的 AI 推荐表现" }
];

export function ChatView() {
  const ws = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [ws.messages]);

  const startFromPlan = () => {
    const lastUser = [...ws.messages].reverse().find((message) => message.role === "user");
    void ws.startRun(ws.pendingBrief ?? parseBrief(lastUser?.text || ""));
  };

  return (
    <section className="chat-view">
      <div className="chat-scroll" ref={scrollRef}>
        {ws.messages.length === 0 ? (
          <div className="empty-state">
            <p className="eyebrow">
              <Sparkles /> AI 推荐情报
            </p>
            <h1>
              让 AI 告诉你，
              <br />
              它怎么推荐你的产品
            </h1>
            <p className="lede">
              描述你的产品、型号和竞品，或者直接问一个关于报告的问题。剩下的交给 AnswerLens。
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map(({ icon: Icon, text }) => (
                <button key={text} type="button" onClick={() => ws.setDraft(text)}>
                  <Icon />
                  <span>{text}</span>
                </button>
              ))}
            </div>
            <div className="recent-strip">
              <div className="recent-strip-head">
                <span>最近报告</span>
                <button className="link-btn" type="button" onClick={ws.openLibrary}>
                  全部报告 <ArrowRight />
                </button>
              </div>
              <div className="mini-reports">
                {ws.reports.slice(0, 3).map((report) => (
                  <button
                    key={report.id}
                    className="mini-report"
                    type="button"
                    onClick={() => ws.openReport(report.id)}
                  >
                    <span>{report.product || report.brand}</span>
                    <b>{report.score}</b>
                    <span>{report.date}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="thread">
            {ws.messages.map((message) => (
              <div key={message.id} className={`msg ${message.role === "user" ? "is-user" : ""}`}>
                <div className="msg-body">{message.text || (message.role === "assistant" ? "…" : "")}</div>
                {message.blocks?.map((block, index) => (
                  <BlockView key={index} block={block} onStart={startFromPlan} />
                ))}
                <span className="msg-time">刚刚</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BlockView({ block, onStart }: { block: ChatBlock; onStart: () => void }) {
  if (block.type === "text") return <div className="msg-card">{block.text}</div>;
  if (block.type === "metric") {
    return (
      <div className="msg-card">
        <span className="artifact-kicker">{block.label}</span>
        <strong>{block.value}</strong>
        {block.note && <p>{block.note}</p>}
      </div>
    );
  }
  return (
    <div className="msg-card">
      <div className="msg-card-head">
        <ListChecks />
        {block.title}
      </div>
      {block.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {block.action?.key === "start-analysis" && (
        <div className="msg-card-actions">
          <button className="primary-btn" type="button" onClick={onStart}>
            {block.action.label}
          </button>
        </div>
      )}
    </div>
  );
}
