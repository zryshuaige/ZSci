import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Input";

const STATUS_META: Record<string, { color: string; icon: React.ComponentType<{ className?: string }> }> = {
  completed: { color: "bg-green-100 text-green-800", icon: CheckCircle },
  failed: { color: "bg-red-100 text-red-800", icon: XCircle },
  rejected: { color: "bg-red-100 text-red-800", icon: XCircle },
  awaiting_approval: { color: "bg-amber-100 text-amber-800", icon: Clock },
  running: { color: "bg-blue-100 text-blue-800", icon: Spinner },
  pending: { color: "bg-muted", icon: Clock },
};

export default function AgentPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const qc = useQueryClient();
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [request, setRequest] = useState(project.research_direction || "");

  const runTrend = useMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "research.trend_analysis", { user_request: request }),
    onSuccess: (task) => setSelectedTask(task.id),
  });
  const runHypo = useMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "research.generate_hypothesis", { user_request: request }),
    onSuccess: (task) => { setSelectedTask(task.id); qc.invalidateQueries({ queryKey: ["ideas", project.id] }); },
  });
  const runCode = useMutation({
    mutationFn: () =>
      api.runAgentTask(project.id, "code.search_github", { user_request: request }),
    onSuccess: (task) => { setSelectedTask(task.id); qc.invalidateQueries({ queryKey: ["repos", project.id] }); },
  });

  const busy = runTrend.isPending || runHypo.isPending || runCode.isPending;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Agent 任务中心</h1>

      <Card className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">研究方向 / 分析请求</div>
        {/* L6: use the shared Textarea component for consistent styling. */}
        <Textarea
          rows={2}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => runTrend.mutate()} disabled={busy}>
            <Play className="h-4 w-4" /> 研究趋势分析
          </Button>
          <Button onClick={() => runHypo.mutate()} disabled={busy}>
            <Play className="h-4 w-4" /> 生成 idea
          </Button>
          <Button onClick={() => runCode.mutate()} disabled={busy}>
            <Play className="h-4 w-4" /> GitHub 代码检索
          </Button>
        </div>
        {(runTrend.isError || runHypo.isError || runCode.isError) && (
          <div className="text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              {(runTrend.error || runHypo.error || runCode.error)?.message}
              <div className="text-xs mt-1">Agent 需要 LLM。请在设置页配置模型 API。</div>
            </div>
          </div>
        )}
      </Card>

      {selectedTask && <TaskDetail taskId={selectedTask} projectId={project.id} />}
    </div>
  );
}

function TaskDetail({ taskId, projectId }: { taskId: string; projectId: string }) {
  const qc = useQueryClient();
  const { data: task } = useQuery({
    queryKey: ["agent-task", taskId],
    queryFn: () => api.getAgentTask(taskId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && ["running", "pending"].includes(s) ? 1500 : false;
    },
  });
  // H7: gate events/approvals polling on whether the task is still active.
  // Previously these polled every 1.5s forever, even after the task finished.
  const isActive = !!task?.status && ["running", "pending", "awaiting_approval"].includes(task.status);
  const { data: events = [] } = useQuery({
    queryKey: ["agent-events", taskId],
    queryFn: () => api.listAgentEvents(taskId),
    refetchInterval: () => (isActive ? 1500 : false),
  });
  const { data: approvals = [] } = useQuery({
    queryKey: ["approvals", taskId],
    queryFn: () => api.listApprovals(taskId),
    refetchInterval: () => (isActive ? 1500 : false),
  });

  const decide = useMutation({
    mutationFn: (approved: boolean) => api.decideApproval(taskId, approved),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-task", taskId] });
      qc.invalidateQueries({ queryKey: ["approvals", taskId] });
      qc.invalidateQueries({ queryKey: ["ideas", projectId] });
      qc.invalidateQueries({ queryKey: ["repos", projectId] });
    },
  });

  if (!task) return <Spinner />;
  const meta = STATUS_META[task.status] || STATUS_META.pending;
  const Icon = meta.icon;
  // H11: JSON.parse on every render crashes the page (no ErrorBoundary
  // caught it before; now wrapped but still better to parse defensively).
  // Cast to a JSON-serializable shape so JSON.stringify accepts it.
  let result: Record<string, unknown> | null = null;
  if (task.result_json) {
    try {
      const parsed: unknown = JSON.parse(task.result_json);
      result = (typeof parsed === "object" && parsed !== null ? parsed : { _value: parsed }) as Record<string, unknown>;
    } catch {
      result = { _raw: task.result_json, _error: "无法解析为 JSON" };
    }
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="font-medium">{task.task_type}</span>
          <Badge className={meta.color}>{task.status}</Badge>
          <span className="text-xs text-muted-foreground ml-auto">{task.id}</span>
        </div>
        {task.error && <div className="text-sm text-destructive mt-2">{task.error}</div>}
      </Card>

      {approvals.filter((a) => a.status === "pending").map((a) => (
        <Card key={a.id} className="p-4 border-amber-300 bg-amber-50 animate-fade-in">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">需要审批:{a.action_type}</div>
              {a.payload_json && (
                <pre className="text-xs mt-1 bg-muted p-2 rounded max-h-40 overflow-auto">
                  {a.payload_json}
                </pre>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => decide.mutate(true)} disabled={decide.isPending}>批准</Button>
              <Button size="sm" variant="destructive" onClick={() => decide.mutate(false)} disabled={decide.isPending}>拒绝</Button>
            </div>
          </div>
        </Card>
      ))}

      {result && (
        <Card className="p-4">
          <div className="font-medium mb-2">结果</div>
          <pre className="text-xs bg-muted p-2 rounded max-h-96 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
        </Card>
      )}

      <Card className="p-4">
        <div className="font-medium mb-2">事件流</div>
        <div className="space-y-1 max-h-64 overflow-auto text-xs font-mono">
          {events.map((e) => (
            <div key={e.id} className="flex gap-2 animate-fade-in">
              <span className="text-muted-foreground">{new Date(e.created_at).toLocaleTimeString()}</span>
              <Badge className="bg-muted text-[10px]">{e.kind}</Badge>
              <span className="break-all">{e.message}</span>
            </div>
          ))}
          {events.length === 0 && <div className="text-muted-foreground">无事件</div>}
        </div>
      </Card>
    </div>
  );
}
