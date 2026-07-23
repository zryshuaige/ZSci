import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { Play, Square } from "lucide-react";
import { api, type Metric, type Run } from "@/lib/api";
import { runStatusLabel } from "@/lib/labels";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
import { MetricChart, CompareChart } from "@/components/charts/MetricChart";
import { AutonomousLauncher } from "@/components/AutonomousPanel";
export default function ExperimentDetailPage() {
  const { expId } = useParams<{ expId: string }>();
  // If we were navigated here from "create + autonomous", the task_id is in the
  // query string - hand it to the launcher so it streams the already-started
  // task instead of launching a duplicate.
  const [searchParams] = useSearchParams();
  const initialTaskId = searchParams.get("task");
  const qc = useQueryClient();
  const [command, setCommand] = useState("uv run python -m src.train experiment=baseline");
  const [seed, setSeed] = useState("42");
  const [confirming, setConfirming] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);

  // M11: gate queries on expId so we don't request /experiments/undefined.
  const { data: exp } = useQuery({
    queryKey: ["experiment", expId],
    queryFn: () => api.getExperiment(expId!),
    enabled: !!expId,
  });
  const { data: runs = [] } = useQuery({
    queryKey: ["runs", expId],
    queryFn: () => api.listRuns(expId!),
    enabled: !!expId,
    // H8: refetch while any run is in progress so the UI doesn't go stale if
    // the SSE stream drops.
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === "running") ? 2000 : false,
  });

  // M10: clear activeRun when the run finishes so RunStream unmounts.
  useEffect(() => {
    if (activeRun && runs.find((r) => r.id === activeRun)?.status !== "running") {
      setActiveRun(null);
    }
  }, [runs, activeRun]);

  const runMutation = useMutation({
    mutationFn: () =>
      api.createRun(expId!, { command, seed: Number(seed) || undefined, confirmed: true }),
    onSuccess: (run) => {
      setActiveRun(run.id);
      qc.invalidateQueries({ queryKey: ["runs", expId] });
    },
  });

  // H10: convert stopRun from a raw promise to a mutation so we get isPending
  // state, error handling, and disabled buttons.
  const stopMutation = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", expId] }),
  });

  if (!exp) return <div className="p-6"><Spinner /></div>;

  const running = runs.find((r) => r.status === "running");

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{exp.title}</h1>
        {exp.research_question && <p className="text-sm text-muted-foreground">{exp.research_question}</p>}
        {exp.hypothesis && (
          <p className="text-sm mt-1">
            <span className="text-muted-foreground">假设：</span> {exp.hypothesis}
          </p>
        )}
      </div>

      <AutonomousLauncher expId={expId!} initialTaskId={initialTaskId} />

      <Card className="p-4 space-y-3">
        <div className="font-medium text-sm">手动运行</div>
        <Textarea rows={2} value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-xs" />
        <div className="flex gap-2 items-center">
          <Input placeholder="随机种子" value={seed} onChange={(e) => setSeed(e.target.value)} className="w-32" />
          <Button onClick={() => setConfirming(true)} disabled={!!running || runMutation.isPending}>
            <Play className="h-4 w-4" /> 运行
          </Button>
          {running && (
            <Button
              variant="destructive"
              onClick={() => stopMutation.mutate(running.id)}
              disabled={stopMutation.isPending}
            >
              <Square className="h-4 w-4" />
              {stopMutation.isPending ? "停止中…" : "停止"}
            </Button>
          )}
          {stopMutation.isError && (
            <span className="text-xs text-destructive">
              停止失败：{(stopMutation.error as Error).message}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          命令会在本机实验目录执行并占用算力，需你确认后才会开始。
        </div>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="确认运行命令"
        busy={runMutation.isPending}
        description={
          <div className="text-sm space-y-1">
            <div>工作目录：<code className="bg-muted px-1 rounded text-xs">{exp.slug}</code></div>
            <div>命令：<code className="bg-muted px-1 rounded text-xs break-all">{command}</code></div>
            <div>随机种子：{seed}</div>
          </div>
        }
        confirmLabel="确认运行"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); runMutation.mutate(); }}
      />

      <div className="grid gap-3">
        <div className="font-medium">运行记录</div>
        {runs.map((r, idx) => (
          <Card key={r.id} className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                运行 #{runs.length - idx}
                {r.created_at && (
                  <span className="ml-2">{new Date(r.created_at).toLocaleString()}</span>
                )}
              </div>
              <Badge className={
                r.status === "completed" ? "bg-green-100 text-green-800" :
                r.status === "failed" || r.status === "stopped" ? "bg-red-100 text-red-800" :
                "bg-blue-100 text-blue-800"
              }>{runStatusLabel(r.status)}</Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-1 break-all">{r.command}</div>
            {(r.status === "running" || activeRun === r.id) && <RunStream runId={r.id} expId={expId!} />}
            {r.status !== "running" && (
              <div className="mt-2">
                <RunMetrics runId={r.id} />
              </div>
            )}
          </Card>
        ))}
        {runs.length === 0 && <Card className="p-6 text-center text-muted-foreground text-sm">还没有运行记录</Card>}
      </div>

      {runs.filter((r) => r.status === "completed").length >= 2 && (
        <CompareRuns runs={runs.filter((r) => r.status === "completed")} />
      )}
    </div>
  );
}

