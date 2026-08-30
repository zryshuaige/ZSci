/**
 * ExperimentDetailPage — the autonomous experiment's home.
 *
 * Layout (top to bottom):
 *   1. Header: breadcrumb + title + unified StatusBadge.
 *   2. FivePhaseStepper — the 5 phases at a glance.
 *   3. CurrentStageHero — variant per overall_status:
 *      draft / running / waiting_user / completed / failed / paused.
 *   4. Live agent log (AutonomousPanel) — shown whenever a task is known:
 *      launched from this page, restored from the ?task= deep link, or
 *      rediscovered via the shared /workflows/active feed. This is what
 *      makes "the agent is alive" visible across reloads and navigation.
 *   5. Advanced drawer — research question editor, decision history,
 *      manual runs + run log stream + metrics.
 *   6. StickyActionBar — semantic actions only; every button is wired.
 *
 * Data flow: stage polling runs ONLY while the workflow is actually
 * running (2s) — terminal/paused/waiting states don't poll; mutations
 * invalidate explicitly. The decide mutation does optimistic update with
 * rollback.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Play, Square, ChevronDown, ChevronRight, ArrowRight, AlertTriangle, RotateCw } from "@/components/ui/icons";
import { api, fmtTime, qk, type Metric, type Run, type StageProgress as StageProgressData, type ExperimentStage } from "@/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { useActiveWorkflows, findTaskForExperiment } from "@/lib/hooks/useActiveWorkflows";
import { useEventSource } from "@/lib/hooks/useEventSource";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
import { MetricChart, CompareChart } from "@/components/charts/MetricChart";
import AutonomousPanel from "@/components/AutonomousPanel";
import { FivePhaseStepper } from "@/components/experiment/FivePhaseStepper";
import { CurrentStageHero } from "@/components/experiment/CurrentStageHero";
import { StickyActionBar, type ActionKey } from "@/components/experiment/StickyActionBar";
import { DecisionHistory } from "@/components/experiment/DecisionHistory";
import { LABEL_ZH, KNOWN_KEYS, renderValue } from "@/components/experiment/CheckpointCard";
import { usePhaseView } from "@/lib/stageLabels";
import { cn } from "@/lib/cn";
import { TONE_CLASSES } from "@/lib/statusMeta";

type Decision = "approve" | "edit" | "skip" | "abort";

/** 抽屉 Tab：阶段与决策 / 运行记录 / 研究问题。 */
type DrawerTab = "stages" | "runs" | "question";

