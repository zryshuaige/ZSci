import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FlaskConical, Bot, Play, Loader2, CheckCircle2, XCircle, Activity,
  Search, Download, FileText, Languages, NotebookPen, FileCode, BookOpen,
} from "lucide-react";
import { api, type ActiveWorkflowTask, type ActiveWorkflowRun, type Job } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  agentStatusLabel,
  agentTaskLabel,
  jobDisplayTitle,
} from "@/lib/labels";

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
  // Hide agent_task jobs when the matching agent task is already listed.
  const taskIds = new Set((data?.tasks ?? []).map((t) => t.id));
  const activeJobs = (data?.jobs ?? []).filter(
    (j) => !j.recent && !(j.kind === "agent_task" && j.target_id && taskIds.has(j.target_id)),
  );
  const recentJobs = (data?.jobs ?? []).filter(
    (j) => j.recent && !(j.kind === "agent_task" && j.target_id && taskIds.has(j.target_id)),
  );
  const runs = data?.runs ?? [];
  const activeCount = activeTasks.length + activeJobs.length + runs.length;

  const go = (href: string) => navigate(href);

  if (collapsed) {
    return (
      <CollapsedActivity
        activeCount={activeCount}
        activeTasks={activeTasks}
        activeJobs={activeJobs}
        runs={runs}
        recentTasks={recentTasks}
        recentJobs={recentJobs}
        onNavigate={go}
      />
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
        进行中的任务
        {activeCount > 0 && <span className="text-blue-600">{activeCount}</span>}
      </div>

      {activeTasks.length === 0 && runs.length === 0 && activeJobs.length === 0 && recentTasks.length === 0 && recentJobs.length === 0 && (
        <div className="px-1 py-1 text-[11px] text-muted-foreground/70">暂无进行中的任务</div>
      )}

      <TaskList
        activeTasks={activeTasks}
        activeJobs={activeJobs}
        runs={runs}
        recentTasks={recentTasks}
        recentJobs={recentJobs}
        onNavigate={go}
      />
    </div>
  );
}

