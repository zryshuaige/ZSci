import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Trash2, Sparkles, Plus, Pencil, ChevronDown, Loader2 } from "lucide-react";
import { api, type Idea, type Project } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useAgentTaskStatus } from "@/lib/hooks/useAgentTaskStatus";

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
    onSuccess: (task) => {
      // The backend synchronously ran the skill and returned the terminal
      // task. Refresh the affected lists and the global sidebar so the
      // freshly-created Idea rows show up immediately. The sidebar's
      // `recent` window also picks up the completed Job row.
      qc.invalidateQueries({ queryKey: ["ideas", project.id] });
      qc.invalidateQueries({ queryKey: ["workflows", "active"] });
      if (task?.id) setActiveGenTaskId(task.id);
    },
  });

  // Track the most recent task so we can show a transient "running" hint
  // while the mutation is in-flight (the request itself is the long part —
  // the LLM call holds the HTTP connection until the skill finishes).
  const [activeGenTaskId, setActiveGenTaskId] = useState<string | null>(null);
  const genTaskStatus = useAgentTaskStatus(
    activeGenTaskId,
    () => {
      // When the task leaves the active/recent window, clear the local id.
      setActiveGenTaskId(null);
    },
  );
  // Button is "busy" while the request is in flight OR the task is still
  // visible in the sidebar's active/recent window. Combining both gives a
  // continuous running state without the "submitting → idle → waiting"
  // flicker.
  const isGenRunning = genMutation.isPending || genTaskStatus.isActive || genTaskStatus.isTerminal;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <div className="relative z-chrome flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">研究想法</h1>
          <p className="text-xs text-muted-foreground mt-1">
            基于已下载论文生成可验证的研究假设,或手动记录自己的想法
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 手动添加
          </Button>
          <Button
            onClick={() => genMutation.mutate()}
            disabled={isGenRunning}
            title="基于项目已下载论文生成可验证的研究假设"
          >
            {isGenRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isGenRunning ? "生成中…" : "智能生成想法"}
          </Button>
        </div>
      </div>

      {genMutation.isError && (
        <Card className="p-3 text-sm text-destructive animate-pop">
          生成失败：{(genMutation.error as Error).message}
          <div className="text-xs mt-1 opacity-80">智能生成需要先配置大模型。请到「设置」完成配置后重试。</div>
        </Card>
      )}

      {genTaskStatus.isTerminal && genTaskStatus.status === "failed" && (
        <Card className="p-3 text-sm text-destructive animate-pop">
          生成任务失败{genTaskStatus.lastMessage ? `：${genTaskStatus.lastMessage}` : ""}
          <div className="text-xs mt-1 opacity-80">可在左侧「进行中的任务」查看详情。</div>
        </Card>
      )}

      {ideasLoading ? (
        <ListSkeleton rows={3} />
      ) : ideas.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground animate-pop">
          <Lightbulb className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <div className="text-sm">还没有研究想法</div>
          <div className="text-xs mt-1.5">可手动添加，或点击「智能生成想法」，基于已下载论文生成可验证假设</div>
        </Card>
      ) : (
        <div className="relative z-0 grid gap-3">
          {ideas.map((idea, i) => (
            <Card
              key={idea.id}
              style={{ animationDelay: `${i * 40}ms` }}
              className="p-5 animate-slide-up hover-lift"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{idea.title || "（未命名）"}</span>
                    <StatusMenu
                      current={idea.status}
                      open={statusMenuFor === idea.id}
                      onOpenChange={(open) => setStatusMenuFor(open ? idea.id : null)}
                      onSelect={(s) => {
                        setStatusMenuFor(null);
                        updateMutation.mutate({ id: idea.id, body: { status: s } });
                      }}
                    />
                  </div>
                  {idea.hypothesis && (
                    <div className="text-sm mt-2 leading-relaxed">
                      <span className="text-muted-foreground">假设：</span>
                      <span className="text-foreground">{idea.hypothesis}</span>
                    </div>
                  )}
                  {idea.motivation && (
                    <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      动机：{idea.motivation}
                    </div>
                  )}
                  <IdeaDetails idea={idea} />
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
                    title="编辑想法"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeletingIdea({ id: idea.id, title: idea.title })}
                    title="删除想法"
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
              placeholder="核心假设（待验证的想法）"
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
              placeholder="核心假设（待验证的想法）"
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
      .join("；");
  }
  if (typeof v === "object") return JSON.stringify(v);
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
      <summary className="text-xs text-blue-600 cursor-pointer select-none list-none flex items-center gap-1">
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

/** Status switcher — a compact dropdown that overlays the idea card.
 *
 *  Why a portal: the ideas are rendered inside <Card hover-lift>, which
 *  applies `transform: translateY(-1px)` on hover; transform creates a new
 *  CSS stacking context, so a child `position: absolute` menu with any
 *  z-index is bounded by that card's context. Neighbouring cards (also
 *  with their own stacking contexts) can then paint OVER the menu with
 *  no way to opt out — the user sees the dropdown as "covered".
 *
 *  Rendering the menu via a portal to `document.body` attaches it to the
 *  document root, where the z-index ladder is unconstrained. The bubble's
 *  position is computed from the trigger's bounding rect at the moment
 *  the menu opens, so it tracks correctly even when the user scrolls.
 */
function StatusMenu({
  current,
  open,
  onOpenChange,
  onSelect,
}: {
  current: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (status: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Place the bubble below the trigger, left-aligned to its left edge.
    setPos({ top: r.bottom + 4, left: r.left });
    // Reposition on scroll/resize so the bubble stays anchored to the
    // trigger if the page scrolls while the menu is open.
    const onResize = () => {
      const el2 = triggerRef.current;
      if (!el2) return;
      const r2 = el2.getBoundingClientRect();
      setPos({ top: r2.bottom + 4, left: r2.left });
    };
    window.addEventListener("scroll", onResize, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onResize, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-sm ease-out hover:opacity-85",
          STATUS_COLORS[current] || "bg-muted"
        )}
      >
        {STATUS_LABEL[current] || current}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && pos && createPortal(
        <>
          {/* Full-screen click-catcher that closes the menu. Sits behind the
              bubble but above all other content; `z-dropdown` is the same
              z-index as the menu container for the menu group, which is
              below the modal/toast layers. */}
          <div
            className="fixed inset-0 z-dropdown"
            onClick={() => onOpenChange(false)}
          />
          <div
            style={{ position: "fixed", top: pos.top, left: pos.left }}
            className="z-dropdown w-32 rounded-lg border border-border bg-card shadow-float p-1 animate-pop origin-top-left"
          >
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                onClick={() => onSelect(s)}
                className={cn(
                  "w-full text-left rounded-md px-2.5 py-1.5 text-xs transition-colors duration-sm ease-out hover:bg-muted",
                  current === s && "font-medium bg-muted"
                )}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
