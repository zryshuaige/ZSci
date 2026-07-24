import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ExternalLink, AlertTriangle, Plus, Trash2, Star, Info, FolderPlus } from "lucide-react";
import { api, type Benchmark, type BenchmarkHit, type Experiment } from "@/lib/api";
import { formatBenchmarkSource, formatBenchmarkTags } from "@/lib/benchmarkTags";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Spinner, ConfirmDialog } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { showFriendlyError } from "@/lib/useFriendlyError";

export default function BenchmarksPanel({
  projectId,
  className,
  compact = false,
}: {
  projectId: string;
  className?: string;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<BenchmarkHit[]>([]);
  const [queryUsed, setQueryUsed] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Benchmark | null>(null);

  const { data: benchmarks = [], isLoading } = useQuery({
    queryKey: ["benchmarks", projectId],
    queryFn: () => api.listBenchmarks(projectId),
  });

  const { data: experiments = [] } = useQuery({
    queryKey: ["experiments", projectId],
    queryFn: () => api.listExperiments(projectId),
  });

  const addedUrls = useMemo(
    () => new Set(benchmarks.map((b) => b.url).filter(Boolean) as string[]),
    [benchmarks],
  );

  const searchMutation = useMutation({
    mutationFn: () => api.searchBenchmarks(projectId, { query, limit: 10 }),
    onSuccess: (r) => {
      setHits(r.hits || r.benchmarks || []);
      setWarnings(r.warnings || []);
      setQueryUsed(r.query_used || []);
    },
    onError: (err) => {
      setHits([]);
      setWarnings([]);
      showFriendlyError(err);
    },
  });

  const addMutation = useMutation({
    mutationFn: (args: { hit: BenchmarkHit; experiment_id?: string | null }) =>
      api.addBenchmark(projectId, {
        ...args.hit,
        experiment_id: args.experiment_id ?? null,
      }),
    onSuccess: (_row, vars) => {
      qc.invalidateQueries({ queryKey: ["benchmarks", projectId] });
      setHits((prev) => prev.filter((h) => h.url !== vars.hit.url || h.name !== vars.hit.name));
    },
  });

  const linkMutation = useMutation({
    mutationFn: (args: { id: string; experiment_id: string | null }) =>
      api.updateBenchmark(args.id, { experiment_id: args.experiment_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["benchmarks", projectId] }),
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
    <Card className={cn("p-4 space-y-3 flex flex-col min-h-0", className)}>
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="font-medium text-sm">数据集与基准</div>
        <div className="text-[11px] text-muted-foreground shrink-0">来自 HuggingFace</div>
      </div>

      <div className={cn("shrink-0", compact ? "space-y-2" : "flex gap-2")}>
        <Input
          placeholder="搜索任务或数据集，如 语义分割、CIFAR"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.trim() && searchMutation.mutate()}
          className={compact ? "w-full" : "flex-1 min-w-0"}
        />
        <div className={cn("flex gap-2", compact && "w-full")}>
          <Button
            onClick={() => searchMutation.mutate()}
            disabled={!query.trim() || searchMutation.isPending}
            className={cn("shrink-0 whitespace-nowrap", compact && "flex-1")}
          >
            <Search className="h-4 w-4" /> {searchMutation.isPending ? "搜索中…" : "搜索"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setAdding(true)}
            className={cn("shrink-0 whitespace-nowrap", compact && "flex-1")}
          >
            <Plus className="h-4 w-4" /> 手动添加
          </Button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 flex gap-2 shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="space-y-1 min-w-0">
            <div>暂时无法连接 HuggingFace（已尝试官方与镜像）。</div>
            <div className="text-muted-foreground">可稍后重试，或点「手动添加」录入已知数据集。</div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        {/* Search results — not saved until user adds */}
        {(hits.length > 0 || searchMutation.isSuccess) && (
          <section>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">
              搜索结果
              <span className="ml-1 opacity-70 font-normal">（未加入项目）</span>
            </div>
            {queryUsed.length > 1 && (
              <div className="text-[11px] text-muted-foreground mb-1.5">
                已同时检索：{queryUsed.join(" · ")}
              </div>
            )}
            {hits.length === 0 ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                没有找到匹配结果。可尝试英文关键词，例如 semantic segmentation。
              </p>
            ) : (
              <div className="space-y-1">
                {hits.map((h) => {
                  const already = !!(h.url && addedUrls.has(h.url));
                  return (
                    <HitRow
                      key={h.url || h.name}
                      hit={h}
                      compact={compact}
                      already={already}
                      busy={addMutation.isPending}
                      onAdd={(experimentId) =>
                        addMutation.mutate({ hit: h, experiment_id: experimentId || null })
                      }
                      experiments={experiments}
                    />
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Project library */}
        <section>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">
            项目已添加
            {!isLoading && <span className="ml-1 opacity-70">({benchmarks.length})</span>}
          </div>
          {isLoading ? (
            <Spinner />
          ) : benchmarks.length === 0 ? (
            <p className="text-xs text-muted-foreground leading-relaxed">
              还没有加入任何数据集。搜索后点「加入项目」，或手动添加。加入后可关联到具体实验，供后续 AI 选用。
            </p>
          ) : (
            <div className="space-y-3">
              {sota.length > 0 && (
                <Group
                  title="最优结果对比"
                  items={sota}
                  experiments={experiments}
                  onDelete={setDeleting}
                  onLink={(id, expId) => linkMutation.mutate({ id, experiment_id: expId })}
                  compact={compact}
                />
              )}
              {tasks.length > 0 && (
                <Group
                  title="任务"
                  items={tasks}
                  experiments={experiments}
                  onDelete={setDeleting}
                  onLink={(id, expId) => linkMutation.mutate({ id, experiment_id: expId })}
                  compact={compact}
                />
              )}
              {datasets.length > 0 && (
                <Group
                  title="数据集"
                  items={datasets}
                  experiments={experiments}
                  onDelete={setDeleting}
                  onLink={(id, expId) => linkMutation.mutate({ id, experiment_id: expId })}
                  compact={compact}
                />
              )}
            </div>
          )}
        </section>
      </div>

      <ManualBenchmarkDialog
        open={adding}
        projectId={projectId}
        experiments={experiments}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          qc.invalidateQueries({ queryKey: ["benchmarks", projectId] });
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        title="从项目移除"
        description={deleting ? `确定移除「${deleting.name}」？` : ""}
        confirmLabel="移除"
        busy={delMutation.isPending}
        onConfirm={() => deleting && delMutation.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </Card>
  );
}

function HitRow({
  hit,
  compact,
  already,
  busy,
  onAdd,
  experiments,
}: {
  hit: BenchmarkHit;
  compact?: boolean;
  already: boolean;
  busy: boolean;
  onAdd: (experimentId?: string) => void;
  experiments: Experiment[];
}) {
  const tags = formatBenchmarkTags(hit.tags, compact ? 2 : 3);
  const [expId, setExpId] = useState("");
  return (
    <div className="rounded-md border border-border/60 px-2 py-2 space-y-1.5 hover:bg-muted/30">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            {hit.url ? (
              <a
                href={hit.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline truncate font-medium text-xs flex items-center gap-1"
              >
                {hit.name} <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              </a>
            ) : (
              <span className="truncate font-medium text-xs">{hit.name}</span>
            )}
            {hit.is_mainstream && (
              <Badge className="bg-amber-100 text-amber-800 gap-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                <Star className="h-2.5 w-2.5 fill-amber-500 stroke-amber-700" />
                主流
              </Badge>
            )}
          </div>
          {hit.description && !compact && (
            <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{hit.description}</div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {tags.map((t) => (
                <span key={t.raw} className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                  {t.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {experiments.length > 0 && (
          <select
            className="h-7 max-w-[9rem] rounded-md border border-input bg-background px-1.5 text-[11px]"
            value={expId}
            onChange={(e) => setExpId(e.target.value)}
          >
            <option value="">加入项目</option>
            {experiments.map((e) => (
              <option key={e.id} value={e.id}>
                引入：{e.title}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          variant={already ? "outline" : "default"}
          disabled={busy || already}
          onClick={() => onAdd(expId || undefined)}
          className="h-7 text-[11px] px-2"
        >
          <FolderPlus className="h-3 w-3" />
          {already ? "已在项目中" : expId ? "引入实验" : "加入项目"}
        </Button>
      </div>
    </div>
  );
}

function Group({
  title,
  items,
  experiments,
  onDelete,
  onLink,
  compact,
}: {
  title: string;
  items: Benchmark[];
  experiments: Experiment[];
  onDelete: (b: Benchmark) => void;
  onLink: (id: string, experimentId: string | null) => void;
  compact?: boolean;
}) {
  const expName = (id: string | null) =>
    id ? experiments.find((e) => e.id === id)?.title || "未知实验" : null;

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1.5 font-medium">
        {title}
        <span className="ml-1 opacity-70">({items.length})</span>
      </div>
      <div className="space-y-1">
        {items.map((b) => {
          const tags = formatBenchmarkTags(b.tags, compact ? 2 : 3);
          return (
            <div
              key={b.id}
              className="flex items-start justify-between gap-2 text-xs py-2 px-2 rounded-md hover:bg-muted/40 group"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  {b.url ? (
                    <a
                      href={b.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline truncate flex items-center gap-1 font-medium text-foreground"
                    >
                      {b.name} <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                    </a>
                  ) : (
                    <span className="truncate font-medium">{b.name}</span>
                  )}
                  {b.is_mainstream && (
                    <Tooltip content="下载量较高或已人工标记的主流基准">
                      <Badge className="bg-amber-100 text-amber-800 gap-0.5 shrink-0 px-1.5 py-0">
                        <Star className="h-2.5 w-2.5 fill-amber-500 stroke-amber-700" />
                        主流
                      </Badge>
                    </Tooltip>
                  )}
                  {b.description && (
                    <Tooltip content={b.description} className="max-w-xs whitespace-normal">
                      <Info className="h-3 w-3 shrink-0 text-muted-foreground/60 hover:text-muted-foreground cursor-help" />
                    </Tooltip>
                  )}
                </div>
                {b.description && !compact && (
                  <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                    {b.description}
                  </div>
                )}
                {tags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {tags.map((t) => (
                      <Tooltip key={t.raw} content={t.category ? `${t.category} · ${t.raw}` : t.raw}>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                          {t.label}
                        </span>
                      </Tooltip>
                    ))}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <select
                    className="h-6 max-w-full rounded border border-input bg-background px-1 text-[10px] text-muted-foreground"
                    value={b.experiment_id || ""}
                    onChange={(e) => onLink(b.id, e.target.value || null)}
                  >
                    <option value="">未关联实验</option>
                    {experiments.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                  {b.experiment_id && (
                    <span className="text-[10px] text-blue-600 truncate max-w-[8rem]">
                      → {expName(b.experiment_id)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0 pt-0.5">
                {b.metric_name && b.metric_value != null && (
                  <span className="font-mono text-muted-foreground whitespace-nowrap text-[11px]">
                    {b.metric_name}={fmt(b.metric_value)}
                  </span>
                )}
                <div className="flex items-center gap-1.5">
                  <Badge className="bg-muted text-muted-foreground font-normal">
                    {formatBenchmarkSource(b.source)}
                  </Badge>
                  <Tooltip content="从项目移除">
                    <button
                      type="button"
                      onClick={() => onDelete(b)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-0.5"
                      aria-label="删除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          );
        })}
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

function ManualBenchmarkDialog({
  open,
  projectId,
  experiments,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  experiments: Experiment[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"dataset" | "task" | "sota">("dataset");
  const [url, setUrl] = useState("");
  const [metricName, setMetricName] = useState("");
  const [metricValue, setMetricValue] = useState("");
  const [description, setDescription] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [isMainstream, setIsMainstream] = useState(false);
  const [experimentId, setExperimentId] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createManualBenchmark(projectId, {
        name: name.trim(),
        kind,
        url: url.trim() || null,
        metric_name: metricName.trim() || null,
        metric_value: metricValue.trim() ? Number(metricValue) : null,
        description: description.trim() || null,
        tags: tagsRaw
          .split(/[,，;；\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
        is_mainstream: isMainstream,
        experiment_id: experimentId || null,
      }),
    onSuccess: () => {
      setName(""); setUrl(""); setMetricName(""); setMetricValue("");
      setDescription(""); setTagsRaw(""); setIsMainstream(false); setKind("dataset");
      setExperimentId("");
      onSaved();
    },
    onError: (err) => showFriendlyError(err),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-lg bg-card p-5 shadow-float animate-pop">
        <h3 className="text-lg font-semibold">手动添加</h3>
        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
          网络不便时，可直接录入已知的数据集或公开最优指标。
        </p>
        <div className="space-y-3 mt-4">
          <Input placeholder="名称，如 ImageNet" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm shrink-0"
              value={kind}
              onChange={(e) => setKind(e.target.value as "dataset" | "task" | "sota")}
            >
              <option value="dataset">数据集</option>
              <option value="task">任务</option>
              <option value="sota">公开最优指标</option>
            </select>
            <Input placeholder="链接（可选）" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1 min-w-0" />
          </div>
          {kind === "sota" && (
            <div className="flex gap-2">
              <Input placeholder="指标名，如 top-1 准确率" value={metricName} onChange={(e) => setMetricName(e.target.value)} className="flex-1 min-w-0" />
              <Input placeholder="数值" value={metricValue} onChange={(e) => setMetricValue(e.target.value)} className="w-28 shrink-0" />
            </div>
          )}
          <Textarea
            rows={2}
            placeholder="一句话说明（可选）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Input
            placeholder="标签，用逗号分隔，如 图像分类、CV"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
          />
          {experiments.length > 0 && (
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={experimentId}
              onChange={(e) => setExperimentId(e.target.value)}
            >
              <option value="">不关联实验</option>
              {experiments.map((e) => (
                <option key={e.id} value={e.id}>{e.title}</option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded"
              checked={isMainstream}
              onChange={(e) => setIsMainstream(e.target.checked)}
            />
            标记为业界主流基准
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border">
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? "添加中…" : "添加"}
          </Button>
        </div>
      </div>
    </div>
  );
}
