/** Customer-facing Chinese labels for internal enums and skill ids. */

export const AGENT_TASK_LABELS: Record<string, string> = {
  "research.trend_analysis": "研究趋势分析",
  "research.generate_hypothesis": "生成研究想法",
  "code.search_github": "GitHub 代码检索",
  "writing.draft_section": "写作起草",
  "experiment.autonomous_run": "自主实验",
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  planning: "规划中",
  awaiting_approval: "待确认",
  completed: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  stopped: "已停止",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

export const EXPERIMENT_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  scaffolded: "项目已就绪",
  generated: "代码已生成",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  smoke_failed: "自检失败",
};

export const JOB_KIND_LABELS: Record<string, string> = {
  literature_search: "文献检索",
  literature_recommend: "相似文献推荐",
  paper_download: "论文下载",
  paper_parse: "解析论文 PDF",
  translate: "翻译",
  reading_note: "阅读笔记",
  latex_compile: "LaTeX 编译",
  benchmark_search: "查找数据集基准",
  writing_init: "写作初始化",
  agent_task: "智能助手任务",
};

export const EVENT_KIND_LABELS: Record<string, string> = {
  step: "进度",
  info: "信息",
  warning: "提示",
  error: "错误",
  approval: "待确认",
  result: "结果",
  done: "完成",
};

export const ACTION_TYPE_LABELS: Record<string, string> = {
  run_command: "执行命令",
  write_file: "写入文件",
  delete_file: "删除文件",
  network: "网络请求",
  install: "安装依赖",
};

export function agentTaskLabel(taskType: string | null | undefined): string {
  if (!taskType) return "智能任务";
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

export function experimentStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return EXPERIMENT_STATUS_LABELS[status] || status;
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
