import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

type SortKey = "recent" | "year" | "title";

export default function PapersListPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const { data: papers, isLoading } = useQuery({
    queryKey: ["papers", project.id],
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
      <h1 className="text-xl font-semibold tracking-tight">PDF 阅读</h1>

      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : downloaded.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground animate-pop">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <div className="text-sm">还没有已下载的论文</div>
          <div className="text-xs mt-1.5">
            请先到{" "}
            <Link to={`/projects/${project.id}/literature`} className="text-primary underline">
              文献库
            </Link>{" "}
            搜索并下载
          </div>
        </Card>
      ) : (
        <>
          {/* Filter bar — search + venue + parse-status + sort. Apple-style
              grouped controls in a single glass card. */}
          <Card className="p-3 glass">
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
              <Select value={venue} onChange={setVenue} options={[{ value: "all", label: "全部会议" }, ...venues.map((v) => ({ value: v, label: v }))]} />
              <Select
                value={parseFilter}
                onChange={setParseFilter}
                options={[
                  { value: "all", label: "全部状态" },
                  { value: "success", label: "已解析" },
                  { value: "none", label: "未解析" },
                ]}
              />
              <Select
                value={sort}
                onChange={(v) => setSort(v as SortKey)}
                options={[
                  { value: "recent", label: "最近更新" },
                  { value: "year", label: "年份降序" },
                  { value: "title", label: "标题排序" },
                ]}
              />
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
                        <div className="text-sm text-muted-foreground mt-0.5">
                          {p.authors.slice(0, 3).join(", ")}
                          {p.authors.length > 3 ? " et al." : ""}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {[p.year, p.venue].filter(Boolean).map((x, idx) => (
                            <Badge key={idx} className="bg-muted">{x}</Badge>
                          ))}
                          {p.venue_verified && (
                            <Badge className="bg-accent text-accent-foreground">已验证顶会</Badge>
                          )}
                          <Badge className={cn("bg-muted", p.parse_status === "success" && "bg-green-100 text-green-800")}>
                            {p.parse_status === "success" ? "已解析" : p.parse_status || "未解析"}
                          </Badge>
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

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground transition-colors duration-sm ease-out hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
