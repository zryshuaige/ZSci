// Agent domain: research-assistant tasks, their event streams and approvals.
import { BASE, request } from "./client";

export interface AgentTask {
  id: string;
  project_id: string;
  task_type: string;
  status: string;
  input_json: string | null;
  plan_json: string | null;
  result_json: string | null;
  error: string | null;
  evidence_ids: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentEvent {
  id: string;
  task_id: string;
  kind: string;
  message: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  task_id: string;
  action_type: string;
  payload_json: string | null;
  status: string;
  decision_at: string | null;
  created_at: string;
}

export const agentApi = {
  listAgentSkills: () => request<{ skills: string[] }>("/agent/skills"),
  runAgentTask: (projectId: string, task_type: string, input: unknown) =>
    request<AgentTask>(`/projects/${projectId}/agent/tasks`, {
      method: "POST",
      body: JSON.stringify({ task_type, input }),
    }),
  getAgentTask: (taskId: string) => request<AgentTask>(`/agent/tasks/${taskId}`),
  listAgentEvents: (taskId: string) =>
    request<AgentEvent[]>(`/agent/tasks/${taskId}/events`),
  listApprovals: (taskId: string) =>
    request<Approval[]>(`/agent/tasks/${taskId}/approvals`),
  decideApproval: (taskId: string, approved: boolean) =>
    request<Approval>(`/agent/tasks/${taskId}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    }),
  agentStreamUrl: (taskId: string) => `${BASE}/agent/tasks/${taskId}/stream`,
};
