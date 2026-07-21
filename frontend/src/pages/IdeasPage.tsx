import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Trash2, Sparkles, Plus, Pencil, ChevronDown } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

// DB stores english status values; map to natural Chinese for display so the
// UI doesn't mix raw english tokens ("hypothesis"/"backlog") into Chinese text.
const STATUS_LABEL: Record<string, string> = {
  backlog: "待评估",
  hypothesis: "待验证",
  decision: "已采纳",
  rejected: "已否决",
};
const STATUS_COLORS: Record<string, string> = {
  backlog: "bg-muted",
  hypothesis: "bg-blue-100 text-blue-800",
  decision: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};
const STATUS_ORDER: (keyof typeof STATUS_LABEL)[] = ["backlog", "hypothesis", "decision", "rejected"];

export default function IdeasPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [hyp, setHyp] = useState("");
  const [motiv, setMotiv] = useState("");
  // H6: track which idea is pending deletion for a confirm dialog.
  const [deletingIdea, setDeletingIdea] = useState<{ id: string; title: string | null } | null>(null);
  // Editing state: a copy of the idea being edited, surfaced in a dialog.
  const [editing, setEditing] = useState<{ id: string; title: string; hypothesis: string; motivation: string } | null>(null);
  const [statusMenuFor, setStatusMenuFor] = useState<string | null>(null);

  const { data: ideas = [], isLoading: ideasLoading } = useQuery({
    queryKey: ["ideas", project.id],
    queryFn: () => api.listIdeas(project.id),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createIdea(project.id, { title, hypothesis: hyp, motivation: motiv, status: "backlog" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ideas", project.id] });
      setCreating(false); setTitle(""); setHyp(""); setMotiv("");
    },
  });

  const delMutation = useMutation({
    mutationFn: (id: string) => api.deleteIdea(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ideas", project.id] });
      setDeletingIdea(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (args: { id: string; body: Partial<{ title: string; hypothesis: string; motivation: string; status: string }> }) =>
      api.updateIdea(args.id, args.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ideas", project.id] }),
  });

  const genMutation = useMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "research.generate_hypothesis", { user_request: project.research_direction || "" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ideas", project.id] }),
  });

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">研究想法</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 手动添加
          </Button>
          <Button onClick={() => genMutation.mutate()} disabled={genMutation.isPending}>
            <Sparkles className="h-4 w-4" />
            {genMutation.isPending ? "生成中…" : "Agent 生成 idea"}
          </Button>
        </div>
      </div>

      {genMutation.isError && (
        <Card className="p-3 text-sm text-destructive animate-pop">
          生成失败:{(genMutation.error as Error).message}
          <div className="text-xs mt-1 opacity-80">提示:Agent 需要 LLM。在设置页配置模型后重试。</div>
        </Card>
      )}

      {ideasLoading ? (
        <ListSkeleton rows={3} />
      ) : ideas.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground animate-pop">
          <Lightbulb className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <div className="text-sm">还没有研究想法</div>
          <div className="text-xs mt-1.5">可手动添加,或点击"Agent 生成 idea"基于已下载论文生成可验证的 idea</div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {ideas.map((idea, i) => (
            <Card
              key={idea.id}
              style={{ animationDelay: `${i * 40}ms` }}
              className="p-5 animate-slide-up hover-lift"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{idea.title || "(未命名)"}</span>
                    {/* Status switcher — a compact dropdown instead of a static badge. */}
                    <div className="relative">
                      <button
                        onClick={() => setStatusMenuFor(statusMenuFor === idea.id ? null : idea.id)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-sm ease-out hover:opacity-85",
                          STATUS_COLORS[idea.status] || "bg-muted"
                        )}
                      >
                        {STATUS_LABEL[idea.status] || idea.status}
                        <ChevronDown className="h-3 w-3" />
                      </button>
                      {statusMenuFor === idea.id && (
                        <>
                          <div className="fixed inset-0 z-30" onClick={() => setStatusMenuFor(null)} />
                          <div className="absolute left-0 top-full mt-1 z-40 w-32 rounded-lg border border-border bg-card shadow-float p-1 animate-pop origin-top-left">
                            {STATUS_ORDER.map((s) => (
                              <button
                                key={s}
                                onClick={() => {
                                  setStatusMenuFor(null);
                                  updateMutation.mutate({ id: idea.id, body: { status: s } });
                                }}
                                className={cn(
                                  "w-full text-left rounded-md px-2.5 py-1.5 text-xs transition-colors duration-sm ease-out hover:bg-muted",
                                  idea.status === s && "font-medium bg-muted"
                                )}
                              >
                                {STATUS_LABEL[s]}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  {idea.hypothesis && (
                    <div className="text-sm mt-2 leading-relaxed">
                      <span className="text-muted-foreground">idea:</span>
                      <span className="text-foreground"> {idea.hypothesis}</span>
                    </div>
                  )}
                  {idea.motivation && (
                    <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">动机:{idea.motivation}</div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setEditing({
                        id: idea.id,
                        title: idea.title ?? "",
                        hypothesis: idea.hypothesis ?? "",
                        motivation: idea.motivation ?? "",
                      })
                    }
                    title="编辑"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeletingIdea({ id: idea.id, title: idea.title })}
                    title="删除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={creating}
        title="添加研究想法"
        busy={createMutation.isPending}
        description={
          <div className="space-y-2">
            <Input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea
              placeholder="idea(核心想法,待验证)"
              rows={2}
              value={hyp}
              onChange={(e) => setHyp(e.target.value)}
            />
            <Textarea placeholder="动机" rows={2} value={motiv} onChange={(e) => setMotiv(e.target.value)} />
          </div>
        }
        confirmLabel="添加"
        onCancel={() => setCreating(false)}
        onConfirm={() => title.trim() && createMutation.mutate()}
      />

      {/* Edit dialog — reuses ConfirmDialog with controlled inputs bound to the
          editing state. Persists via PATCH on confirm. */}
      <ConfirmDialog
        open={!!editing}
        title="编辑研究想法"
        busy={updateMutation.isPending}
        description={
          <div className="space-y-2">
            <Input
              placeholder="标题"
              value={editing?.title ?? ""}
              onChange={(e) => setEditing((s) => (s ? { ...s, title: e.target.value } : s))}
            />
            <Textarea
              placeholder="idea(核心想法,待验证)"
              rows={3}
              value={editing?.hypothesis ?? ""}
              onChange={(e) => setEditing((s) => (s ? { ...s, hypothesis: e.target.value } : s))}
            />
            <Textarea
              placeholder="动机"
              rows={2}
              value={editing?.motivation ?? ""}
              onChange={(e) => setEditing((s) => (s ? { ...s, motivation: e.target.value } : s))}
            />
          </div>
        }
        confirmLabel="保存"
        onCancel={() => setEditing(null)}
        onConfirm={() =>
          editing &&
          updateMutation.mutate(
            { id: editing.id, body: { title: editing.title, hypothesis: editing.hypothesis, motivation: editing.motivation } },
          )
        }
      />

      {/* H6: confirm idea deletion. */}
      <ConfirmDialog
        open={!!deletingIdea}
        title="删除研究想法"
        description={
          <div className="text-sm space-y-1">
            <p>将删除「{deletingIdea?.title || "(未命名)"}」。</p>
            <p className="text-destructive">此操作不可撤销。</p>
          </div>
        }
        confirmLabel="确认删除"
        busy={delMutation.isPending}
        onCancel={() => setDeletingIdea(null)}
        onConfirm={() => deletingIdea && delMutation.mutate(deletingIdea.id)}
      />
    </div>
  );
}
