// Experiments domain: experiments, the 5-phase workflow, runs/metrics,
// checkpoint decisions, branches, files, preview-plan, next-steps.
import { BASE, request } from "./client";

export interface Experiment {
  id: string;
  project_id: string;
  title: string | null;
  slug: string | null;
  root_path: string | null;
  source_repository_id: string | null;
  related_idea_id: string | null;
  status: string;
  research_question: string | null;
  hypothesis: string | null;
  plan_json: string | null;
  created_at: string;
  updated_at: string;
  // 5-phase interactive workflow (see backend app/experiments/states.py).
  mode: string;
  overall_status: string;
  current_stage: string | null;
  parent_experiment_id: string | null;
  branch_name: string | null;
  decision_history_json: string | null;
}

export interface ExperimentStage {
  id: string;
  experiment_id: string;
  stage_key: string;
  stage_name_zh: string;
  description: string;
  requires_user: boolean;
  optional_user: boolean;
  expected_seconds: number;
  version: number;
  status: string;
  inputs_json: Record<string, unknown> | null;
  outputs_json: Record<string, unknown> | null;
  artifacts_json: Array<Record<string, unknown>> | null;
  config_json: Record<string, unknown> | null;
  user_decisions_json: Array<Record<string, unknown>> | null;
  dependencies: string[] | null;
  invalidated_by_stage_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  /** Populated only when status === "waiting_for_user". */
  checkpoint_summary: Record<string, unknown> | null;
}

export interface StageProgress {
  experiment_id: string;
  overall_status: string;
  current_stage: string | null;
  mode: string;
  stages: ExperimentStage[];
  decision_history: Array<Record<string, unknown>>;
  /** Most-recent friendly error message (for the 失败 banner). */
  last_error: string | null;
}

export interface ExperimentUpdate {
  title?: string;
  research_question?: string;
  hypothesis?: string;
}

export interface Run {
  id: string;
  experiment_id: string;
  run_path: string | null;
  command: string | null;
  status: string;
  git_commit: string | null;
  seed: number | null;
  pid: number | null;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
}

export interface Metric {
  id: string;
  run_id: string;
  step: number;
  metric_name: string;
  metric_value: number;
  created_at: string;
}

export interface Branch {
  id: string;
  experiment_id: string;
  parent_experiment_id: string | null;
  parent_branch_id: string | null;
  fork_stage_id: string | null;
  fork_stage_key: string | null;
  branch_name: string;
  created_at: string;
}

export interface PreviewPlan {
  goal: string | null;
  hypothesis: string | null;
  scope: string | null;
  fairness_note: string | null;
  compute_plan: string | null;
  risks: string[];
  metrics: Array<{ name: string; definition?: string | null; aggregation?: string | null }>;
  est_minutes: number | null;
  success_means: string | null;
  failure_means: string | null;
  has_plan: boolean;
}

export interface NextSteps {
  conclusion: string | null;
  judgement: string | null;
  metrics: Record<string, number | string>;
  risks: string[];
  next_steps: Array<{
    id: string;
    title: string;
    description?: string | null;
    est_cost?: string | null;
    template?: string | null;
  }>;
  has_analysis: boolean;
}

export type StageDecision = "approve" | "edit" | "skip" | "abort";

export const experimentsApi = {
  listExperiments: (projectId: string) =>
    request<Experiment[]>(`/projects/${projectId}/experiments`),
  createExperiment: (projectId: string, body: Record<string, unknown>) =>
    request<Experiment>(`/projects/${projectId}/experiments`, {
      method: "POST", body: JSON.stringify(body),
    }),
  getExperiment: (expId: string) => request<Experiment>(`/experiments/${expId}`),
  /** PATCH — fill in research_question before launching, or edit the title. */
  updateExperiment: (expId: string, body: ExperimentUpdate) =>
    request<Experiment>(`/experiments/${expId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  startAutonomous: (
    expId: string,
    body: { selected_papers?: string[]; selected_repositories?: string[]; run_configs?: string[] },
    mode: "interactive" | "auto" = "interactive"
  ) =>
    request<{ task_id: string; experiment_id: string; mode: string }>(
      `/experiments/${expId}/autonomous?mode=${mode}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),
  listStages: (expId: string) =>
    request<StageProgress>(`/experiments/${expId}/stages`),
  decideStage: (
    expId: string,
    body: {
      decision: StageDecision;
      target_stage_id?: string | null;
      payload?: Record<string, unknown> | null;
    }
  ) =>
    request<{ ok: boolean; decision: string; experiment_id: string; task_id: string | null; fork_experiment_id: string | null }>(
      `/experiments/${expId}/decide`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  forkExperiment: (
    expId: string,
    body: { target_stage_id: string; title?: string | null; branch_name?: string | null }
  ) =>
    request<Experiment>(`/experiments/${expId}/fork`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listBranches: (expId: string) =>
    request<Branch[]>(`/experiments/${expId}/branches`),
  listExperimentFiles: (expId: string) =>
    request<{ files: string[] }>(`/experiments/${expId}/files`),
  getExperimentFile: (expId: string, path: string) =>
    request<{ path: string; content: string }>(
      `/experiments/${expId}/file?path=${encodeURIComponent(path)}`
    ),

  /** 研究计划确认页消费的非技术化预览。 */
  previewPlan: (expId: string) =>
    request<PreviewPlan | null>(`/experiments/${expId}/preview-plan`),
  /** 实验结果后续研究方向。未到 analysis 阶段时 has_analysis=false。 */
  nextSteps: (expId: string) =>
    request<NextSteps | null>(`/experiments/${expId}/next-steps`),

  // --- Runs ---
  listRuns: (expId: string) => request<Run[]>(`/experiments/${expId}/runs`),
  createRun: (expId: string, body: { command: string; seed?: number; confirmed: boolean }) =>
    request<Run>(`/experiments/${expId}/runs`, { method: "POST", body: JSON.stringify(body) }),
  getRun: (runId: string) => request<Run>(`/runs/${runId}`),
  getRunLogs: (runId: string) => request<{ logs: string }>(`/runs/${runId}/logs`),
  getRunMetrics: (runId: string) => request<Metric[]>(`/runs/${runId}/metrics`),
  stopRun: (runId: string) => request<{ stopped: boolean }>(`/runs/${runId}/stop`, { method: "POST" }),
  runStreamUrl: (runId: string) => `${BASE}/runs/${runId}/stream`,
};
