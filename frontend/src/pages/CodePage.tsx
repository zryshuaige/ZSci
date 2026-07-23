import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Trash2, ExternalLink, Github } from "lucide-react";
import { api, type Project, type Repository } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";

const STATUS_COLORS: Record<string, string> = {
  official: "bg-green-100 text-green-800",
  author_affiliated: "bg-blue-100 text-blue-800",
  community: "bg-amber-100 text-amber-800",
  unverified: "bg-muted",
};

export default function CodePage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [selectedPaper, setSelectedPaper] = useState<string>("");
  // H6: track which repo is pending deletion for a confirm dialog.
  const [deletingRepo, setDeletingRepo] = useState<{ id: string; name: string } | null>(null);

  const { data: papers = [] } = useQuery({
    queryKey: ["papers", project.id],
    queryFn: () => api.listPapers(project.id),
  });
  const downloaded = papers.filter((p) => p.downloaded);

  const { data: repos = [] } = useQuery({
    queryKey: ["repos", project.id],
    queryFn: () => api.listRepositories(project.id),
  });

  const searchMutation = useMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "code.search_github", {
        selected_papers: selectedPaper ? [selectedPaper] : downloaded.map((p) => p.id),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos", project.id] }),
  });

  const delMutation = useMutation({
    mutationFn: (id: string) => api.deleteRepository(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["repos", project.id] });
      setDeletingRepo(null);
    },
  });

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">代码仓库</h1>

      <Card className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">
          选择一篇已下载论文，将检索相关代码仓库，并保守判断是否为官方实现。
        </div>
        <div className="flex gap-2 items-center">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm flex-1"
            value={selectedPaper}
            onChange={(e) => setSelectedPaper(e.target.value)}
          >
            <option value="">全部已下载论文({downloaded.length})</option>
            {downloaded.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title.slice(0, 60)}
              </option>
            ))}
          </select>
          <Button
            className="shrink-0 whitespace-nowrap"
            onClick={() => searchMutation.mutate()}
            disabled={searchMutation.isPending || downloaded.length === 0}
          >
            <Search className="h-4 w-4" />
            {searchMutation.isPending ? "检索中…" : "检索代码"}
          </Button>
        </div>
        {searchMutation.isError && (
          <div className="text-sm text-destructive">
            检索失败:{(searchMutation.error as Error).message}
          </div>
        )}
      </Card>

      {searchMutation.isPending && <Spinner />}

      <div className="space-y-2">
        {repos.map((r: Repository) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Github className="h-4 w-4 shrink-0" />
                  <a href={r.repo_url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {r.full_name || r.repo_url}
                  </a>
                  <Badge className={STATUS_COLORS[r.official_status] || "bg-muted"}>
                    {r.official_status}
                  </Badge>
                  {r.license && <Badge className="bg-muted">{r.license}</Badge>}
                  {r.stars != null && <Badge className="bg-muted">★ {r.stars}</Badge>}
                </div>
                {r.evidence && (
                  <p className="text-xs text-muted-foreground mt-2">{r.evidence}</p>
                )}
                <div className="text-xs text-amber-600 mt-1">
                  ⚠️ 仅凭标题相似或 Star 数高不能判定 official;克隆前请人工核对论文/作者主页。
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <a href={r.repo_url} target="_blank" rel="noreferrer">
                  <Button variant="ghost" size="sm"><ExternalLink className="h-4 w-4" /></Button>
                </a>
                <Button variant="ghost" size="icon" onClick={() => setDeletingRepo({ id: r.id, name: r.full_name || r.repo_url })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {repos.length === 0 && !searchMutation.isPending && (
          <EmptyState
            icon={<Github className="h-10 w-10" />}
            title="还没有代码仓库"
            subtitle="选择一篇论文后点击「检索代码」,Agent 会去 GitHub 找相关仓库并判断官方性"
          />
        )}
      </div>

      {/* H6: confirm repository deletion. */}
      <ConfirmDialog
        open={!!deletingRepo}
        title="删除代码仓库"
        description={
          <div className="text-sm space-y-1">
            <p>将删除「{deletingRepo?.name}」的记录(不会删除远端仓库)。</p>
          </div>
        }
        confirmLabel="确认删除"
        busy={delMutation.isPending}
        onCancel={() => setDeletingRepo(null)}
        onConfirm={() => deletingRepo && delMutation.mutate(deletingRepo.id)}
      />
    </div>
  );
}
