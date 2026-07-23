import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type AgentEvent } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

/** Streams an autonomous experiment agent task's events (SSE) and renders them
 * as a stage-by-stage progress log. Reuses the existing /agent/tasks/{id}/stream
 * endpoint that the orchestrator commits events to.
 *
 * Reconnect hardening (mirrors RunStream in ExperimentDetailPage): exponential
 * backoff capped at 8s, a max-attempt ceiling so a persistently-dead endpoint
 * gives up instead of looping forever, event dedup by id on replay, and the
 * reconnect timer is tracked + cleared on unmount. Once `done` arrives we stop
 * reconnecting entirely. */
export default function AutonomousPanel({ taskId, onReset }: { taskId: string; onReset?: () => void }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<string>("running");
  const [done, setDone] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  // Track seen event ids so a server replay on reconnect doesn't duplicate rows.
  const seenIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;
    const maxBackoffMs = 8000;
    let attempts = 0;
    const maxAttempts = 20;

    const open = () => {
      if (closed || done) return;
      es = new EventSource(api.agentStreamUrl(taskId));
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.kind === "done") {
            setStatus(data.status);
            setDone(true);
            setDisconnected(false);
            es?.close();
            return;
          }
          // Dedup by id: the SSE endpoint replays from the start on reconnect,
          // so without this every event would appear twice after a blip.
          const id = data.id || `${data.kind}:${data.created_at}:${data.message}`;
          if (seenIds.current.has(id)) return;
          seenIds.current.add(id);
          setEvents((prev) => [
            ...prev,
            {
              id: id,
              task_id: taskId,
              kind: data.kind,
              message: data.message,
              payload_json: data.payload_json ?? null,
              created_at: data.created_at || new Date().toISOString(),
            },
          ]);
          setDisconnected(false);
          attempts = 0; // a successful message resets the backoff
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (closed || done) return;
        setDisconnected(true);
        attempts += 1;
        if (attempts > maxAttempts) return; // give up, stop reconnecting
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
  }, [taskId, done]);

  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">自主实验进度</div>
        <div className="flex items-center gap-2">
          {/* When the task has reached a terminal state, offer to start a fresh
              run instead of leaving the user staring at a completed log with no
              way forward. */}
          {done && onReset && (
            <Button size="sm" variant="ghost" onClick={onReset}>启动新的一轮</Button>
          )}
          <Badge className={
            status === "completed" ? "bg-green-100 text-green-800" :
            status === "failed" ? "bg-red-100 text-red-800" :
            "bg-blue-100 text-blue-800"
          }>
            {done
              ? (status === "completed" ? "已完成" : status === "failed" ? "失败" : status === "stopped" ? "已停止" : status)
              : "进行中…"}
          </Badge>
        </div>
      </div>
      <div className="space-y-1 max-h-80 overflow-auto">
        {events.length === 0 && <div className="text-xs text-muted-foreground">正在连接进度…</div>}
        {events.map((e, i) => (
          <div key={e.id || i} className="text-xs flex gap-2">
            <span className="text-muted-foreground shrink-0 w-16">{new Date(e.created_at).toLocaleTimeString()}</span>
            <span className={
              e.kind === "warning" ? "text-amber-600" :
              e.kind === "error" ? "text-destructive" :
              e.kind === "approval" ? "text-blue-600" :
              ""
            }>
              {e.message}
            </span>
          </div>
        ))}
      </div>
      {disconnected && !done && (
        <div className="text-xs text-amber-600">事件流断开,正在重连…</div>
      )}
    </Card>
  );
}

/** Launch button + panel. Calls POST /experiments/{id}/autonomous, then mounts
 * the streaming panel with the returned task_id.
 *
 * `initialTaskId` lets a caller (e.g. ExperimentsPage's "create + autonomous"
 * flow, or the sidebar deep-link) hand off an already-started task so we don't
 * lose it or start a duplicate.
 *
 * Dedupe + survive-navigation: on mount we check the global active-workflows
 * list for a running autonomous task on THIS experiment. If one exists we
 * attach to it (stream its events) instead of showing the launch button - so
 * navigating away and back never looks like the workflow "exited" and the user
 * can't accidentally start a racing second task. Shares the sidebar's
 * ["workflows","active"] cache (the sidebar drives the polling). */
export function AutonomousLauncher({
  expId,
  initialTaskId,
}: {
  expId: string;
  initialTaskId?: string | null;
}) {
  // localTaskId: set from the URL param or when the user clicks launch (so the
  // panel shows immediately, before the active-workflows poll catches up).
  const [localTaskId, setLocalTaskId] = useState<string | null>(initialTaskId ?? null);
  const { data: active, isLoading: checking } = useQuery({
    queryKey: ["workflows", "active"],
    queryFn: () => api.listActiveWorkflows(),
    refetchInterval: false, // the sidebar drives polling; we just read the shared cache
  });
  // A currently-running autonomous task for this experiment, if any.
  const activeTaskId =
    active?.tasks.find(
      (t) =>
        t.task_type === "experiment.autonomous_run" &&
        t.experiment_id === expId &&
        ["running", "pending", "awaiting_approval"].includes(t.status),
    )?.id ?? null;
  // Prefer the live task; fall back to the local/URL one (e.g. a just-launched
  // task not yet in the poll, or a completed task whose log we still want to show).
  const effectiveTaskId = activeTaskId ?? localTaskId;

  const launch = useMutation({
    mutationFn: () => api.startAutonomous(expId, {}),
    onSuccess: (r) => setLocalTaskId(r.task_id),
  });

  if (effectiveTaskId) {
    return (
      <AutonomousPanel
        taskId={effectiveTaskId}
        onReset={() => setLocalTaskId(null)}
      />
    );
  }

  // While we're still checking for an existing task (and no URL task was given),
  // don't show the launch button yet - avoids a race where the user could start
  // a duplicate before the active-task check resolves.
  if (checking && !initialTaskId) {
    return (
      <Card className="p-4 space-y-2">
        <div className="text-xs text-muted-foreground">检测已有任务…</div>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">一键自主实验</div>
          <div className="text-xs text-muted-foreground">
            查找基准 → 生成代码 → 自检修复 → 运行 → 对比最优结果
          </div>
        </div>
        <Button onClick={() => launch.mutate()} disabled={launch.isPending}>
          {launch.isPending ? "启动中…" : "启动自主实验"}
        </Button>
      </div>
      {launch.isError && (
        <div className="text-xs text-destructive">启动失败:{(launch.error as Error).message}</div>
      )}
    </Card>
  );
}
