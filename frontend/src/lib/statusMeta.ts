// Single source of truth for status → presentation across the whole app.
//
// Vocabularies mirror the backend (backend/app/experiments/states.py and
// db/models.py); labels reuse the backend's own Chinese wording
// (EXPERIMENT_STATUS_ZH / STAGE_STATUS_ZH) so server-rendered and
// client-rendered labels never drift apart.
//
// Usage:
//   import { statusMeta, decisionMeta, type Tone } from "@/lib/statusMeta";
//   const m = statusMeta(exp.overall_status);  // { label, tone, spinning }

export type Tone = "green" | "red" | "blue" | "amber" | "slate" | "violet";

export interface StatusMeta {
  /** Chinese, user-facing. */
  label: string;
  tone: Tone;
  /** True when the status represents in-flight work — StatusBadge shows a spinner. */
  spinning?: boolean;
}

/** Every status value the backend can emit, across all domains. Unknown
 *  values fall back to a neutral slate badge showing the raw status. */
const TABLE: Record<string, StatusMeta> = {
  // --- Experiment overall_status (states.py ExpStatus / EXPERIMENT_STATUS_ZH) ---
  draft: { label: "草稿", tone: "slate" },
  running: { label: "正在进行", tone: "blue", spinning: true },
  paused: { label: "已暂停", tone: "amber" },
  waiting_user: { label: "等待你的确认", tone: "amber" },
  completed: { label: "已完成", tone: "green" },
  failed: { label: "需要处理", tone: "red" },
  archived: { label: "已归档", tone: "slate" },

  // --- Stage status (states.py StageStatus / STAGE_STATUS_ZH) ---
  not_started: { label: "未开始", tone: "slate" },
  waiting_for_user: { label: "等待决策", tone: "amber" },
  approved: { label: "已通过", tone: "green" },
  needs_revision: { label: "需要修改", tone: "amber" },
  skipped: { label: "已跳过", tone: "slate" },
  outdated: { label: "已失效", tone: "slate" },

  // --- AgentTask status (db/models.py AgentTask) ---
  pending: { label: "排队中", tone: "slate" },
  planning: { label: "规划中", tone: "blue", spinning: true },
  awaiting_approval: { label: "等待审批", tone: "amber" },
  rejected: { label: "已拒绝", tone: "red" },

  // --- ExperimentRun status ---
  created: { label: "已创建", tone: "slate" },
  stopped: { label: "已停止", tone: "amber" },

  // --- Job status (global sidebar jobs) ---
  done: { label: "完成", tone: "green" },

  // --- Repository official_status ---
  unverified: { label: "未验证", tone: "slate" },
  verified: { label: "已验证", tone: "green" },

  // --- Idea status ---
  candidate: { label: "候选", tone: "violet" },
  backlog: { label: "待评估", tone: "slate" },
  hypothesis: { label: "假设验证", tone: "blue" },
  decision: { label: "已采纳", tone: "green" },

  // --- Paper parse_status (backend actually emits "success"; "none" = never parsed) ---
  parsed: { label: "已解析", tone: "green" },
  parsing: { label: "解析中", tone: "blue", spinning: true },
  parse_failed: { label: "解析失败", tone: "red" },
  success: { label: "已解析", tone: "green" },
  none: { label: "未解析", tone: "slate" },
};

export function statusMeta(status: string | null | undefined): StatusMeta {
  if (!status) return { label: "—", tone: "slate" };
  return TABLE[status] ?? { label: status, tone: "slate" };
}

// --- Checkpoint decisions (orchestrator._apply_decision) -------------------

export interface DecisionMeta {
  label: string;
  tone: Tone;
}

const DECISIONS: Record<string, DecisionMeta> = {
  approve: { label: "批准", tone: "green" },
  edit: { label: "修改后继续", tone: "amber" },
  skip: { label: "跳过", tone: "slate" },
  abort: { label: "终止", tone: "red" },
  // legacy values that may appear in decision history payloads
  approved: { label: "批准", tone: "green" },
  rejected: { label: "拒绝", tone: "red" },
};

export function decisionMeta(decision: string | null | undefined): DecisionMeta {
  if (!decision) return { label: "—", tone: "slate" };
  return DECISIONS[decision] ?? { label: decision, tone: "slate" };
}

// --- Repository source kind (GitHub officiality judgement) -----------------

const REPO_SOURCES: Record<string, StatusMeta> = {
  official: { label: "官方", tone: "green" },
  author_affiliated: { label: "作者关联", tone: "blue" },
  community: { label: "社区", tone: "amber" },
};

export function repoSourceMeta(source: string | null | undefined): StatusMeta {
  if (!source) return { label: "—", tone: "slate" };
  return REPO_SOURCES[source] ?? { label: source, tone: "slate" };
}

/** Hex per tone — for contexts that can't take Tailwind classes (charts,
 *  inline styles). Values mirror the Tailwind palette used in TONE_CLASSES. */
export const TONE_HEX: Record<Tone, string> = {
  green: "#059669",
  red: "#DC2626",
  blue: "#2563EB",
  amber: "#D97706",
  slate: "#64748B",
  violet: "#7C3AED",
};

/** Tailwind class pairs per tone — the ONLY place status colors are defined.
 *  Includes both soft (badge) and solid (button/dot) variants. Dot shades
 *  match TONE_HEX (both are the -600 stops) so badges and chart series are
 *  pixel-identical hues. */
export const TONE_CLASSES: Record<
  Tone,
  { soft: string; dot: string; text: string; border: string }
> = {
  green: {
    soft: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    dot: "bg-emerald-600",
    text: "text-emerald-700",
    border: "border-emerald-200",
  },
  red: {
    soft: "bg-red-50 text-red-700 border border-red-200",
    dot: "bg-red-600",
    text: "text-red-700",
    border: "border-red-200",
  },
  blue: {
    soft: "bg-blue-50 text-blue-700 border border-blue-200",
    dot: "bg-blue-600",
    text: "text-blue-700",
    border: "border-blue-200",
  },
  amber: {
    soft: "bg-amber-50 text-amber-700 border border-amber-200",
    dot: "bg-amber-600",
    text: "text-amber-700",
    border: "border-amber-200",
  },
  slate: {
    soft: "bg-slate-100 text-slate-600 border border-slate-200",
    dot: "bg-slate-500",
    text: "text-slate-600",
    border: "border-slate-200",
  },
  violet: {
    soft: "bg-violet-50 text-violet-700 border border-violet-200",
    dot: "bg-violet-600",
    text: "text-violet-700",
    border: "border-violet-200",
  },
};
