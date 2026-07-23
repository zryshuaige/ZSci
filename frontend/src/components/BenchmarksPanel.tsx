import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ExternalLink, AlertTriangle, Plus, Trash2 } from "lucide-react";
import { api, type Benchmark } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Spinner, ConfirmDialog } from "@/components/ui/Dialog";

/** Project-level benchmark discovery (Phase A).
 *
 * Lets the user search standard benchmark datasets + SOTA numbers for the
 * research direction via HuggingFace (PapersWithCode was acquired by HF and its
 * API now redirects there, so it's no longer a separate source). Results are
 * stored server-side and re-shown on reload; the autonomous experiment agent
 * calls the same backend endpoint automatically.
 *
 * Network notes: huggingface.co is auto-fallback'd to the hf-mirror.com mirror
 * on connect failure; if both fail the backend returns `warnings`. As a
 * never-blocked fallback the user can also add a benchmark by hand ("手动添加")
 * - useful when the network can't reach HF at all but the user already knows the
 * dataset/SOTA number. */
export default function BenchmarksPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Benchmark | null>(null);

  const { data: benchmarks = [], isLoading } = useQuery({
    queryKey: ["benchmarks", projectId],
    queryFn: () => api.listBenchmarks(projectId),
  });

  const searchMutation = useMutation({
    mutationFn: () => api.searchBenchmarks(projectId, { query, limit: 8 }),
    onSuccess: (r) => {
      setWarnings(r.warnings || []);
      qc.invalidateQueries({ queryKey: ["benchmarks", projectId] });
    },
    onError: () => setWarnings([]),
  });

  const delMutation = useMutation({
    mutationFn: (id: string) => api.deleteBenchmark(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["benchmarks", projectId] });
      setDeleting(null);
    },
  });

  const datasets = benchmarks.filter((b) => b.kind === "dataset");
  const tasks = benchmarks.filter((b) => b.kind === "task");
  const sota = benchmarks.filter((b) => b.kind === "sota");

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">Benchmark 查找</div>
        <div className="text-xs text-muted-foreground">HuggingFace Datasets</div>
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="研究方向 / 任务关键词,如 image classification"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.trim() && searchMutation.mutate()}
          className="flex-1 min-w-0"
        />
        <Button
          onClick={() => searchMutation.mutate()}
          disabled={!query.trim() || searchMutation.isPending}
          className="shrink-0 whitespace-nowrap"
        >
          <Search className="h-4 w-4" /> {searchMutation.isPending ? "搜索中…" : "搜索"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setAdding(true)}
          className="shrink-0 whitespace-nowrap"
          title="网络不通时手动添加 benchmark"
        >
          <Plus className="h-4 w-4" /> 手动添加
        </Button>
      </div>
      {searchMutation.isError && (
        <div className="text-xs text-destructive">搜索失败:{(searchMutation.error as Error).message}</div>
      )}
      {/* Surface source-level failures so an empty list isn't mistaken for "no
          matches". The backend already auto-falls back to a mirror; if both
          fail, tell the user how to configure an endpoint/proxy or add manually. */}
      {warnings.length > 0 && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div>HuggingFace 请求失败(已尝试官方 + 镜像):</div>
            {warnings.map((w, i) => (
              <div key={i} className="font-mono text-[11px] break-all">{w}</div>
            ))}
            <div>
              可在 <code className="bg-amber-100 px-1 rounded">backend/.env</code> 设置{" "}
              <code className="bg-amber-100 px-1 rounded">ZSCI_HF_ENDPOINT=https://hf-mirror.com</code>{" "}
              跳过官方直连,或设 <code className="bg-amber-100 px-1 rounded">HTTPS_PROXY</code> 走代理;
              也可点「手动添加」直接录入已知 benchmark。
            </div>
          </div>
        </div>
      )}
      {isLoading ? (
        <Spinner />
      ) : benchmarks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {warnings.length > 0
            ? "本次搜索未拿到结果(见上方告警),可手动添加。"
            : "还没有 benchmark。输入关键词搜索,或网络不通时点「手动添加」录入已知数据集/SOTA。"}
        </p>
      ) : (
        <div className="space-y-3">
          {sota.length > 0 && <Group title="SOTA(用于对比)" items={sota} onDelete={setDeleting} />}
          {tasks.length > 0 && <Group title="任务" items={tasks} onDelete={setDeleting} />}
          {datasets.length > 0 && <Group title="数据集" items={datasets} onDelete={setDeleting} />}
        </div>
      )}

      <ManualBenchmarkDialog
        open={adding}
        projectId={projectId}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          qc.invalidateQueries({ queryKey: ["benchmarks", projectId] });
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        title="删除 benchmark"
        description={deleting ? `确定删除「${deleting.name}」?` : ""}
        confirmLabel="删除"
        busy={delMutation.isPending}
        onConfirm={() => deleting && delMutation.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </Card>
  );
}