export default function ExperimentDetailPage() {
  const { expId } = useParams<{ expId: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [command, setCommand] = useState("uv run python -m src.train experiment=baseline");
  const [seed, setSeed] = useState("42");
  const [confirming, setConfirming] = useState(false);
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  // The agent task whose live log we're showing. Restored from ?task= or
  // the workflows feed — survives reloads and sidebar navigation.
  const [taskId, setTaskId] = useState<string | null>(searchParams.get("task"));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("stages");
  // The stage selected in the stepper (rendered in the drawer's stages tab).
  const [selectedStageKey, setSelectedStageKey] = useState<string | null>(null);
  const [rqDraft, setRqDraft] = useState<string>("");
  const [showFailedReason, setShowFailedReason] = useState(false);
  const logAnchorRef = useRef<HTMLDivElement>(null);

  // True while a /decide request is in flight (see decideMutation below).
  const decidePendingRef = useRef(false);

  const view = usePhaseView();

  const expQuery = useQuery({
    queryKey: qk.experiments.one(expId!),
    queryFn: () => api.getExperiment(expId!),
    enabled: !!expId,
  });
  const exp = expQuery.data;
  useEffect(() => {
    if (exp) setRqDraft(exp.research_question ?? "");
  }, [exp?.research_question]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: runs = [] } = useQuery({
    queryKey: qk.experiments.runs(expId!),
    queryFn: () => api.listRuns(expId!),
    enabled: !!expId,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === "running") ? 2000 : false,
  });

  const { data: stageProgress } = useQuery({
    queryKey: qk.experiments.stages(expId!),
    queryFn: () => api.listStages(expId!),
    enabled: !!expId,
    refetchInterval: (q) => {
      // Hold off the periodic refetch while a /decide is in flight so we
      // don't clobber the optimistic update with stale server data.
      if (decidePendingRef.current) return false;
      const d = q.state.data;
      if (!d) return false;
      // Poll only while work is actually in flight. Terminal, paused and
      // waiting states change only via explicit user actions (which
      // invalidate), so a standing 4s timer was pure noise.
      const active =
        d.overall_status === "running" ||
        d.stages.some((s) => s.status === "running");
      return active ? 2000 : false;
    },
    refetchOnWindowFocus: false,
  });

  // Restore the live task when we don't know it (reload / deep link /
  // arriving from the sidebar). The shared workflows feed is the answer.
  const { data: workflows } = useActiveWorkflows();
  useEffect(() => {
    if (taskId || !expId) return;
    const t = findTaskForExperiment(workflows, expId);
    if (t) setTaskId(t.id);
  }, [workflows, expId, taskId]);

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
      qc.invalidateQueries({ queryKey: qk.experiments.runs(expId!) });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onError: (err) => showFriendlyError(err),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.experiments.runs(expId!) }),
  });

  const saveMetaMutation = useMutation({
    mutationFn: () =>
      api.updateExperiment(expId!, {
        research_question: rqDraft.trim() ? rqDraft.trim() : undefined,
      }),
    onError: (err) => showFriendlyError(err),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.experiments.one(expId!) }),
  });

  const launchMutation = useMutation({
    mutationFn: () => api.startAutonomous(expId!, {}, "interactive"),
    onError: (err) => showFriendlyError(err),
    onSuccess: (data) => {
      setTaskId(data.task_id);
      // Reflect the task in the URL so a reload / copy-paste restores the
      // live log view (the deep-link contract).
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("task", data.task_id);
        return next;
      }, { replace: true });
      qc.invalidateQueries({ queryKey: qk.experiments.stages(expId!) });
      qc.invalidateQueries({ queryKey: qk.experiments.one(expId!) });
      qc.invalidateQueries({ queryKey: qk.workflows.active });
    },
  });

  /**
   * Decide mutation with OPTIMISTIC UPDATE + ROLLBACK (see git history for
   * the full rationale — the short version: the UI flips the moment the
   * user clicks; server rejection restores the snapshot).
   */
  const decideMutation = useMutation({
    mutationFn: (vars: {
      decision: Decision;
      payload?: Record<string, unknown> | null;
      target_stage_id?: string | null;
    }) => api.decideStage(expId!, vars),
    onMutate: async (vars) => {
      decidePendingRef.current = true;
      await qc.cancelQueries({ queryKey: qk.experiments.stages(expId!) });
      await qc.cancelQueries({ queryKey: qk.experiments.one(expId!) });
      const prevStages = qc.getQueryData<StageProgressData>(qk.experiments.stages(expId!));
      const prevExp = qc.getQueryData<typeof exp>(qk.experiments.one(expId!));
      const isAbort = vars.decision === "abort";
      const optimisticStageStatus: string =
        vars.decision === "approve" || vars.decision === "edit"
          ? "completed"
          : vars.decision === "skip"
            ? "skipped"
            : "needs_revision";
      const optimisticOverall: string = isAbort ? "paused" : "running";
      if (prevStages) {
        qc.setQueryData<StageProgressData>(qk.experiments.stages(expId!), {
          ...prevStages,
          overall_status: optimisticOverall,
          stages: prevStages.stages.map((s) =>
            s.status === "waiting_for_user" ? { ...s, status: optimisticStageStatus } : s,
          ),
        });
      }
      if (prevExp) {
        qc.setQueryData<typeof exp>(qk.experiments.one(expId!), {
          ...prevExp,
          overall_status: optimisticOverall,
        });
      }
      return { prev: prevStages, prevExp };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.experiments.stages(expId!), ctx.prev);
      if (ctx?.prevExp) qc.setQueryData(qk.experiments.one(expId!), ctx.prevExp);
      showFriendlyError(err);
    },
    onSettled: () => {
      decidePendingRef.current = false;
      qc.invalidateQueries({ queryKey: qk.experiments.stages(expId!) });
      qc.invalidateQueries({ queryKey: qk.experiments.one(expId!) });
      qc.invalidateQueries({ queryKey: qk.workflows.active });
    },
  });

  // ---- Loading / error states (previously: error → spinner forever) ----
  if (expQuery.isError) {
    return (
      <div className="p-6">
        <Card className="mx-auto max-w-xl p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-destructive/10 p-2 shrink-0">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold">实验加载失败</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                没能读取这个实验的数据。它可能已被删除,或服务暂时不可用。
              </p>
              <div className="mt-4 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => expQuery.refetch()}>
                  <RotateCw className="h-3.5 w-3.5" /> 重试
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate("..")}>
                  返回实验列表
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }
  if (!exp) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const running = runs.find((r) => r.status === "running");
  const overall = stageProgress?.overall_status ?? exp.overall_status ?? "draft";
  const rqDirty = (rqDraft ?? "") !== (exp.research_question ?? "");
  const failedReason = overall === "failed" ? stageProgress?.last_error ?? null : null;
  const hasWaiting = !!stageProgress?.stages.some((s) => s.status === "waiting_for_user");

  const variant: "draft" | "running" | "waiting_user" | "completed" | "failed" | "paused" =
    overall === "completed"
      ? "completed"
      : overall === "failed"
        ? "failed"
        : overall === "paused"
          ? "paused"
          : overall === "waiting_user" || hasWaiting
            ? "waiting_user"
            : overall === "running"
              ? "running"
              : "draft";

  const resultPath = `/experiments/${expId}/result`;
  const writingPath = `/projects/${exp.project_id}/writing`;

  // ---- Semantic actions from the sticky bar (every key is wired) --------
  const handleAction = (key: ActionKey) => {
    switch (key) {
      case "launch":
      case "retry":
      case "resume":
        launchMutation.mutate();
        break;
      case "approve":
        decideMutation.mutate({ decision: "approve" });
        break;
      case "abort":
        setConfirmingAbort(true);
        break;
      case "editPlan":
      case "editQuestion":
        setAdvancedOpen(true);
        setDrawerTab("question");
        break;
      case "showReason":
        setShowFailedReason((v) => !v);
        break;
      case "scrollToLog":
        if (taskId) {
          logAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          // No live stream to show — open the run history instead.
          setAdvancedOpen(true);
        }
        break;
      case "viewResult":
        navigate(resultPath);
        break;
      case "nextRound":
        navigate(resultPath);
        break;
      case "generateReport":
        navigate(writingPath);
        break;
    }
  };

  return (
    <div className="flex flex-col pb-20">
      {/* Title row — first content block. This page lives under the
          ProjectLayout header, so it must not render its own bordered band
          (one-header rule). */}
      <div className="pt-6 px-4 md:px-6 mx-auto max-w-5xl w-full">
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
          <StatusBadge
            status={overall}
            label={view.experiment_status_zh[overall] ?? undefined}
            data-testid="overall-status-badge"
          />
        </div>
      </div>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-4 px-4 py-6 md:px-6">
        {stageProgress && stageProgress.stages.length > 0 && (
          <Card className="p-4">
            <FivePhaseStepper
              stages={stageProgress.stages}
              currentStage={stageProgress.current_stage}
              onSelectStage={(row: ExperimentStage | null, key: string) => {
                // 点击阶段格子 → 打开「阶段与决策」Tab 并定位该阶段详情。
                setSelectedStageKey(key);
                setAdvancedOpen(true);
                setDrawerTab("stages");
                void row;
              }}
            />
          </Card>
        )}
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
          failedReason={showFailedReason ? failedReason : null}
          onDecide={(d, payload) =>
            d === "abort"
              ? setConfirmingAbort(true)
              : decideMutation.mutate({ decision: d, payload })
          }
          onStart={() => launchMutation.mutate()}
          onEditQuestion={() => {
            setAdvancedOpen(true);
            setDrawerTab("question");
          }}
          onRetry={() => launchMutation.mutate()}
          onViewResult={() => navigate(resultPath)}
          onNextRound={() => navigate(resultPath)}
          onGenerateReport={() => navigate(writingPath)}
        />

        {/* Live agent log — restored from ?task= / workflows feed, so the
            "agent is alive" signal survives reloads and navigation. */}
        {taskId && (
          <div ref={logAnchorRef} className="scroll-mt-20">
            <AutonomousPanel
              taskId={taskId}
              onReset={() => {
                setTaskId(null);
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete("task");
                  return next;
                }, { replace: true });
              }}
            />
          </div>
        )}

        {/* Advanced drawer — collapsed by default, three tabs:
            阶段与决策 / 运行记录 / 研究问题。此前四块内容垂直堆在一个
            折叠区里（RQ 编辑器、决策历史、手动运行、运行记录混排），
            现在按用户意图分层。 */}
        <Card className="overflow-hidden">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40"
            aria-expanded={advancedOpen}
          >
            <span>研究详情</span>
            {advancedOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {advancedOpen && (
            <>
              <div className="border-t border-border/60 flex gap-1 px-3 pt-2" role="tablist">
                {(
                  [
                    { key: "stages", label: "阶段与决策" },
                    { key: "runs", label: "运行记录" },
                    { key: "question", label: "研究问题" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={drawerTab === t.key}
                    onClick={() => setDrawerTab(t.key)}
                    className={cn(
                      "rounded-t-md px-3 py-1.5 text-sm border-b-2 transition-colors duration-sm",
                      drawerTab === t.key
                        ? "border-primary text-foreground font-medium"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="border-t border-border/60">
                {drawerTab === "stages" && (
                  <div className="p-4 space-y-4">
                    {selectedStageKey &&
                      (() => {
                        const row = stageProgress?.stages.find(
                          (s) => s.stage_key === selectedStageKey,
                        );
                        if (!row) return null;
                        return (
                          <div className="rounded-lg border border-border/60 p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">{row.stage_name_zh}</span>
                              <StatusBadge status={row.status} />
                            </div>
                            <StageSummary stage={row} />
                          </div>
                        );
                      })()}
                    {decisionHistory.length > 0 ? (
                      <DecisionHistory history={decisionHistory as Array<Record<string, unknown>>} />
                    ) : (
                      <EmptyHint text="还没有任何决策记录 —— 启动实验后，每个阶段完成时你都会在这里确认。" />
                    )}
                  </div>
                )}

                {drawerTab === "runs" && (
                  <div className="divide-y divide-border/60">
                    <div className="p-4">
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
                            loading={stopMutation.isPending}
                          >
                            {!stopMutation.isPending && <Square className="h-3 w-3" />}
                            停止
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="p-4">
                      <div className="font-medium text-sm">运行记录</div>
                      {runs.length === 0 ? (
                        <EmptyHint text="还没有运行记录。启动自主实验或手动运行后，这里会显示每次运行的命令、日志与指标。" />
                      ) : (
                        <div className="mt-2 divide-y divide-border/60">
                          {runs.map((r, idx) => (
                            <div key={r.id} className="py-3 first:pt-0 last:pb-0">
                              <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground">
                                  运行 #{runs.length - idx}
                                  {r.created_at && (
                                    <span className="ml-2">{fmtTime(r.created_at)}</span>
                                  )}
                                </div>
                                <StatusBadge status={r.status} />
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
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {runs.filter((r) => r.status === "completed").length >= 2 && (
                      <CompareRuns runs={runs.filter((r) => r.status === "completed")} />
                    )}
                  </div>
                )}

                {drawerTab === "question" && (
                  <div className="p-4">
                    <div className="text-xs text-muted-foreground mb-1">
                      研究问题(可随时修改,后续阶段将基于修改后的问题)
                    </div>
                    <Textarea
                      rows={2}
                      value={rqDraft}
                      onChange={(e) => setRqDraft(e.target.value)}
                      placeholder="例如：相比基线，新方法在 X 数据集上的准确率是否提升 ≥2%?"
                      className="text-sm"
                    />
                    {rqDirty && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveMetaMutation.mutate()}
                          loading={saveMetaMutation.isPending}
                        >
                          保存
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </Card>

        {overall === "completed" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(resultPath)}
          >
            查看完整结果 <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </main>

      <StickyActionBar
        variant={variant}
        primaryPending={
          launchMutation.isPending ||
          decideMutation.isPending ||
          saveMetaMutation.isPending
        }
        onAction={handleAction}
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

      <ConfirmDialog
        open={confirmingAbort}
        title="结束本次实验？"
        busy={decideMutation.isPending}
        danger
        description="当前阶段的进度会保留，但本轮工作流将暂停。你可以之后从暂停状态继续。"
        confirmLabel="结束本次"
        onCancel={() => setConfirmingAbort(false)}
        onConfirm={() => {
          setConfirmingAbort(false);
          decideMutation.mutate({ decision: "abort" });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer helpers
// ---------------------------------------------------------------------------

/** 抽屉「阶段与决策」Tab：渲染选中阶段的 checkpoint 摘要（与 CheckpointCard
 *  同一套标签/渲染函数，视觉一致；限 8 键防止堆砌）。 */
function StageSummary({ stage }: { stage: ExperimentStage }) {
  const summary = (stage.checkpoint_summary ?? {}) as Record<string, unknown>;
  const keys = KNOWN_KEYS.filter(
    (k) => k in summary && summary[k as keyof typeof summary] != null,
  ).slice(0, 8);
  if (keys.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {keys.map((k) => (
        <div key={String(k)} className="min-w-0">
          <dt className="text-[11px] tracking-wide text-muted-foreground">
            {LABEL_ZH[k] ?? k}
          </dt>
          <dd className="text-foreground/90">{renderValue(summary[k as keyof typeof summary])}</dd>
        </div>
      ))}
    </dl>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="py-6 text-center text-sm text-muted-foreground leading-relaxed">
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run log stream — server replays the whole log on reconnect, so the buffer
// resets whenever the stream reconnects (no duplicated lines). The buffer is
// CAPPED to the last MAX_LOG_LINES lines: a multi-hour training run would
// otherwise grow an unbounded string (tens of MB → re-render + scroll cost
// on every SSE tick).
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 800;

function RunStream({ runId, expId }: { runId: string; expId: string }) {
  const [logs, setLogs] = useState("");
  const [truncated, setTruncated] = useState(false);
  const qc = useQueryClient();
  const ref = useRef<HTMLPreElement>(null);

  const { status: streamStatus, reconnect } = useEventSource({
    url: api.runStreamUrl(runId),
    onEvent: (ev) => {
      if (!ev.text) return;
      setLogs((l) => {
        const next = l + ev.text;
        const lines = next.split("\n");
        if (lines.length > MAX_LOG_LINES) {
          setTruncated(true);
          return lines.slice(-MAX_LOG_LINES).join("\n");
        }
        return next;
      });
    },
    onDone: () => qc.invalidateQueries({ queryKey: qk.experiments.runs(expId) }),
  });

  // Server replays from offset 0 on every connect — reset the buffer when
  // a (re)connection opens so replayed content doesn't double up.
  const prevStatus = useRef(streamStatus);
  useEffect(() => {
    if (streamStatus === "connecting" && prevStatus.current !== "connecting") {
      setLogs("");
      setTruncated(false);
    }
    prevStatus.current = streamStatus;
  }, [streamStatus]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <div className="mt-2">
      <pre
        ref={ref}
        className="max-h-64 overflow-auto rounded-lg bg-[#16181C] p-2 font-mono text-xs text-emerald-300/90"
      >
        {truncated && "（日志过长，仅显示最后 800 行）\n"}
        {logs || "(等待输出…)"}
        {streamStatus === "done" && "\n【运行已结束】"}
      </pre>
      {streamStatus === "retrying" && (
        <div className="text-xs text-amber-600 mt-1">日志流断开，正在重连…</div>
      )}
      {streamStatus === "failed" && (
        <div className="text-xs text-destructive mt-1 flex items-center gap-2">
          日志流已断开
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={reconnect}>
            重连
          </Button>
        </div>
      )}
    </div>
  );
}

function RunMetrics({ runId }: { runId: string }) {
  const { data: metrics = [] } = useQuery({
    queryKey: qk.runs.metrics(runId),
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
    <div className="p-4">
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
            <tr className="border-b border-border text-[11px] tracking-wide text-muted-foreground">
              <th className="text-left py-1">指标</th>
              {sel.map((id) => (
                <th key={id} className="text-right py-1">
                  {id.slice(0, 10)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {names.map((name) => {
              const best = bestBy(name);
              return (
                <tr key={name}>
                  <td className="py-1">{name}</td>
                  {sel.map((id) => {
                    const ms = (allMetrics[id] || []).filter(
                      (m) => m.metric_name === name,
                    );
                    const v = ms.length ? ms[ms.length - 1].metric_value : null;
                    return (
                      <td
                        key={id}
                        className={cn(
                          "text-right py-1 tabular-nums",
                          best?.runId === id && cn(TONE_CLASSES.green.text, "font-semibold"),
                        )}
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
    </div>
  );
}
