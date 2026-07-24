// Phase D: 实验结果与下一步建议屏。
//
// Route: /experiments/:expId/result
// 行为:
//   1. 拉取 experiment + 尝试拉取 next-steps(后端 GET /experiments/{id}/next-steps,
//      可能尚未上线,失败时降级为「查看实验详情」CTA)。
//   2. 显示「一句话结论」+ 价值判断 + 核心指标 + 「推荐 A/B/C」按钮(走 /fork 或
//      createExperiment + startAutonomous;本轮先做前端渲染 + 主 CTA「查看实验详情」
//      /「基于此创建分支」/「生成实验报告」三个一阶动作)。
//   3. 用户从 ExperimentDetailPage 顶部点击「下一步建议」也会跳这里。

import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, GitBranch, Loader2, Sparkles } from "lucide-react";
import { api, fmtTime } from "@/lib/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Dialog";


/** 后端 /next-steps 返回的形状 — 用 ReturnType 自动对齐 api.nextSteps 的定义。 */
type NextStepsData = NonNullable<Awaited<ReturnType<typeof api.nextSteps>>>;
type NextStep = NextStepsData["next_steps"][number];

const JUDGEMENT_LABEL: Record<string, string> = {
  continue: "初步支持,值得继续",
  adjust: "需要调整实验设置",
  insufficient: "证据尚不充分",
  pivot: "可考虑尝试替代方向",
};

export default function ExperimentResultPage() {
  const { expId } = useParams<{ expId: string }>();
  const navigate = useNavigate();

  const expQuery = useQuery({
    queryKey: ["experiment", expId],
    queryFn: () => api.getExperiment(expId!),
    enabled: !!expId,
  });

  // next-steps 端点;走统一的 api.nextSteps 包装(自动 FriendlyError / 404 降级)。
  // 若 phase_4_report 还没到 analysis,后端返回 has_analysis=false 与空 next_steps ——
  // 前端按"系统在整理"路径渲染,主 CTA 仍可用。
  const nextQuery = useQuery({
    queryKey: ["experiment-next-steps", expId],
    queryFn: () => api.nextSteps(expId!),
    enabled: !!expId,
    retry: false,
  });

  // 「基于此创建分支」→ fork experiment(后端会复制已完成的 stage)。
  const forkMutation = useMutation({
    mutationFn: () => {
      // 找到第一个非 complete 的 stage;若有则从那里 fork;
      // 没有则传 null(后端会处理 default 行为)。
      return api.listStages(expId!).then((s) => {
        const lastDone = [...s.stages].reverse().find((st) => st.status === "completed");
        return api.forkExperiment(expId!, {
          target_stage_id: lastDone?.id ?? s.stages[s.stages.length - 1]?.id ?? "",
          title: `${expQuery.data?.title ?? "实验"} - 分支`,
        });
      });
    },
    onSuccess: (newExp) => navigate(`/experiments/${newExp.id}/preview`),
    onError: (err) => showFriendlyError(err),
  });

  if (expQuery.isLoading) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <Card className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> 正在读取本轮实验结果……
        </Card>
      </div>
    );
  }

  const exp = expQuery.data;
  const next = nextQuery.data;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          实验结果 / {exp?.title ?? expId}
        </div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          首轮实验已完成
        </h1>
        <p className="text-sm text-muted-foreground">
          以下汇总本轮实验的初步结论、证据强度与若干后续研究方向,具体判断请结合重复实验与领域知识进一步确认。
        </p>
      </div>

      {/* 结论 + 证据强度 */}
      <Card className="p-5 space-y-3">
        <div className="text-sm text-foreground leading-relaxed">
          {next?.conclusion
            || (exp?.research_question
              ? `已完成对 "${exp.research_question.slice(0, 40)}${exp.research_question.length > 40 ? "…" : ""}" 的首轮小规模验证,主要指标与可能的解释见下方。`
              : "本轮实验的主要指标与原始记录可在实验详情页查看。")}
        </div>
        {next?.judgement && (
          <div className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs">
            <span className="text-muted-foreground">本轮证据强度</span>
            <span className="font-medium">
              {JUDGEMENT_LABEL[next.judgement] ?? next.judgement}
            </span>
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">
          本轮实验于 {fmtTime(exp?.updated_at)} 记录完成
        </div>
      </Card>

      {/* 核心指标 */}
      {next?.metrics && Object.keys(next.metrics).length > 0 && (
        <Card className="p-5 space-y-2">
          <div className="text-sm font-medium">本轮主要指标</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Object.entries(next.metrics).map(([k, v]) => (
              <div key={k} className="rounded-md bg-muted/40 p-3">
                <div className="text-[11px] text-muted-foreground">{k}</div>
                <div className="text-base font-semibold tabular-nums">
                  {typeof v === "number" ? v.toFixed(3) : String(v)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 后续研究方向 */}
      <Card className="p-5 space-y-3">
        <div className="text-sm font-medium">后续研究方向</div>
        {next?.next_steps && next.next_steps.length > 0 ? (
          <div className="space-y-2">
            {next.next_steps.map((s, i) => (
              <div
                key={s.id}
                className="rounded-md border border-border/60 p-3 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">
                    {["方向 A", "方向 B", "方向 C"][i] ?? `方向 ${i + 1}`} · {s.title}
                  </div>
                  {s.est_cost && (
                    <span className="text-[11px] text-muted-foreground">
                      估算成本:{s.est_cost}
                    </span>
                  )}
                </div>
                {s.description && (
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {s.description}
                  </div>
                )}
                <div className="pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/experiments/${expId}`)}
                  >
                    查看完整记录
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground leading-relaxed">
            系统还在整理后续方向,你也可以直接从下方进入实验详情查看完整记录。
          </div>
        )}
      </Card>

      {/* 主行动 */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate("/")}
        >
          返回研究方向列表
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/experiments/${expId}`)}
          >
            <FileText className="h-4 w-4" />
            查看完整记录
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => forkMutation.mutate()}
            disabled={forkMutation.isPending}
          >
            {forkMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GitBranch className="h-4 w-4" />
            )}
            基于此开新分支
          </Button>
        </div>
      </div>
    </div>
  );
}