import { useState } from "react";
import {
  Check, Pencil, SkipForward, Square,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/Button";
import { TONE_CLASSES } from "@/lib/statusMeta";
import type { ExperimentStage } from "@/lib/api";

/** The 4 checkpoint decisions surfaced to the user (mirrors the narrowed
 *  `ExperimentStageDecision.decision` Literal in app/schemas.py). The
 *  legacy 'fork_from_stage' / 'select_resume_point' / 'redo' decisions
 *  are intentionally NOT exposed here — the backend keeps the fork
 *  capability but the UI doesn't surface it. */
type Decision = "approve" | "edit" | "skip" | "abort";

interface CheckpointCardProps {
  stage: ExperimentStage;
  onDecide: (decision: Decision, payload?: Record<string, unknown>) => void;
  busy?: boolean;
}

/** Ordered list of summary keys we know how to render nicely. Anything not
 *  in this list is shown raw in a <details> fold so the user still sees it.
 *  Exported so the detail drawer's stage tab renders with the same labels. */
export const KNOWN_KEYS = [
  "title", "goal", "research_question", "hypothesis", "checklist",
  "metrics", "baselines", "run_specs", "datasets", "tasks", "sota",
  "ai_judgement", "recommendation", "fairness_note", "compute_plan",
  "files_written", "run_command", "smoke_command", "official_code_note",
  "best_run", "best_metric", "vs_sota", "stability", "fairness",
  "report_path", "preview", "passed", "attempts", "probe",
  "disk_free_gb", "config_present", "warnings", "risks",
  "query", "counts",
] as const;

export const LABEL_ZH: Record<string, string> = {
  title: "本阶段结论",
  goal: "研究目标",
  research_question: "研究问题",
  hypothesis: "研究假设",
  checklist: "核查要点",
  metrics: "拟跟踪的指标",
  baselines: "可对照方法",
  run_specs: "实验配置",
  datasets: "数据集",
  tasks: "评测任务",
  sota: "已有最优结果",
  ai_judgement: "系统评估",
  recommendation: "建议方向",
  fairness_note: "对照与公平性说明",
  compute_plan: "算力使用计划",
  files_written: "已写入文件",
  run_command: "运行命令",
  smoke_command: "快速运行检查",
  official_code_note: "官方代码说明",
  best_run: "最佳实验记录",
  best_metric: "最佳指标",
  vs_sota: "与已有结果对比",
  stability: "稳定性",
  fairness: "公平性",
  report_path: "报告路径",
  preview: "报告预览",
  passed: "是否通过",
  attempts: "尝试次数",
  probe: "环境探测",
  disk_free_gb: "可用磁盘(GB)",
  config_present: "配置存在",
  warnings: "需关注的告警",
  risks: "已知风险",
  query: "检索关键词",
  counts: "候选数量",
};

/** 领域里常见的内部命名 → 人话;未命中的 id 由 humanizeTerm 兜底。 */
const TERM_ZH: Record<string, string> = {
  text_only: "仅文本（单模态基线）",
  table_only: "仅表格（单模态基线）",
  image_only: "仅图像（单模态基线）",
  audio_only: "仅音频（单模态基线）",
  baseline: "基础基线",
  no_aug: "无数据增强",
  concat_late_fusion: "晚期拼接融合",
  early_fusion: "早期融合",
  late_fusion: "晚期融合",
  multimodal_shared_space: "多模态共享空间（本方案）",
};

/** 把内部命名风格的取值翻成人话:已知词典优先;纯 snake_case id 把
 *  下划线转成空格。普通句子（含空格/标点/中文）原样返回,不受影响。 */
export function humanizeTerm(value: string): string {
  const v = value.trim();
  const direct = TERM_ZH[v];
  if (direct) return direct;
  if (/^[a-z][a-z0-9_]*$/.test(v) && v.includes("_")) {
    return v.replace(/_/g, " ");
  }
  return value;
}

/** 字段的一句话说明 —— 让「可对照方法」「拟跟踪的指标」这类标签
 *  自解释,研究者不必猜术语。 */
export const FIELD_HINTS: Record<string, string> = {
  goal: "这一步要回答的问题",
  research_question: "整个实验要验证的核心问题",
  hypothesis: "预期会出现的现象，实验就是来检验它的",
  metrics: "判断实验是否成功的量化标准",
  baselines: "用于对比的简化版本，证明每个模块都有贡献",
  run_specs: "实际要运行的每一组配置",
  fairness_note: "保证对比公平的说明",
  compute_plan: "预计消耗的算力与时长",
  checklist: "启动前的自检结果",
  recommendation: "系统建议",
  datasets: "为本研究检索到的公开数据集",
  tasks: "为本研究检索到的评测任务",
  sota: "已有最优方法的成绩，用来设定目标",
  query: "用于检索基准的关键词",
  counts: "各类候选的数量",
  files_written: "已写入工作区的文件",
  run_command: "正式实验的运行命令",
};

/** Render one summary value as a compact, readable cell. Lists -> bullets,
 *  booleans -> green/red dot, objects -> a <pre> JSON block. */
export function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/60">—</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className={value ? TONE_CLASSES.green.text : TONE_CLASSES.red.text}>
        {value ? "通过" : "未通过"}
      </span>
    );
  }
  if (typeof value === "string" || typeof value === "number") {
    const text = typeof value === "string" ? humanizeTerm(value) : String(value);
    return <span className="break-words whitespace-pre-wrap">{text}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground/60">—</span>;
    // [标签, 布尔] 对（如 checklist 的「研究问题清晰, true」）→ 单行结论。
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "boolean"
    ) {
      return (
        <span>
          {value[0]}
          <span className={value[1] ? TONE_CLASSES.green.text : TONE_CLASSES.red.text}>
            （{value[1] ? "通过" : "未通过"}）
          </span>
        </span>
      );
    }
    // Array of {name: ...} objects — 指标带 definition、基准行带指标值,
    // 一并渲染出来(此前 definition 被直接丢弃,用户只剩一个裸指标名)。
    if (value.every((v) => typeof v === "object" && v !== null)) {
      return (
        <ul className="list-disc pl-4 space-y-0.5">
          {value.map((v, i) => {
            const o = v as Record<string, unknown>;
            const label = o.name ?? o.file ?? o.title;
            const definition =
              typeof o.definition === "string" && o.definition && o.definition !== label
                ? o.definition
                : null;
            const metric =
              o.metric_name != null && o.metric_value != null
                ? `（${humanizeTerm(String(o.metric_name))}: ${String(o.metric_value)}）`
                : null;
            return (
              <li key={i}>
                {renderValue(label ?? v)}
                {definition && (
                  <span className="text-muted-foreground text-xs"> —— {definition}</span>
                )}
                {metric && <span className="text-muted-foreground text-xs">{metric}</span>}
              </li>
            );
          })}
        </ul>
      );
    }
    return (
      <ul className="list-disc pl-4 space-y-0.5">
        {value.map((v, i) => (
          <li key={i}>{renderValue(v)}</li>
        ))}
      </ul>
    );
  }
  // 嵌套对象 → 缩进键值列表（结构化渲染，不向用户展示原始 JSON）。
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
  if (entries.length === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <dl className="space-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-muted-foreground" title={FIELD_HINTS[k]}>
            {LABEL_ZH[k] ?? k}
          </dt>
          <dd className="text-foreground/90">{renderValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 单个 summary 字段格:中文标签 + 一句话说明,让字段自解释。 */
function SummaryCell({ k, value }: { k: string; value: unknown }) {
  const hint = FIELD_HINTS[k];
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-muted-foreground" title={hint}>
        {LABEL_ZH[k] ?? k}
        {hint && <span className="ml-1.5 font-normal text-muted-foreground/60">· {hint}</span>}
      </div>
      <div className="text-foreground/90">{renderValue(value)}</div>
    </div>
  );
}

/** 首屏最多渲染的 summary 键数量；其余收进「展开全部」折叠，
 *  避免一张卡片铺 30 个键值对的「堆砌感」。 */
const SUMMARY_LIMIT = 6;

/** 每个阶段「确认后会发生什么」的一句话说明——用户不该靠猜来理解
 *  「确认并继续」按钮的后果。与后端 5 阶段注册表一一对应。 */
const CONFIRM_NEXT: Record<string, string> = {
  phase_0_scope: "AI 将基于研究问题设计方案：给出评测指标、对照基线与运行配置。",
  phase_1_plan: "进入代码生成,AI 会写出实验代码并自动做一轮快速自检。",
  phase_2_build: "开始首轮实验运行，这一步耗时最长，期间你可以随时暂停。",
  phase_3_run: "AI 会汇总各次运行结果，与已有最优方法对比并生成报告。",
  phase_4_report: "本轮实验收尾，你可以随时在「实验」页查看报告与数据。",
};

export function CheckpointCard({ stage, onDecide, busy }: CheckpointCardProps) {
  const summary = stage.checkpoint_summary ?? {};
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const [showAll, setShowAll] = useState(false);

  // Only render for a stage actually awaiting a decision.
  if (stage.status !== "waiting_for_user") return null;

  // `title` 只是阶段名的回声（卡头已显示阶段名）,不占正文版面。
  const known = KNOWN_KEYS.filter(
    (k) => k !== "title" && k in summary && summary[k as keyof typeof summary] != null,
  );
  // Unknown keys go into a folded 'raw' section.
  const unknown = Object.keys(summary).filter(
    (k) => k !== "title" && !KNOWN_KEYS.includes(k as (typeof KNOWN_KEYS)[number]),
  );
  // 实验配置与可对照方法完全一致时不重复罗列 —— 原样渲染两份相同列表
  // 只会让用户以为漏看了什么。
  const specsDuplicateBaselines =
    "run_specs" in (summary as Record<string, unknown>) &&
    "baselines" in (summary as Record<string, unknown>) &&
    JSON.stringify((summary as Record<string, unknown>).run_specs) ===
      JSON.stringify((summary as Record<string, unknown>).baselines);
  const visibleKeys = showAll ? known : known.slice(0, SUMMARY_LIMIT);
  const hiddenCount = known.length - visibleKeys.length + unknown.length;
  const hasContent = known.length > 0 || unknown.length > 0;

  const handleEdit = () => {
    if (editOpen && editText.trim()) {
      // 自然语言修改要求：后端把 decision_payload 作为阶段新产出；这里
      // 统一包成 edited_note，不再要求用户粘贴 JSON（此前 placeholder
      // 直接暴露内部数据结构，科研用户无法理解）。
      onDecide("edit", { edited_note: editText.trim() });
    }
  };

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50/40 shadow-soft p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-full bg-amber-100 px-2 text-[11px] font-medium text-amber-800">
            等待确认
          </span>
          <span className="text-sm font-medium">{stage.stage_name_zh}</span>
        </div>
        <span className="text-[11px] text-muted-foreground">v{stage.version}</span>
      </div>

      {/* 空内容兜底:老数据可能没有 summary —— 此时至少告诉用户这一步
          是干什么的、确认意味着什么,而不是一张只有按钮的裸卡。 */}
      {!hasContent && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          本阶段:{stage.description || stage.stage_name_zh}。确认后按当前结果继续;若有不满意的地方,选「修改结果」用一句话告诉我们怎么改。
        </p>
      )}

      {/* Structured summary sections（首屏限 6 键，其余折叠;标签带一句话说明） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {visibleKeys.map((k) => (
          <SummaryCell
            key={k}
            k={k}
            value={
              k === "run_specs" && specsDuplicateBaselines
                ? "与「可对照方法」一致"
                : (summary[k as keyof typeof summary] as unknown)
            }
          />
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "收起完整结果" : `展开全部结果（还有 ${hiddenCount} 项）`}
        </button>
      )}
      {showAll && unknown.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {unknown.map((k) => (
            <SummaryCell key={k} k={k} value={summary[k as keyof typeof summary] as unknown} />
          ))}
        </div>
      )}

      {/* Inline editor for the 'edit' decision — 自然语言修改要求。 */}
      {editOpen && (
        <div className="rounded-md border border-border bg-card p-2 space-y-2">
          <div className="text-xs text-muted-foreground">
            用一句话说明你想改什么（例如「对照方法只保留仅文本和仅表格」「先只跑 1 轮」）。
            确认后,后续阶段将按你的要求重新进行。
          </div>
          <textarea
            className="w-full h-20 rounded border border-border bg-background p-2 text-sm"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="例如：对照方法只保留仅文本，并增加一组更大的学习率对照"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={handleEdit} disabled={busy || !editText.trim()}>
              提交修改并继续
            </Button>
          </div>
        </div>
      )}

      {/* The 4 core buttons (no More dropdown — fork/resume/redo were
          removed for the simplified UI; the backend keeps the fork
          capability but it's not exposed here). */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-amber-200/60">
        <Button size="sm" onClick={() => onDecide("approve")} disabled={busy || editOpen}>
          <Check className="h-4 w-4" />
          确认并继续
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditOpen((v) => !v)} disabled={busy}>
          <Pencil className="h-4 w-4" />
          修改结果
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide("skip")} disabled={busy || editOpen}>
          <SkipForward className="h-4 w-4" />
          跳过本阶段
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onDecide("abort")}
          disabled={busy || editOpen}
        >
          <Square className="h-4 w-4" />
          结束本次实验
        </Button>
      </div>
      {CONFIRM_NEXT[stage.stage_key] && (
        <p className="text-xs text-muted-foreground/90 leading-relaxed">
          确认并继续后:{CONFIRM_NEXT[stage.stage_key]}
        </p>
      )}
    </div>
  );
}
