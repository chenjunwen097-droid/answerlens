"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileText,
  ImagePlus,
  Library,
  Menu,
  MessageCircle,
  MessageSquareText,
  PanelLeftClose,
  Search,
  Settings,
  Share2,
  Sparkles,
  SquarePen,
  Tags,
  X
} from "lucide-react";
import { STAGES } from "@/lib/runtime";
import type { Report } from "@/lib/types";
import { RichText } from "./rich-text";
import { useWorkspace } from "./workspace";

export function AppShell({ children }: { children: React.ReactNode }) {
  const ws = useWorkspace();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  return (
    <div
      className={`app ${ws.artifact.open ? "has-artifact" : ""} ${
        collapsed ? "rail-collapsed" : ""
      } ${railOpen ? "rail-open" : ""}`}
    >
      <aside className="rail">
        <div className="rail-head">
          <Link className="brand" href="/" aria-label="AnswerLens">
            <span className="brand-mark">A</span>
            <span className="brand-text">
              <strong>AnswerLens</strong>
              <small>AI 推荐情报</small>
            </span>
          </Link>
          <button
            className="icon-btn"
            aria-label="收起侧栏"
            title="收起侧栏"
            onClick={() => setCollapsed((value) => !value)}
          >
            <PanelLeftClose />
          </button>
        </div>

        <button className="new-chat" onClick={ws.newConversation} type="button">
          <SquarePen />
          <span>新建对话</span>
          <kbd>⌘K</kbd>
        </button>

        <nav className="rail-nav" aria-label="主导航">
          <Link
            className={`rail-item ${pathname === "/" ? "is-active" : ""}`}
            href="/"
            onClick={() => setRailOpen(false)}
          >
            <MessageSquareText />
            <span>会话</span>
          </Link>
          <Link
            className={`rail-item ${pathname.startsWith("/reports") ? "is-active" : ""}`}
            href="/reports"
            onClick={() => setRailOpen(false)}
          >
            <Library />
            <span>报告库</span>
            <em>{ws.reports.length}</em>
          </Link>
          <button className="rail-item" type="button" disabled title="即将推出">
            <Tags />
            <span>品牌与竞品</span>
          </button>
        </nav>

        <div className="rail-recent">
          <p className="rail-label">最近</p>
          {ws.reports.slice(0, 3).map((report, index) => (
            <button
              key={report.id}
              className={`recent-item ${index === 0 ? "is-active" : ""}`}
              type="button"
              onClick={() => ws.openReport(report.id)}
            >
              <span>
                {report.product || report.brand} · v{report.version}
              </span>
              <small>{report.date}</small>
            </button>
          ))}
        </div>

        <div className="rail-foot">
          <span className="avatar">陈</span>
          <div>
            <strong>陈俊文</strong>
            <small>个人空间</small>
          </div>
          <button className="icon-btn" type="button" aria-label="设置" title="设置">
            <Settings />
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <Crumbs pathname={pathname} activeReport={ws.activeReport} />
          <div className="top-actions">
            <button
              className="icon-btn"
              type="button"
              aria-label="打开导航"
              onClick={() => setRailOpen((value) => !value)}
            >
              <Menu />
            </button>
            <button
              className="icon-btn"
              type="button"
              aria-label="搜索"
              title="搜索"
              onClick={() => ws.setPaletteOpen(true)}
            >
              <Search />
            </button>
            <button className="ghost-btn" type="button" onClick={() => alert("分享链接将在 v2.1 开放")}>
              <Share2 />
              <span>分享</span>
            </button>
          </div>
        </header>

        <div className="stage">
          <div className="stage-body">{children}</div>
          <Composer />
        </div>
      </main>

      {ws.artifact.open && <ArtifactPanel />}
      {ws.paletteOpen && <CommandPalette />}
    </div>
  );
}

function Crumbs({ pathname, activeReport }: { pathname: string | null; activeReport: Report | null }) {
  if (pathname?.startsWith("/reports") && activeReport) {
    return (
      <div className="crumbs">
        <span>报告库</span>
        <ChevronRight />
        <strong>{activeReport.product || activeReport.brand}</strong>
      </div>
    );
  }
  if (pathname === "/reports") {
    return (
      <div className="crumbs">
        <span>工作区</span>
        <ChevronRight />
        <strong>报告库</strong>
      </div>
    );
  }
  return (
    <div className="crumbs">
      <span>会话</span>
      <ChevronRight />
      <strong>新对话</strong>
    </div>
  );
}

