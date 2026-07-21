import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Play, Square } from "lucide-react";
import { api, type Metric, type Run } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
export default function ExperimentDetailPage() {
  const { expId } = useParams<{ expId: string }>();
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
            <span className="text-muted-foreground">idea:</span> {exp.hypothesis}
          </p>
        )}
        <div className="text-xs text-muted-foreground mt-1 font-mono">{exp.root_path}</div>
      </div>

      <Card className="p-4 space-y-3">
        <div className="font-medium text-sm">运行命令</div>
        <Textarea rows={2} value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-xs" />
        <div className="flex gap-2 items-center">
          <Input placeholder="seed" value={seed} onChange={(e) => setSeed(e.target.value)} className="w-32" />
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
              停止失败:{(stopMutation.error as Error).message}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          ⚠️ 命令将在实验目录执行,占用本地计算资源。Agent 不直接执行 shell,需你确认(design.md §16.2)。
        </div>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="确认运行命令"
        busy={runMutation.isPending}
        description={
          <div className="text-sm space-y-1">
            <div>工作目录:<code className="bg-muted px-1 rounded text-xs">{exp.slug}</code></div>
            <div>命令:<code className="bg-muted px-1 rounded text-xs break-all">{command}</code></div>
            <div>seed:{seed}</div>
          </div>
        }
        confirmLabel="确认运行"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); runMutation.mutate(); }}
      />

      <div className="grid gap-3">
        <div className="font-medium">运行记录</div>
        {runs.map((r) => (
          <Card key={r.id} className="p-3">
            <div className="flex items-center justify-between">
              <div className="font-mono text-xs">{r.id}</div>
              <Badge className={
                r.status === "completed" ? "bg-green-100 text-green-800" :
                r.status === "failed" || r.status === "stopped" ? "bg-red-100 text-red-800" :
                "bg-blue-100 text-blue-800"
              }>{r.status}</Badge>
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
        {logs || "(等待输出…)"}{done && "\n[run ended]"}
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

function MetricChart({ metrics }: { metrics: Metric[] }) {
  const [logScale, setLogScale] = useState(false);
  // Group by metric_name, render an SVG line chart.
  const byName: Record<string, { step: number; v: number }[]> = {};
  for (const m of metrics) {
    (byName[m.metric_name] ||= []).push({ step: m.step, v: m.metric_value });
  }
  const names = Object.keys(byName);
  const W = 560, H = 200, P = { l: 48, r: 12, t: 14, b: 24 };
  const innerW = W - P.l - P.r;
  const innerH = H - P.t - P.b;

  const rawVals = metrics.map((m) => m.metric_value);
  const allPositive = rawVals.every((v) => v > 0);
  const useLog = logScale && allPositive;
  const transform = (v: number) => (useLog ? Math.log(v) : v);
  const tVals = rawVals.map(transform);
  const minTV = Math.min(...tVals);
  const maxTV = Math.max(...tVals);
  const tRange = maxTV - minTV || 1;
  const maxStep = Math.max(...metrics.map((m) => m.step)) || 1;

  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

  const x = (step: number) => P.l + (step / maxStep) * innerW;
  const y = (v: number) => P.t + innerH - ((transform(v) - minTV) / tRange) * innerH;

  // 4 horizontal gridlines + y tick labels (back-transform to real values).
  const gridLines = Array.from({ length: 4 }, (_, i) => {
    const frac = i / 3;
    const tVal = minTV + frac * tRange;
    const realVal = useLog ? Math.exp(tVal) : tVal;
    return { py: P.t + innerH - frac * innerH, label: fmtNum(realVal) };
  });

  const linePath = (pts: { step: number; v: number }[]) =>
    pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.step).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(" ");

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-muted-foreground">指标曲线({metrics.length} 点)</div>
        <button
          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted disabled:opacity-40"
          onClick={() => setLogScale((s) => !s)}
          disabled={!allPositive}
          title={allPositive ? "切换对数坐标" : "含非正值,无法使用对数坐标"}
        >
          {useLog ? "线性" : "对数"}
        </button>
      </div>
      <svg width={W} height={H} className="border border-border rounded bg-white">
        {/* gridlines + y-axis labels */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={P.l} y1={g.py} x2={W - P.r} y2={g.py} stroke="#e5e7eb" strokeWidth={1} />
            <text x={P.l - 6} y={g.py + 3} fontSize={9} fill="#9ca3af" textAnchor="end">
              {g.label}
            </text>
          </g>
        ))}
        {/* x-axis baseline + step labels */}
        <line x1={P.l} y1={P.t + innerH} x2={W - P.r} y2={P.t + innerH} stroke="#d1d5db" strokeWidth={1} />
        <text x={P.l} y={H - 6} fontSize={9} fill="#9ca3af">step 0</text>
        <text x={W - P.r} y={H - 6} fontSize={9} fill="#9ca3af" textAnchor="end">step {maxStep}</text>
        {/* lines + end-point markers */}
        {names.map((n, i) => {
          const c = colors[i % colors.length];
          const pts = byName[n];
          const last = pts[pts.length - 1];
          return (
            <g key={n}>
              <path d={linePath(pts)} stroke={c} strokeWidth={1.8} fill="none" />
              <circle cx={x(last.step)} cy={y(last.v)} r={2.6} fill={c} />
            </g>
          );
        })}
      </svg>
      <div className="flex gap-3 mt-1 flex-wrap">
        {names.map((n, i) => {
          const last = byName[n][byName[n].length - 1];
          return (
            <span key={n} className="text-xs flex items-center gap-1">
              <span style={{ background: colors[i % colors.length] }} className="w-2.5 h-2.5 inline-block rounded-full" />
              {n} <span className="text-muted-foreground">= {fmtNum(last.v)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
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
      <div className="font-medium mb-2">实验对比(design.md §12.3)</div>
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
      {names.length > 0 && (
        <table className="text-xs w-full">
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
