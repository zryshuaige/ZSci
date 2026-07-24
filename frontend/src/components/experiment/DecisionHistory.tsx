import { Check, Pencil, SkipForward, Square, GitBranch, RotateCcw, Play, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/api";

interface DecisionHistoryProps {
  /** The experiment's `decision_history` array (already JSON-decoded by the
   *  backend's StageProgressOut). Each entry: {stage_key, decision, at,
   *  target_stage_id?, fork_experiment_id?, redo?}. */
  history: Array<Record<string, unknown>>;
}

const DECISION_META: Record<string, { label: string; Icon: typeof Check; color: string }> = {
  approve: { label: "通过", Icon: Check, color: "text-green-700" },
  edit: { label: "编辑", Icon: Pencil, color: "text-blue-700" },
  skip: { label: "跳过", Icon: SkipForward, color: "text-muted-foreground" },
  abort: { label: "中止", Icon: Square, color: "text-red-700" },
  fork_from_stage: { label: "分叉", Icon: GitBranch, color: "text-purple-700" },
  select_resume_point: { label: "恢复点", Icon: Play, color: "text-blue-700" },
  redo: { label: "重做", Icon: RotateCcw, color: "text-amber-700" },
};

/** Vertical timeline of the experiment's user decisions. Each entry is one
 *  checkpoint the user resolved, newest-first. Renders the stage + decision
 *  + timestamp; fork decisions also show the new experiment id so the user
 *  can jump to the branch. */
export function DecisionHistory({ history }: DecisionHistoryProps) {
  if (!history || history.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-2">
        暂无决策记录(在每个阶段的等待决策卡片中操作后,记录会出现在这里)
      </div>
    );
  }
  // newest first
  const entries = [...history].reverse();
  return (
    <ol className="relative space-y-3 pl-5">
      {/* the vertical rail */}
      <div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />
      {entries.map((h, i) => {
        const decision = String(h.decision ?? "approve");
        const meta = DECISION_META[decision] ?? DECISION_META.approve;
        const Icon = meta.Icon;
        const at = h.at ? String(h.at) : null;
        return (
          <li key={i} className="relative">
            <span
              className={cn(
                "absolute -left-5 top-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-card ring-2 ring-border",
                meta.color
              )}
            >
              <Icon className="h-2.5 w-2.5" />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium">{meta.label}</span>
              <span className="text-[11px] text-muted-foreground font-mono">
                {String(h.stage_key ?? "")}
              </span>
              {h.redo === true && (
                <span className="text-[10px] text-amber-700">(重做)</span>
              )}
              {at && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto">
                  <Clock className="h-2.5 w-2.5" />
                  {fmtTime(at)}
                </span>
              )}
            </div>
            {Boolean(h.fork_experiment_id) && (
              <div className="text-[11px] text-purple-700 mt-0.5">
                → 新实验: {String(h.fork_experiment_id).slice(0, 12)}…
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
