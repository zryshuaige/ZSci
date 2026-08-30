import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Hourglass,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  RotateCw,
  type LucideIcon,
} from "@/components/ui/icons";
import { api } from "@/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useEventSource, type StreamEvent } from "@/lib/hooks/useEventSource";
import { humanizeEventMessage } from "@/lib/eventHumanize";
import { cn } from "@/lib/cn";

/* ---------- 时间显示的小工具 ---------- */

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function dayLabel(d: Date): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  if (sameDay(d, now)) return `今天 · ${week}`;
  if (sameDay(d, yesterday)) return `昨天 · ${week}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${week}`;
}

/** 24 小时制 HH:mm。同一段日志里日期几乎不变，完整时间戳（年份+秒）
 *  只是噪音 —— 日期变化用分组条表达，时刻用这一列表达。 */
function hm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/* ---------- 事件的视觉语义 ---------- */

type Tone = "primary" | "emerald" | "amber" | "blue" | "rose" | "muted";

const TONE_NODE: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/15 text-emerald-600",
  amber: "bg-amber-500/15 text-amber-600",
  blue: "bg-blue-500/15 text-blue-600",
  rose: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

/** 事件 → (图标, 色调)。让用户扫颜色就能分清状态：
 *  蓝=启动/执行、绿=完成、琥珀=需要你操作、红=出错、灰=暂停等中性状态。 */
function eventVisual(kind: string, message: string): { Icon: LucideIcon; tone: Tone } {
  if (kind === "error") return { Icon: AlertTriangle, tone: "rose" };
  if (kind === "warning") return { Icon: AlertTriangle, tone: "amber" };
  if (message.includes("等待你的确认")) return { Icon: Hourglass, tone: "amber" };
  if (/^你(确认通过|要求修改|选择跳过|选择结束)/.test(message))
    return { Icon: CheckCircle2, tone: "blue" };
  if (message.includes("已暂停")) return { Icon: Pause, tone: "muted" };
  if (message.startsWith("开始执行")) return { Icon: Play, tone: "primary" };
  if (message.includes("已启动")) return { Icon: PlayCircle, tone: "primary" };
  if (kind === "result" || message.endsWith("完成") || message.endsWith("已完成"))
    return { Icon: CheckCircle2, tone: "emerald" };
  return { Icon: Circle, tone: "muted" };
}

type LogRow = { ev: StreamEvent; count: number; msg: string };

/** Streams an autonomous experiment agent task's events (SSE) as a live
 *  timeline. Built on the shared useEventSource hook: reconnect with
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
  // 因每次恢复重跑而出现 3 次，且中间隔着其他消息）。对用户这是噪音：
  // 全文相同的条目按首次出现位置合并为一条，行内 ×N 计数。
  // 有意义的进展消息（「开始执行…」「…已完成」）每次内容不同，不受影响。
  // 此外旧数据里同一节点常先后写入两条几乎相同的记录（「X」已完成 →
  // 「X」已完成，等待你的确认），后者是前者的加长版 —— 保留信息更全的一条。
  const rows = useMemo<LogRow[]>(() => {
    const byText = new Map<string, LogRow>();
    const out: LogRow[] = [];
    for (const e of events) {
      const msg = humanizeEventMessage(e.message ?? "");
      const hit = byText.get(msg);
      if (hit) {
        hit.count += 1;
      } else {
        const item = { ev: e, count: 1, msg };
        byText.set(msg, item);
        out.push(item);
      }
    }
    return out.filter(
      (row, i) =>
        !(
          out[i + 1] &&
          out[i + 1].msg.length > row.msg.length &&
          out[i + 1].msg.startsWith(row.msg)
        ),
    );
  }, [events]);

  const done = streamStatus === "done";

  return (
    <Card className="p-4 space-y-3" data-testid="autonomous-panel">
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
        className="thin-scrollbar max-h-96 overflow-auto pr-1"
        aria-live="polite"
      >
        {rows.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            {streamStatus === "failed" ? (
              <>进度流连接已断开，可用下方按钮重连。</>
            ) : (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在连接进度流…
              </>
            )}
          </div>
        )}
        {rows.map(({ ev, count, msg }, i) => {
          const { Icon, tone } = eventVisual(ev.kind, msg);
          const at = new Date(ev.created_at);
          const prev = i > 0 ? new Date(rows[i - 1].ev.created_at) : null;
          const newDay = Number.isNaN(at.getTime()) || !prev || !sameDay(at, prev);
          const isLast = i === rows.length - 1;
          // 最后一条若在等确认，就是当前唯一需要用户行动的事 —— 重点标出。
          const currentWait = isLast && msg.includes("等待你的确认");
          return (
            <Fragment key={ev.id || i}>
              {newDay && (
                <div className="flex items-center gap-3 py-1.5">
                  <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                    {dayLabel(at)}
                  </span>
                  <span className="h-px flex-1 bg-border" aria-hidden />
                </div>
              )}
              <div className="relative flex gap-3">
                {!isLast && (
                  <span
                    aria-hidden
                    className="absolute left-[13px] top-8 -bottom-5 w-px bg-input"
                  />
                )}
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_2px_hsl(var(--card))]",
                    TONE_NODE[tone],
                    currentWait && "ring-2 ring-amber-500/40 ring-offset-2",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className={cn("min-w-0 flex-1", isLast ? "pb-1" : "pb-5")}>
                  <div className="flex items-start justify-between gap-3">
                    <p
                      className={cn(
                        "min-w-0 text-[13px] leading-5",
                        tone === "rose" && "text-destructive",
                        tone === "amber" && "text-amber-700",
                        currentWait && "font-medium",
                      )}
                    >
                      {msg}
                      {count > 1 && (
                        <span
                          className="ml-1.5 inline-block rounded-full bg-muted px-1.5 align-baseline text-[10px] leading-4 text-muted-foreground"
                          title={`同一状态重复上报了 ${count} 次，已合并显示`}
                        >
                          ×{count}
                        </span>
                      )}
                    </p>
                    <time
                      dateTime={ev.created_at}
                      className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground/80"
                    >
                      {hm(ev.created_at)}
                    </time>
                  </div>
                  {currentWait && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      在上方的确认卡中做出选择后，流程才会继续。
                    </p>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Liveness + connection state line — the answer to "is the agent
          alive?" without opening devtools. */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {!done && lastEventAt && streamStatus === "open" && <>最后活动 {hm(lastEventAt)}</>}
          {streamStatus === "connecting" && "正在连接…"}
          {streamStatus === "retrying" && (
            <span className="text-amber-600">连接中断，正在自动重连…</span>
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
