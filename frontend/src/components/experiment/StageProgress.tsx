import { useState } from "react";
import { CheckCircle2, Loader2, Circle, AlertTriangle, SkipForward, Pause, XCircle, Hourglass } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ExperimentStage } from "@/lib/api";

/** Visual encoding for each stage status. The colors match the runtime
 *  semantic so the progress bar feels like a live readout: blue = running,
 *  amber = waiting for the user, green = done, red = failed, dashed =
 *  skipped or archived.
 *
 *  Status mapping per app/experiments/states.py:
 *    not_started       gray dot
 *    draft             hollow circle
 *    waiting_for_user  amber pulsing dot (the most important state — the
 *                      user is the bottleneck)
 *    approved          blue check
 *    running           blue spinner
 *    paused            amber pause
 *    completed         green check
 *    failed            red x
 *    needs_revision    red dot
 *    skipped           dashed gray
 *    outdated          red dotted (downstream was invalidated by upstream)
 *    archived          hollow gray circle
 */
const STATUS_META: Record<string, {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
  ring: string;
}> = {
  not_started:      { label: "未开始", Icon: Circle,        color: "text-muted-foreground",       bg: "bg-muted",       ring: "ring-muted" },
  draft:            { label: "草稿",   Icon: Circle,        color: "text-muted-foreground",       bg: "bg-muted",       ring: "ring-muted" },
  waiting_for_user: { label: "等待决策", Icon: Hourglass,     color: "text-amber-700",              bg: "bg-amber-100",   ring: "ring-amber-400" },
  approved:         { label: "已通过", Icon: CheckCircle2,  color: "text-blue-700",               bg: "bg-blue-100",    ring: "ring-blue-400" },
  running:          { label: "运行中", Icon: Loader2,       color: "text-blue-700",               bg: "bg-blue-100",    ring: "ring-blue-400" },
  paused:           { label: "已暂停", Icon: Pause,         color: "text-amber-700",              bg: "bg-amber-100",   ring: "ring-amber-400" },
  completed:        { label: "已完成", Icon: CheckCircle2,  color: "text-green-700",              bg: "bg-green-100",   ring: "ring-green-400" },
  failed:           { label: "失败",   Icon: XCircle,       color: "text-red-700",                 bg: "bg-red-100",     ring: "ring-red-400" },
  needs_revision:   { label: "需修改", Icon: AlertTriangle, color: "text-red-700",                 bg: "bg-red-100",     ring: "ring-red-400" },
  skipped:          { label: "已跳过", Icon: SkipForward,   color: "text-muted-foreground",       bg: "bg-muted",       ring: "ring-muted" },
  outdated:         { label: "已失效", Icon: AlertTriangle, color: "text-red-700",                 bg: "bg-red-50",      ring: "ring-red-300" },
  archived:         { label: "已归档", Icon: Circle,        color: "text-muted-foreground",       bg: "bg-muted",       ring: "ring-muted" },
};

interface StageProgressProps {
  stages: ExperimentStage[];
  /** Currently active stage_key (highlighted + bigger). */
  currentStage?: string | null;
  /** Which stage the user clicked — the parent renders the detail. */
  onSelectStage?: (stage: ExperimentStage) => void;
  /** Compact mode for embedding in card headers; full is for the detail page. */
  variant?: "compact" | "full";
  className?: string;
}

/** 9-stage horizontal progress bar.
 *
 *  Layout: 9 connected cells with a connector line between them. Each cell
 *  shows the stage's index + name + status badge. The current stage is
 *  highlighted with a ring + drop shadow. Stages with status === "outdated"
 *  show a red dotted border, drawing the eye to "this needs your attention".
 *
 *  Accessibility: each cell is a button (when clickable) so keyboard users
 *  can tab through stages. The current cell uses `aria-current="step"`.
 */
export function StageProgress({
  stages,
  currentStage,
  onSelectStage,
  variant = "full",
  className,
}: StageProgressProps) {
  if (!stages.length) {
    return (
      <p className="text-xs text-muted-foreground px-3 py-2">
        无阶段进度
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex items-stretch gap-1",
        variant === "compact" ? "text-[10px]" : "text-xs",
        className,
      )}
    >
      {stages.map((stage, idx) => {
        const meta = STATUS_META[stage.status] || STATUS_META.not_started;
        const isCurrent = stage.stage_key === currentStage;
        const isLast = idx === stages.length - 1;
        const Icon = meta.Icon;
        return (
          <div
            key={stage.id}
            className="flex-1 min-w-0 flex items-stretch"
          >
            <button
              type="button"
              onClick={() => onSelectStage?.(stage)}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex-1 min-w-0 flex flex-col items-center gap-1.5 rounded-lg px-2 py-2.5",
                "border transition-colors duration-sm ease-out",
                "hover:bg-muted/40 active:scale-[0.98]",
                isCurrent
                  ? "border-primary bg-primary/5 shadow-soft"
                  : "border-border bg-card",
                meta.ring,
                stage.status === "outdated" && "border-dashed",
              )}
              title={`${stage.stage_name_zh} — ${meta.label}`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex items-center justify-center rounded-full",
                    variant === "compact" ? "h-5 w-5" : "h-7 w-7",
                    meta.bg,
                  )}
                >
                  <Icon
                    className={cn(
                      stage.status === "running" && "animate-spin",
                      variant === "compact" ? "h-3 w-3" : "h-4 w-4",
                      meta.color,
                    )}
                  />
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {stage.stage_key.split("_")[1]}
                </span>
              </div>
              <div
                className={cn(
                  "text-center leading-tight truncate w-full",
                  isCurrent ? "font-medium" : "text-muted-foreground",
                )}
              >
                {stage.stage_name_zh}
              </div>
              <div
                className={cn(
                  "text-[10px] truncate",
                  meta.color,
                )}
              >
                {meta.label}
              </div>
            </button>
            {!isLast && (
              <div
                className={cn(
                  "w-2 self-center h-px",
                  stage.status === "completed" ? "bg-green-300" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Mini stage-name labels for the compact pill under each card. */
export function StageStatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] || STATUS_META.not_started;
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        meta.bg,
        meta.color,
      )}
    >
      <Icon
        className={cn(
          "h-2.5 w-2.5",
          status === "running" && "animate-spin",
        )}
      />
      {meta.label}
    </span>
  );
}
