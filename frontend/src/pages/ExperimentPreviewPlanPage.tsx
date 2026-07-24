// Phase C: 研究计划确认屏(用户在采纳候选方向 → 自动建实验后看到的中间页)。
//
// Route: /experiments/:expId/preview
// 行为:
//   1. 拉取 experiment 详情 + 试图拉取 preview-plan(后端 GET /experiments/{id}/preview-plan,
//      如果不存在则本次 PR 后端尚未实现,前端优雅降级显示 fallback 文案)。
//   2. 显示「你选择的方向」+ 6 步 AI 将自动完成 + 预计耗时 + 风险 + 成功/失败标准。
//   3. 主 CTA「一键开始首轮实验」→ POST startAutonomous → 跳 /experiments/:expId。
//   4. 次 CTA「调整实验范围」(Phase C 收尾时再加滑块)/「保存,稍后开始」(直接跳详情)。
//
// 本轮范围:不让这一步阻断用户旅程;Plan 后端缺失时显示 fallback 文案,主 CTA 仍然能
// 直接走 start_autonomous。

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, Loader2, Save, ChevronLeft, ListChecks, Sparkles } from "lucide-react";
import { api, fmtTime } from "@/lib/api";
import { showFriendlyError } from "@/lib/useFriendlyError";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Dialog";

/** 后端 /preview-plan 返回的形状 — 用 ReturnType 自动对齐 api.previewPlan 的定义。 */
type PlanPreview = NonNullable<Awaited<ReturnType<typeof api.previewPlan>>>;

interface StepBullet {
  title: string;
  detail: string;
}

const DEFAULT_STEPS: StepBullet[] = [
  { title: "梳理已有研究中的可对照基线和数据集", detail: "结合本项目已下载文献,挑出 1-3 个与所选方向最相关的结果作为参考对照。" },
  { title: "拟定评价指标与对照设置", detail: "明确对照方法、目标指标以及随机种子,确保首轮结果可重复比较。" },
  { title: "准备可运行的实验代码", detail: "生成项目结构、训练脚本与配置文件,并使其可以在本环境下复现。" },
  { title: "执行运行前的环境与代码检查", detail: "校验依赖、运行一次最短流程,确认设置无误后再正式计算。" },
  { title: "运行小规模首轮验证", detail: "在小数据集或短迭代下获得初步可对照的指标,用以判断方向是否值得继续。" },
  { title: "整理本轮结果,给出后续方向建议", detail: "汇总本轮结论与初步证据,并列出若干值得进一步比较的后续方案。" },
];

