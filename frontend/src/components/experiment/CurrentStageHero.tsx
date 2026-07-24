/**
 * CurrentStageHero — the main content area of the ExperimentDetailPage.
 *
 * Iteration 4: replaces the 11-card vertical stack with a single hero
 * block that switches variant based on the experiment's
 * `overall_status`:
 *
 *   - draft:       empty state, "未开始" + "启动实验" CTA
 *   - running:     "AI 正在…" with the current stage name + summary
 *   - waiting_user: CheckpointCard inline + 确认/调整 actions
 *   - completed:   headline result + 核心结果 + 查看结论 CTA
 *   - failed:      friendly "实验暂时停下来了" banner + 自动修复 CTA
 *
 * The hero intentionally avoids rendering raw internal enums
 * (`phase_0_scope` / `waiting_for_user` etc.) — every label comes
 * from `usePhaseView()` which hydrates from
 * `/api/v1/experiments/phase-view`.
 */

import { useState } from "react";
import {
  Loader2,
  Hourglass,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  CircleDashed,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { CheckpointCard } from "./CheckpointCard";
import {
  usePhaseView,
  phaseLabel,
  type PhaseKey,
} from "@/lib/stageLabels";
import type { Experiment, ExperimentStage, StageProgress } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CurrentStageHeroProps {
  exp: Experiment;
  stageProgress: StageProgress;
  /** The currently active stage (the orchestrator writes this). */
  currentStageKey: string | null | undefined;
  /** True when a /decide call is in flight (disables buttons). */
  decidePending?: boolean;
  /** Handler invoked when the user picks a decision on the checkpoint. */
  onDecide?: (
    decision: "approve" | "edit" | "skip" | "abort",
    payload?: Record<string, unknown>,
  ) => void;
  /** Handler for the "启动实验" CTA (draft variant). */
  onStart?: () => void;
  /** Handler for "自动修复并继续" (failed variant). */
  onRetry?: () => void;
  /** Optional friendly error text from the failed banner. */
  failedReason?: string | null;
}

// ---------------------------------------------------------------------------
// Variant helpers
// ---------------------------------------------------------------------------

type Variant = "draft" | "running" | "waiting_user" | "completed" | "failed";

function variantFor(overall: string | null | undefined, hasWaiting: boolean): Variant {
  if (overall === "completed") return "completed";
  if (overall === "failed") return "failed";
  if (overall === "waiting_user" || hasWaiting) return "waiting_user";
  if (overall === "running" || overall === "paused") return "running";
  return "draft";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CurrentStageHero({
  exp,
  stageProgress,
  currentStageKey,
  decidePending,
  onDecide,
  onStart,
  onRetry,
  failedReason,
}: CurrentStageHeroProps) {
  const view = usePhaseView();
  const waitingStage = stageProgress.stages.find(
    (s) => s.status === "waiting_for_user",
  );
  const variant = variantFor(stageProgress.overall_status, !!waitingStage);
  const currentMeta = currentStageKey
    ? phaseLabel(view, currentStageKey as PhaseKey)
    : null;

  return (
    <section
      aria-label="当前阶段"
      className={cn(
        "rounded-xl border bg-card p-6 md:p-8 shadow-soft",
        variant === "failed" && "border-red-300 bg-red-50/40",
        variant === "completed" && "border-green-300 bg-green-50/30",
        variant === "waiting_user" && "border-amber-300 bg-amber-50/40",
      )}
    >
      {variant === "draft" && (
        <DraftVariant exp={exp} onStart={onStart} />
      )}

      {variant === "running" && (
        <RunningVariant
          stageName={currentMeta?.name ?? ""}
          stageSummary={currentMeta?.summary ?? ""}
        />
      )}

      {variant === "waiting_user" && waitingStage && (
        <WaitingUserVariant
          stage={waitingStage}
          decidePending={!!decidePending}
          onDecide={onDecide ?? noopDecide}
        />
      )}

      {variant === "completed" && (
        <CompletedVariant exp={exp} stageProgress={stageProgress} />
      )}

      {variant === "failed" && (
        <FailedVariant
          reason={failedReason ?? null}
          onRetry={onRetry}
        />
      )}
    </section>
  );
}

function noopDecide() {
  /* parent didn't wire decide — used in compact previews */
}

// ---------------------------------------------------------------------------
// Variant: draft
// ---------------------------------------------------------------------------

function DraftVariant({
  exp,
  onStart,
}: {
  exp: Experiment;
  onStart?: () => void;
}) {
  const hasRq = !!(exp.research_question && exp.research_question.trim());
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <CircleDashed className="h-5 w-5" />
        <span className="text-sm">尚未开始</span>
      </div>
      <h2 className="text-xl font-semibold leading-tight">
        准备好研究问题后,就可以启动实验。
      </h2>
      <p className="text-sm text-muted-foreground">
        {hasRq
          ? `研究问题:${exp.research_question}`
          : "请先在下方补充你要研究的问题,或在左侧从已有研究方向中选择一个。"}
      </p>
      <Button onClick={onStart} disabled={!hasRq}>
        <Sparkles className="mr-2 h-4 w-4" />
        启动实验
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant: running
// ---------------------------------------------------------------------------

function RunningVariant({
  stageName,
  stageSummary,
}: {
  stageName: string;
  stageSummary: string;
}) {
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex items-center gap-2 text-blue-700">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm font-medium">正在进行</span>
      </div>
      <h2 className="text-xl font-semibold leading-tight">
        AI 正在准备{stageName || "当前阶段"}
      </h2>
      {stageSummary && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {stageSummary}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        本阶段通常需要 1-3 分钟,具体取决于模型规模和数据集大小。你不需要做任何事。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant: waiting_user
// ---------------------------------------------------------------------------

function WaitingUserVariant({
  stage,
  decidePending,
  onDecide,
}: {
  stage: ExperimentStage;
  decidePending: boolean;
  onDecide: (decision: "approve" | "edit" | "skip" | "abort") => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-amber-700">
        <Hourglass className="h-5 w-5" />
        <span className="text-sm font-medium">等待你的确认</span>
      </div>
      <CheckpointCard stage={stage} busy={decidePending} onDecide={onDecide} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant: completed
// ---------------------------------------------------------------------------

function CompletedVariant({
  exp,
  stageProgress,
}: {
  exp: Experiment;
  stageProgress: StageProgress;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-2 text-green-700">
        <CheckCircle2 className="h-5 w-5" />
        <span className="text-sm font-medium">首轮实验已完成</span>
      </div>
      <h2 className="text-xl font-semibold leading-tight">
        查看研究结论与下一步建议
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed">
        本轮实验的所有数据已经整理好,包括核心指标、SOTA 对比和后续研究方向。
      </p>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button variant="default">
          <Sparkles className="mr-2 h-4 w-4" />
          查看研究结论
        </Button>
        <Button variant="outline">生成报告</Button>
        <Button variant="ghost">开始下一轮实验</Button>
      </div>
      {/* Keep a reference so the bundler doesn't dead-code eliminate the prop */}
      <span className="sr-only">{exp.id} {stageProgress.experiment_id}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant: failed
// ---------------------------------------------------------------------------

function FailedVariant({
  reason,
  onRetry,
}: {
  reason: string | null;
  onRetry?: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-2 text-red-700">
        <AlertTriangle className="h-5 w-5" />
        <span className="text-sm font-medium">需要处理</span>
      </div>
      <h2 className="text-xl font-semibold leading-tight">
        实验暂时停下来了
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {reason || "系统在执行本阶段时遇到了一些问题。你可以查看详细原因,或在下方选择其他操作。"}
      </p>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button onClick={onRetry}>
          <Sparkles className="mr-2 h-4 w-4" />
          自动修复并继续
        </Button>
        <Button variant="outline" onClick={() => setShowDetails((s) => !s)}>
          {showDetails ? "收起详细原因" : "查看详细原因"}
        </Button>
      </div>
      {showDetails && reason && (
        <pre className="mt-2 w-full rounded bg-muted/50 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {reason}
        </pre>
      )}
    </div>
  );
}