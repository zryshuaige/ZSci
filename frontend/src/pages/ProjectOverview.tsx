import { Link, useOutletContext } from "react-router-dom";
import { BookOpen, Lightbulb, FlaskConical, ArrowRight, AlertTriangle, RotateCw, Pencil, Check, X } from "@/components/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, qk, type Project } from "@/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToastMutation } from "@/lib/hooks/useToastMutation";

/** 项目总览 = 旅程仪表盘:项目 → 文献 → 想法 → 实验 → 写作。
 *  除了各环节计数,还要回答「下一步去哪」——根据链路里第一个空缺环节
 *  给出唯一的引导 CTA,让用户随时知道当前位置与下一步动作。 */
export default function ProjectOverview() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();

  // 研究方向卡此前是纯展示:未设定时用户没有任何入口去填它。现在
  // 提供内联编辑,保存即 PATCH /projects/{id}。
  const [dirEditing, setDirEditing] = useState(false);
  const [dirDraft, setDirDraft] = useState("");
  const dirMutation = useToastMutation({
    mutationFn: (v: string) => api.updateProject(project.id, { research_direction: v }),
    successMessage: "研究方向已更新",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.projects.one(project.id) });
      qc.invalidateQueries({ queryKey: qk.projects.all });
      setDirEditing(false);
    },
  });

  const papersQuery = useQuery({
    queryKey: qk.papers.byProject(project.id),
    queryFn: () => api.listPapers(project.id),
  });
  const ideasQuery = useQuery({
    queryKey: qk.ideas.byProject(project.id),
    queryFn: () => api.listIdeas(project.id),
  });
  const expsQuery = useQuery({
    queryKey: qk.experiments.byProject(project.id),
    queryFn: () => api.listExperiments(project.id),
  });

  const papers = papersQuery.data ?? [];
  const ideas = ideasQuery.data ?? [];
  const exps = expsQuery.data ?? [];
  const downloaded = papers.filter((p) => p.downloaded);

  // 「需要你注意」的实验：运行中 / 等待确认 —— 这是最该被推到眼前的状态，
  // 比计数更重要，因此渲染在计数卡之前。
  const runningExps = exps.filter((e) => e.overall_status === "running");
  const waitingExps = exps.filter((e) => e.overall_status === "waiting_user");

  const anyLoading = papersQuery.isLoading || ideasQuery.isLoading || expsQuery.isLoading;
  const anyError = papersQuery.isError || ideasQuery.isError || expsQuery.isError;
  const retryAll = () => {
    // 只重试失败的查询,已成功的缓存不动。
    if (papersQuery.isError) papersQuery.refetch();
    if (ideasQuery.isError) ideasQuery.refetch();
    if (expsQuery.isError) expsQuery.refetch();
  };

  // 下一步引导:优先级高于旅程阶梯 —— 有实验在等确认/在跑时,先处理它;
  // 否则取旅程中第一个空缺的环节作为 CTA。顺序即旅程顺序。
  const nextStep = (() => {
    if (waitingExps.length > 0) {
      return {
        step: `待处理 · ${waitingExps.length} 个实验等你确认`,
        hint: "实验流程已停在关键节点,确认后才会继续。决策比补充文献更紧急。",
        cta: "去决策",
        to: `/projects/${project.id}/experiments/${waitingExps[0].id}`,
      };
    }
    if (runningExps.length > 0) {
      return {
        step: `进行中 · ${runningExps.length} 个实验正在运行`,
        hint: "实验在自动推进。你可以先做别的,有结论时这里会提醒你。",
        cta: "查看进度",
        to: `/projects/${project.id}/experiments/${runningExps[0].id}`,
      };
    }
    if (papers.length === 0) {
      return {
        step: "第一步 · 检索文献",
        hint: "文献是后续想法与实验的基础。先检索并下载几篇相关论文。",
        cta: "去检索文献",
        to: `/projects/${project.id}/literature`,
      };
    }
    if (ideas.length === 0) {
      // 有研究方向时把它带进探索流程,避免用户重新输入一遍。
      const seed = (project.research_direction || "").trim();
      const to = seed
        ? `/projects/${project.id}/explore/new?${new URLSearchParams({ idea: seed }).toString()}`
        : `/projects/${project.id}/explore/new`;
      return {
        step: "第二步 · 探索想法",
        hint: "已有文献积累。让系统结合文献整理几个值得进一步评估的研究方向。",
        cta: "去探索想法",
        to,
      };
    }
    if (exps.length === 0) {
      return {
        step: "第三步 · 做实验",
        hint: "已有候选研究方向。挑一个方向创建实验,验证它的核心假设。",
        cta: "去做实验",
        to: `/projects/${project.id}/experiments`,
      };
    }
    return {
      step: "实验进行中",
      hint: "已有实验记录。回到实验工作台跟踪进展,或基于结果开始写作。",
      cta: "查看实验",
      to: `/projects/${project.id}/experiments`,
    };
  })();

  const counts = [
    { label: "文献", icon: BookOpen, tint: "bg-blue-50 text-blue-600", value: papers.length, loading: papersQuery.isLoading, to: `/projects/${project.id}/literature` },
    { label: "想法", icon: Lightbulb, tint: "bg-amber-50 text-amber-600", value: ideas.length, loading: ideasQuery.isLoading, to: `/projects/${project.id}/ideas` },
    { label: "实验", icon: FlaskConical, tint: "bg-violet-50 text-violet-600", value: exps.length, loading: expsQuery.isLoading, to: `/projects/${project.id}/experiments` },
  ];

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-5">
      <Card className="p-5 border-l-4 border-l-primary/60">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">研究方向</div>
            {dirEditing ? (
              <div className="mt-2 space-y-2">
                <textarea
                  className="w-full h-20 rounded-md border border-border bg-background p-2 text-sm"
                  value={dirDraft}
                  onChange={(e) => setDirDraft(e.target.value)}
                  placeholder="用一两句话概括这个项目想研究什么,例如:多模态科研数据融合如何加速材料发现"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={dirMutation.isPending || !dirDraft.trim()}
                    onClick={() => dirMutation.mutate(dirDraft.trim())}
                  >
                    <Check className="h-4 w-4" /> 保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDirEditing(false)}>
                    <X className="h-4 w-4" /> 取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-1.5 text-lg font-medium leading-snug">
                {project.research_direction || (
                  <span className="text-muted-foreground/70">未设定 —— 一句话概括你想研究什么</span>
                )}
              </div>
            )}
          </div>
          {!dirEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              onClick={() => {
                setDirDraft(project.research_direction || "");
                setDirEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              {project.research_direction ? "编辑" : "设定"}
            </Button>
          )}
        </div>
      </Card>

      {/* 错误 ≠ 空:任一计数查询失败时先给出错误卡 + 重试,不把失败渲染成 0。 */}
      {anyError && !anyLoading && (
        <Card className="p-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-destructive/70" />
          <div className="mt-2 text-sm text-muted-foreground">项目概览加载失败,请稍后重试</div>
          <Button size="sm" variant="outline" className="mt-3" onClick={retryAll}>
            <RotateCw className="h-3.5 w-3.5" /> 重试
          </Button>
        </Card>
      )}

      {/* 「需要你注意」：运行中 / 等待确认的实验，置顶于一切之前。 */}
      {(runningExps.length > 0 || waitingExps.length > 0) && (
        <Card className="p-4 space-y-2 border-amber-300/60 bg-amber-50/30">
          {waitingExps.map((e) => (
            <Link
              key={e.id}
              to={`/projects/${project.id}/experiments/${e.id}`}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-amber-100/40 transition-colors"
            >
              <span className="text-sm min-w-0 truncate">
                <span className="font-medium">⏸ 等待你的确认</span>
                <span className="text-muted-foreground"> · {e.title}</span>
              </span>
              <span className="text-xs text-primary shrink-0 flex items-center gap-1">
                去决策 <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          ))}
          {runningExps.map((e) => (
            <Link
              key={e.id}
              to={`/projects/${project.id}/experiments/${e.id}`}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-amber-100/40 transition-colors"
            >
              <span className="text-sm min-w-0 truncate">
                <span className="font-medium">⟳ 实验进行中</span>
                <span className="text-muted-foreground"> · {e.title}</span>
              </span>
              <span className="text-xs text-primary shrink-0 flex items-center gap-1">
                去查看 <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          ))}
        </Card>
      )}

      {/* 旅程计数:三个环节各一张卡,点击直达对应页面。 */}
      <div className="grid grid-cols-3 gap-4">
        {counts.map((c) => (
          <Link key={c.label} to={c.to} className="block">
            <Card className="p-4 hover-lift hover:shadow-medium hover:border-primary/25 transition-colors duration-sm">
              <div className="flex items-center gap-2.5">
                <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${c.tint}`}>
                  <c.icon className="h-4 w-4" />
                </span>
                <span className="text-sm text-muted-foreground">{c.label}</span>
              </div>
              {c.loading
                ? <Skeleton className="h-9 w-16 mt-2" />
                : <div className="text-4xl font-bold mt-2 tabular-nums tracking-tight">{c.value}</div>}
            </Card>
          </Link>
        ))}
      </div>

      {/* 下一步 CTA —— 只在数据就绪(非加载、非错误)时给出引导,
          否则 CTA 可能基于错误的「空」把用户带错方向。 */}
      {!anyLoading && !anyError && (
        <Card className="p-5 bg-gradient-to-br from-primary/[0.06] to-transparent border-primary/10">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs font-medium text-primary">{nextStep.step}</div>
              <div className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {nextStep.hint}
              </div>
            </div>
            <Link to={nextStep.to} className="shrink-0">
              <Button>
                {nextStep.cta} <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium">最近下载</h3>
          <Link to={`/projects/${project.id}/literature`}>
            <Button variant="outline" size="sm">去文献库</Button>
          </Link>
        </div>
        {papersQuery.isLoading ? (
          <div className="space-y-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : papersQuery.isError ? (
          <div className="text-sm text-muted-foreground">
            下载记录加载失败。
            <button
              type="button"
              className="ml-1 text-primary hover:underline"
              onClick={() => papersQuery.refetch()}
            >
              重试
            </button>
          </div>
        ) : downloaded.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            还没有下载论文。去
            <Link to={`/projects/${project.id}/literature`} className="text-primary hover:underline mx-0.5">
              文献库
            </Link>
            检索并下载第一批论文。
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {downloaded.slice(0, 5).map((p) => (
              <li key={p.id} className="py-2 hover:bg-muted/50 -mx-2 px-2 rounded-md transition-colors duration-sm">
                <Link to={`/projects/${project.id}/papers/${p.id}`} className="hover:underline">
                  <div className="text-sm font-medium line-clamp-1">{p.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {[p.year, p.venue].filter(Boolean).join(" · ")}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

    </div>
  );
}
