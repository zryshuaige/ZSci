import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileText, RotateCw, Search } from "@/components/ui/icons";
import { api, qk, type Project } from "@/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge, ToneBadge } from "@/components/ui/StatusBadge";
import { Input } from "@/components/ui/Input";
import { Select, SelectOptions } from "@/components/ui/Select";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

type SortKey = "recent" | "year" | "title";

export default function PapersListPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const { data: papers, isLoading, isError, refetch } = useQuery({
    queryKey: qk.papers.byProject(project.id),
    queryFn: () => api.listPapers(project.id),
  });

  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState<string>("all");
  const [parseFilter, setParseFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("recent");

  const downloaded = papers?.filter((p) => p.downloaded) ?? [];

  // Derive the venue list from downloaded papers so the filter dropdown always
  // matches what's actually in the project (no hardcoded options).
  const venues = useMemo(() => {
    const s = new Set<string>();
    downloaded.forEach((p) => p.venue && s.add(p.venue));
    return Array.from(s).sort();
  }, [downloaded]);

  const filtered = useMemo(() => {
    let list = downloaded;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.authors.some((a) => a.toLowerCase().includes(q)),
      );
    }
    if (venue !== "all") list = list.filter((p) => p.venue === venue);
    if (parseFilter !== "all")
      list = list.filter((p) => (p.parse_status ?? "none") === parseFilter);
    const sorted = [...list];
    if (sort === "year") sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
    else sorted.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    return sorted;
  }, [downloaded, query, venue, parseFilter, sort]);

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <PageHeader title="PDF 阅读" subtitle="阅读与管理项目内已下载的论文" />

      {/* 三态:加载骨架 / 错误卡+重试(错误≠空,不能渲染成空态)/ 空态给出口 */}
      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : isError ? (
        <Card className="p-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
          <div className="mt-2 text-sm text-muted-foreground">论文列表加载失败</div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => refetch()}
          >
            <RotateCw className="h-3.5 w-3.5" /> 重试
          </Button>
        </Card>
      ) : downloaded.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title="还没有已下载的论文"
          subtitle="到文献库检索并下载论文，或导入本地 PDF,之后回到这里阅读"
          action={
            <Link to={`/projects/${project.id}/literature`}>
              <Button size="sm">
                <Search className="h-4 w-4" /> 去文献库检索
              </Button>
            </Link>
          }
        />
      ) : (
        <>
          {/* Filter bar — search + venue + parse-status + sort. Grouped
              controls in a single plain card. */}
          <Card className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索标题或作者"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-8"
                />
              </div>
              <Select
                label="会议"
                size="sm"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
              >
                <SelectOptions
                  items={[
                    { value: "all", label: "全部" },
                    ...venues.map((v) => ({ value: v, label: v })),
                  ]}
                />
              </Select>
              <Select
                label="状态"
                size="sm"
                value={parseFilter}
                onChange={(e) => setParseFilter(e.target.value)}
              >
                <SelectOptions
                  items={[
                    { value: "all", label: "全部" },
                    { value: "success", label: "已解析" },
                    { value: "none", label: "未解析" },
                  ]}
                />
              </Select>
              <Select
                label="排序"
                size="sm"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <SelectOptions
                  items={[
                    { value: "recent", label: "最近更新" },
                    { value: "year", label: "年份降序" },
                    { value: "title", label: "标题排序" },
                  ]}
                />
              </Select>
            </div>
          </Card>

          {filtered.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-10">
              没有匹配的论文。试试调整搜索或筛选条件。
            </div>
          ) : (
            <div className="grid gap-3">
              {filtered.map((p, i) => (
                <Card
                  key={p.id}
                  style={{ animationDelay: `${i * 35}ms` }}
                  className="p-4 hover-lift hover:shadow-medium animate-slide-up"
                >
                  <Link to={`/projects/${project.id}/papers/${p.id}`} className="block">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium leading-snug line-clamp-2">{p.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {p.authors.slice(0, 3).join(", ")}
                          {p.authors.length > 3 ? " et al." : ""}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {p.year && (
                            <Badge className="bg-muted/70 text-[11px] tabular-nums">{p.year}</Badge>
                          )}
                          {p.venue && (
                            <Badge className="bg-muted/70 text-[11px] max-w-[10rem] truncate">{p.venue}</Badge>
                          )}
                          {p.venue_verified && (
                            <ToneBadge tone="blue">已验证顶会</ToneBadge>
                          )}
                          <StatusBadge status={p.parse_status ?? "none"} />
                        </div>
                      </div>
                      <FileText className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
