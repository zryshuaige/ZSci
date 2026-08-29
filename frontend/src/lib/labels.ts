/**
 * Customer-facing Chinese labels for internal enums and skill ids.
 *
 * Iteration 4 — aligned with backend `STAGE_STATUS_ZH` / `EXPERIMENT_STATUS_ZH`
 * (single source of truth lives in `backend/app/experiments/states.py`).
 *
 * The page-level helpers (`experimentStatusLabel`, `stageStatusLabel`,
 * `phaseLabel`) live in `lib/stageLabels.ts` and hydrate from
 * `/api/v1/experiments/phase-view`; the helpers here are kept for
 * component-level labels (event kinds, action types, run statuses)
 * that don't go through that endpoint.
 */

import { stageKeyZh } from "@/lib/eventHumanize";

/** Internal skill ids used in agent task titles — translated to natural
 *  Chinese so the UI never shows raw enum strings. */
export const AGENT_TASK_LABELS: Record<string, string> = {
  "research.trend_analysis": "研究趋势分析",
  "research.generate_hypothesis": "整理研究想法",
  "research.generate_hypothesis_candidates": "整理候选研究方向",
  "code.search_github": "GitHub 代码检索",
  "writing.draft_section": "写作起草",
  "experiment.autonomous_run": "自动化实验流程",
};

/** Agent task / job statuses. */
export const AGENT_STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  planning: "规划中",
  awaiting_approval: "待确认",
  completed: "已完成",
  failed: "需要处理",
  rejected: "已拒绝",
  stopped: "已停止",
};

/** Run statuses shown next to manual command runs. */
export const RUN_STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  running: "运行中",
  completed: "已完成",
  failed: "需要处理",
  stopped: "已停止",
};

/** Legacy alias — kept because some pages still import
 *  `EXPERIMENT_STATUS_LABELS` directly (only the new 7-key set is
 *  authoritative; the page-level `experimentStatusLabel` in stageLabels
 *  should be preferred). */
export const EXPERIMENT_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  running: "正在进行",
  paused: "已暂停",
  waiting_user: "等待你的确认",
  completed: "已完成",
  failed: "需要处理",
  archived: "已归档",
};

export const JOB_KIND_LABELS: Record<string, string> = {
  literature_search: "文献检索",
  literature_recommend: "相似文献推荐",
  paper_download: "论文下载",
  paper_parse: "解析论文 PDF",
  translate: "翻译",
  reading_note: "阅读笔记",
  latex_compile: "LaTeX 编译",
  benchmark_search: "查找数据集与基线",
  writing_init: "创建写作框架",
  agent_task: "研究辅助任务",
};

export const EVENT_KIND_LABELS: Record<string, string> = {
  step: "进度",
  info: "信息",
  warning: "提示",
  error: "需要处理",
  approval: "等待你的确认",
  result: "结果",
  done: "已完成",
};

export const ACTION_TYPE_LABELS: Record<string, string> = {
  run_command: "运行分析程序",
  write_file: "保存文件",
  delete_file: "移除文件",
  network: "访问在线资源",
  install: "准备运行环境",
};

/** Stage status — covers the same 12 keys as `STAGE_STATUS_ZH`. Used as
 *  a fallback for places that don't go through `usePhaseView()`. */
export const STAGE_STATUS_LABELS: Record<string, string> = {
  not_started: "尚未开始",
  draft: "草稿",
  waiting_for_user: "等待你的确认",
  approved: "已通过",
  running: "正在进行",
  paused: "已暂停",
  completed: "已完成",
  failed: "需要处理",
  needs_revision: "需要修改",
  skipped: "已跳过",
  outdated: "需要重新验证",
  archived: "已归档",
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function agentTaskLabel(taskType: string | null | undefined): string {
  if (!taskType) return "研究辅助任务";
  return AGENT_TASK_LABELS[taskType] || "后台任务";
}

export function agentStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return AGENT_STATUS_LABELS[status] || status;
}

export function runStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return RUN_STATUS_LABELS[status] || status;
}

/** Prefer `experimentStatusLabel` from `@/lib/stageLabels` (which
 *  hydrates from the backend) over this fallback-only helper. */
export function experimentStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return EXPERIMENT_STATUS_LABELS[status] || status;
}

export function stageStatusLabelFallback(status: string | null | undefined): string {
  if (!status) return "";
  return STAGE_STATUS_LABELS[status] || status;
}

export function jobKindLabel(kind: string | null | undefined): string {
  if (!kind) return "后台任务";
  return JOB_KIND_LABELS[kind] || "后台任务";
}

export function eventKindLabel(kind: string | null | undefined): string {
  if (!kind) return "";
  return EVENT_KIND_LABELS[kind] || kind;
}

export function actionTypeLabel(action: string | null | undefined): string {
  if (!action) return "操作";
  // 实验阶段审批的动作形如 experiment.stage.phase_0_scope —— 译成
  // 「实验阶段确认:需求与基准」,而不是把内部动作串直接糊给用户。
  if (action.startsWith("experiment.stage.")) {
    return `实验阶段确认:${stageKeyZh(action.slice("experiment.stage.".length))}`;
  }
  return ACTION_TYPE_LABELS[action] || action;
}

/** Prefer a clean Chinese job title; strip raw skill ids from Agent titles. */
export function jobDisplayTitle(title: string | null | undefined, kind: string | null | undefined): string {
  if (kind === "agent_task" && title) {
    const m = title.match(/^Agent:\s*(.+)$/i);
    if (m) return agentTaskLabel(m[1].trim());
  }
  if (title && !/^[a-z]+(\.[a-z_]+)+$/i.test(title) && !title.startsWith("Agent:")) {
    return title;
  }
  return jobKindLabel(kind);
}