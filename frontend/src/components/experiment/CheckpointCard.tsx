import { useState } from "react";
import {
  Check, Pencil, SkipForward, Square,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
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
 *  in this list is shown raw in a <details> fold so the user still sees it. */
const KNOWN_KEYS = [
  "title", "goal", "research_question", "hypothesis", "checklist",
  "metrics", "baselines", "run_specs", "datasets", "tasks", "sota",
  "ai_judgement", "recommendation", "fairness_note", "compute_plan",
  "files_written", "run_command", "smoke_command", "official_code_note",
  "best_run", "best_metric", "vs_sota", "stability", "fairness",
  "report_path", "preview", "passed", "attempts", "probe",
  "disk_free_gb", "config_present", "warnings", "risks",
] as const;

const LABEL_ZH: Record<string, string> = {
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
};

/** Render one summary value as a compact, readable cell. Lists -> bullets,
 *  booleans -> green/red dot, objects -> a <pre> JSON block. */
function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/60">—</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className={value ? "text-green-700" : "text-red-700"}>
        {value ? "通过" : "未通过"}
      </span>
    );
  }
  if (typeof value === "string" || typeof value === "number") {
    return <span className="break-words whitespace-pre-wrap">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground/60">—</span>;
    // Array of {name: ...} objects (metrics / datasets) -> render the name.
    if (value.every((v) => typeof v === "object" && v !== null)) {
      return (
        <ul className="list-disc pl-4 space-y-0.5">
          {value.map((v, i) => (
            <li key={i}>
              {renderValue(
                (v as Record<string, unknown>).name
                  ?? (v as Record<string, unknown>).file
                  ?? (v as Record<string, unknown>).definition
                  ?? v
              )}
            </li>
          ))}
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
  if (typeof value === "object") {
    return (
      <pre className="text-[11px] bg-muted/40 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return String(value);
}

export function CheckpointCard({ stage, onDecide, busy }: CheckpointCardProps) {
  const summary = stage.checkpoint_summary ?? {};
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");

  // Only render for a stage actually awaiting a decision.
  if (stage.status !== "waiting_for_user") return null;

  const known = KNOWN_KEYS.filter((k) => k in summary && summary[k as keyof typeof summary] != null);
  // Unknown keys go into a folded 'raw' section.
  const unknown = Object.keys(summary).filter((k) => !KNOWN_KEYS.includes(k as (typeof KNOWN_KEYS)[number]));

  const handleEdit = () => {
    let payload: Record<string, unknown> | undefined;
    if (editOpen && editText.trim()) {
      // The backend's `edit` branch writes `decision_payload` as the new
      // stage outputs. We send a best-effort JSON; if it doesn't parse we
      // send the raw text under a `note` key so nothing is lost.
      try {
        payload = JSON.parse(editText);
      } catch {
        payload = { edited_note: editText };
      }
    }
    onDecide("edit", payload);
  };

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50/40 shadow-soft p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-full bg-amber-100 px-2 text-[11px] font-medium text-amber-800">
            等待确认
          </span>
          <span className="text-sm font-medium">{stage.stage_name_zh}</span>
          <span className="text-[11px] text-muted-foreground font-mono">{stage.stage_key}</span>
        </div>
        <span className="text-[11px] text-muted-foreground">v{stage.version}</span>
      </div>

      {/* Structured summary sections */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {known.map((k) => (
          <div key={k} className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {LABEL_ZH[k] ?? k}
            </div>
            <div className="text-foreground/90">{renderValue(summary[k as keyof typeof summary])}</div>
          </div>
        ))}
      </div>

      {unknown.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">其他结果信息 ({unknown.length})</summary>
          <pre className="mt-1 bg-muted/40 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-words">
            {JSON.stringify(
              Object.fromEntries(unknown.map((k) => [k, summary[k as keyof typeof summary]])),
              null,
              2
            )}
          </pre>
        </details>
      )}

      {/* Inline editor for the 'edit' decision */}
      {editOpen && (
        <div className="rounded-md border border-border bg-card p-2 space-y-2">
          <div className="text-xs text-muted-foreground">
            修改本阶段结果或补充说明。确认后,后续分析将基于修改后的内容重新进行。
          </div>
          <textarea
            className="w-full h-28 rounded border border-border bg-background p-2 font-mono text-xs"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder='{"experiment_settings": ["baseline", "no_aug"], "note": "..."}'
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={handleEdit} disabled={busy}>
              保存并继续
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
    </div>
  );
}
