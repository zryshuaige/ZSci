import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ExternalLink } from "lucide-react";
import { api, type Benchmark } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Dialog";

/** Project-level benchmark discovery (Phase A).
 *
 * Lets the user search standard benchmark datasets/tasks + SOTA numbers for the
 * research direction, via PapersWithCode + HuggingFace. Results are stored
 * server-side and re-shown on reload. The autonomous experiment agent (Phase D)
 * will call the same backend endpoint automatically. */
export default function BenchmarksPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");

  const { data: benchmarks = [], isLoading } = useQuery({
    queryKey: ["benchmarks", projectId],
    queryFn: () => api.listBenchmarks(projectId),
  });

  const searchMutation = useMutation({
    mutationFn: () => api.searchBenchmarks(projectId, { query, limit: 8 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["benchmarks", projectId] }),
  });

  const datasets = benchmarks.filter((b) => b.kind === "dataset");
  const tasks = benchmarks.filter((b) => b.kind === "task");
  const sota = benchmarks.filter((b) => b.kind === "sota");

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">Benchmark 查找</div>
        <div className="text-xs text-muted-foreground">PapersWithCode + HuggingFace</div>
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="研究方向 / 任务关键词,如 image classification"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.trim() && searchMutation.mutate()}
        />
        <Button onClick={() => searchMutation.mutate()} disabled={!query.trim() || searchMutation.isPending}>
          <Search className="h-4 w-4" /> {searchMutation.isPending ? "搜索中…" : "搜索"}
        </Button>
      </div>
      {searchMutation.isError && (
        <div className="text-xs text-destructive">搜索失败:{(searchMutation.error as Error).message}</div>
      )}
      {isLoading ? (
        <Spinner />
      ) : benchmarks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          还没有 benchmark。输入研究方向关键词搜索标准数据集/任务与 SOTA 数字。
        </p>
      ) : (
        <div className="space-y-3">
          {sota.length > 0 && <Group title="SOTA(用于对比)" items={sota} />}
          {tasks.length > 0 && <Group title="任务" items={tasks} />}
          {datasets.length > 0 && <Group title="数据集" items={datasets} />}
        </div>
      )}
    </Card>
  );
}

function Group({ title, items }: { title: string; items: Benchmark[] }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{title}({items.length})</div>
      <div className="space-y-1">
        {items.map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-2 text-xs py-1">
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