export default function ExperimentPreviewPlanPage() {
  const { expId } = useParams<{ expId: string }>();
  const navigate = useNavigate();

  const expQuery = useQuery({
    queryKey: ["experiment", expId],
    queryFn: () => api.getExperiment(expId!),
    enabled: !!expId,
  });

  // Plan 端点可能尚未上线(本轮后端 deliverable 推迟)。前端优先尝试调用,
  // 失败/404 时降级使用本地默认文案。这样主 CTA 永远可用,不阻塞流程。
  const planQuery = useQuery({
    queryKey: ["experiment-preview-plan", expId],
    queryFn: () => api.previewPlan(expId!),
    enabled: !!expId,
    retry: false,
  });

  // 一键启动:走 startAutonomous,成功后跳实验详情。
  const startMutation = useMutation({
    mutationFn: () => api.startAutonomous(expId!, {}, "interactive"),
    onSuccess: ({ task_id }) => {
      const params = new URLSearchParams();
      if (task_id) params.set("task", task_id);
      navigate(`/experiments/${expId}${params.toString() ? `?${params.toString()}` : ""}`);
    },
    onError: (err) => showFriendlyError(err),
  });

  const goBackToIdeas = () => navigate("/");

  if (expQuery.isLoading) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <Card className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> 正在读取实验信息……
        </Card>
      </div>
    );
  }

  const exp = expQuery.data;
  const plan = planQuery.data;
  const hasPlan = plan?.has_plan === true;
  const estMinutes = plan?.est_minutes ?? 120;
  const risks = (plan?.risks && plan.risks.length > 0)
    ? plan.risks
    : ["数据下载或解析可能受限", "小样本首轮验证,结论仅作初判"];
  const success = plan?.success_means
    ?? "在主要指标上观察到与对照的可重复差异(幅度视任务而定)";
  const failure = plan?.failure_means
    ?? "未观察到与对照的稳定差异,或复现性不足";
  // 后端给的 metrics 是 [{name, definition, aggregation}];前端只取 name 拼读。
  const metricNames = (plan?.metrics || []).map((m) => m.name).filter(Boolean);
  const metrics = metricNames.length > 0
    ? metricNames
    : ["主要任务指标", "稳定性(跨随机种子方差)", "运行成本与时长"];
  // 算力描述后端放在 compute_plan(自由文本);fallback 用一个温和的"按任务规模"
  const computePlan = plan?.compute_plan ?? "按任务规模合理安排(以本环境为准)";

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <button
          type="button"
          onClick={goBackToIdeas}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          ← 返回候选方向
        </button>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          首轮验证计划
        </h1>
        <p className="text-sm text-muted-foreground">
          下面是基于所选方向整理的首轮验证计划;耗时、算力和判定阈值均为初步估计,实际研究中请结合任务与领域惯例判断。
        </p>
      </div>

      {/* 你选择的方向 */}
      <Card className="p-5 space-y-2">
        <div className="text-xs text-muted-foreground">所选方向</div>
        <div className="text-lg font-semibold leading-snug">
          {exp?.title || "未命名方向"}
        </div>
        {exp?.research_question && (
          <div className="text-sm text-foreground/90 leading-relaxed">
            {exp.research_question}
          </div>
        )}
        {exp?.hypothesis && (
          <div className="text-xs text-muted-foreground leading-relaxed border-l-2 border-muted pl-3">
            假设:{exp.hypothesis}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground pt-1">
          记录于 {fmtTime(exp?.created_at)}
        </div>
      </Card>

      {/* 系统将协助完成的步骤 */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 text-primary" />
          本轮将完成的步骤
        </div>
        <ol className="space-y-2 text-sm leading-relaxed">
          {DEFAULT_STEPS.map((s, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="shrink-0 mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-medium">
                {i + 1}
              </span>
              <div>
                <div className="font-medium">{s.title}</div>
                <div className="text-xs text-muted-foreground">{s.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {/* 计划参数(若后端 plan 已就绪,使用真实数据;否则 fallback) */}
      <Card className="p-5 space-y-3">
        <div className="text-sm font-medium">首轮范围与初步估计</div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="预计耗时" value={`约 ${estMinutes >= 60 ? `${Math.round(estMinutes / 60)} 小时` : `${estMinutes} 分钟`} · 仅供参考`} />
          <Stat label="算力需求" value={computePlan} />
          <Stat label="初步通过阈值" value={success} />
          <Stat label="需重新评估的情况" value={failure} />
        </div>
        <div className="space-y-2 pt-2 border-t border-border/50">
          <Stat
            label="需关注的风险"
            value={risks.join("、")}
          />
          <Stat
            label="拟跟踪的指标"
            value={metrics.join("、")}
          />
        </div>
        {!hasPlan && (
          <div className="text-[11px] text-muted-foreground pt-1">
            注:更具体的范围与对照设置会在实验进行中进一步细化,这里先给出首轮可行范围。
          </div>
        )}
      </Card>

      {/* 主 CTA */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/experiments/${expId}`)}
          disabled={startMutation.isPending}
        >
          <Save className="h-4 w-4" />
          保存,稍后开始
        </Button>
        <Button
          size="lg"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
        >
          {startMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          启动首轮验证
        </Button>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <ChevronLeft className="h-3 w-3" />
        整体流程:梳理研究方向 → 选定方向 → 确认首轮计划 → 启动验证
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground mb-0.5">{label}</div>
      <div className="text-foreground/90">{value}</div>
    </div>
  );
}