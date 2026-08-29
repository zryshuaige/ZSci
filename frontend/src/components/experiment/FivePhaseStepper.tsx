/**
 * FivePhaseStepper — always renders 5 fixed phase cells.
 *
 * Iteration 4 replaces the older `StageProgress` (which iterated the
 * stages that actually exist for an experiment, hiding future phases
 * when they hadn't been created yet). The new stepper renders a
 * fixed 5-phase row regardless of how many `ExperimentStage` rows
 * the orchestrator has written so far — missing stages render as
 * `not_started` so the user sees the full pipeline at all times.
 *
 * The 5 phases are derived from `usePhaseView()`, which hydrates
 * from `/api/v1/experiments/phase-view` (single source of truth
 * living in `app/experiments/states.py:STAGE_USER_VIEW`).
 */

import { useMemo } from "react";
import {
  CheckCircle2,
  Loader2,
  Circle,
  AlertTriangle,
  SkipForward,
  Pause,
  XCircle,
  Hourglass,
  Target,
  Compass,
  Code2,
  PlayCircle,
  FileText,
  RefreshCcw,
  type LucideIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { ExperimentStage } from "@/lib/api";
import {
  usePhaseView,
  type PhaseKey,
  type PhaseViewItem,
} from "@/lib/stageLabels";

// ---------------------------------------------------------------------------
// Icon registry — maps lucide icon names from STAGE_USER_VIEW to imports
// ---------------------------------------------------------------------------

const ICONS: Record<string, LucideIcon> = {
  Target,
  Compass,
  Code2,
  PlayCircle,
  FileText,
  RefreshCcw,
};

function iconFor(name: string): LucideIcon {
  return ICONS[name] ?? Circle;
}

// ---------------------------------------------------------------------------
// Status encoding — matches backend STAGE_STATUS_ZH semantics
// ---------------------------------------------------------------------------

interface StatusMeta {
  Icon: LucideIcon;
  color: string;
  bg: string;
  spin?: boolean;
  pulse?: boolean;
}

const STATUS_META: Record<string, StatusMeta> = {
  not_started:      { Icon: Circle,        color: "text-muted-foreground",   bg: "bg-muted" },
  draft:            { Icon: Circle,        color: "text-muted-foreground",   bg: "bg-muted" },
  waiting_for_user: { Icon: Hourglass,     color: "text-amber-700",          bg: "bg-amber-100", pulse: true },
  approved:         { Icon: CheckCircle2,  color: "text-blue-700",           bg: "bg-blue-100" },
  running:          { Icon: Loader2,       color: "text-blue-700",           bg: "bg-blue-100", spin: true, pulse: true },
  paused:           { Icon: Pause,         color: "text-amber-700",          bg: "bg-amber-100" },
  completed:        { Icon: CheckCircle2,  color: "text-green-700",          bg: "bg-green-100" },
  failed:           { Icon: XCircle,       color: "text-red-700",            bg: "bg-red-100" },
  needs_revision:   { Icon: AlertTriangle, color: "text-red-700",            bg: "bg-red-100" },
  skipped:          { Icon: SkipForward,   color: "text-muted-foreground",   bg: "bg-muted" },
  outdated:         { Icon: AlertTriangle, color: "text-red-700",            bg: "bg-red-50" },
  archived:         { Icon: Circle,        color: "text-muted-foreground",   bg: "bg-muted" },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FivePhaseStepperProps {
  /** Backend stage rows (any subset of the 5 phases — missing ones
   *  render as `not_started`). */
  stages: ExperimentStage[];
  /** Currently active stage_key (highlighted + bigger). */
  currentStage?: string | null;
  /** Optional click handler — most callers won't surface this in the
   *  stepper itself; the detail page already shows full content below. */
  onSelectStage?: (stage: ExperimentStage | null, key: PhaseKey) => void;
  /** Compact mode for embedding in card headers. */
  variant?: "compact" | "full";
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FivePhaseStepper({
  stages,
  currentStage,
  onSelectStage,
  variant = "full",
  className,
}: FivePhaseStepperProps) {
  const view = usePhaseView();
  const phaseItems = view.phases;

  // Build a stage_key → status lookup from the API rows; missing
  // keys default to "not_started" so the stepper always renders 5
  // cells (the original StageProgress iterated `stages` and skipped
  // future phases, which made the page look like the workflow was
  // stuck on the current stage).
  const statusByKey = useMemo(() => {
    const m: Record<string, ExperimentStage> = {};
    for (const s of stages) m[s.stage_key] = s;
    return m;
  }, [stages]);

  return (
    <ol
      aria-label="实验进度"
      className={cn(
        "flex items-stretch gap-1.5",
        variant === "compact" ? "text-[10px]" : "text-xs",
        className,
      )}
    >
      {phaseItems.map((phase, idx) => {
        const row = statusByKey[phase.key];
        const status = row?.status ?? "not_started";
        const meta = STATUS_META[status] ?? STATUS_META.not_started;
        const isCurrent = phase.key === currentStage;
        const Icon = iconFor(phase.icon);
        const isLast = idx === phaseItems.length - 1;
        return (
          <li
            key={phase.key}
            className="flex-1 min-w-0 flex items-stretch"
            aria-current={isCurrent ? "step" : undefined}
            data-testid="phase-cell"
            data-phase-key={phase.key}
            data-phase-status={status}
          >
            <button
              type="button"
              onClick={() => onSelectStage?.(row ?? null, phase.key)}
              title={`${phase.name} — ${view.stage_status_zh[status] ?? status}`}
              className={cn(
                "flex-1 min-w-0 flex flex-col items-center gap-1 rounded-lg px-2 py-2",
                "border transition-colors duration-sm ease-out",
                "hover:bg-muted/40",
                isCurrent
                  ? "border-primary bg-primary/5 shadow-soft"
                  : "border-border bg-card",
                status === "outdated" && "border-dashed",
              )}
            >
              <span
                className={cn(
                  "inline-flex items-center justify-center rounded-full",
                  variant === "compact" ? "h-6 w-6" : "h-8 w-8",
                  meta.bg,
                  meta.pulse && "animate-pulse",
                )}
              >
                {status === "completed" || status === "approved" ? (
                  <CheckCircle2
                    className={cn(
                      variant === "compact" ? "h-3 w-3" : "h-4 w-4",
                      // Completed reads as a signal-blue check in the
                      // precision-instrument language; approved keeps its
                      // status-tone chip color.
                      status === "completed" ? "text-primary" : meta.color,
                    )}
                  />
                ) : status === "running" ? (
                  <Loader2 className={cn("animate-spin", variant === "compact" ? "h-3 w-3" : "h-4 w-4", meta.color)} />
                ) : (
                  <Icon className={cn(variant === "compact" ? "h-3 w-3" : "h-4 w-4", meta.color)} />
                )}
              </span>
              <div
                className={cn(
                  "text-center leading-tight w-full px-1 truncate",
                  isCurrent ? "font-medium" : "text-muted-foreground",
                )}
              >
                {phase.name}
              </div>
              <div className={cn("text-[10px] truncate", meta.color)}>
                {view.stage_status_zh[status] ?? status}
              </div>
            </button>
            {!isLast && (
              <div
                aria-hidden
                className="w-2 self-center h-px bg-border"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the friendly Chinese label for the current phase key (e.g.
 * "phase_0_scope" → "研究目标确认"). Falls back to the raw key when
 * the key isn't in `STAGE_USER_VIEW` (which would only happen for
 * legacy atomic stage keys like `stage_0_init`).
 */