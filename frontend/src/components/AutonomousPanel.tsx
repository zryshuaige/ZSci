import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCw } from "@/components/ui/icons";
import { api, fmtTime } from "@/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useEventSource, type StreamEvent } from "@/lib/hooks/useEventSource";
import { humanizeEventMessage } from "@/lib/eventHumanize";
import { cn } from "@/lib/cn";

/** Streams an autonomous experiment agent task's events (SSE) as a live
 *  progress log. Built on the shared useEventSource hook: reconnect with
 *  backoff, event dedup on server replay, a clear failed state with a
 *  manual 重连 button, and a "最后活动" liveness line so the user can tell
 *  a working agent from a stuck one. */
export default function AutonomousPanel({
  taskId,
  onReset,
}: {
  taskId: string;
  onReset?: () => void;
}) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the tail while the user is near the bottom; don't yank the
  // scroll position when they've scrolled up to read history.
  const stickToBottom = useRef(true);

  const { status: streamStatus, lastEventAt, reconnect } = useEventSource({
    url: api.agentStreamUrl(taskId),
    onEvent: (ev) =>
      setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [...prev, ev])),
    onDone: (s) => setFinalStatus(s),
  });

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  // 进程重启/轮询重放会把同一条状态反复写进事件流（例如「自动化实验已启动」
  // 因每次恢复重跑而出现 3 次,且中间隔着其他消息）。对用户这是噪音:
  // 全文相同的条目按首次出现位置合并为一条,右上角 ×N 计数。
  // 有意义的进展消息（「开始执行:X」「「X」完成」）每次内容不同,不受影响。
  const collapsedEvents = useMemo(() => {
    const byText = new Map<string, { ev: StreamEvent; count: number }>();
    const out: { ev: StreamEvent; count: number }[] = [];
    for (const e of events) {
      const text = humanizeEventMessage(e.message);
      const hit = byText.get(text);
      if (hit) {
        hit.count += 1;
      } else {
        const item = { ev: e, count: 1 };
        byText.set(text, item);
        out.push(item);
      }
    }
    return out;
  }, [events]);

  const done = streamStatus === "done";

  return (
    <Card className="p-4 space-y-2" data-testid="autonomous-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-sm">
          AI 工作日志
          {!done && streamStatus !== "failed" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {done && finalStatus && <StatusBadge status={finalStatus} />}
          {done && onReset && (
            <Button size="sm" variant="ghost" onClick={onReset}>
              收起日志
            </Button>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="space-y-1 max-h-80 overflow-auto"
        aria-live="polite"
      >
        {events.length === 0 && (
          <div className="text-xs text-muted-foreground">
            {streamStatus === "failed" ? "连接已断开。" : "正在连接进度流…"}
          </div>
        )}
        {collapsedEvents.map(({ ev, count }, i) => (
          <div key={ev.id || i} className="flex gap-2 font-mono text-xs leading-5">
            <span className="text-muted-foreground shrink-0 w-28 tabular-nums">
              {fmtTime(ev.created_at)}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                ev.kind === "warning" && "text-amber-600",
                ev.kind === "error" && "text-destructive",
                ev.kind === "approval" && "text-blue-600",
                ev.kind === "result" && "text-emerald-700",
              )}
            >
              {humanizeEventMessage(ev.message)}
            </span>
            {count > 1 && (
              <span
                className="shrink-0 text-muted-foreground/60"
                title={`同一状态重复上报了 ${count} 次,已合并显示`}
              >
                ×{count}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Liveness + connection state line — the answer to "is the agent
          alive?" without opening devtools. */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {!done && lastEventAt && streamStatus === "open" && (
            <>最后活动:{fmtTime(lastEventAt)}</>
          )}
          {streamStatus === "connecting" && "正在连接…"}
          {streamStatus === "retrying" && (
            <span className="text-amber-600">连接中断,正在自动重连…</span>
          )}
        </span>
        {streamStatus === "failed" && (
          <span className="inline-flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            事件流已断开
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={reconnect}
            >
              <RotateCw className="h-3 w-3" /> 重连
            </Button>
          </span>
        )}
      </div>
    </Card>
  );
}
