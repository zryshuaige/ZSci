import { useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FlaskConical, Sparkles, Loader2 } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { experimentStatusLabel } from "@/lib/labels";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import BenchmarksPanel from "@/components/BenchmarksPanel";

function statusClass(status: string, isLiveRunning: boolean): string {
  if (isLiveRunning || status === "running") return "bg-blue-100 text-blue-800";
  if (status === "done") return "bg-green-100 text-green-800";
  if (status === "failed" || status === "smoke_failed") return "bg-red-100 text-red-800";
  if (status === "generated" || status === "scaffolded") return "bg-amber-100 text-amber-800";
  return "bg-muted text-muted-foreground";
}

export default function ExperimentsPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [rq, setRq] = useState("");
  const [hyp, setHyp] = useState("");
  const [relatedIdeaId, setRelatedIdeaId] = useState<string | null>(null);
  const [autonomous, setAutonomous] = useState(false);

  const { data: exps = [], isLoading: expsLoading } = useQuery({
    queryKey: ["experiments", project.id],
    queryFn: () => api.listExperiments(project.id),
  });

  const { data: ideas = [] } = useQuery({
    queryKey: ["ideas", project.id],
    queryFn: () => api.listIdeas(project.id),
  });

  const { data: workflows } = useQuery({
    queryKey: ["workflows", "active"],
    queryFn: () => api.listActiveWorkflows(),
    refetchInterval: 3000,
  });

  const runningExpIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of workflows?.runs ?? []) {
      if (r.project_id === project.id) ids.add(r.experiment_id);
    }
    for (const t of workflows?.tasks ?? []) {
      if (
        !t.recent &&
        t.project_id === project.id &&
        t.task_type === "experiment.autonomous_run" &&
        t.experiment_id
      ) {
        ids.add(t.experiment_id);
      }
    }
    return ids;
  }, [workflows, project.id]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createExperiment(project.id, {
        title,
        research_question: rq,
        hypothesis: hyp,
        related_idea_id: relatedIdeaId || undefined,
      }),
    onSuccess: async (exp) => {
      qc.invalidateQueries({ queryKey: ["experiments", project.id] });
      const goAutonomous = autonomous;
      setCreating(false); setTitle(""); setRq(""); setHyp(""); setRelatedIdeaId(null); setAutonomous(false);
      if (goAutonomous) {
        let taskId: string | null = null;
        try {
          const r = await api.startAutonomous(exp.id, {});
          taskId = r.task_id;
        } catch {
          taskId = null;
        }
        navigate(`/projects/${project.id}/experiments/${exp.id}${taskId ? `?task=${taskId}` : ""}`);
      }
    },
  });

  const importIdea = (ideaId: string) => {
    const idea = ideas.find((i) => i.id === ideaId);
    if (!idea) return;
    setTitle(idea.title || title);
    setHyp(idea.hypothesis || hyp);
    setRq(idea.motivation || rq);
    setRelatedIdeaId(idea.id);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-6 pt-6 pb-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">实验工作台</h1>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            左侧查找并加入数据集基准，右侧创建与跟踪实验。运行中的实验会标出「运行中」。
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="shrink-0">
          <Plus className="h-4 w-4" /> 新建实验
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 flex-col lg:flex-row gap-4 px-6 pb-6">
        <aside className="w-full lg:w-80 xl:w-96 shrink-0 flex flex-col min-h-0 max-h-[42vh] lg:max-h-none">
          <BenchmarksPanel projectId={project.id} compact className="flex-1 h-full" />
        </aside>

        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
          <div className="text-xs font-medium text-muted-foreground mb-2.5">
            我的实验
            {!expsLoading && <span className="ml-1 opacity-70">({exps.length})</span>}
          </div>

          {expsLoading ? (
            <ListSkeleton rows={3} />
          ) : exps.length === 0 ? (
            <EmptyState
              icon={<FlaskConical className="h-10 w-10" />}
              title="还没有实验"
              subtitle="点击「新建实验」开始，可从研究想法一键导入假设"
            />
          ) : (
            <div className="grid gap-3">
              {exps.map((e) => {
                const live = runningExpIds.has(e.id);
                return (
                  <Link key={e.id} to={`/projects/${project.id}/experiments/${e.id}`}>
                    <Card className={`p-4 hover:shadow-md transition-shadow ${live ? "ring-1 ring-blue-200" : ""}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium truncate flex items-center gap-2">
                            {e.title}
                            {live && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600 shrink-0" />
                            )}
                          </div>
                          {e.research_question && (
                            <div className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
                              {e.research_question}
                            </div>
                          )}
                        </div>
                        <Badge className={`shrink-0 ${statusClass(e.status, live)}`}>
                          {live ? "运行中" : experimentStatusLabel(e.status)}
                        </Badge>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </main>
      </div>

      <ConfirmDialog
        open={creating}
        title="新建实验"
        busy={createMutation.isPending}
        description={
          <div className="space-y-2">
            {ideas.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">从研究想法导入（可选）</label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={relatedIdeaId || ""}
                  onChange={(e) => (e.target.value ? importIdea(e.target.value) : setRelatedIdeaId(null))}
                >
                  <option value="">不导入，手动填写</option>
                  {ideas.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title || "（未命名）"} · {i.hypothesis?.slice(0, 40) || "（无假设）"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Input placeholder="实验名称" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder="研究问题" rows={2} value={rq} onChange={(e) => setRq(e.target.value)} />
            <Textarea
              placeholder="核心假设（待验证的想法）"
              rows={2}
              value={hyp}
              onChange={(e) => setHyp(e.target.value)}
            />
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={autonomous}
                onChange={(e) => setAutonomous(e.target.checked)}
              />
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              创建后启动自主实验助手（查找基准 → 生成代码 → 自检 → 运行）
            </label>
            <div className="text-xs text-muted-foreground">
              将在本地为该实验创建独立的可运行项目目录。
            </div>
          </div>
        }
        confirmLabel={autonomous ? "创建并启动" : "创建"}
        onCancel={() => { setCreating(false); setAutonomous(false); }}
        onConfirm={() => title.trim() && createMutation.mutate()}
      />
    </div>
  );
}