function Composer() {
  const ws = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scope = ws.activeReport;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, [ws.draft]);

  const submit = async () => {
    const value = ws.draft.trim();
    if (!value || ws.running) return;
    ws.setDraft("");
    setMenuOpen(false);
    await ws.send(value);
  };

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="composer-top">
          <button
            className="scope-chip"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MessageCircle />
            <span>{ws.scope.type === "report" && scope ? `报告 · ${scope.product || scope.brand}` : "新对话"}</span>
            <ChevronDown className="chev" />
          </button>
          <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
        </div>
        <div className="composer-row">
          <button className="icon-btn" type="button" aria-label="添加图片" title="添加图片">
            <ImagePlus />
          </button>
          <textarea
            ref={inputRef}
            id="input"
            rows={1}
            value={ws.draft}
            placeholder={
              scope
                ? `问这份报告：${scope.product || scope.brand} 的任何问题…`
                : "描述你的产品和竞品，或直接问一个关于报告的问题…"
            }
            onChange={(event) => ws.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button className="send-btn" type="submit" id="sendBtn" aria-label="发送" disabled={!ws.draft.trim() || ws.running}>
            <ArrowUp />
          </button>
        </div>
        {menuOpen && (
          <div className="scope-menu" role="menu">
            <button
              type="button"
              className={ws.scope.type === "conversation" ? "is-active" : ""}
              onClick={() => {
                ws.newConversation();
                setMenuOpen(false);
              }}
            >
              <MessageCircle />
              <span>新对话</span>
              <small>全局助手</small>
            </button>
            {ws.reports.slice(0, 5).map((report) => (
              <button
                key={report.id}
                type="button"
                className={ws.scope.type === "report" && ws.scope.reportId === report.id ? "is-active" : ""}
                onClick={() => {
                  ws.openReport(report.id);
                  setMenuOpen(false);
                }}
              >
                <FileText />
                <span>报告 · {report.product || report.brand}</span>
                <small>v{report.version}</small>
              </button>
            ))}
          </div>
        )}
      </form>
      <p className="disclaimer">AI 可能出错，报告中的每条结论都可以追溯到原始回答。</p>
    </div>
  );
}

function ArtifactPanel() {
  const ws = useWorkspace();
  const report = ws.activeReport;
  return (
    <aside className="artifact" aria-label="上下文面板">
      <header className="artifact-head">
        <div className="artifact-title">
          <FileText />
          <strong>{ws.artifact.title}</strong>
        </div>
        <button className="icon-btn" type="button" aria-label="关闭面板" onClick={ws.closeArtifact}>
          <X />
        </button>
      </header>
      <div className="artifact-body">
        {ws.artifact.mode === "steps" && (
          <div className="step-list">
            {STAGES.map((stage, index) => (
              <div
                key={stage.stage}
                className={`step ${index < ws.stageIndex ? "is-done" : index === ws.stageIndex ? "is-running" : ""}`}
              >
                <span className="step-dot">{index < ws.stageIndex ? "✓" : index + 1}</span>
                <div>
                  <strong>{stage.label}</strong>
                  <p>{stage.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {ws.artifact.mode === "report" && report && (
          <div className="artifact-report">
            <div className="artifact-score">
              <strong>{report.score}</strong>
              <span> / 100</span>
              <p>{report.summary}</p>
            </div>
            <div className="artifact-list">
              <button type="button" onClick={() => ws.openReport(report.id)}>
                查看完整报告
                <span>6 题 · 12 答</span>
              </button>
            </div>
          </div>
        )}

        {ws.artifact.mode === "info" && report && (
          <div className="artifact-report">
            <p className="artifact-kicker">元数据</p>
            <div className="artifact-list">
              <button type="button" disabled>
                模型 <span>DeepSeek Flash · GLM 4.6v</span>
              </button>
              <button type="button" disabled>
                版本 <span>v{report.version}</span>
              </button>
              <button type="button" disabled>
                检测时间 <span>{report.date}</span>
              </button>
              <button type="button" disabled>
                问题 <span>{report.questions.length} 题 · 12 条回答</span>
              </button>
            </div>
            <p className="artifact-hint">在下方输入框直接提问这份报告。</p>
          </div>
        )}

        {ws.artifact.mode === "chat" && report && (
          <div className="artifact-chat">
            <div className="artifact-chat-head">
              <span>
                {report.product || report.brand} · v{report.version}
              </span>
              <button
                className="link-btn"
                type="button"
                onClick={() => ws.showReportInfo(report)}
              >
                返回报告
              </button>
            </div>
            <div className="artifact-chat-list">
              {ws.messages.length === 0 && (
                <div className="artifact-empty">在这份报告里直接提问，例如「第 2 题为什么得分低？」</div>
              )}
              {ws.messages.map((message) => (
                <div key={message.id} className={`artifact-msg ${message.role === "user" ? "is-user" : ""}`}>
                  <span>{message.role === "user" ? "你" : "AnswerLens"}</span>
                  <div>
                    <RichText>{message.text || "正在查看这份报告的证据…"}</RichText>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function CommandPalette() {
  const ws = useWorkspace();
  const [query, setQuery] = useState("");
  const actions = useMemo(
    () => [
      { label: "新建对话", hint: "会话", run: ws.newConversation },
      { label: "打开报告库", hint: "导航", run: ws.openLibrary },
      ...ws.reports.slice(0, 6).map((report) => ({
        label: `打开报告 · ${report.product || report.brand}`,
        hint: `v${report.version}`,
        run: () => ws.openReport(report.id)
      }))
    ],
    [ws]
  );
  const items = actions.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") ws.setPaletteOpen(false);
      if (event.key === "Enter" && items[0]) {
        ws.setPaletteOpen(false);
        items[0].run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, ws]);

  return (
    <div className="palette" onClick={(event) => event.target === event.currentTarget && ws.setPaletteOpen(false)}>
      <div className="palette-shell">
        <div className="palette-input">
          <Search />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话、报告或操作…" />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                ws.setPaletteOpen(false);
                item.run();
              }}
            >
              <Sparkles />
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

