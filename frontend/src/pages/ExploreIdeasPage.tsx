// Phase B: 候选研究想法对比屏。
//
// Route: /projects/:projectId/explore/ideas
// 数据源（关键设计）: 候选**持久化在 ideas 表**（status="candidate"，由
// 后端 generate_hypothesis_candidates skill 直接写入）。因此：
//   - 切走再回来、甚至刷新页面，看到的都是同一批候选 —— 不再重新跑
//     LLM（此前候选只活在前端 60s query cache 里，每次回访都烧一次 token）；
//   - 采纳 = 把选中候选升级为 status="hypothesis" + 以首个方向创建实验，
//     单次事务性操作（不再有 bulk 插入 + 建实验的两段写）；
//   - 未采纳的候选保留在想法页，随时可以回来继续挑或手动删除。

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles, ArrowRight, Loader2, AlertTriangle, RotateCw, Info } from "@/components/ui/icons";
import {
  api,
  qk,
  type Idea,
  type MultiIdeaCandidate,
} from "@/api";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { MultiIdeaCard } from "@/components/explore/MultiIdeaCard";
import WizardBar from "@/components/WizardBar";

/** 把库内的候选 Idea 行映射为对比卡需要的多候选结构。 */
function ideaToCandidate(row: Idea): MultiIdeaCandidate {
  let content: Record<string, unknown> = {};
  try {
    const parsed: unknown = row.content ? JSON.parse(row.content) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      content = parsed as Record<string, unknown>;
    }
  } catch {
    content = {};
  }
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)) : [];
  const num = (v: unknown, d: number): number =>
    typeof v === "number" ? v : d;
  return {
    name: row.title || "(未命名)",
    hypothesis: row.hypothesis || "",
    motivation: row.motivation || "",
    one_liner: typeof content.one_liner === "string" ? content.one_liner : "",
    feasibility: num(content.feasibility, 2),
    novelty: num(content.novelty, 2),
    est_cost: typeof content.est_cost === "string" ? content.est_cost : "medium",
    est_days: num(content.est_days, 3),
    recommended: content.recommended === true,
    targets: strList(content.targets),
    baseline_methods: strList(content.baseline_methods),
    key_differences: strList(content.key_differences),
    evidence_paper_ids: strList(content.evidence_paper_ids),
  };
}

