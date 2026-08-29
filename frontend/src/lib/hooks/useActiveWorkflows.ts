// The single shared observer for /workflows/active.
//
// Before this hook, four components (WorkflowStatus, ExperimentsPage,
// useAgentTaskStatus, WritingPage) each opened their own useQuery on
// ["workflows","active"] with their own refetchInterval — up to 3 overlapping
// timers on one page. React Query shares the cache entry but each observer
// still schedules its own polling timer. Now: ONE observer lives here, every
// consumer calls useActiveWorkflows() and shares its timer.
//
// Polling cadence: 2s while anything is genuinely active, 8s when idle
// (still cheap enough to notice work started elsewhere), and the query is
// invalidated by mutations elsewhere to get instant updates.

import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk, workflowsApi, type ActiveWorkflows, type ActiveWorkflowTask } from "@/api";

const TERMINAL = new Set(["completed", "failed", "rejected", "stopped"]);

export function isWorkflowsBusy(d: ActiveWorkflows | undefined): boolean {
  if (!d) return false;
  return (
    d.tasks.some((t) => !t.recent && !TERMINAL.has(t.status)) ||
    d.runs.length > 0 ||
    d.jobs.some((j) => !j.recent && !TERMINAL.has(j.status))
  );
}

export function useActiveWorkflows() {
  return useQuery({
    queryKey: qk.workflows.active,
    queryFn: () => workflowsApi.listActiveWorkflows(),
    refetchInterval: (q) =>
      isWorkflowsBusy(q.state.data as ActiveWorkflows | undefined) ? 2000 : 8000,
    refetchOnWindowFocus: false,
  });
}

/** Find the active agent task driving a given experiment — used to restore
 *  the live event stream when landing on an experiment detail page via a
 *  `?task=` deep link, the sidebar, or a reload mid-run. */
export function findTaskForExperiment(
  workflows: ActiveWorkflows | undefined,
  expId: string | undefined,
): ActiveWorkflowTask | null {
  if (!workflows || !expId) return null;
  // Prefer genuinely-active tasks; fall back to the recent window so a
  // just-finished task still shows its final events.
  const all = workflows.tasks.filter((t) => t.experiment_id === expId);
  return all.find((t) => !t.recent) ?? all[0] ?? null;
}

/** Track one agent task via the shared workflows feed.
 *  `onTerminal` fires once when the task leaves the active set. */
export function useAgentTaskStatus(taskId: string | null, onTerminal?: () => void) {
  const qc = useQueryClient();
  const { data } = useActiveWorkflows();

  const task = useMemo(
    () => data?.tasks.find((t) => t.id === taskId) ?? null,
    [data, taskId],
  );

  useEffect(() => {
    if (!task || !onTerminal) return;
    if (task.recent) {
      onTerminal();
      qc.invalidateQueries({ queryKey: qk.workflows.active });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.recent, task?.status, taskId]);

  return {
    status: task?.status ?? "pending",
    lastMessage: task?.last_message ?? null,
    isActive: !!task && !task.recent,
    isTerminal: !!task?.recent,
  };
}