function Group({
  title,
  items,
  onDelete,
}: {
  title: string;
  items: Benchmark[];
  onDelete: (b: Benchmark) => void;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{title}({items.length})</div>
      <div className="space-y-1">
        {items.map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-2 text-xs py-1 group">
            <div className="min-w-0 flex items-center gap-1">
              {b.url ? (
                <a
                  href={b.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline truncate flex items-center gap-1"
                >
                  {b.name} <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              ) : (
                <span className="truncate">{b.name}</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {b.metric_name && b.metric_value != null && (
                <span className="font-mono text-muted-foreground">
                  {b.metric_name}={fmt(b.metric_value)}
                </span>
              )}
              <Badge className="bg-muted">{b.source}</Badge>
              <button
                onClick={() => onDelete(b)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                title="删除"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4);
}

/** Inline form to add a benchmark by hand (never-blocked fallback). */
function ManualBenchmarkDialog({
  open,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"dataset" | "task" | "sota">("dataset");
  const [url, setUrl] = useState("");
  const [metricName, setMetricName] = useState("");
  const [metricValue, setMetricValue] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createManualBenchmark(projectId, {
        name: name.trim(),
        kind,
        url: url.trim() || null,
        metric_name: metricName.trim() || null,
        metric_value: metricValue.trim() ? Number(metricValue) : null,
      }),
    onSuccess: () => {
      setName(""); setUrl(""); setMetricName(""); setMetricValue(""); setKind("dataset");
      onSaved();
    },
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-float animate-pop space-y-3">
        <h3 className="text-lg font-semibold">手动添加 benchmark</h3>
        <p className="text-xs text-muted-foreground">
          网络无法访问 HuggingFace 时,可直接录入已知的数据集/SOTA 数字,自主实验的对比会用到它。
        </p>
        <div className="space-y-2">
          <Input placeholder="名称(如 ImageNet / ImageNet SOTA)" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm shrink-0"
              value={kind}
              onChange={(e) => setKind(e.target.value as "dataset" | "task" | "sota")}
            >
              <option value="dataset">数据集</option>
              <option value="task">任务</option>
              <option value="sota">SOTA 数字</option>
            </select>
            <Input placeholder="链接(可选)" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1 min-w-0" />
          </div>
          {kind === "sota" && (
            <div className="flex gap-2">
              <Input placeholder="指标名(如 top-1 acc)" value={metricName} onChange={(e) => setMetricName(e.target.value)} className="flex-1 min-w-0" />
              <Input placeholder="数值(如 0.910)" value={metricValue} onChange={(e) => setMetricValue(e.target.value)} className="w-32 shrink-0" />
            </div>
          )}
        </div>
        {create.isError && (
          <div className="text-xs text-destructive">添加失败:{(create.error as Error).message}</div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? "添加中…" : "添加"}
          </Button>
        </div>
      </div>
    </div>
  );
}
