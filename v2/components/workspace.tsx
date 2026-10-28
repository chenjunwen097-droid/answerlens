"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { buildReport, parseBrief, seedReports } from "@/lib/data";
import { STAGES, type Brief } from "@/lib/runtime";
import type { ArtifactState, ChatBlock, ChatMessage, Report, Scope } from "@/lib/types";

const STORAGE_KEY = "answerlens.v2.state";

interface WorkspaceValue {
  reports: Report[];
  messages: ChatMessage[];
  scope: Scope;
  artifact: ArtifactState;
  running: boolean;
  stageIndex: number;
  activeReport: Report | null;
  pendingBrief: Brief | null;
  draft: string;
  setDraft: (value: string) => void;
  paletteOpen: boolean;
  send: (text: string) => Promise<void>;
  startRun: (brief: Brief) => Promise<void>;
  openReport: (id: string) => void;
  openLibrary: () => void;
  newConversation: () => void;
  setScope: (scope: Scope) => void;
  closeArtifact: () => void;
  setPaletteOpen: (open: boolean) => void;
  showReportInfo: (report: Report) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}

async function readSse(response: Response, onEvent: (event: Record<string, unknown>) => void) {
  if (!response.body) throw new Error("stream is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = chunk.split("\n").find((item) => item.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
      split = buffer.indexOf("\n\n");
    }
  }
}

const now = () => new Date().toISOString();
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.random().toString(16).slice(2)}`);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [reports, setReports] = useState<Report[]>(seedReports);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({ conversation: [] });
  const [scope, setScope] = useState<Scope>({ type: "conversation" });
  const [artifact, setArtifact] = useState<ArtifactState>({ open: false, mode: "steps", title: "分析进度" });
  const [running, setRunning] = useState(false);
  const [stageIndex, setStageIndex] = useState(-1);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingBrief, setPendingBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState("");
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as {
          reports?: Report[];
          threads?: Record<string, ChatMessage[]>;
          messages?: ChatMessage[];
        };
        if (saved.reports?.length) setReports(saved.reports);
        if (saved.threads) setThreads(saved.threads);
        else if (saved.messages?.length) setThreads({ conversation: saved.messages });
      }
    } catch {
      /* ignore corrupt local state */
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ reports, threads }));
  }, [reports, threads]);

  useEffect(() => {
    const match = pathname?.match(/^\/reports\/([^/]+)/);
    if (match) {
      setScope({ type: "report", reportId: match[1] });
    } else if (pathname === "/reports") {
      setScope({ type: "conversation" });
    } else if (pathname === "/") {
      setScope({ type: "conversation" });
    }
  }, [pathname]);

  const activeReport = useMemo(
    () => (scope.type === "report" ? reports.find((item) => item.id === scope.reportId) || null : null),
    [reports, scope]
  );
  const threadKey = scope.type === "report" ? `report:${scope.reportId}` : "conversation";
  const messages = threads[threadKey] || [];

  const appendMessage = useCallback((key: string, message: ChatMessage) => {
    setThreads((current) => ({ ...current, [key]: [...(current[key] || []), message] }));
  }, []);

  const updateMessage = useCallback(
    (key: string, id: string, updater: (message: ChatMessage) => ChatMessage) => {
      setThreads((current) => ({
        ...current,
        [key]: (current[key] || []).map((message) => (message.id === id ? updater(message) : message))
      }));
    },
    []
  );

  const showReportInfo = useCallback((report: Report) => {
    setArtifact({ open: true, mode: "info", title: "报告信息" });
  }, []);

  const openReport = useCallback(
    (id: string) => {
      const report = reports.find((item) => item.id === id);
      setScope({ type: "report", reportId: id });
      setArtifact({ open: Boolean(report), mode: "info", title: "报告信息" });
      router.push(`/reports/${id}`);
    },
    [reports, router]
  );

  const openLibrary = useCallback(() => {
    setScope({ type: "conversation" });
    setArtifact((current) => ({ ...current, open: false }));
    router.push("/reports");
  }, [router]);

  const newConversation = useCallback(() => {
    setThreads((current) => ({ ...current, conversation: [] }));
    setScope({ type: "conversation" });
    setArtifact((current) => ({ ...current, open: false }));
    router.push("/");
  }, [router]);

  const closeArtifact = useCallback(() => {
    setArtifact((current) => ({ ...current, open: false }));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || running) return;
      const key = scope.type === "report" ? `report:${scope.reportId}` : "conversation";
      const userMessage: ChatMessage = { id: uid(), role: "user", text: value, createdAt: now() };
      const assistantId = uid();
      appendMessage(key, userMessage);
      if (scope.type === "report") {
        setArtifact({ open: true, mode: "chat", title: "报告对话" });
      } else {
        setPendingBrief(parseBrief(value));
      }
      appendMessage(key, { id: assistantId, role: "assistant", text: "", createdAt: now() });

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: value,
            scope,
            report: activeReport
          })
        });
        await readSse(response, (event) => {
          if (event.type === "token") {
            updateMessage(key, assistantId, (message) => ({
              ...message,
              text: message.text + String(event.text || "")
            }));
          }
          if (event.type === "blocks") {
            updateMessage(key, assistantId, (message) => ({
              ...message,
              blocks: event.blocks as ChatBlock[]
            }));
          }
        });
      } catch (error) {
        updateMessage(key, assistantId, (message) => ({
          ...message,
          text: `${message.text}\n\n（服务暂时不可用：${(error as Error).message}）`
        }));
      }
    },
    [activeReport, appendMessage, running, scope, updateMessage]
  );

  const startRun = useCallback(
    async (brief: Brief) => {
      if (running) return;
      setRunning(true);
      setStageIndex(0);
      setArtifact({ open: true, mode: "steps", title: "分析进度" });
      try {
        const response = await fetch("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief })
        });
        const result: { report: Report | null } = { report: null };
        await readSse(response, (event) => {
          if (event.type === "stage") setStageIndex(Number(event.index));
          if (event.type === "report") {
            const incoming = event.report as Report;
            const same = reports.filter(
              (item) => item.brand === incoming.brand && item.product === incoming.product
            );
            result.report = {
              ...incoming,
              version: same.length ? Math.max(...same.map((item) => item.version)) + 1 : 1
            };
            setReports((current) => [result.report!, ...current]);
            setScope({ type: "report", reportId: result.report!.id });
            setArtifact({ open: true, mode: "report", title: "报告摘要" });
          }
          if (event.type === "error") throw new Error(String(event.message));
        });
        if (result.report) {
          appendMessage("conversation", {
            id: uid(),
            role: "assistant",
            text: `报告已经生成：${result.report.brand} 的 AI 推荐表现是 ${result.report.score}/100。右侧可以先看摘要，也可以在这份报告里继续追问。`,
            createdAt: now()
          });
          router.push(`/reports/${result.report.id}`);
        }
      } catch (error) {
        appendMessage("conversation", {
          id: uid(),
          role: "assistant",
          text: `分析失败：${(error as Error).message}`,
          createdAt: now()
        });
      } finally {
        setRunning(false);
      }
    },
    [appendMessage, reports, router, running]
  );

  const value: WorkspaceValue = {
    reports,
    messages,
    scope,
    artifact,
    running,
    stageIndex,
    activeReport,
    pendingBrief,
    draft,
    setDraft,
    paletteOpen,
    send,
    startRun,
    openReport,
    openLibrary,
    newConversation,
    setScope,
    closeArtifact,
    setPaletteOpen,
    showReportInfo
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
