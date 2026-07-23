import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FlaskConical, Bot, Play, Loader2, CheckCircle2, XCircle, Activity,
  Search, Download, FileText, Languages, NotebookPen, FileCode, BookOpen,
} from "lucide-react";
import { api, type ActiveWorkflowTask, type ActiveWorkflowRun, type Job } from "@/lib/api";
import { cn } from "@/lib/cn";

/** Global workflow indicator, mounted in the left sidebar so it survives page
 * navigation.
 *
 * The backend keeps autonomous experiments + agent tasks running even when the
 * user navigates away (orchestrator uses asyncio.create_task; sync agent tasks
 * run in the threadpool). The problem this solves: the streaming panels held
 * the task id in component state, so leaving the page looked like the workflow
 * "exited". This sidebar lists every active task/run across all projects and
 * deep-links back to the right page, so a running workflow is always visible
 * and reachable.
 *
 * The section is ALWAYS rendered (with a header) so it's discoverable even when
 * idle. It also shows recently-finished tasks for ~90s (the `recent` flag) so
 * fast synchronous tasks like "生成 idea" leave a visible trace even if they
 * completed between polls. Polls every 2s while workflows are active, 4s when
 * idle.
 */
export default function WorkflowStatus({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["workflows", "active"],
    queryFn: () => api.listActiveWorkflows(),
    refetchInterval: (q) => {
      const d = q.state.data;
      const hasActive =
        !!d &&
        (d.tasks.some((t) => !t.recent) ||
          d.jobs.some((j) => !j.recent) ||
          d.runs.length > 0);
      return hasActive ? 2000 : 4000;
    },
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const activeTasks = (data?.tasks ?? []).filter((t) => !t.recent);
  const recentTasks = (data?.tasks ?? []).filter((t) => t.recent);
  const activeJobs = (data?.jobs ?? []).filter((j) => !j.recent);
  const recentJobs = (data?.jobs ?? []).filter((j) => j.recent);
  const runs = data?.runs ?? [];
  const activeCount = activeTasks.length + activeJobs.length + runs.length;

  if (collapsed) {
    // Collapsed: always show an activity icon (discoverable); pulse + badge when
    // something is actually running.
    return (
      <div className="px-2 py-2">
        <button
          onClick={() => {
            const first = activeTasks[0] ?? activeJobs[0] ?? null;
            if (first && "task_type" in first) navigate(linkForTask(first));
            else if (first && "kind" in first) navigate(linkForJob(first));
            else if (runs[0]) navigate(linkForRun(runs[0]));
            else if (recentTasks[0]) navigate(linkForTask(recentTasks[0]));
            else if (recentJobs[0]) navigate(linkForJob(recentJobs[0]));
          }}
          title={
            activeCount > 0
              ? `${activeCount} 个进行中工作流`
              : recentTasks.length > 0
                ? "工作流(最近完成)"
                : "工作流(无进行中)"
          }
          className={cn(
            "relative flex h-9 w-9 mx-auto items-center justify-center rounded-md transition-colors duration-sm ease-out",
            activeCount > 0
              ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {activeCount > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Activity className="h-4 w-4" />
          )}
          {activeCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="px-2 py-2 space-y-1">
      <div className="px-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {activeCount > 0 ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        ) : (
          <Activity className="h-3 w-3" />
        )}
        工作流
        {activeCount > 0 && <span className="text-blue-600">{activeCount} 进行中</span>}
      </div>

      {activeTasks.length === 0 && runs.length === 0 && activeJobs.length === 0 && recentTasks.length === 0 && recentJobs.length === 0 && (
        <div className="px-1 py-1 text-[11px] text-muted-foreground/70">暂无进行中工作流</div>
      )}

      {activeTasks.map((t) => (
        <WorkflowRow key={t.id} t={t} onClick={() => navigate(linkForTask(t))} />
      ))}
      {activeJobs.map((j) => (
        <JobRow key={j.id} j={j} onClick={() => navigate(linkForJob(j))} />
      ))}
      {runs.map((r) => (
        <button
          key={r.run_id}
          onClick={() => navigate(linkForRun(r))}
          title={r.command || "运行中"}
          className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-sm ease-out active:scale-[0.98]"
        >
          <Play className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">实验运行中</span>
            <span className="block truncate text-[11px] text-muted-foreground/80 font-mono">{r.command || r.run_id.slice(0, 10)}</span>
          </span>
        </button>
      ))}

      {(recentTasks.length > 0 || recentJobs.length > 0) && (
        <>
          <div className="px-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/50">最近完成</div>
          {recentTasks.map((t) => (
            <WorkflowRow key={t.id} t={t} onClick={() => navigate(linkForTask(t))} />
          ))}
          {recentJobs.map((j) => (
            <JobRow key={j.id} j={j} onClick={() => navigate(linkForJob(j))} />
          ))}
        </>
      )}
    </div>
  );
}

function WorkflowRow({ t, onClick }: { t: ActiveWorkflowTask; onClick: () => void }) {
  const isRecent = t.recent;
  const failed = ["failed", "rejected", "stopped"].includes(t.status);
  const done = t.status === "completed";
  return (
    <button
      onClick={onClick}
      title={t.last_message || t.task_type}
      className={cn(
        "w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted transition-colors duration-sm ease-out active:scale-[0.98]",
        isRecent ? "text-muted-foreground/70" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {t.task_type === "experiment.autonomous_run" ? (
        <FlaskConical className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", isRecent ? (failed ? "text-red-400" : done ? "text-green-500" : "text-blue-400") : "text-blue-500")} />
      ) : isRecent ? (
        failed ? <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-400" /> : <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
      ) : (
        <Bot className="h-3.5 w-3.5 mt-0.5 shrink-0 text-violet-500" />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", !isRecent && "font-medium text-foreground")}>
          {labelForTask(t)}
          {isRecent && (
            <span className={cn("ml-1", failed ? "text-red-500" : done ? "text-green-600" : "text-muted-foreground")}>
              {failed ? "失败" : done ? "完成" : t.status}
            </span>
          )}
        </span>
        {t.last_message && !isRecent && (
          <span className="block truncate text-[11px] text-muted-foreground/80">{t.last_message}</span>
        )}
      </span>
    </button>
  );
}

function labelForTask(t: ActiveWorkflowTask): string {
  switch (t.task_type) {
    case "experiment.autonomous_run":
      return "自主实验";
    case "research.trend_analysis":
      return "研究趋势分析";
    case "research.generate_hypothesis":
      return "生成 idea";
    case "code.search_github":
      return "GitHub 代码检索";
    case "writing.draft_section":
      return "写作起草";
    default:
      return t.task_type.split(".").pop() || t.task_type;
  }
}

function linkForTask(t: ActiveWorkflowTask): string {
  if (t.task_type === "experiment.autonomous_run" && t.experiment_id) {
    return `/projects/${t.project_id}/experiments/${t.experiment_id}?task=${t.id}`;
  }
  return `/projects/${t.project_id}/agent?task=${t.id}`;
}

function linkForRun(r: ActiveWorkflowRun): string {
  return `/projects/${r.project_id}/experiments/${r.experiment_id}`;
}

/** A generic long-running operation (literature search, download, parse,
 *  translation, reading note, LaTeX compile, benchmark search). */
const JOB_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  literature_search: { icon: Search, label: "文献检索" },
  literature_recommend: { icon: BookOpen, label: "相似文献推荐" },
  paper_download: { icon: Download, label: "论文下载" },
  paper_parse: { icon: FileText, label: "PDF 解析" },
  translate: { icon: Languages, label: "翻译" },
  reading_note: { icon: NotebookPen, label: "阅读笔记" },
  latex_compile: { icon: FileCode, label: "LaTeX 编译" },
  benchmark_search: { icon: Search, label: "Benchmark 查找" },
  writing_init: { icon: FileCode, label: "写作初始化" },
};

function JobRow({ j, onClick }: { j: Job; onClick: () => void }) {
  const isRecent = j.recent;
  const failed = ["failed", "stopped"].includes(j.status);
  const done = j.status === "completed";
  const meta = JOB_META[j.kind] ?? { icon: Activity, label: j.kind };
  const Icon = meta.icon;
  return (
    <button
      onClick={onClick}
      title={j.message || j.title || j.kind}
      className={cn(
        "w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted transition-colors duration-sm ease-out active:scale-[0.98]",
        isRecent ? "text-muted-foreground/70" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {!isRecent && !done && !failed ? (
        <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 animate-spin text-blue-500" />
      ) : failed ? (
        <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-400" />
      ) : done ? (
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
      ) : (
        <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", !isRecent && "font-medium text-foreground")}>
          {j.title || meta.label}
          {isRecent && (
            <span className={cn("ml-1", failed ? "text-red-500" : done ? "text-green-600" : "text-muted-foreground")}>
              {failed ? "失败" : done ? "完成" : j.status}
            </span>
          )}
        </span>
        {j.message && !isRecent && (
          <span className="block truncate text-[11px] text-muted-foreground/80">{j.message}</span>
        )}
        {isRecent && j.result_summary && (
          <span className="block truncate text-[11px] text-muted-foreground/80">{j.result_summary}</span>
        )}
      </span>
    </button>
  );
}

function linkForJob(j: Job): string {
  // Deep-link back to the page that owns the operation, using the target.
  const pid = j.project_id;
  if (j.target_type === "paper" && j.target_id) {
    return `/projects/${pid}/papers/${j.target_id}`;
  }
  if (j.target_type === "experiment" && j.target_id) {
    return `/projects/${pid}/experiments/${j.target_id}`;
  }
  if (j.target_type === "run" && j.target_id) {
    return `/projects/${pid}/experiments`;
  }
  if (j.target_type === "literature") {
    return `/projects/${pid}/literature`;
  }
  if (j.target_type === "writing") {
    return `/projects/${pid}/writing`;
  }
  // Benchmark search lives on the experiments page.
  if (j.kind === "benchmark_search") {
    return `/projects/${pid}/experiments`;
  }
  return `/projects/${pid}`;
}
