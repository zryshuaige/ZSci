import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, FolderOpen, Sparkles, ArrowRight, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

const EXAMPLE_IDEAS = [
  "减少大模型在医疗问答中的幻觉",
  "用 AI 辅助医学影像诊断",
  "让教育 AI 更懂学生的学习困难",
  "用多智能体自动完成文献综述",
];

export default function ProjectsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("");
  // H6: track which project is pending deletion so we can show a confirm dialog.
  const [deletingProject, setDeletingProject] = useState<{ id: string; name: string } | null>(null);

  // Phase B: hero state — one-line research idea + "explore this idea" CTA.
  // The CTA either reuses the user's most recent project (so existing
  // research direction + papers aren't lost) or creates a fresh project
  // with the idea as its research_direction.
  const [heroIdea, setHeroIdea] = useState("");
  const [projectIdForIdea, setProjectIdForIdea] = useState<string | null>(null);
  const mostRecentProject = useMemo(
    () => (projects && projects.length > 0 ? projects[0] : null),
    [projects],
  );

  const exploreMutation = useMutation({
    mutationFn: async (idea: string) => {
      const trimmed = idea.trim();
      if (!trimmed) throw new Error("请输入你的研究想法");
      if (projectIdForIdea || mostRecentProject) {
        const targetId = projectIdForIdea ?? mostRecentProject!.id;
        // Reuse existing project — don't create a new one, just navigate.
        return targetId;
      }
      // Create-on-the-fly: name = first 20 chars of the idea, direction = full text.
      const project = await api.createProject({
        name: trimmed.slice(0, 20),
        research_direction: trimmed,
      });
      return project.id;
    },
    onSuccess: (projectId) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      const params = new URLSearchParams({ idea: heroIdea.trim() });
      navigate(`/explore/${projectId}/new?${params.toString()}`);
    },
    onError: (err) => showFriendlyError(err),
  });

  const createMutation = useMutation({
    mutationFn: () => api.createProject({ name, research_direction: direction || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setCreating(false);
      setName("");
      setDirection("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setDeletingProject(null);
    },
  });

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      {/* Phase B: hero 区 — "把一个想法,变成可验证的研究方向"。
          这是用户首次打开 app 看到的第一屏。Hero 下面是已有的项目列表
          (作为"我的研究"workspace)。新建项目按钮降级为次级操作。 */}
      <Card className="p-6 space-y-3 bg-gradient-to-br from-primary/5 to-transparent">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">
            写下你想研究的问题,看看可以怎么往下走
          </h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          用一两句话描述你的研究兴趣,系统会结合项目已有文献梳理可能的切入点,并整理出若干值得进一步评估的方向。
        </p>
        <Textarea
          rows={3}
          placeholder="例如:我想研究如何减少大模型在医疗问答中的幻觉……"
          value={heroIdea}
          onChange={(e) => setHeroIdea(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_IDEAS.map((ex) => (
              <button
                key={ex}
                type="button"
                className="rounded-full bg-muted px-3 py-1 text-xs hover:bg-muted/70 transition-colors"
                onClick={() => setHeroIdea(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
          <Button
            onClick={() => exploreMutation.mutate(heroIdea)}
            disabled={!heroIdea.trim() || exploreMutation.isPending}
          >
            {exploreMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            查看候选方向
          </Button>
        </div>
        {/* 当用户已有项目时,提供"将想法归入"下拉;无项目则不显示。 */}
        {projects && projects.length > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <label className="text-[11px] text-muted-foreground shrink-0">
              归入项目
            </label>
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
              value={projectIdForIdea ?? ""}
              onChange={(e) =>
                setProjectIdForIdea(e.target.value ? e.target.value : null)
              }
            >
              <option value="">按本次输入新建</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground/70">
              · 不选则按你的输入创建新项目
            </span>
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">我的研究方向</h2>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> 新建研究方向
        </Button>
      </div>

      {isLoading && <ListSkeleton rows={3} />}
      {!isLoading && projects?.length === 0 && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="还没有研究方向"
          subtitle="在上方写下你正在思考的研究问题,系统会整理出几个候选方向"
        />
      )}

      <div className="grid gap-3">
        {projects?.map((p, i) => (
          <Card
            key={p.id}
            style={{ animationDelay: `${i * 40}ms` }}
            className="p-4 flex items-center justify-between hover-lift hover:shadow-medium animate-slide-up"
          >
            <Link to={`/projects/${p.id}`} className="flex-1">
              <div className="font-medium">{p.name}</div>
              {p.research_direction && (
                <div className="text-sm text-muted-foreground line-clamp-1">{p.research_direction}</div>
              )}
              <div className="text-xs text-muted-foreground mt-1">
                文献 {p.paper_count} · 已下载 {p.downloaded_count}
              </div>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeletingProject({ id: p.id, name: p.name })}
              title="移除项目"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={creating}
        title="新建研究方向"
        description={
          <div className="space-y-3">
            <p>填写方向名称与简要描述。系统会按此名称归集文献、想法与实验记录。</p>
            <Input
              placeholder="方向名称,例如:视觉语言模型的高效微调与鲁棒性"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Textarea
              placeholder="研究问题或关注重点,例如:在医疗影像上提高诊断准确率,同时保持可解释性"
              rows={3}
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            />
          </div>
        }
        confirmLabel={createMutation.isPending ? "创建中…" : "创建"}
        busy={createMutation.isPending}
        onCancel={() => setCreating(false)}
        onConfirm={() => name.trim() && createMutation.mutate()}
      />

      {/* H6: confirm project deletion so a misclick can't wipe a project. */}
      <ConfirmDialog
        open={!!deletingProject}
        title="移除项目"
        description={
          <div className="space-y-2 text-sm">
            <p>将移除 <span className="font-medium">{deletingProject?.name}</span> 及其相关文献、笔记、实验与写作记录。</p>
            <p className="text-destructive">此操作不可撤销。</p>
          </div>
        }
        confirmLabel="确认移除"
        busy={deleteMutation.isPending}
        onCancel={() => setDeletingProject(null)}
        onConfirm={() => deletingProject && deleteMutation.mutate(deletingProject.id)}
      />
    </div>
  );
}
