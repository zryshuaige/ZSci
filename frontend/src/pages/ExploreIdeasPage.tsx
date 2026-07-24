// Phase B: 多候选研究方向对比屏。
//
// Route: /explore/:projectId/ideas?idea=...
// 行为:
//   1. 用相同 query key 复用 /explore/:id/new 已经在 query cache 写下的候选列表
//      (避免重复触发 LLM);若无则重新调一次 generateIdeaCandidates。
//   2. 让用户勾选 ≥1 个候选 + 「让 AI 再生成一批方向」可重新拉。
//   3. 用户选完点「确认采纳」 → POST /ideas/bulk 入库;
//      接着 POST /projects/{id}/experiments 自动建一个 draft 实验填 RQ +
//      hypothesis → 跳 /experiments/:expId/preview(Phase C 研究计划确认)。

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles, ArrowRight, Loader2 } from "lucide-react";
import {
  api,
  type Idea,
  type MultiIdeaCandidate,
} from "@/lib/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Dialog";
import { MultiIdeaCard } from "@/components/explore/MultiIdeaCard";

export default function ExploreIdeasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const ideaText = searchParams.get("idea") || "";
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Selected candidate indexes (allow multi-select; backend bulk_insert
  // accepts N). The candidate comparison page defaults to single-select
  // visually (one card highlighted at a time), but `selected` is a Set
  // so adding/removing is constant time.
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // The candidates, fetched via the same query key as the understanding page.
  // Cached data from `useQuery` is returned synchronously on first render so
  // there's no double-LLM call when the user accepts on /new.
  const candidatesQuery = useQuery<MultiIdeaCandidate[]>({
    queryKey: ["explore", "candidates", projectId, ideaText],
    queryFn: async () => {
      const task = await api.generateIdeaCandidates(projectId!, ideaText.trim());
      let parsed: { candidates?: MultiIdeaCandidate[] } = {};
      try {
        parsed = task.result_json ? JSON.parse(task.result_json) : {};
      } catch {
        parsed = {};
      }
      return parsed.candidates ?? [];
    },
    enabled: !!projectId && !!ideaText.trim(),
    staleTime: 60_000,
  });

  // If there's a "recommended" candidate in the loaded list, default-select
  // it on first render. Anything other than the first one's recommendation
  // is left for the user.
  useEffect(() => {
    if (!candidatesQuery.data || selected.size > 0) return;
    const idx = candidatesQuery.data.findIndex((c) => c.recommended);
    if (idx >= 0) {
      setSelected(new Set([idx]));
    }
  }, [candidatesQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = candidatesQuery.data ?? [];

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const regenerate = useMutation({
    mutationFn: () =>
      api.generateIdeaCandidates(projectId!, ideaText.trim()),
    onSuccess: () => {
      candidatesQuery.refetch();
      setSelected(new Set());
    },
    onError: (err) => showFriendlyError(err),
  });

  // Adopt selected candidates: bulk-insert Ideas, then create one Experiment
  // with the FIRST candidate's hypothesis as the research_question, then
  // navigate to the preview-plan page.
  const adoptMutation = useMutation({
    mutationFn: async () => {
      const chosen = candidates.filter((_, i) => selected.has(i));
      if (chosen.length === 0) throw new Error("请选择至少一个值得继续的方向");

      const lead = chosen[0];
      const rqDraft = (lead.hypothesis || lead.one_liner || ideaText || "").trim();
      if (!rqDraft) {
        // Don't even hit the server — backend will 422 anyway, but
        // surfacing the message client-side avoids a round trip and
        // lets the user pick a candidate that has a hypothesis.
        throw new Error("请先选择研究方向或填写原始想法");
      }

      const bulkResp = await api.bulkInsertIdeas(projectId!, {
        ideas: chosen.map((c) => ({
          title: c.name,
          hypothesis: c.hypothesis,
          motivation: `${c.motivation}\n\n研究方向候选\none_liner:${c.one_liner}\n可行性:${c.feasibility}/3  创新性:${c.novelty}/3`.trim(),
          status: "hypothesis",
          // content is a dict (object) per the backend BulkIdeaIn contract;
          // the router json.dumps() it into the TEXT column. Sending a
          // pre-serialized string is rejected with INPUT_INVALID.
          content: {
            feasibility: c.feasibility,
            novelty: c.novelty,
            est_cost: c.est_cost,
            est_days: c.est_days,
            targets: c.targets,
            baseline_methods: c.baseline_methods,
            key_differences: c.key_differences,
            evidence_paper_ids: c.evidence_paper_ids,
          },
        })),
      });
      const inserted: Idea[] = bulkResp.inserted;

      // Build the experiment: title + RQ + hypothesis from candidate[0].
      const expResp = await api.createExperiment(projectId!, {
        title: lead.name,
        research_question: rqDraft,
        hypothesis: lead.motivation || lead.one_liner || "",
        related_idea_id: inserted[0]?.id || undefined,
      });
      return { experiment: expResp, insertedCount: inserted.length };
    },
    onSuccess: ({ experiment }) => {
      qc.invalidateQueries({ queryKey: ["ideas", projectId] });
      qc.invalidateQueries({ queryKey: ["experiments", projectId] });
      // Phase C: jump to the preview-plan page (next implement step).
      navigate(`/experiments/${experiment.id}/preview`);
    },
    onError: (err) => showFriendlyError(err),
  });

  const goBack = () => {
    if (!ideaText) {
      navigate("/");
      return;
    }
    const params = new URLSearchParams({ idea: ideaText });
    navigate(`/explore/${projectId}/new?${params.toString()}`);
  };

  const hasCandidates = candidates.length > 0;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <button
          type="button"
          onClick={goBack}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          ← 返回研究问题概述
        </button>
        <h1 className="text-xl font-semibold tracking-tight">
          候选研究方向 {hasCandidates && <span>({candidates.length})</span>}
        </h1>
        <p className="text-xs text-muted-foreground leading-relaxed">
          以下方向根据 "{ideaText.slice(0, 30)}{ideaText.length > 30 ? "…" : ""}" 整理。请选择一个或多个值得进一步验证的方向,然后进入首轮计划;若结果不合适,可调整描述或重新生成。
        </p>
      </div>

      {/* Loading / empty / error */}
      {candidatesQuery.isLoading && (
        <Card className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> 正在整理候选研究方向……
        </Card>
      )}
      {!candidatesQuery.isLoading && !hasCandidates && (
        <Card className="p-6 text-center">
          <Sparkles className="h-6 w-6 text-primary mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            这一轮没有整理出候选方向,可以尝试调整描述或重新生成。
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => regenerate.mutate()}
            disabled={regenerate.isPending}
          >
            <RefreshCw className="h-4 w-4" /> 重新整理
          </Button>
        </Card>
      )}

      {/* Cards grid */}
      {hasCandidates && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {candidates.map((c, idx) => (
            <MultiIdeaCard
              key={`${c.name}-${idx}`}
              candidate={c}
              selected={selected.has(idx)}
              onSelect={() => toggle(idx)}
              busy={adoptMutation.isPending}
            />
          ))}
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
          重新整理候选方向
        </Button>
        <Button
          size="lg"
          onClick={() => adoptMutation.mutate()}
          disabled={selected.size === 0 || adoptMutation.isPending}
        >
          {adoptMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
          确认并拟定首轮计划{selected.size > 0 ? `(${selected.size} 个)` : ""}
        </Button>
      </div>
    </div>
  );
}
