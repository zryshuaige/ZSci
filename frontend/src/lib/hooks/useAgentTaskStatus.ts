import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActiveWorkflows } from "@/lib/api";

/**
 * Track the status of an agent task started via `api.runAgentTask` (async path).
 *
 * Returns the matching `ActiveWorkflowTask` entry from `/workflows/active` so
 * the caller can render "running / completed / failed" without polling the
 * individual task endpoint. The sidebar already polls this list every 2s when
 * something is active, so we don't add a second timer.
 *
 * `onTerminal` (optional) fires once when the task leaves the active set —
 * useful for triggering a refresh of the data the task produces (e.g. idea
 * list after `research.generate_hypothesis`).
 */
export function useAgentTaskStatus(taskId: string | null, onTerminal?: () => void) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["workflows", "active"],
    queryFn: () => api.listActiveWorkflows(),
    refetchInterval: (q) => {
      const d = q.state.data as ActiveWorkflows | undefined;
      if (!d || !taskId) return 4000;
      // If our task is still in the active list, poll fast.
      const mine = d.tasks.find((t) => t.id === taskId);
      if (mine && !mine.recent) return 2000;
      // If our task is in the recent window, slow poll (waiting for it to age out).
      if (mine && mine.recent) return 4000;
      return 4000;
    },
    refetchOnWindowFocus: false,
  });

  const task = useMemo(
    () => data?.tasks.find((t) => t.id === taskId) ?? null,
    [data, taskId],
  );

  // Fire `onTerminal` once when the task moves from active to recent (i.e.
  // reached a terminal status). The recent window is the only signal we get
  // because the sidebar drops terminal tasks from the active list immediately.
  useEffect(() => {
    if (!task || !onTerminal) return;
    if (task.recent) {
      onTerminal();
      qc.invalidateQueries({ queryKey: ["workflows", "active"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.recent, task?.status, taskId]);

  return {
    /** "running" while active, "completed" / "failed" / "rejected" once
     *  terminal, "pending" before the first poll sees it. */
    status: task?.status ?? "pending",
    lastMessage: task?.last_message ?? null,
    isActive: !!task && !task.recent,
    isTerminal: !!task?.recent,
  };
}