export default function ExploreIdeasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const ideaText = searchParams.get("idea") || "";
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Selected candidate ids（库内 Idea id，稳定持久）。
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 数据源：项目想法列表中的「候选」状态行（与想法页/侧栏共享缓存）。
  const ideasQuery = useQuery({
    queryKey: qk.ideas.byProject(projectId!),
    queryFn: () => api.listIdeas(projectId!),
    enabled: !!projectId,
  });
  const candidates = useMemo(
    () => (ideasQuery.data ?? []).filter((r) => r.status === "candidate"),
    [ideasQuery.data],
  );

  // 推荐项默认勾选（仅在用户还没交互时）。
  useEffect(() => {
    if (!ideasQuery.data || selected.size > 0) return;
    const first = candidates.find((c) => {
      try {
        return JSON.parse(c.content || "{}")?.recommended === true;
      } catch {
        return false;
      }
    });
    if (first) setSelected(new Set([first.id]));
  }, [ideasQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 重新整理 = 让 LLM 再生成一批（后端会作为新候选入库）。
  const regenerate = useToastMutation({
    mutationFn: () =>
      api.generateIdeaCandidates(
        projectId!,
        ideaText.trim() || candidates[0]?.hypothesis || "",
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(projectId!) });
      setSelected(new Set());
    },
    // onError 默认走 toast(禁止静默失败)。
  });

  // 采纳：选中候选升级为「待验证」+ 以第一个方向创建实验 → 计划确认页。
  const adoptMutation = useToastMutation({
    mutationFn: async () => {
      const chosen = candidates.filter((c) => selected.has(c.id));
      if (chosen.length === 0) throw new Error("请选择至少一个值得继续的方向");

      const lead = chosen[0];
      const rqDraft = (lead.hypothesis || lead.motivation || lead.title || "").trim();
      if (!rqDraft) {
        throw new Error("请先选择带假设的研究想法，或先在想法页补充假设");
      }

      // 1) 升级状态：candidate → hypothesis（未选中的候选保持 candidate）。
      for (const c of chosen) {
        await api.updateIdea(c.id, { status: "hypothesis" });
      }
      // 2) 创建实验（首选项）。
      const expResp = await api.createExperiment(projectId!, {
        title: lead.title || "未命名实验",
        research_question: rqDraft,
        hypothesis: (lead.motivation || "").trim() || undefined,
        related_idea_id: lead.id,
      });
      return { experiment: expResp, adoptedCount: chosen.length };
    },
    onSuccess: ({ experiment }) => {
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(projectId!) });
      qc.invalidateQueries({ queryKey: qk.experiments.byProject(projectId!) });
      navigate(`/projects/${projectId}/experiments/${experiment.id}/preview`);
    },
    // onError 默认走 toast —— 采纳失败(含客户端校验抛错)必有反馈。
  });

  const goBack = () => {
    const params = ideaText ? `?idea=${encodeURIComponent(ideaText)}` : "";
    navigate(`/projects/${projectId}/explore/new${params}`);
  };

  const hasCandidates = candidates.length > 0;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <WizardBar projectId={projectId!} current={2} />
      {/* Header */}
      <div className="space-y-1">
        <button
          type="button"
          onClick={goBack}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          ← 返回研究问题概述
        </button>
        <PageHeader
          title={`候选研究想法${hasCandidates ? ` (${candidates.length})` : ""}`}
          subtitle="以下候选已保存到本项目的研究想法库，随时可以离开再回来继续挑选，不会丢失、也不会重复生成。选中后进入首轮计划。"
        />
      </div>

      {/* 持久化提示条：让用户明确知道「这些候选不会丢」。 */}
      {hasCandidates && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs text-blue-800">
          <Info className="h-3.5 w-3.5 shrink-0" />
          这些候选已保存在「研究想法」页（状态：候选）。采纳后状态变为「待验证」；未采纳的会保留，不会重复消耗生成次数。
        </div>
      )}

      {/* 三态分离:骨架 / 错误卡(可重试)/ 空态(可重新生成)/ 列表。 */}
      {ideasQuery.isLoading ? (
        <Card className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> 正在读取已保存的候选……
        </Card>
      ) : ideasQuery.isError ? (
        <Card className="p-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
          <div className="mt-2 text-sm text-muted-foreground">候选列表加载失败</div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => ideasQuery.refetch()}
            loading={ideasQuery.isFetching}
          >
            <RotateCw className="h-3.5 w-3.5" /> 重试
          </Button>
        </Card>
      ) : !hasCandidates ? (
        <EmptyState
          icon={<Sparkles className="h-8 w-8 text-primary" />}
          title="还没有已保存的候选"
          subtitle="让系统根据你的描述整理一批候选（会保存到研究想法库）；生成一次即可反复挑选。"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => regenerate.mutate()}
              loading={regenerate.isPending}
            >
              <RefreshCw className="h-4 w-4" /> 生成一批候选
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {candidates.map((row, idx) => {
            const c = ideaToCandidate(row);
            return (
              <div
                key={row.id}
                style={{ animationDelay: `${idx * 60}ms` }}
                className="animate-slide-up"
              >
                <MultiIdeaCard
                  candidate={c}
                  selected={selected.has(row.id)}
                  onSelect={() => toggle(row.id)}
                  busy={adoptMutation.isPending}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
        >
          {regenerate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          再生成一批（现有候选保留）
        </Button>
        <Button
          size="lg"
          onClick={() => adoptMutation.mutate()}
          disabled={selected.size === 0 || adoptMutation.isPending}
          title={selected.size > 1 ? "将全部选中项标记为待验证，并以第一个方向创建实验" : undefined}
        >
          {adoptMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
          确认并拟定首轮计划{selected.size > 0 ? `(${selected.size} 个)` : ""}
        </Button>
      </div>
      {selected.size > 1 && (
        <p className="text-[11px] text-muted-foreground text-right -mt-3">
          将把 {selected.size} 个选中项标记为「待验证」，并以第一个方向创建实验进入计划确认。
        </p>
      )}
    </div>
  );
}
