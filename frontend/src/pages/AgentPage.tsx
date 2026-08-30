import { useEffect, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, TrendingUp, Github, CheckCircle, XCircle, Clock, AlertTriangle, Loader2, Bot, ArrowRight, Sparkles } from "@/components/ui/icons";
import { api, fmtTime, qk, type AgentTask, type Project } from "@/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TONE_CLASSES } from "@/lib/statusMeta";
import { humanizeEventMessage } from "@/lib/eventHumanize";
import { Spinner } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAgentTaskStatus } from "@/lib/hooks/useActiveWorkflows";
import { useToastMutation } from "@/lib/hooks/useToastMutation";
import { useFriendlyError } from "@/lib/useFriendlyError";
import { cn } from "@/lib/cn";
import {
  actionTypeLabel,
  agentStatusLabel,
  agentTaskLabel,
  eventKindLabel,
} from "@/lib/labels";

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  completed: CheckCircle,
  failed: XCircle,
  rejected: XCircle,
  awaiting_approval: Clock,
  running: Spinner,
  pending: Clock,
};

/** 助手任务类型：分段控件选项。 */
const TASK_KINDS = [
  { key: "trend", label: "研究趋势分析", icon: TrendingUp, sample: "分析本项目的文献时间线，概括近三年的技术趋势与热点变化" },
  { key: "hypo", label: "想法灵感", icon: Lightbulb, sample: "基于已下载文献，提出 3 个值得验证的研究假设" },
  { key: "code", label: "代码检索", icon: Github, sample: "检索与本研究方向相关的官方代码仓库" },
] as const;

type TaskKind = (typeof TASK_KINDS)[number]["key"];

export default function AgentPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [selectedTask, setSelectedTask] = useState<string | null>(searchParams.get("task"));
  useEffect(() => {
    const t = searchParams.get("task");
    if (t) setSelectedTask(t);
  }, [searchParams]);
  const [request, setRequest] = useState(project.research_direction || "");
  const [kind, setKind] = useState<TaskKind>("trend");

  // 当前正在执行的任务 id。启动成功后立即记录,任务到达终态
  // (completed/failed/rejected)时由 useAgentTaskStatus 的回调清空 ——
  // 期间发起按钮保持禁用,杜绝任务还在跑就重复提交。
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const activeTaskStatus = useAgentTaskStatus(activeTaskId, () => {
    qc.invalidateQueries({ queryKey: qk.ideas.byProject(project.id) });
    qc.invalidateQueries({ queryKey: qk.repos.byProject(project.id) });
    setActiveTaskId(null);
  });

  const startTask = (task: AgentTask | undefined) => {
    qc.invalidateQueries({ queryKey: qk.workflows.active });
    if (task?.id) {
      setSelectedTask(task.id);
      setActiveTaskId(task.id);
    }
  };

  const runTask = useToastMutation({
    mutationFn: (k: TaskKind) => {
      const taskType =
        k === "trend"
          ? "research.trend_analysis"
          : k === "hypo"
            ? "research.generate_hypothesis"
            : "code.search_github";
      return api.runAgentTask(project.id, taskType, { user_request: request });
    },
    onSuccess: (task, k) => {
      if (k === "hypo") qc.invalidateQueries({ queryKey: qk.ideas.byProject(project.id) });
      if (k === "code") qc.invalidateQueries({ queryKey: qk.repos.byProject(project.id) });
      startTask(task);
    },
  });

  const busy =
    runTask.isPending || activeTaskStatus.isActive || activeTaskStatus.isTerminal;

  // 提交失败除 toast 外还在卡片内留一条持久提示;用友好文案,不直接
  // 暴露后端原始英文报错。
  const friendlyError = useFriendlyError(runTask.error);

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <PageHeaderBlock />

      <Card className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">分析请求</div>
        <Textarea
          rows={2}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="描述你的研究方向或具体问题"
        />
        {/* 单一主操作 + 任务类型分段控件：三种能力一个入口，无视觉权重争议。 */}
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="任务类型">
          {TASK_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={kind === k.key}
              disabled={busy}
              onClick={() => setKind(k.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-sm disabled:opacity-60",
                kind === k.key
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/30",
              )}
            >
              <k.icon className="h-3.5 w-3.5" />
              {k.label}
            </button>
          ))}
        </div>
        <Button onClick={() => runTask.mutate(kind)} disabled={busy} loading={runTask.isPending}>
          <Sparkles className="h-4 w-4" />
          {runTask.isPending ? "任务已提交，执行中…" : "开始分析"}
        </Button>
        {activeTaskStatus.isActive && (
          <div className="text-xs text-muted-foreground">
            任务进行中,完成后按钮会恢复可用;进度见下方任务详情。
          </div>
        )}
        {friendlyError && (
          <div className="text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              {friendlyError.title}:{friendlyError.body}
              {friendlyError.actionKey === "go_settings" && (
                <div className="text-xs mt-1">智能生成需要先配置大模型。请到「设置」完成配置后重试。</div>
              )}
            </div>
          </div>
        )}
      </Card>

      {selectedTask ? (
        <TaskDetail taskId={selectedTask} projectId={project.id} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">不知道从哪开始？点一张示例卡试试：</p>
          <div className="grid gap-3 md:grid-cols-3">
            {TASK_KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                onClick={() => {
                  setKind(k.key);
                  setRequest(k.sample);
                }}
                className="text-left rounded-xl border border-border/60 bg-card p-4 hover-lift hover:border-primary/25 transition-colors"
              >
                <k.icon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium">{k.label}</div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">{k.sample}</p>
              </button>
            ))}
          </div>
          <EmptyState
            icon={<Bot className="h-8 w-8" />}
            title="选择任务类型与请求，点「开始分析」"
            subtitle="任务进度也会出现在左侧「进行中的任务」，随时可点回来查看"
          />
        </div>
      )}
    </div>
  );
}

