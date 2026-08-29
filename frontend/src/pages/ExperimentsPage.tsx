import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FlaskConical, Sparkles, Loader2, AlertTriangle, RotateCw } from "@/components/ui/icons";
import { api, qk, type Project } from "@/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { useActiveWorkflows } from "@/lib/hooks/useActiveWorkflows";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select, SelectOptions } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TONE_CLASSES } from "@/lib/statusMeta";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export default function ExperimentsPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [rq, setRq] = useState("");
  const [hyp, setHyp] = useState("");
  const [relatedIdeaId, setRelatedIdeaId] = useState<string | null>(null);
  const [autonomous, setAutonomous] = useState(false);

  const expsQuery = useQuery({
    queryKey: qk.experiments.byProject(project.id),
    queryFn: () => api.listExperiments(project.id),
  });
  const exps = expsQuery.data ?? [];

  const { data: ideas = [] } = useQuery({
    queryKey: qk.ideas.byProject(project.id),
    queryFn: () => api.listIdeas(project.id),
  });

  // Shared observer — one polling timer for the whole app.
  const { data: workflows } = useActiveWorkflows();

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
        t.experiment_id &&
        // 只认真正在跑的任务；awaiting_approval 的实验让 overall_status
        // 徽章显示「等待你的确认」——标成「运行中」会误导用户以为不用管。
        t.status === "running"
      ) {
        ids.add(t.experiment_id);
      }
    }
    return ids;
  }, [workflows, project.id]);

  const createMutation = useToastMutation({
    mutationFn: () =>
      api.createExperiment(project.id, {
        title,
        research_question: rq,
        hypothesis: hyp,
        related_idea_id: relatedIdeaId || undefined,
      }),
    onSuccess: async (exp) => {
      qc.invalidateQueries({ queryKey: qk.experiments.byProject(project.id) });
      const goAutonomous = autonomous;
      setCreating(false); setTitle(""); setRq(""); setHyp(""); setRelatedIdeaId(null); setAutonomous(false);
      if (goAutonomous) {
        // Surface a failed launch instead of silently navigating on.
        try {
          const r = await api.startAutonomous(exp.id, {});
          window.location.assign(
            `/projects/${project.id}/experiments/${exp.id}?task=${r.task_id}`,
          );
        } catch (err) {
          showFriendlyError(err);
          window.location.assign(`/projects/${project.id}/experiments/${exp.id}`);
        }
      }
    },
  });

  const importIdea = (ideaId: string) => {
    const idea = ideas.find((i) => i.id === ideaId);
    if (!idea) return;
    setTitle(idea.title || title);
    setRq(idea.hypothesis || rq);
    setHyp(idea.motivation || hyp);
    setRelatedIdeaId(idea.id);
  };

  const canSubmit = !!title.trim() && (!autonomous || !!rq.trim());

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-5">
      <PageHeader
        title="实验"
        subtitle="创建与跟踪实验。查找数据集基准请到侧栏旅程的「数据集基准」页；运行中的实验会标出「运行中」。"
        actions={
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <Plus className="h-4 w-4" /> 新建实验
          </Button>
        }
      />

      <main>
        <div className="text-xs font-medium text-muted-foreground mb-2.5">
          我的实验
          {!expsQuery.isLoading && <span className="ml-1 opacity-70">({exps.length})</span>}
        </div>

        {expsQuery.isLoading ? (
          <ListSkeleton rows={3} />
        ) : expsQuery.isError ? (
          <Card className="p-6 text-center">
            <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
            <div className="mt-2 text-sm text-muted-foreground">实验列表加载失败</div>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => expsQuery.refetch()}
            >
              <RotateCw className="h-3.5 w-3.5" /> 重试
            </Button>
          </Card>
        ) : exps.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="h-10 w-10" />}
            title="还没有实验"
            subtitle="点击「新建实验」开始；也可以先到研究想法页，用「用这个想法做实验」一键创建"
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> 新建实验
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {exps.map((e) => {
              const live = runningExpIds.has(e.id);
              return (
                <Link key={e.id} to={`/projects/${project.id}/experiments/${e.id}`}>
                  <Card className={`p-4 hover:shadow-md transition-shadow ${live ? "ring-1 ring-primary/30" : ""}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate flex items-center gap-2">
                          {e.title}
                          {live && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                          )}
                        </div>
                        {e.research_question && (
                          <div className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
                            {e.research_question}
                          </div>
                        )}
                      </div>
                      {/* overall_status is the workflow state; the legacy
                          `status` column carries dead vocabulary. */}
                      {live ? (
                        <StatusBadge status="running" label="运行中" className="shrink-0" />
                      ) : (
                        <StatusBadge status={e.overall_status} className="shrink-0" />
                      )}
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      {/* Create form in a real Modal: Enter submits, Esc closes, first
          input autofocuses. The submit button is disabled with an inline
          reason instead of silently doing nothing. */}
      <Modal
        open={creating}
        onClose={() => { setCreating(false); setAutonomous(false); }}
        title="新建实验"
        busy={createMutation.isPending}
        onSubmit={() => {
          if (canSubmit) createMutation.mutate();
        }}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setCreating(false)} disabled={createMutation.isPending}>
              取消
            </Button>
            <Button type="submit" loading={createMutation.isPending} disabled={!canSubmit}>
              {autonomous ? "创建并启动" : "创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {ideas.length > 0 && (
            <Select
              label="从想法导入"
              value={relatedIdeaId || ""}
              onChange={(e) => (e.target.value ? importIdea(e.target.value) : setRelatedIdeaId(null))}
            >
              <SelectOptions
                placeholder="不导入，手动填写"
                items={ideas.map((i) => ({
                  value: i.id,
                  label: `${i.title || "(未命名)"} · ${i.hypothesis?.slice(0, 40) || "(无假设)"}`,
                }))}
              />
            </Select>
          )}
          <Input placeholder="实验名称" value={title} onChange={(e) => setTitle(e.target.value)} />
          {!title.trim() && (
            <div className="text-xs text-muted-foreground">需要一个实验名称才能创建。</div>
          )}
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
          {autonomous && !rq.trim() && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${TONE_CLASSES.amber.soft}`}>
              请先填写研究问题,再勾选「创建并启动」。
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            将在本地为该实验创建独立的可运行项目目录。
          </div>
        </div>
      </Modal>
    </div>
  );
}
