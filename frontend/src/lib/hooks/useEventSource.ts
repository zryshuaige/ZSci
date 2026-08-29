// The ONE canonical SSE hook — replaces the two hand-rolled, divergent
// EventSource implementations (AutonomousPanel + RunStream).
//
// Behaviour contract:
//   - Exponential backoff 500ms → 8s cap; a successful message resets it.
//   - After `maxAttempts` consecutive failures the hook stops retrying and
//     reports status "failed" — the UI shows a clear "断开" state with a
//     manual 重连 action instead of silently giving up or looping forever.
//   - Server replays the full event log on reconnect, so events are deduped
//     by id before being appended.
//   - A `done`-kind message (or `stopOnDone`) closes the stream for good.
//   - Full cleanup on unmount; `enabled: false` keeps the stream closed.

import { useCallback, useEffect, useRef, useState } from "react";

export type StreamStatus = "idle" | "connecting" | "open" | "retrying" | "failed" | "done";

export interface StreamEvent {
  id: string;
  kind: string;
  message: string | null;
  payload_json: string | null;
  created_at: string;
  /** Run-log streams send {text: "..."} chunks instead of {message}. */
  text?: string;
  /** Present on the terminal "done" message: the task's final status. */
  status?: string;
}

export function useEventSource({
  url,
  enabled = true,
  onEvent,
  onDone,
  maxAttempts = 10,
}: {
  url: string | null;
  enabled?: boolean;
  /** Called for every non-done event AFTER dedup. */
  onEvent?: (ev: StreamEvent) => void;
  /** Called once when the server sends kind:"done". */
  onDone?: (finalStatus: string) => void;
  maxAttempts?: number;
}) {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const retryCount = useRef(0);
  // Callbacks in refs so the effect doesn't re-run when inline closures change.
  const onEventRef = useRef(onEvent);
  const onDoneRef = useRef(onDone);
  onEventRef.current = onEvent;
  onDoneRef.current = onDone;
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  /** Manual reconnect after "failed" — resets the attempt counter. */
  const reconnect = useCallback(() => {
    retryCount.current = 0;
    setReconnectNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !url) {
      setStatus("idle");
      return;
    }
    let closed = false;
    let backoffMs = 500;
    const maxBackoffMs = 8000;
    doneRef.current = false;

    const open = () => {
      if (closed || doneRef.current) return;
      setStatus((s) => (s === "open" ? s : retryCount.current > 0 ? "retrying" : "connecting"));
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.kind === "done") {
            doneRef.current = true;
            setStatus("done");
            es.close();
            onDoneRef.current?.(data.status ?? "completed");
            return;
          }
          const id = data.id || `${data.kind}:${data.created_at}:${data.message}`;
          if (seenIds.current.has(id)) return;
          seenIds.current.add(id);
          retryCount.current = 0; // healthy message resets the backoff
          backoffMs = 500;
          setStatus("open");
          const at = data.created_at || new Date().toISOString();
          setLastEventAt(at);
          onEventRef.current?.({
            id,
            kind: data.kind ?? "step",
            message: data.message ?? null,
            payload_json: data.payload_json ?? null,
            created_at: at,
            text: typeof data.text === "string" ? data.text : undefined,
          });
        } catch {
          /* malformed frame — ignore */
        }
      };

      es.onerror = () => {
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (closed || doneRef.current) return;
        retryCount.current += 1;
        if (retryCount.current > maxAttempts) {
          setStatus("failed");
          return;
        }
        setStatus("retrying");
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        timerRef.current = setTimeout(open, backoffMs);
      };
    };

    setStatus("connecting");
    open();

    return () => {
      closed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
    // reconnectNonce lets the manual `reconnect()` button re-run the effect.
  }, [url, enabled, maxAttempts, reconnectNonce]);

  return { status, lastEventAt, reconnect };
}