function PageHeaderBlock() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">研究助手</h1>
      <p className="text-xs text-muted-foreground mt-1">
        基于项目文献做趋势分析、提供想法灵感，或检索相关代码仓库
      </p>
    </div>
  );
}

function TaskDetail({ taskId, projectId }: { taskId: string; projectId: string }) {
  const qc = useQueryClient();
  const { data: task } = useQuery({
    queryKey: qk.agent.task(taskId),
    queryFn: () => api.getAgentTask(taskId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && ["running", "pending"].includes(s) ? 2000 : false;
    },
  });
  const isActive = !!task?.status && ["running", "pending", "awaiting_approval"].includes(task.status);
  const { data: events = [] } = useQuery({
    queryKey: qk.agent.events(taskId),
    queryFn: () => api.listAgentEvents(taskId),
    refetchInterval: () => (isActive ? 2000 : false),
  });
  const { data: approvals = [] } = useQuery({
    queryKey: qk.agent.approvals(taskId),
    queryFn: () => api.listApprovals(taskId),
    refetchInterval: () => (isActive ? 2000 : false),
  });

  const decide = useToastMutation({
    mutationFn: (approved: boolean) => api.decideApproval(taskId, approved),
    successMessage: (_d, approved) => (approved ? "已批准，任务继续执行" : "已拒绝"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agent.task(taskId) });
      qc.invalidateQueries({ queryKey: qk.agent.approvals(taskId) });
      qc.invalidateQueries({ queryKey: qk.ideas.byProject(projectId) });
      qc.invalidateQueries({ queryKey: qk.repos.byProject(projectId) });
    },
  });

  if (!task) return <Spinner />;
  const Icon = STATUS_ICONS[task.status] || Clock;
  let result: Record<string, unknown> | null = null;
  if (task.result_json) {
    try {
      const parsed: unknown = JSON.parse(task.result_json);
      result = (typeof parsed === "object" && parsed !== null ? parsed : { _value: parsed }) as Record<string, unknown>;
    } catch {
      result = { _raw: task.result_json, _error: "无法解析结果" };
    }
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="font-medium">{agentTaskLabel(task.task_type)}</span>
          <StatusBadge status={task.status} label={agentStatusLabel(task.status)} />
        </div>
        {task.error && <div className="text-sm text-destructive mt-2">{task.error}</div>}
      </Card>

      {task.task_type === "research.generate_hypothesis" && task.status === "completed" && (
        <Card className="p-3 flex items-center justify-between gap-3 flex-wrap border-primary/20 bg-primary/[0.04]">
          <span className="text-sm">已把新想法存入本项目的研究想法列表。</span>
          <div className="flex gap-2">
            <Link to={`/projects/${projectId}/ideas`}>
              <Button size="sm" variant="outline">查看想法列表</Button>
            </Link>
            <Link to={`/projects/${projectId}/ideas`}>
              <Button size="sm">
                用想法做实验 <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </Card>
      )}

      {approvals.filter((a) => a.status === "pending").map((a) => (
        <Card key={a.id} className={`p-4 animate-fade-in border ${TONE_CLASSES.amber.soft} rounded-xl`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">需要你确认：{actionTypeLabel(a.action_type)}</div>
              {(() => {
                // 结构化渲染审批内容——绝不再把原始 JSON 糊给用户。
                try {
                  const payload: unknown = a.payload_json ? JSON.parse(a.payload_json) : null;
                  const entries = payload && typeof payload === "object" && !Array.isArray(payload)
                    ? Object.entries(payload as Record<string, unknown>).filter(
                        ([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
                      )
                    : [];
                  if (entries.length === 0) return null;
                  return (
                    <dl className="mt-2 space-y-1.5 text-xs min-w-0">
                      {entries.map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-[11px] text-muted-foreground">{APPROVAL_KEY_LABELS[k] ?? k}</dt>
                          <dd className="text-foreground/90 break-words">{renderResultValue(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  );
                } catch {
                  return null; // payload 不可解析时不渲染任何原始内容
                }
              })()}
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" onClick={() => decide.mutate(true)} disabled={decide.isPending}>批准</Button>
              <Button size="sm" variant="destructive" onClick={() => decide.mutate(false)} disabled={decide.isPending}>拒绝</Button>
            </div>
          </div>
        </Card>
      ))}

      {result && (
        <Card className="p-4">
          <div className="font-medium mb-2">结果</div>
          {/* 结构化键值渲染,不再把整段 JSON 直接糊给用户;原始 JSON 折叠保留备查。 */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {Object.entries(result).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[11px] tracking-wide text-muted-foreground">
                  {RESULT_KEY_LABELS[k] ?? k}
                </dt>
                <dd className="text-foreground/90">{renderResultValue(v)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Card className="p-4">
        <div className="font-medium mb-2">进度记录</div>
        <div className="space-y-1 max-h-64 overflow-auto text-xs">
          {events.map((e) => (
            <div key={e.id} className="flex gap-2 animate-fade-in">
              <span className="text-muted-foreground shrink-0 tabular-nums font-mono">{fmtTime(e.created_at)}</span>
              <Badge className="bg-muted text-[10px] shrink-0 font-normal">{eventKindLabel(e.kind)}</Badge>
              <span className="break-all">{humanizeEventMessage(e.message)}</span>
            </div>
          ))}
          {events.length === 0 && <div className="text-muted-foreground">暂无记录</div>}
        </div>
      </Card>
    </div>
  );
}

/** 审批 payload 常见键 → 中文标签（未覆盖的键原样显示）。 */
const APPROVAL_KEY_LABELS: Record<string, string> = {
  action_type: "操作类型",
  stage_key: "阶段",
  stage_name: "阶段名称",
  summary: "阶段摘要",
  decision_options: "可选决策",
  title: "标题",
  name: "名称",
  description: "说明",
  url: "链接",
  path: "路径",
  command: "命令",
  reason: "原因",
  detail: "详情",
};

/** result_json 解析失败/非标对象时使用的内部键 → 中文标签。 */
const RESULT_KEY_LABELS: Record<string, string> = {
  _value: "返回值",
  _raw: "原始内容",
  _error: "解析失败原因",
};

/** 把任意结果值渲染成可读单元(与 CheckpointCard 的 renderValue 同模式):
 *  空值 → —;布尔 → 是/否;数组 → 项目符号;嵌套对象 → 小号 JSON 块。 */
function renderResultValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/60">—</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className={value ? TONE_CLASSES.green.text : TONE_CLASSES.red.text}>
        {value ? "是" : "否"}
      </span>
    );
  }
  if (typeof value === "string" || typeof value === "number") {
    return <span className="break-words whitespace-pre-wrap">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground/60">—</span>;
    return (
      <ul className="list-disc pl-4 space-y-0.5">
        {value.map((v, i) => (
          <li key={i}>
            {renderResultValue(
              // 对象数组优先取 name/title 作为行文本,避免整行 JSON。
              typeof v === "object" && v !== null
                ? ((v as Record<string, unknown>).name ??
                   (v as Record<string, unknown>).title ??
                   v)
                : v,
            )}
          </li>
        ))}
      </ul>
    );
  }
  // 嵌套对象 → 缩进键值列表（递归结构化，绝不渲染原始 JSON）。
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
  if (entries.length === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <dl className="space-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-muted-foreground">{RESULT_KEY_LABELS[k] ?? k}</dt>
          <dd className="text-foreground/90">{renderResultValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