function RunStream({ runId, expId }: { runId: string; expId: string }) {
  const [logs, setLogs] = useState("");
  const [done, setDone] = useState(false);
  // H9: surface disconnection so the user knows the stream died instead of
  // silently showing stale logs.
  const [disconnected, setDisconnected] = useState(false);
  const qc = useQueryClient();
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backoffMs = 500;
    const maxBackoffMs = 8000;
    // Hold the live EventSource so the teardown closure can actually close it.
    // Previously `es` was local to open(), so unmount leaked the stream and it
    // kept appending logs / firing reconnects after the component was gone.
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
        } catch { /* ignore */ }
      };
      // H9: reconnect with exponential backoff on transient errors instead of
      // closing permanently.
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

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);

  return (
    <div className="mt-2">
      <pre ref={ref} className="text-xs bg-black text-green-300 p-2 rounded max-h-64 overflow-auto font-mono">
        {logs || "（等待输出…）"}{done && "\n【运行已结束】"}
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
    queryKey: ["metrics", runId], queryFn: () => api.getRunMetrics(runId),
  });
  if (metrics.length === 0) return null;
  return <MetricChart metrics={metrics} />;
}

function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4);
}

function CompareRuns({ runs }: { runs: Run[] }) {
  const [sel, setSel] = useState<string[]>(runs.slice(0, 2).map((r) => r.id));
  const [allMetrics, setAllMetrics] = useState<Record<string, Metric[]>>({});

  // H5: guard against out-of-order Promise.all resolution by tracking the
  // current selection in a ref; ignore results that arrive after sel changes.
  useEffect(() => {
    let cancelled = false;
    Promise.all(sel.map((id) => api.getRunMetrics(id))).then((res) => {
      if (cancelled) return;
      const m: Record<string, Metric[]> = {};
      sel.forEach((id, i) => { m[id] = res[i]; });
      setAllMetrics(m);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.join(",")]);

  // Collect distinct metric names across selected runs.
  const names = Array.from(new Set(Object.values(allMetrics).flat().map((m) => m.metric_name)));
  const bestBy = (name: string) => {
    let best: { runId: string; v: number } | null = null;
    for (const id of sel) {
      const ms = (allMetrics[id] || []).filter((m) => m.metric_name === name);
      if (!ms.length) continue;
      const v = ms[ms.length - 1].metric_value;
      if (!best || (name.includes("acc") ? v > best.v : v < best.v)) best = { runId: id, v };
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
              onChange={(e) => setSel((s) => e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id))}
            />
            {r.id.slice(0, 12)}
          </label>
        ))}
      </div>
      {sel.length > 0 && (
        <CompareChart runsMetrics={sel.map((id) => ({ runId: id, metrics: allMetrics[id] || [] }))} />
      )}
      {names.length > 0 && (
        <table className="text-xs w-full mt-3">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-1">指标</th>
              {sel.map((id) => <th key={id} className="text-right py-1">{id.slice(0, 10)}</th>)}
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const best = bestBy(name);
              return (
                <tr key={name} className="border-b border-border">
                  <td className="py-1">{name}</td>
                  {sel.map((id) => {
                    const ms = (allMetrics[id] || []).filter((m) => m.metric_name === name);
                    const v = ms.length ? ms[ms.length - 1].metric_value : null;
                    return (
                      <td key={id} className={`text-right py-1 ${best?.runId === id ? "font-bold text-green-700" : ""}`}>
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
