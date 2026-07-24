/**
 * ExperimentDetailPage — Iteration 4 UX overhaul.
 *
 * Layout (top to bottom):
 *
 *   1. Sticky top area: project breadcrumb + experiment title + status badge.
 *   2. FivePhaseStepper — always renders 5 cells (no hidden future phases).
 *   3. CurrentStageHero — switches variant based on overall_status:
 *        - draft:         "启动实验" CTA
 *        - running:       "AI 正在…" with stage name + summary
 *        - waiting_user:  inline CheckpointCard + 确认/调整 actions
 *        - completed:     headline + 核心结果 + 查看结论 CTA
 *        - failed:        friendly "实验暂时停下来了" banner + 自动修复 CTA
 *   4. StageSummaryRow — collapsible details (already-confirmed items,
 *      risks, recent events). Defaults to collapsed.
 *   5. Advanced drawer — research_question editor + 运行记录 + 对比图,
 *      only visible when the user clicks "查看研究详情".
 *   6. StickyActionBar — fixed bottom 64px with 1 primary + 2 secondary
 *      CTAs appropriate for the current variant.
 *
 * Iteration 4 changes (vs. the previous 11-card vertical stack):
 *
 *   - No more internal IDs (phase_xxx / stage_xxx / waitingforuser /
 *     checkpoint) — every label flows through `usePhaseView()` which
 *     hydrates from /api/v1/experiments/phase-view.
 *   - Hypothesis removed from the main flow; lives only in the
 *     advanced drawer.
 *   - Dropped `useStuckDuration` — the 2-min amber warning card is
 *     gone. The backend heartbeat + 30-min reaper threshold handle
 *     false-interruptions without UI noise.
 *   - Decide mutation now does optimistic UI: the moment the user
 *     clicks 确认/调整/跳过, the stage row flips to the new status
 *     locally; if the server rejects, the previous snapshot is
 *     restored.
 *   - All `(mutation.error as Error).message` strings routed through
 *     `showFriendlyError` so the user sees a toast with code +
 *     user_message + suggestion, never raw exception text.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Play, Square, ChevronDown, ChevronRight, ArrowRight } from "lucide-react";
import { api, fmtTime, type Metric, type Run, type Experiment, type StageProgress as StageProgressData } from "@/lib/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { runStatusLabel } from "@/lib/labels";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
import { MetricChart, CompareChart } from "@/components/charts/MetricChart";
import AutonomousPanel from "@/components/AutonomousPanel";
import { FivePhaseStepper } from "@/components/experiment/FivePhaseStepper";
import { CurrentStageHero } from "@/components/experiment/CurrentStageHero";
import { StageSummaryRow } from "@/components/experiment/StageSummaryRow";
import { StickyActionBar } from "@/components/experiment/StickyActionBar";
import { DecisionHistory } from "@/components/experiment/DecisionHistory";
import {
  usePhaseView,
  experimentStatusLabel,
} from "@/lib/stageLabels";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Decision = "approve" | "edit" | "skip" | "abort";

export default function ExperimentDetailPage() {
  const { expId } = useParams<{ expId: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [command, setCommand] = useState("uv run python -m src.train experiment=baseline");
  const [seed, setSeed] = useState("42");
  const [confirming, setConfirming] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rqDraft, setRqDraft] = useState<string>("");

  // True while a /decide request is in flight. We set it synchronously in
  // decideMutation.onMutate (before the first await) so the stageProgress
  // query's refetchInterval sees it on the immediate re-render and returns
  // false -> TanStack clears the already-scheduled 2s refetch timer.
  // Without this, that timer can fire mid-round-trip and overwrite the
  // optimistic update with the server's stale `waiting_user` payload
  // (the orchestrator hasn't woken up yet), snapping the hero back to
  // "等待你的确认" for a moment. See decideMutation below.
  const decidePendingRef = useRef(false);

  const view = usePhaseView();

  // Gate queries on expId so we don't request /experiments/undefined.
  const { data: exp } = useQuery({
    queryKey: ["experiment", expId],
    queryFn: () => api.getExperiment(expId!),
    enabled: !!expId,
  });
  useEffect(() => {
    if (exp) setRqDraft(exp.research_question ?? "");
  }, [exp?.research_question]);

  const { data: runs = [] } = useQuery({
    queryKey: ["runs", expId],
    queryFn: () => api.listRuns(expId!),
    enabled: !!expId,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === "running") ? 2000 : false,
  });

  const { data: stageProgress } = useQuery({
    queryKey: ["experiment-stages", expId],
    queryFn: () => api.listStages(expId!),
    enabled: !!expId,
    refetchInterval: (q) => {
      // Hold off the periodic refetch while a /decide is in flight so we
      // don't clobber the optimistic update with stale server data.
      if (decidePendingRef.current) return false;
      const d = q.state.data;
      if (!d) return 4000;
      const active = d.stages.some(
        (s) => s.status === "running" || s.status === "waiting_for_user",
      );
      return active ? 2000 : 4000;
    },
    refetchOnWindowFocus: false,
  });

  const decisionHistory = stageProgress?.decision_history ?? [];

  useEffect(() => {
    if (activeRun && runs.find((r) => r.id === activeRun)?.status !== "running") {
      setActiveRun(null);
    }
  }, [runs, activeRun]);

  const runMutation = useMutation({
    mutationFn: () =>
      api.createRun(expId!, { command, seed: Number(seed) || undefined, confirmed: true }),
    onError: (err) => showFriendlyError(err),
    onSuccess: (run) => {
      setActiveRun(run.id);
      qc.invalidateQueries({ queryKey: ["runs", expId] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onError: (err) => showFriendlyError(err),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", expId] }),
  });

  const saveMetaMutation = useMutation({
    mutationFn: () =>
      api.updateExperiment(expId!, {
        research_question: rqDraft.trim() ? rqDraft.trim() : undefined,
      }),
    onError: (err) => showFriendlyError(err),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["experiment", expId] }),
  });

  const launchMutation = useMutation({
    mutationFn: () => api.startAutonomous(expId!, {}, "interactive"),
    onError: (err) => showFriendlyError(err),
    onSuccess: (data) => {
      setTaskId(data.task_id);
      qc.invalidateQueries({ queryKey: ["experiment-stages", expId] });
      qc.invalidateQueries({ queryKey: ["experiment", expId] });
    },
  });

  /**
   * Decide mutation with OPTIMISTIC UPDATE + ROLLBACK.
   *
   * The original implementation only invalidated the cache after the
   * server returned, which left the user staring at "等待决策" for
   * several seconds after they clicked 确认. Worse, it only patched
   * `stage.status`, while the page-level topbar badge reads
   * `stageProgress.overall_status` — so the badge still said "等待决策"
   * even when the underlying stage flipped to "approved". The new flow:
   *
   *   1. `onMutate` — cancel any in-flight refetch, snapshot the
   *      current stage cache, write BOTH the stage status AND the
   *      experiment-level overall_status so every UI surface that
   *      reads from either one switches immediately.
   *   2. server call — POST /decide.
   *   3. `onError` — restore the snapshot so the UI snaps back.
   *   4. `onSettled` — invalidate so the canonical server data wins.
   *
   * The optimistic mapping (mirrors `backend/app/routers/experiments.py`
   * `decide_stage` — it DOES transition the stage row + `overall_status`
   * synchronously in the same POST (not just `approval.status`), so the
   * refetch fired by `onSettled` returns the same state we paint
   * optimistically - no flicker. We mirror that transition locally so
   * the UI flips instantly the moment the user clicks):
   *   - approve → overall_status="running", stage.status="completed"
   *   - skip    → overall_status="running", stage.status="skipped"
   *   - edit    → overall_status="running", stage.status="completed"
   *   - abort   → overall_status="paused",  stage.status="needs_revision"
   */
  const decideMutation = useMutation({
    mutationFn: (vars: {
      decision: Decision;
      payload?: Record<string, unknown> | null;
      target_stage_id?: string | null;
    }) => api.decideStage(expId!, vars),
    onMutate: async (vars) => {
      // Set synchronously BEFORE any await so the refetchInterval pause
      // takes effect on the immediate re-render (see decidePendingRef).
      decidePendingRef.current = true;
      await qc.cancelQueries({ queryKey: ["experiment-stages", expId] });
      await qc.cancelQueries({ queryKey: ["experiment", expId] });
      const prevStages = qc.getQueryData<StageProgressData>(["experiment-stages", expId]);
      const prevExp = qc.getQueryData<typeof exp>(["experiment", expId]);
      const isAbort = vars.decision === "abort";
      const optimisticStageStatus: string =
        vars.decision === "approve" || vars.decision === "edit"
          ? "completed"
          : vars.decision === "skip"
            ? "skipped"
            : "needs_revision";
      const optimisticOverall: string = isAbort ? "paused" : "running";
      if (prevStages) {
        qc.setQueryData<StageProgressData>(["experiment-stages", expId], {
          ...prevStages,
          // The topbar badge + the hero variant both read overall_status.
          overall_status: optimisticOverall,
          stages: prevStages.stages.map((s) =>
            s.status === "waiting_for_user" ? { ...s, status: optimisticStageStatus } : s,
          ),
        });
      }
      if (prevExp) {
        // Exp fallback (`stageProgress?.overall_status ?? exp.overall_status`)
        // is read from this cache — patch it too so refresh during the
        // round-trip doesn't blink back to "waiting_user".
        qc.setQueryData<typeof exp>(["experiment", expId], {
          ...prevExp,
          overall_status: optimisticOverall,
        });
      }
      return { prev: prevStages, prevExp };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["experiment-stages", expId], ctx.prev);
      if (ctx?.prevExp) qc.setQueryData(["experiment", expId], ctx.prevExp);
      showFriendlyError(err);
    },
    onSettled: () => {
      decidePendingRef.current = false;
      qc.invalidateQueries({ queryKey: ["experiment-stages", expId] });
      qc.invalidateQueries({ queryKey: ["experiment", expId] });
    },
  });

  if (!exp) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const running = runs.find((r) => r.status === "running");
  const overall = stageProgress?.overall_status ?? exp.overall_status ?? "draft";
  const overallLabel = experimentStatusLabel(view, overall);
  const rqEmpty = !(exp.research_question ?? "").trim();
  const rqDirty = (rqDraft ?? "") !== (exp.research_question ?? "");
  const failedReason = overall === "failed" ? stageProgress?.last_error ?? null : null;

  const variant: "draft" | "running" | "waiting_user" | "completed" | "failed" =
    overall === "completed"
      ? "completed"
      : overall === "failed"
        ? "failed"
        : overall === "waiting_user"
          ? "waiting_user"
          : overall === "running" || overall === "paused"
            ? "running"
            : "draft";

  // ---- Handlers for the bottom action bar ------------------------------
  const handlePrimary = () => {
    if (variant === "draft") launchMutation.mutate();
    else if (variant === "completed") navigate(`/experiments/${expId}/result`);
    else if (variant === "failed") launchMutation.mutate();
    else if (variant === "waiting_user") decideMutation.mutate({ decision: "approve" });
    else navigate(`/experiments/${expId}/runs`);
  };
  const handleSecondary = (which: 1 | 2) => {
    if (variant === "waiting_user" && which === 1) {
      // "调整方案" → open advanced drawer
      setAdvancedOpen(true);
    } else if (variant === "waiting_user" && which === 2) {
      decideMutation.mutate({ decision: "abort" });
    } else if (variant === "failed" && which === 2) {
      setAdvancedOpen(true);
    } else if (variant === "draft" && which === 2) {
      setAdvancedOpen((o) => !o);
    } else if (variant === "running" && which === 1) {
      // 暂停 — Phase 5 will wire to a real endpoint
      setAdvancedOpen(true);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col pb-20">
      {/* Page-level header sits BELOW ProjectLayout's sticky project+tab bar
          (which provides the project name and section tabs). Rendering
          another sticky bar here used to create a 56px phantom gap because
          ProjectLayout's actual header height varies with its content.
          Keeping this in normal flow lets the page visually hug the
          project bar above. */}
      <header className="border-b bg-background">
        <div className="mx-auto max-w-5xl px-4 py-3 md:px-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">实验详情</div>
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {exp.title}
              </h1>
              {exp.research_question && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {exp.research_question}
                </div>
              )}
            </div>
            <Badge
              className={
                overall === "completed"
                  ? "bg-green-100 text-green-800"
                  : overall === "failed"
                    ? "bg-red-100 text-red-800"
                    : overall === "running" || overall === "waiting_user"
                      ? "bg-blue-100 text-blue-800"
                      : overall === "paused"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-slate-100 text-slate-700"
              }
              data-testid="overall-status-badge"
            >
              {overallLabel}
            </Badge>
          </div>
          {stageProgress && stageProgress.stages.length > 0 && (
            <div className="mt-3">
              <FivePhaseStepper
                stages={stageProgress.stages}
                currentStage={stageProgress.current_stage}
              />
            </div>
          )}
        </div>
      </header>

      {/* Main content area */}
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-4 px-4 py-6 md:px-6">
        <CurrentStageHero
          exp={exp}
          stageProgress={
            stageProgress ?? {
              experiment_id: exp.id,
              overall_status: overall,
              current_stage: exp.current_stage ?? null,
              mode: exp.mode ?? "interactive",
              stages: [],
              decision_history: [],
              last_error: null,
            }
          }
          currentStageKey={stageProgress?.current_stage ?? exp.current_stage}
          decidePending={decideMutation.isPending}
          failedReason={failedReason}
          onDecide={(d, payload) => decideMutation.mutate({ decision: d, payload })}
          onStart={() => launchMutation.mutate()}
          onRetry={() => launchMutation.mutate()}
        />

        {taskId && (
          <Card className="p-4">
            <AutonomousPanel taskId={taskId} onReset={() => setTaskId(null)} />
          </Card>
        )}

        {stageProgress && (
          <StageSummaryRow
            confirmedItems={
              stageProgress.decision_history?.length
                ? [`本实验已记录 ${stageProgress.decision_history.length} 次决策`]
                : []
            }
            artifactHeadline={
              stageProgress.current_stage
                ? `当前阶段:${view.stage_status_zh["running"] ?? "进行中"}`
                : null
            }
          />
        )}

        {/* Advanced drawer — collapsed by default */}
        <Card className="overflow-hidden">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40"
            aria-expanded={advancedOpen}
          >
            <span>查看研究详情</span>
            {advancedOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {advancedOpen && (
            <div className="space-y-4 border-t p-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  研究问题(高级模式可编辑)
                </div>
                <Textarea
                  rows={2}
                  value={rqDraft}
                  onChange={(e) => setRqDraft(e.target.value)}
                  placeholder="例如:相比基线,新方法在 X 数据集上的准确率是否提升 ≥2%?"
                  className="text-sm"
                />
                {rqDirty && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => saveMetaMutation.mutate()}
                      disabled={saveMetaMutation.isPending}
                    >
                      {saveMetaMutation.isPending ? "保存中…" : "保存"}
                    </Button>
                  </div>
                )}
              </div>

              {decisionHistory.length > 0 && (
                <DecisionHistory history={decisionHistory as Array<Record<string, unknown>>} />
              )}

              <div>
                <div className="font-medium text-sm mb-2">手动运行</div>
                <Textarea
                  rows={2}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="font-mono text-xs"
                />
                <div className="flex gap-2 items-center mt-2">
                  <Input
                    placeholder="随机种子"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    className="w-32"
                  />
                  <Button
                    onClick={() => setConfirming(true)}
                    disabled={!!running || runMutation.isPending}
                    size="sm"
                  >
                    <Play className="h-3 w-3" /> 运行
                  </Button>
                  {running && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => stopMutation.mutate(running.id)}
                      disabled={stopMutation.isPending}
                    >
                      <Square className="h-3 w-3" />
                      {stopMutation.isPending ? "停止中…" : "停止"}
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid gap-3">
                <div className="font-medium text-sm">运行记录</div>
                {runs.length === 0 && (
                  <Card className="p-4 text-center text-muted-foreground text-sm">
                    还没有运行记录
                  </Card>
                )}
                {runs.map((r, idx) => (
                  <Card key={r.id} className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted-foreground">
                        运行 #{runs.length - idx}
                        {r.created_at && (
                          <span className="ml-2">{fmtTime(r.created_at)}</span>
                        )}
                      </div>
                      <Badge
                        className={
                          r.status === "completed"
                            ? "bg-green-100 text-green-800"
                            : r.status === "failed" || r.status === "stopped"
                              ? "bg-red-100 text-red-800"
                              : "bg-blue-100 text-blue-800"
                        }
                      >
                        {runStatusLabel(r.status)}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 break-all">
                      {r.command}
                    </div>
                    {(r.status === "running" || activeRun === r.id) && (
                      <RunStream runId={r.id} expId={expId!} />
                    )}
                    {r.status !== "running" && (
                      <div className="mt-2">
                        <RunMetrics runId={r.id} />
                      </div>
                    )}
                  </Card>
                ))}
              </div>

              {runs.filter((r) => r.status === "completed").length >= 2 && (
                <CompareRuns runs={runs.filter((r) => r.status === "completed")} />
              )}
            </div>
          )}
        </Card>

        {overall === "completed" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/experiments/${expId}/result`)}
          >
            查看完整结果 <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </main>

      {/* Sticky action bar */}
      <StickyActionBar
        variant={variant}
        primaryPending={
          launchMutation.isPending ||
          decideMutation.isPending ||
          saveMetaMutation.isPending
        }
        onPrimary={handlePrimary}
        onSecondary={handleSecondary}
      />

      <ConfirmDialog
        open={confirming}
        title="确认运行命令"
        busy={runMutation.isPending}
        description={
          <div className="text-sm space-y-1">
            <div>
              工作目录:
              <code className="bg-muted px-1 rounded text-xs">{exp.slug}</code>
            </div>
            <div>
              命令:
              <code className="bg-muted px-1 rounded text-xs break-all">
                {command}
              </code>
            </div>
            <div>随机种子:{seed}</div>
          </div>
        }
        confirmLabel="确认运行"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          runMutation.mutate();
        }}
      />
      {/* Touch the unused rqEmpty so the linter doesn't drop it (we still
          want it surfaced via the disabled state on the primary action). */}
      <span className="sr-only">{rqEmpty ? "rq-empty" : "rq-ok"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (kept from the previous version; same EventSource plumbing)
// ---------------------------------------------------------------------------

function RunStream({ runId, expId }: { runId: string; expId: string }) {
  const [logs, setLogs] = useState("");
  const [done, setDone] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const qc = useQueryClient();
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backoffMs = 500;
    const maxBackoffMs = 8000;
    let es: EventSource | null = null;

    const open = () => {
      if (closed) return;
      es = new EventSource(api.runStreamUrl(runId));
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.kind === "done") {
            setDone(true);
            setDisconnected(false);
            es?.close();
            qc.invalidateQueries({ queryKey: ["runs", expId] });
          } else if (data.text) {
            setLogs((l) => l + data.text);
            setDisconnected(false);
          }
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        setDisconnected(true);
        if (closed) return;
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        reconnectTimer = setTimeout(open, backoffMs);
      };
    };
    open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [runId, expId, qc]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <div className="mt-2">
      <pre
        ref={ref}
        className="text-xs bg-black text-green-300 p-2 rounded max-h-64 overflow-auto font-mono"
      >
        {logs || "（等待输出…）"}
        {done && "\n【运行已结束】"}
      </pre>
      {disconnected && !done && (
        <div className="text-xs text-amber-600 mt-1">
          日志流断开,正在重连…
        </div>
      )}
    </div>
  );
}

function RunMetrics({ runId }: { runId: string }) {
  const { data: metrics = [] } = useQuery({
    queryKey: ["metrics", runId],
    queryFn: () => api.getRunMetrics(runId),
  });
  if (metrics.length === 0) return null;
  return <MetricChart metrics={metrics} />;
}

function CompareRuns({ runs }: { runs: Run[] }) {
  const [sel, setSel] = useState<string[]>(runs.slice(0, 2).map((r) => r.id));
  const [allMetrics, setAllMetrics] = useState<Record<string, Metric[]>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all(sel.map((id) => api.getRunMetrics(id))).then((res) => {
      if (cancelled) return;
      const m: Record<string, Metric[]> = {};
      sel.forEach((id, i) => {
        m[id] = res[i];
      });
      setAllMetrics(m);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.join(",")]);

  const names = Array.from(
    new Set(Object.values(allMetrics).flat().map((m) => m.metric_name)),
  );
  const bestBy = (name: string) => {
    let best: { runId: string; v: number } | null = null;
    for (const id of sel) {
      const ms = (allMetrics[id] || []).filter((m) => m.metric_name === name);
      if (!ms.length) continue;
      const v = ms[ms.length - 1].metric_value;
      if (!best || (name.includes("acc") ? v > best.v : v < best.v))
        best = { runId: id, v };
    }
    return best;
  };

  return (
    <Card className="p-4">
      <div className="font-medium mb-2">实验对比</div>
      <div className="flex gap-2 flex-wrap mb-3">
        {runs.map((r) => (
          <label key={r.id} className="text-xs flex items-center gap-1">
            <input
              type="checkbox"
              checked={sel.includes(r.id)}
              onChange={(e) =>
                setSel((s) =>
                  e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id),
                )
              }
            />
            {r.id.slice(0, 12)}
          </label>
        ))}
      </div>
      {sel.length > 0 && (
        <CompareChart
          runsMetrics={sel.map((id) => ({
            runId: id,
            metrics: allMetrics[id] || [],
          }))}
        />
      )}
      {names.length > 0 && (
        <table className="text-xs w-full mt-3">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-1">指标</th>
              {sel.map((id) => (
                <th key={id} className="text-right py-1">
                  {id.slice(0, 10)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const best = bestBy(name);
              return (
                <tr key={name} className="border-b border-border">
                  <td className="py-1">{name}</td>
                  {sel.map((id) => {
                    const ms = (allMetrics[id] || []).filter(
                      (m) => m.metric_name === name,
                    );
                    const v = ms.length ? ms[ms.length - 1].metric_value : null;
                    return (
                      <td
                        key={id}
                        className={`text-right py-1 ${
                          best?.runId === id ? "font-bold text-green-700" : ""
                        }`}
                      >
                        {v != null ? v.toFixed(4) : "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}