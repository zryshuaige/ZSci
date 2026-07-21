import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, FolderOpen } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

export default function ProjectsPage() {
  const qc = useQueryClient();
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("");
  // H6: track which project is pending deletion so we can show a confirm dialog.
  const [deletingProject, setDeletingProject] = useState<{ id: string; name: string } | null>(null);

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
    <div className="p-8 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">研究项目</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> 新建项目
        </Button>
      </div>

      {isLoading && <ListSkeleton rows={3} />}
      {!isLoading && projects?.length === 0 && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="还没有项目"
          subtitle="点击「新建项目」开始你的第一个研究方向"
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
              title="删除项目"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={creating}
        title="新建研究项目"
        description={
          <div className="space-y-3">
            <p>输入项目名称与研究方向。系统会在本地创建项目目录与数据库记录。</p>
            <Input
              placeholder="项目名称,例如:VLM Efficient Fine-tuning"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Textarea
              placeholder="研究方向,例如:视觉语言模型的高效微调与鲁棒性"
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
        title="删除项目"
        description={
          <div className="space-y-2 text-sm">
            <p>将删除项目 <span className="font-medium">{deletingProject?.name}</span> 及其所有文献、笔记、实验、写作文件。</p>
            <p className="text-destructive">此操作不可撤销。</p>
          </div>
        }
        confirmLabel="确认删除"
        busy={deleteMutation.isPending}
        onCancel={() => setDeletingProject(null)}
        onConfirm={() => deletingProject && deleteMutation.mutate(deletingProject.id)}
      />
    </div>
  );
}