function CollapsedActivity({
  activeCount,
  activeTasks,
  activeJobs,
  runs,
  recentTasks,
  recentJobs,
  onNavigate,
}: {
  activeCount: number;
  activeTasks: ActiveWorkflowTask[];
  activeJobs: Job[];
  runs: ActiveWorkflowRun[];
  recentTasks: ActiveWorkflowTask[];
  recentJobs: Job[];
  onNavigate: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const items =
    activeCount > 0
      ? activeCount
      : recentTasks.length + recentJobs.length;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.top, left: r.right + 8 });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  const handleClick = () => {
    const total =
      activeTasks.length + activeJobs.length + runs.length + recentTasks.length + recentJobs.length;
    if (total === 0) return;
    if (total === 1) {
      const only =
        activeTasks[0] ? linkForTask(activeTasks[0])
        : activeJobs[0] ? linkForJob(activeJobs[0])
        : runs[0] ? linkForRun(runs[0])
        : recentTasks[0] ? linkForTask(recentTasks[0])
        : recentJobs[0] ? linkForJob(recentJobs[0])
        : null;
      if (only) onNavigate(only);
      return;
    }
    setOpen((v) => !v);
  };

  const tip =
    activeCount > 0
      ? `进行中的任务（${activeCount}）· 点击查看`
      : items > 0
        ? "最近完成的任务 · 点击查看"
        : "暂无进行中的任务";

  return (
    <div className="px-2 py-2">
      <Tooltip content={tip} side="right">
        <button
          ref={btnRef}
          type="button"
          onClick={handleClick}
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
      </Tooltip>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-64 max-h-80 overflow-y-auto rounded-lg border border-border bg-card shadow-float p-2 space-y-1 animate-pop"
        >
          <div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
            {activeCount > 0 ? `进行中的任务（${activeCount}）` : "最近完成"}
          </div>
          <TaskList
            activeTasks={activeTasks}
            activeJobs={activeJobs}
            runs={runs}
            recentTasks={recentTasks}
            recentJobs={recentJobs}
            onNavigate={(href) => {
              setOpen(false);
              onNavigate(href);
            }}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

function TaskList({
  activeTasks,
  activeJobs,
  runs,
  recentTasks,
  recentJobs,
  onNavigate,
}: {
  activeTasks: ActiveWorkflowTask[];
  activeJobs: Job[];
  runs: ActiveWorkflowRun[];
  recentTasks: ActiveWorkflowTask[];
  recentJobs: Job[];
  onNavigate: (href: string) => void;
}) {
  return (
    <>
      {activeTasks.map((t) => (
        <WorkflowRow key={t.id} t={t} onClick={() => onNavigate(linkForTask(t))} />
      ))}
      {activeJobs.map((j) => (
        <JobRow key={j.id} j={j} onClick={() => onNavigate(linkForJob(j))} />
      ))}
      {runs.map((r) => (
        <button
          key={r.run_id}
          type="button"
          onClick={() => onNavigate(linkForRun(r))}
          className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-sm ease-out active:scale-[0.98]"
        >
          <Play className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">
              实验运行中
              {r.experiment_title ? ` · ${r.experiment_title}` : ""}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground/80">
              点击查看进度
            </span>
          </span>
        </button>
      ))}
      {(recentTasks.length > 0 || recentJobs.length > 0) && (
        <>
          <div className="px-1 pt-1 text-[10px] text-muted-foreground/50">最近完成</div>
          {recentTasks.map((t) => (
            <WorkflowRow key={t.id} t={t} onClick={() => onNavigate(linkForTask(t))} />
          ))}
          {recentJobs.map((j) => (
            <JobRow key={j.id} j={j} onClick={() => onNavigate(linkForJob(j))} />
          ))}
        </>
      )}
    </>
  );
}

function WorkflowRow({ t, onClick }: { t: ActiveWorkflowTask; onClick: () => void }) {
  const isRecent = t.recent;
  const failed = ["failed", "rejected", "stopped"].includes(t.status);
  const done = t.status === "completed";
  return (
    <button
      type="button"
      onClick={onClick}
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
          {agentTaskLabel(t.task_type)}
          {isRecent && (
            <span className={cn("ml-1", failed ? "text-red-500" : done ? "text-green-600" : "text-muted-foreground")}>
              {agentStatusLabel(t.status)}
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

const JOB_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  literature_search: Search,
  literature_recommend: BookOpen,
  paper_download: Download,
  paper_parse: FileText,
  translate: Languages,
  reading_note: NotebookPen,
  latex_compile: FileCode,
  benchmark_search: Search,
  writing_init: FileCode,
  agent_task: Bot,
};

function JobRow({ j, onClick }: { j: Job; onClick: () => void }) {
  const isRecent = j.recent;
  const failed = ["failed", "stopped"].includes(j.status);
  const done = j.status === "completed";
  const Icon = JOB_ICONS[j.kind] ?? Activity;
  const title = jobDisplayTitle(j.title, j.kind);
  return (
    <button
      type="button"
      onClick={onClick}
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
          {title}
          {isRecent && (
            <span className={cn("ml-1", failed ? "text-red-500" : done ? "text-green-600" : "text-muted-foreground")}>
              {agentStatusLabel(j.status)}
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

function linkForTask(t: ActiveWorkflowTask): string {
  if (t.task_type === "experiment.autonomous_run" && t.experiment_id) {
    return `/projects/${t.project_id}/experiments/${t.experiment_id}?task=${t.id}`;
  }
  return `/projects/${t.project_id}/agent?task=${t.id}`;
}

function linkForRun(r: ActiveWorkflowRun): string {
  return `/projects/${r.project_id}/experiments/${r.experiment_id}`;
}

function linkForJob(j: Job): string {
  const pid = j.project_id;
  if (j.target_type === "agent_task" && j.target_id) {
    return `/projects/${pid}/agent?task=${j.target_id}`;
  }
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
  if (j.kind === "benchmark_search") {
    return `/projects/${pid}/experiments`;
  }
  if (j.kind === "agent_task") {
    return `/projects/${pid}/agent`;
  }
  return `/projects/${pid}`;
}
