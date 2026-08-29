import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, FolderOpen, Sparkles, ArrowRight, AlertTriangle, RotateCw, BookOpen, Download, Settings, Hourglass, Loader2 } from "@/components/ui/icons";
import { api, qk } from "@/api";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { useLLMReadiness } from "@/lib/hooks/useLLMReadiness";
import { useActiveWorkflows } from "@/lib/hooks/useActiveWorkflows";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Modal } from "@/components/ui/Modal";
import { Select, SelectOptions } from "@/components/ui/Select";
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
  const projectsQuery = useQuery({
    queryKey: qk.projects.all,
    queryFn: api.listProjects,
  });
  const projects = projectsQuery.data;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("");

  // 项目卡上的「注意力」信号:哪些项目有实验在等确认 / 在跑。
  // 复用全局 useActiveWorkflows 观察者,零新增请求。
  const { data: workflows } = useActiveWorkflows();
  const projectAttention = useMemo(() => {
    const map = new Map<string, { waiting: number; running: number }>();
    for (const t of workflows?.tasks ?? []) {
      if (t.recent || t.task_type !== "experiment.autonomous_run" || !t.project_id) continue;
      const e = map.get(t.project_id) ?? { waiting: 0, running: 0 };
      if (t.status === "awaiting_approval") e.waiting += 1;
      else if (t.status === "running") e.running += 1;
      map.set(t.project_id, e);
    }
    return map;
  }, [workflows]);
  // H6: track which project is pending deletion so we can show a confirm dialog.
  const [deletingProject, setDeletingProject] = useState<{ id: string; name: string } | null>(null);

  // Phase B: hero state — one-line research idea + "explore this idea" CTA.
  // The CTA either reuses the user's most recent project (so existing
  // research direction + papers aren't lost) or creates a fresh project
  // with the idea as its research_direction.
  const [heroIdea, setHeroIdea] = useState("");
  const [projectIdForIdea, setProjectIdForIdea] = useState<string | null>(null);
  // Ref so the empty-state CTA can bring the user straight back to the hero
  // input — 空态必须给出「下一步去哪」,而不是只陈述事实。
  const heroInputRef = useRef<HTMLTextAreaElement | null>(null);
  // 首启预检：未配置模型时，hero 提交前先引导去设置，而不是点了才撞 503。
  const llm = useLLMReadiness();
  const mostRecentProject = useMemo(
    () => (projects && projects.length > 0 ? projects[0] : null),
    [projects],
  );

  const exploreMutation = useToastMutation({
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
      qc.invalidateQueries({ queryKey: qk.projects.all });
      const params = new URLSearchParams({ idea: heroIdea.trim() });
      navigate(`/projects/${projectId}/explore/new?${params.toString()}`);
    },
    // onError 默认走 toast(禁止静默失败),无需显式传入。
  });

  const createMutation = useToastMutation({
    mutationFn: () => api.createProject({ name, research_direction: direction || undefined }),
    successMessage: "已创建研究项目",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.projects.all });
      setCreating(false);
      setName("");
      setDirection("");
    },
  });

  const deleteMutation = useToastMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    successMessage: "已移除项目",
    onSuccess: (_data, deletedId) => {
      qc.invalidateQueries({ queryKey: qk.projects.all });
      // If the hero's "归入项目" selector pointed at the project just removed,
      // reset it — otherwise the next explore would navigate to a dead id.
      if (projectIdForIdea === deletedId) setProjectIdForIdea(null);
      setDeletingProject(null);
    },
  });

  const canCreate = !!name.trim();

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      {/* Phase B: hero 区 — "把一个想法,变成可验证的研究方向"。
          这是用户首次打开 app 看到的第一屏。Hero 下面是已有的项目列表
          (作为"我的研究"workspace)。新建项目按钮降级为次级操作。 */}
      <Card className="relative overflow-hidden rounded-2xl p-8 space-y-3 border-primary/15 bg-gradient-to-br from-primary/[0.08] via-primary/[0.02] to-transparent">
        {/* 装饰光斑：给首屏加氛围，纯 CSS、零运行时成本。 */}
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-10 h-56 w-56 rounded-full bg-indigo-400/10 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-indigo-500 text-white shadow-md">
            <Sparkles className="h-4.5 w-4.5" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">
            写下你想研究的问题,看看可以怎么往下走
          </h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          用一两句话描述你的研究兴趣,系统会结合项目已有文献梳理可能的切入点,并整理出若干值得进一步评估的方向。
        </p>
        <Textarea
          ref={heroInputRef}
          rows={3}
          placeholder="例如:我想研究如何减少大模型在医疗问答中的幻觉……"
          value={heroIdea}
          onChange={(e) => setHeroIdea(e.target.value)}
        />
        {/* 预检：模型未配置时，在提交按钮上方给出明确出口（首访第一步不撞墙）。 */}
        {llm.ready === false && heroIdea.trim() && (
          <div className="rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-amber-800">
              整理候选方向需要调用 AI 模型 —— 你还没有配置 API Key。
            </p>
            <Link to="/settings">
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs">
                <Settings className="h-3.5 w-3.5" /> 去配置模型
              </Button>
            </Link>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_IDEAS.map((ex) => (
              <button
                key={ex}
                type="button"
                className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors duration-sm"
                onClick={() => setHeroIdea(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
          <Button
            onClick={() => exploreMutation.mutate(heroIdea)}
            loading={exploreMutation.isPending}
            disabled={!heroIdea.trim()}
          >
            <ArrowRight className="h-4 w-4" />
            查看候选方向
          </Button>
        </div>
        {/* 当用户已有项目时,提供"将想法归入"下拉;无项目则不显示。 */}
        {projects && projects.length > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <Select
              size="sm"
              label="归入项目"
              className="text-xs"
              value={projectIdForIdea ?? ""}
              onChange={(e) =>
                setProjectIdForIdea(e.target.value ? e.target.value : null)
              }
            >
              <SelectOptions
                placeholder="按本次输入新建"
                items={projects.map((p) => ({ value: p.id, label: p.name }))}
              />
            </Select>
            <span className="text-[11px] text-muted-foreground/70">
              不选则按你的输入创建新项目
            </span>
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">我的研究项目</h2>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> 新建研究项目
        </Button>
      </div>

      {/* 三态分离:加载骨架 / 错误卡(可重试)/ 空态(带出口)/ 列表。
          错误绝不渲染成空态 —— 错误 ≠ 空。 */}
      {projectsQuery.isLoading ? (
        <ListSkeleton rows={3} />
      ) : projectsQuery.isError ? (
        <Card className="p-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
          <div className="mt-2 text-sm text-muted-foreground">研究项目列表加载失败</div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => projectsQuery.refetch()}
          >
            <RotateCw className="h-3.5 w-3.5" /> 重试
          </Button>
        </Card>
      ) : projects?.length === 0 ? (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="还没有研究项目"
          subtitle="在上方写下你正在思考的研究问题,系统会整理出几个候选方向"
          action={
            <Button
              variant="outline"
              onClick={() => {
                heroInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                heroInputRef.current?.focus();
              }}
            >
              <Sparkles className="h-4 w-4" /> 写下研究问题
            </Button>
          }
        />
      ) : null}

      <div className="grid gap-3">
        {projects?.map((p, i) => {
          const attn = projectAttention.get(p.id);
          return (
            <Card
              key={p.id}
              style={{ animationDelay: `${i * 40}ms` }}
              className={`px-4 py-2.5 flex items-center justify-between hover-lift hover:shadow-medium animate-slide-up ${attn?.waiting ? "border-amber-300/70" : "hover:border-primary/25"}`}
            >
              <Link to={`/projects/${p.id}`} className="flex-1 min-w-0">
                <div className="font-medium">{p.name}</div>
                {p.research_direction && (
                  <div className="text-sm text-muted-foreground line-clamp-1">{p.research_direction}</div>
                )}
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
                  <BookOpen className="h-3 w-3" />
                  文献 <span className="tabular-nums">{p.paper_count}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <Download className="h-3 w-3" />
                  已下载 <span className="tabular-nums">{p.downloaded_count}</span>
                  {!!attn?.waiting && (
                    <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                      <Hourglass className="h-3 w-3" />
                      {attn.waiting} 个实验等你确认
                    </span>
                  )}
                  {!!attn?.running && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {attn.running} 个实验运行中
                    </span>
                  )}
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
          );
        })}
      </div>

      {/* 新建表单用 Modal(Enter 提交 / Esc 关闭 / 自动聚焦);确认按钮在
          标题为空时禁用并给出内联提示,而不是点了没反应。 */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="新建研究项目"
        description="填写方向名称与简要描述。系统会按此名称归集文献、想法与实验记录。"
        busy={createMutation.isPending}
        onSubmit={() => {
          if (canCreate) createMutation.mutate();
        }}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setCreating(false)} disabled={createMutation.isPending}>
              取消
            </Button>
            <Button type="submit" loading={createMutation.isPending} disabled={!canCreate}>
              创建
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            placeholder="方向名称,例如:视觉语言模型的高效微调与鲁棒性"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {!canCreate && (
            <div className="text-xs text-muted-foreground">需要一个方向名称才能创建。</div>
          )}
          <Textarea
            placeholder="研究问题或关注重点,例如:在医疗影像上提高诊断准确率,同时保持可解释性"
            rows={3}
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />
        </div>
      </Modal>

      {/* H6: confirm project deletion so a misclick can't wipe a project. */}
      <ConfirmDialog
        open={!!deletingProject}
        title="移除项目"
        danger
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
