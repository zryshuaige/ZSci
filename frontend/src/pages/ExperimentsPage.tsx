import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FlaskConical } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

export default function ExperimentsPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [rq, setRq] = useState("");
  const [hyp, setHyp] = useState("");
  const [relatedIdeaId, setRelatedIdeaId] = useState<string | null>(null);

  const { data: exps = [], isLoading: expsLoading } = useQuery({
    queryKey: ["experiments", project.id],
    queryFn: () => api.listExperiments(project.id),
  });

  // Ideas feed the "import hypothesis" picker in the create dialog.
  const { data: ideas = [] } = useQuery({
    queryKey: ["ideas", project.id],
    queryFn: () => api.listIdeas(project.id),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createExperiment(project.id, {
        title,
        research_question: rq,
        hypothesis: hyp,
        related_idea_id: relatedIdeaId || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["experiments", project.id] });
      setCreating(false); setTitle(""); setRq(""); setHyp(""); setRelatedIdeaId(null);
    },
  });

  // One-click import: copy an idea's hypothesis/motivation into the experiment
  // fields and link the idea. Maps idea.hypothesis -> experiment hypothesis,
  // idea.motivation -> research question (the "why"), idea.title -> experiment title.
  const importIdea = (ideaId: string) => {
    const idea = ideas.find((i) => i.id === ideaId);
    if (!idea) return;
    setTitle(idea.title || title);
    setHyp(idea.hypothesis || hyp);
    setRq(idea.motivation || rq);
    setRelatedIdeaId(idea.id);
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">实验工作台</h1>
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> 新建实验</Button>
      </div>

      <Card className="p-3 text-xs text-muted-foreground">
        新建实验会在项目目录下生成 uv + pyproject.toml 的 Python 实验骨架(src/train.py、configs、scripts、runs)。
        Agent 不自动安装依赖、不自动运行;运行命令需用户确认(design.md §16.2)。stdout 中形如{" "}
        <code className="bg-muted px-1 rounded">METRIC step=&lt;n&gt; &lt;name&gt;=&lt;value&gt;</code> 的行会被解析为指标曲线。
        支持从「研究想法」一键导入 idea。
      </Card>

      {expsLoading ? (
        <ListSkeleton rows={3} />
      ) : exps.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="h-10 w-10" />}
          title="还没有实验"
          subtitle="点击「新建实验」创建,会自动生成 uv + pyproject.toml 骨架"
        />
      ) : (
        <div className="grid gap-3">
          {exps.map((e) => (
            <Link key={e.id} to={`/projects/${project.id}/experiments/${e.id}`}>
              <Card className="p-4 hover:shadow-md transition-shadow">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{e.title}</div>
                    {e.research_question && (
                      <div className="text-sm text-muted-foreground line-clamp-1">{e.research_question}</div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1 font-mono">{e.slug}</div>
                  </div>
                  <Badge className="bg-muted">{e.status}</Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={creating}
        title="新建实验"
        busy={createMutation.isPending}
        description={
          <div className="space-y-2">
            {ideas.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">从研究想法导入(可选)</label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={relatedIdeaId || ""}
                  onChange={(e) => (e.target.value ? importIdea(e.target.value) : setRelatedIdeaId(null))}
                >
                  <option value="">不导入,手动填写</option>
                  {ideas.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title || "(未命名)"} · {i.hypothesis?.slice(0, 40) || "(无 idea)"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Input placeholder="实验名称" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder="研究问题" rows={2} value={rq} onChange={(e) => setRq(e.target.value)} />
            <Textarea
              placeholder="idea(核心想法,待验证)"
              rows={2}
              value={hyp}
              onChange={(e) => setHyp(e.target.value)}
            />
            <div className="text-xs text-muted-foreground">将在本地生成 uv 实验项目骨架。</div>
          </div>
        }
        confirmLabel="创建"
        onCancel={() => setCreating(false)}
        onConfirm={() => title.trim() && createMutation.mutate()}
      />
    </div>
  );
}
