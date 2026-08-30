// Phase B: Idea 探索流第 1 屏 — AI 复述卡 + 智能补充。
//
// Route: /explore/:projectId/new?idea=...
// 该屏从 `Idea` query 参数(由首页 hero 提交时写入)读取研究想法,自动调用
// `research.generate_hypothesis_candidates` 拉取 N 个方向候选,把领头的
// 那个作为"AI 理解"展示,让用户:
//   1. 接受 → 跳到 /explore/:id/ideas(候选对比屏)展示全部候选
//   2. 改 → 原位编辑原始 idea,重新生成候选
//
// 整个屏只有 1 个主操作按钮(对,继续)+ 1 个次操作(改一下),严格遵守
// plan 的"少按钮"原则。

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Settings } from "@/components/ui/icons";
import { api, qk, type MultiIdeaCandidate, type Project } from "@/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { useLLMReadiness } from "@/lib/hooks/useLLMReadiness";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { AIUnderstandingCard, summariseCandidate } from "@/components/explore/AIUnderstandingCard";
import WizardBar from "@/components/WizardBar";

interface ExploreNewPageProps {
  // The Project context comes from <ProjectLayout />'s <Outlet />.
}

export default function ExploreNewPage(_: ExploreNewPageProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const ideaParam = searchParams.get("idea") || "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  // 首启预检：未配置模型时给出引导卡，而不是让第一次点击撞 503。
  const llm = useLLMReadiness();

  const { data: project } = useQuery<Project>({
    queryKey: qk.projects.one(projectId!),
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
  });

  // Editable copy of the idea. Initial value comes from the URL; the page
  // mirrors the project.research_direction as a secondary hint if the user
  // arrived via deep-link without an idea param.
  const [ideaText, setIdeaText] = useState<string>(
    ideaParam || project?.research_direction || "",
  );
  useEffect(() => {
    if (!ideaText && project?.research_direction) setIdeaText(project.research_direction);
  }, [project?.research_direction]); // eslint-disable-line react-hooks/exhaustive-deps

  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState(false);

  // The latest leader candidate used as the AI's understanding. We refetch
  // whenever `ideaText` changes (skip the first initial render so the
  // prompt is committed in the URL before we trigger the LLM).
  const [leader, setLeader] = useState<MultiIdeaCandidate | null>(null);

  const runIdeaQuery = useQuery({
    queryKey: ["explore", "candidates", projectId, ideaText],
    // 预检未就绪（ready === false）时不发起 LLM 调用，由引导卡接管。
    enabled: !!projectId && !!ideaText.trim() && llm.ready !== false,
    queryFn: async () => {
      const task = await api.generateIdeaCandidates(projectId!, ideaText.trim());
      let parsed: { candidates?: MultiIdeaCandidate[] } = {};
      try {
        parsed = task.result_json ? JSON.parse(task.result_json) : {};
      } catch {
        parsed = {};
      }
      const candidates: MultiIdeaCandidate[] = parsed.candidates ?? [];
      // Pick the recommended one as the AI leader; if none, pick the first.
      const next = candidates.find((c) => c.recommended) ?? candidates[0] ?? null;
      setLeader(next);
      // 候选已入库（status=候选）——刷新想法页/侧栏计数。
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(projectId!) });
      return candidates;
    },
    staleTime: 60_000,
  });

  // When the URL param changes (initial mount), re-enable the query.
  // React Query v5 dropped `.isIdle`; we check `.status === "pending"`
  // which is the same condition (the query has never produced data yet).
  useEffect(() => {
    if (ideaText && runIdeaQuery.status === "pending" && !runIdeaQuery.data) {
      runIdeaQuery.refetch();
    }
  }, [ideaText]); // eslint-disable-line react-hooks/exhaustive-deps

  const understanding = useMemo(
    () => summariseCandidate(leader, ideaText),
    [leader],
  );

  // The "background" / "goal" / "familiarity" chips are also derived from the
  // leader candidate. We use the targets list as the closest equivalent to
  // a structured user-goal field — if targets is non-empty, surface its
  // first item; otherwise use the candidate's `motivation` as the goal label.
  const chips = useMemo(() => {
    if (!leader) return { background: null, goal: null, familiarity: null };
    return {
      background: leader.one_liner ? leader.one_liner : null,
      goal: leader.targets[0] ?? null,
      familiarity:
        leader.feasibility >= 2 ? "已有较成熟工作可参考" : "可直接参考的工作较少",
    };
  }, [leader]);

  // Acceptance → leave this page, head to the candidate-comparison screen.
  // 候选已由后端持久化到研究想法库（status=候选），对比屏直接从库里读 ——
  // 离开再回来不会重跑 LLM，也不需要 query-cache handoff。
  function accept() {
    if (!projectId || !ideaText.trim()) return;
    qc.invalidateQueries({ queryKey: qk.ideas.byProject(projectId) });
    const params = new URLSearchParams({ idea: ideaText.trim() });
    navigate(`/projects/${projectId}/explore/ideas?${params.toString()}`);
  }

  async function startRevision() {
    setRevising(true);
  }

  async function saveRevision() {
    setBusy(true);
    try {
      runIdeaQuery.refetch();
      setRevising(false);
    } catch (err) {
      showFriendlyError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancelRevision() {
    setRevising(false);
  }

  if (!projectId) return null;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-5">
      <WizardBar projectId={projectId} current={1} />
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {project?.name ?? "研究项目"} / 梳理候选
        </div>
        <PageHeader
          title="研究问题概述"
          subtitle="根据你的描述，系统先整理出对研究问题的理解，并据此给出若干差异化的候选方向供你选择。"
        />
      </div>

      {/* LLM 预检：未配置模型时给明确出口，不让用户的第一步撞墙。 */}
      {llm.ready === false && (
        <Card className="p-5 border-amber-300 bg-amber-50/40 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Settings className="h-4 w-4 text-amber-600" />
            还没有配置 AI 模型
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            整理研究想法需要调用大模型。请先到设置页填入模型 API Key（支持 DeepSeek、OpenAI、智谱等），
            配置完成后回到这里继续。
          </p>
          <Link to="/settings">
            <Button size="sm" variant="outline" className="mt-1">
              <Settings className="h-3.5 w-3.5" /> 去配置模型
            </Button>
          </Link>
        </Card>
      )}

      {llm.ready !== false && (runIdeaQuery.isLoading || runIdeaQuery.isFetching) ? (
        <Card className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            正在根据你的描述梳理研究问题并生成候选方向,通常需要 5-15 秒……
          </div>
          {/* skeleton lines mirror the eventual card layout */}
          <div className="space-y-2">
            <div className="h-3 rounded bg-muted/60 animate-pulse w-3/4" />
            <div className="h-3 rounded bg-muted/60 animate-pulse w-2/3" />
            <div className="h-3 rounded bg-muted/60 animate-pulse w-1/2" />
          </div>
        </Card>
      ) : runIdeaQuery.isError ? (
        <Card className="p-4 text-sm">
          <div className="text-foreground">这一轮未能整理出候选研究想法。</div>
          <div className="text-xs text-muted-foreground mt-1">
            可以
            <button
              type="button"
              className="mx-1 underline"
              onClick={() => runIdeaQuery.refetch()}
            >
              重试
            </button>
            或直接点「修改描述」继续。
          </div>
        </Card>
      ) : (
        <AIUnderstandingCard
          original={ideaText.trim() || "(尚未提供描述)"}
          understanding={understanding.understanding}
          background={chips.background}
          goal={chips.goal}
          familiarity={chips.familiarity}
          revising={revising}
          revisedText={ideaText}
          onRevisedTextChange={setIdeaText}
          busy={busy}
          onAccept={accept}
          onRevise={startRevision}
          onSaveRevision={saveRevision}
          onCancelRevision={cancelRevision}
        />
      )}

      <Card className="p-4 space-y-2 bg-muted/30">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          小提示
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          不必纠结措辞,模糊的描述也可以。系统会结合你的描述整理出研究问题概述与候选方向,
          如果结果与原意不符,可以随时修改描述后重新生成。
        </p>
      </Card>

      {/* 流程位置已由顶部 WizardBar 呈现。 */}
    </div>
  );
}
