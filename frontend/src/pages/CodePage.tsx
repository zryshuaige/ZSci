import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Trash2, ExternalLink, Github } from "@/components/ui/icons";
import { api, qk, type Project, type Repository } from "@/api";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { ToneBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog, Spinner } from "@/components/ui/Dialog";
import { Select, SelectOptions } from "@/components/ui/Select";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { repoSourceMeta, TONE_CLASSES } from "@/lib/statusMeta";

export default function CodePage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [selectedPaper, setSelectedPaper] = useState<string>("");
  // H6: track which repo is pending deletion for a confirm dialog.
  const [deletingRepo, setDeletingRepo] = useState<{ id: string; name: string } | null>(null);

  const { data: papers = [] } = useQuery({
    queryKey: qk.papers.byProject(project.id),
    queryFn: () => api.listPapers(project.id),
  });
  const downloaded = papers.filter((p) => p.downloaded);

  // 列表加载期间渲染骨架行 —— 否则首次进入会先闪一下空态再出内容。
  const reposQuery = useQuery({
    queryKey: qk.repos.byProject(project.id),
    queryFn: () => api.listRepositories(project.id),
  });
  const repos = reposQuery.data ?? [];

  // 检索是后台 Agent 任务:提交成功 ≠ 已有结果,所以成功提示只说「已启动」。
  const searchMutation = useToastMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "code.search_github", {
        selected_papers: selectedPaper ? [selectedPaper] : downloaded.map((p) => p.id),
      }),
    successMessage: "检索任务已启动,完成后仓库会出现在下方列表",
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.repos.byProject(project.id) }),
  });

  const delMutation = useToastMutation({
    mutationFn: (id: string) => api.deleteRepository(id),
    successMessage: "已删除记录",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.repos.byProject(project.id) });
      setDeletingRepo(null);
    },
  });

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <PageHeader title="代码" subtitle="关联论文的官方/社区代码仓库" />

      <Card className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">
          选择一篇已下载论文，将检索相关代码仓库，并保守判断是否为官方实现。
        </div>
        <div className="flex gap-2 items-center">
          <div className="flex-1 min-w-0">
            <Select
              value={selectedPaper}
              onChange={(e) => setSelectedPaper(e.target.value)}
              aria-label="选择论文"
            >
              <SelectOptions
                placeholder={`全部已下载论文(${downloaded.length})`}
                items={downloaded.map((p) => ({
                  value: p.id,
                  label: p.title.slice(0, 60),
                }))}
              />
            </Select>
          </div>
          <Button
            className="shrink-0 whitespace-nowrap"
            onClick={() => searchMutation.mutate()}
            loading={searchMutation.isPending}
            disabled={downloaded.length === 0}
          >
            <Search className="h-4 w-4" />
            {searchMutation.isPending ? "检索中…" : "检索代码"}
          </Button>
        </div>
      </Card>

      {searchMutation.isPending && <Spinner />}

      <div className="space-y-2">
        {reposQuery.isLoading ? (
          <ListSkeleton rows={3} />
        ) : (
          <>
            {repos.map((r: Repository) => (
              <Card key={r.id} className="p-4 hover:border-primary/25 transition-colors duration-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Github className="h-4 w-4 shrink-0" />
                      <a href={r.repo_url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        {r.full_name || r.repo_url}
                      </a>
                      <ToneBadge tone={repoSourceMeta(r.official_status).tone}>
                        {repoSourceMeta(r.official_status).label}
                      </ToneBadge>
                      {r.license && <Badge className="bg-muted">{r.license}</Badge>}
                      {r.stars != null && <Badge className="bg-muted">★ {r.stars}</Badge>}
                    </div>
                    {r.evidence && (
                      <p className="text-xs text-muted-foreground mt-2">{r.evidence}</p>
                    )}
                    <div className={`text-xs mt-1 ${TONE_CLASSES.amber.text}`}>
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
                action={
                  downloaded.length > 0 ? (
                    <Button onClick={() => searchMutation.mutate()} loading={searchMutation.isPending}>
                      <Search className="h-4 w-4" /> 检索代码
                    </Button>
                  ) : (
                    // 没有已下载论文时检索无从谈起,空态直接给出旅程上一步。
                    <Link to={`/projects/${project.id}/literature`}>
                      <Button variant="outline">先去检索并下载论文</Button>
                    </Link>
                  )
                }
              />
            )}
          </>
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
        danger
        busy={delMutation.isPending}
        onCancel={() => setDeletingRepo(null)}
        onConfirm={() => deletingRepo && delMutation.mutate(deletingRepo.id)}
      />
    </div>
  );
}
