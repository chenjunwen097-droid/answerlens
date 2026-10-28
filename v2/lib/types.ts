export type ReportStatus = "running" | "complete" | "failed";

export interface ReportQuestion {
  q: string;
  score: number;
  deepseek: string;
  glm: string;
}

export interface ReportBar {
  name: string;
  value: number;
  rank: number | null;
}

export interface Report {
  id: string;
  brand: string;
  product?: string;
  competitors: string[];
  score: number;
  date: string;
  version: number;
  status: ReportStatus;
  headline: string;
  summary: string;
  metrics: { recommendRate: number; firstChoiceRate: number; samples: number };
  bars: ReportBar[];
  positioning: { label: string; text: string }[];
  actions: { title: string; why: string }[];
  questions: ReportQuestion[];
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "plan"; title: string; lines: string[]; action?: { key: string; label: string } }
  | { type: "metric"; label: string; value: string; note?: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  blocks?: ChatBlock[];
  createdAt: string;
}

export type Scope = { type: "conversation" } | { type: "report"; reportId: string };

export type ArtifactMode = "steps" | "report" | "info" | "chat";

export interface ArtifactState {
  open: boolean;
  mode: ArtifactMode;
  title: string;
}

export interface RunStageEvent {
  stage: string;
  index: number;
  total: number;
  label: string;
}

export interface ReportReadyEvent {
  report: Report;
}
