import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Lightbulb, Trash2, Sparkles, Plus, Pencil, ChevronDown, FlaskConical, AlertTriangle, RotateCw } from "@/components/ui/icons";
import { api, qk, type Idea, type Project } from "@/api";
import { statusMeta } from "@/lib/statusMeta";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Modal } from "@/components/ui/Modal";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";

// 状态切换的可选集合(展示词与颜色统一走 statusMeta,全站唯一词表;
// 这里只保留「想法可以有哪些状态」这一业务顺序)。
const STATUS_ORDER = ["candidate", "backlog", "hypothesis", "decision", "rejected"] as const;

export default function IdeasPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [hyp, setHyp] = useState("");
  const [motiv, setMotiv] = useState("");
  // H6: track which idea is pending deletion for a confirm dialog.
  const [deletingIdea, setDeletingIdea] = useState<{ id: string; title: string | null } | null>(null);
  // Editing state: a copy of the idea being edited, surfaced in a dialog.
  const [editing, setEditing] = useState<{ id: string; title: string; hypothesis: string; motivation: string } | null>(null);

  const ideasQuery = useQuery({
    queryKey: qk.ideas.byProject(project.id),
    queryFn: () => api.listIdeas(project.id),
  });
  const ideas = ideasQuery.data ?? [];

  // 所有 mutation 统一走 useToastMutation:失败必有 toast(禁止静默失败),
  // 有用户感知意义的操作附成功反馈。
  const createMutation = useToastMutation({
    mutationFn: () =>
      api.createIdea(project.id, { title, hypothesis: hyp, motivation: motiv, status: "backlog" }),
    successMessage: "已添加研究想法",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(project.id) });
      setCreating(false); setTitle(""); setHyp(""); setMotiv("");
    },
  });

  const delMutation = useToastMutation({
    mutationFn: (id: string) => api.deleteIdea(id),
    successMessage: "已删除",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(project.id) });
      setDeletingIdea(null);
    },
  });

  const updateMutation = useToastMutation({
    mutationFn: (args: { id: string; body: Partial<{ title: string; hypothesis: string; motivation: string; status: string }> }) =>
      api.updateIdea(args.id, args.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(project.id) });
      setEditing(null);
    },
  });

  // Phase B entrypoint: 「基于已有研究生成候选」不再直接入库,而是跳到候选对比
  // 屏让用户先看 / 选 / 采纳。`user_request` 走 project.research_direction;
  // 空时退化为让用户在 ExploreNewPage 自己写。
  const goGenerate = () => {
    const seed = (project.research_direction || "").trim();
    if (!seed) {
      navigate(`/projects/${project.id}/explore/new`);
      return;
    }
    const params = new URLSearchParams({ idea: seed });
    navigate(`/projects/${project.id}/explore/ideas?${params.toString()}`);
  };

  // 想法 → 实验：以该想法的假设为研究问题建实验（related_idea_id 回链），
  // 成功后直达计划确认页 —— 旅程「想法 → 实验」的主 CTA。
  const startExperimentMutation = useToastMutation({
    mutationFn: (idea: Idea) =>
      api.createExperiment(project.id, {
        title: idea.title || "未命名实验",
        research_question: (idea.hypothesis || idea.motivation || idea.title || "").trim(),
        hypothesis: (idea.motivation || "").trim() || undefined,
        related_idea_id: idea.id,
      }),
    successMessage: "已创建实验，进入计划确认",
    onSuccess: (exp) => {
      qc.invalidateQueries({ queryKey: qk.experiments.byProject(project.id) });
      navigate(`/projects/${project.id}/experiments/${exp.id}/preview`);
    },
  });

  const canCreate = !!title.trim();
  const canSaveEdit = !!editing?.title.trim();

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <div className="relative z-chrome">
        <PageHeader
          title="研究想法"
          subtitle="这里汇总本项目已记录的研究想法,可手动整理,或基于已下载文献挑选进一步评估的候选。"
          actions={
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> 手动记录
              </Button>
              <Button onClick={goGenerate} title="基于项目已下载文献,挑选若干值得进一步评估的研究想法">
                <Sparkles className="h-4 w-4" />
                基于已有研究整理候选
              </Button>
            </div>
          }
        />
      </div>

      {/* 三态分离:骨架 / 错误卡(可重试)/ 空态(带探索流程出口)/ 列表。 */}
      {ideasQuery.isLoading ? (
        <ListSkeleton rows={3} />
      ) : ideasQuery.isError ? (
        <Card className="p-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
          <div className="mt-2 text-sm text-muted-foreground">研究想法列表加载失败</div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => ideasQuery.refetch()}
          >
            <RotateCw className="h-3.5 w-3.5" /> 重试
          </Button>
        </Card>
      ) : ideas.length === 0 ? (
        <EmptyState
          icon={<Lightbulb className="h-10 w-10" />}
          title="还没有研究想法"
          subtitle="前往探索流程,系统会结合项目文献整理若干候选方向供你挑选;也可以手动记录一条。"
          action={
            <Button onClick={goGenerate}>
              <Sparkles className="h-4 w-4" /> 去探索候选方向
            </Button>
          }
        />
      ) : (
        <div className="relative z-0 grid gap-3">
          {ideas.map((idea, i) => (
            <Card
              key={idea.id}
              style={{ animationDelay: `${i * 40}ms` }}
              className="p-5 animate-slide-up hover-lift hover:border-primary/25 transition-colors duration-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{idea.title || "(未命名)"}</span>
                    <StatusDropdown
                      current={idea.status}
                      busy={updateMutation.isPending}
                      onSelect={(s) => updateMutation.mutate({ id: idea.id, body: { status: s } })}
                    />
                  </div>
                  {idea.hypothesis && (
                    <div className="text-sm mt-2 leading-relaxed">
                      <span className="text-muted-foreground">假设:</span>
                      <span className="text-foreground">{idea.hypothesis}</span>
                    </div>
                  )}
                  {idea.motivation && (
                    <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      动机:{idea.motivation}
                    </div>
                  )}
                  <IdeaDetails idea={idea} />
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <div className="flex items-center gap-0.5">
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
                      title="编辑想法"
                      aria-label="编辑想法"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeletingIdea({ id: idea.id, title: idea.title })}
                      title="删除想法"
                      aria-label="删除想法"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant={ideaRecommended(idea) ? "default" : "outline"}
                    onClick={() => startExperimentMutation.mutate(idea)}
                    loading={startExperimentMutation.isPending && startExperimentMutation.variables?.id === idea.id}
                    title="以这个想法创建实验，进入计划确认"
                  >
                    <FlaskConical className="h-3.5 w-3.5" /> 用这个想法做实验
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 表单统一用 Modal(Enter 提交 / Esc 关闭 / 自动聚焦);标题为空时
          确认按钮禁用并给出内联提示,而不是点了没反应。 */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="添加研究想法"
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
              添加
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
          {!canCreate && (
            <div className="text-xs text-muted-foreground">需要一个标题才能添加。</div>
          )}
          <Textarea
            placeholder="核心假设(待验证的想法)"
            rows={2}
            value={hyp}
            onChange={(e) => setHyp(e.target.value)}
          />
          <Textarea placeholder="动机" rows={2} value={motiv} onChange={(e) => setMotiv(e.target.value)} />
        </div>
      </Modal>

      {/* Edit dialog — controlled inputs bound to the editing state; persists
          via PATCH on submit. */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="编辑研究想法"
        busy={updateMutation.isPending}
        onSubmit={() => {
          if (editing && canSaveEdit) {
            updateMutation.mutate({
              id: editing.id,
              body: { title: editing.title, hypothesis: editing.hypothesis, motivation: editing.motivation },
            });
          }
        }}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={updateMutation.isPending}>
              取消
            </Button>
            <Button type="submit" loading={updateMutation.isPending} disabled={!canSaveEdit}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            placeholder="标题"
            value={editing?.title ?? ""}
            onChange={(e) => setEditing((s) => (s ? { ...s, title: e.target.value } : s))}
          />
          {!canSaveEdit && (
            <div className="text-xs text-muted-foreground">标题不能为空。</div>
          )}
          <Textarea
            placeholder="核心假设(待验证的想法)"
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
      </Modal>

      {/* H6: confirm idea deletion. */}
      <ConfirmDialog
        open={!!deletingIdea}
        title="删除研究想法"
        danger
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

/** 状态切换器 —— 用统一的 Dropdown 原语(portal 渲染,自动处理外部点击 /
 *  Esc 关闭 / 定位),词与颜色来自 statusMeta 单一词表。
 *
 *  为什么必须是 portal:想法卡片带 hover transform,会创建新的 CSS 层叠
 *  上下文,普通 absolute 菜单会被相邻卡片盖住;Dropdown 内部已处理这一点。 */
function StatusDropdown({
  current,
  busy,
  onSelect,
}: {
  current: string;
  busy: boolean;
  onSelect: (status: string) => void;
}) {
  return (
    <Dropdown
      trigger={
        <span
          className={cn(
            "inline-flex items-center gap-0.5 cursor-pointer transition-opacity duration-sm ease-out hover:opacity-85",
            busy && "opacity-60 pointer-events-none",
          )}
        >
          <StatusBadge status={current} />
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </span>
      }
    >
      {(close) => (
        <>
          {STATUS_ORDER.map((s) => {
            const sm = statusMeta(s);
            return (
              <DropdownItem
                key={s}
                onClick={() => {
                  close();
                  if (s !== current) onSelect(s);
                }}
              >
                <span className={cn(current === s && "font-medium")}>{sm.label}</span>
              </DropdownItem>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

const CONTENT_FIELD_LABELS: [string[], string][] = [
  [["min_viable_experiment", "最小可行实验", "min_experiment"], "最小可行实验"],
  [["controls", "对照组"], "对照组"],
  [["variables", "变量"], "变量"],
  [["metrics", "评估指标", "evaluation_metrics"], "评估指标"],
  [["success_criteria", "成功判据"], "成功判据"],
  [["failure_criteria", "失败判据"], "失败判据"],
  [["resource_budget", "资源预算"], "资源预算"],
];

function parseMaybeJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function formatFieldValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          return String(o.claim || o.text || o.name || JSON.stringify(item));
        }
        return String(item);
      })
      .filter(Boolean)
      .join(";");
  }
  if (typeof v === "object") {
    // 嵌套对象 → "键: 值" 串（结构化可读，不暴露 JSON）。
    return Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== null && val !== "")
      .map(([k, val]) => `${k}: ${formatFieldValue(val)}`)
      .join("；");
  }
  return String(v);
}

function pickContentField(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    if (k in obj) {
      const s = formatFieldValue(obj[k]);
      if (s) return s;
    }
  }
  return "";
}

/** AI 生成候选时会在 content JSON 里标 recommended —— 只有被推荐的
 *  想法配得上实心主按钮;其余卡片降为描边,避免整页「按钮海」。 */
function ideaRecommended(idea: Idea): boolean {
  try {
    const c = idea.content ? JSON.parse(idea.content) : null;
    return c && typeof c === "object" && (c as Record<string, unknown>).recommended === true;
  } catch {
    return false;
  }
}

function IdeaDetails({ idea }: { idea: Idea }) {
  const content = parseMaybeJson(idea.content);
  const evidence = parseMaybeJson(idea.evidence_json);
  const risks = parseMaybeJson(idea.risks_json);
  const contentObj =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : null;

  const sections: { label: string; text: string }[] = [];
  if (contentObj) {
    for (const [keys, label] of CONTENT_FIELD_LABELS) {
      const text = pickContentField(contentObj, keys);
      if (text) sections.push({ label, text });
    }
  }
  const evidenceText = formatFieldValue(evidence);
  const risksText = formatFieldValue(risks);
  if (evidenceText) sections.push({ label: "文献证据", text: evidenceText });
  if (risksText) sections.push({ label: "风险与反例", text: risksText });

  if (sections.length === 0) return null;

  return (
    <details className="mt-3 group">
      <summary className="text-xs text-primary cursor-pointer select-none list-none flex items-center gap-1">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        查看完整方案
      </summary>
      <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-3">
        {sections.map((s) => (
          <div key={s.label}>
            <div className="text-[11px] font-medium text-muted-foreground mb-0.5">{s.label}</div>
            <div className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap">{s.text}</div>
          </div>
        ))}
      </div>
    </details>
  );
}
