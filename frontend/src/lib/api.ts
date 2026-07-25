// Typed API client for the Z-Sci backend.

const BASE = "/api/v1";

import { FriendlyError, type FriendlyErrorCode } from "./useFriendlyError";

/** Format a backend ISO timestamp into the user's locale.
 *
 * The backend now serializes all timestamps with an explicit "Z" suffix
 * (via `app/utils.iso_utc`), so `new Date(s)` correctly interprets them
 * as UTC. We keep this helper exported so the page can pass `null` /
 * missing values through `fmtTime` and get an em-dash instead of "Invalid
 * Date".
 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Parse a backend error envelope (Phase A: 全局友好错误层).
 *
 *  New envelope from app/exception_handlers.py:
 *    { code: "LLM_NOT_CONFIGURED", user_message: "...", detail?: "...", suggestion?: "..." }
 *  Old envelope (FastAPI default — still supported as fallback):
 *    { detail: "..." }
 *
 * Returns a FriendlyError on success. Falls back to throwing a
 * plain Error(detail) when the response isn't JSON-shaped, so older
 * callers that only inspect `mutation.error.message` keep working.
 */
function parseErrorBody(status: number, body: unknown): FriendlyError | Error {
  // FastAPI's default unhandled-error body is plain text or arbitrary
  // JSON. The friendly layer always replies with { code, user_message, ... }.
  if (
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    "user_message" in body &&
    typeof (body as Record<string, unknown>).user_message === "string"
  ) {
    const b = body as Record<string, unknown>;
    return new FriendlyError(
      {
        code: (b.code as FriendlyErrorCode) ?? "UNKNOWN",
        user_message: String(b.user_message ?? "出错了,请稍后重试。"),
        detail: (b.detail as string | null | undefined) ?? null,
        suggestion: (b.suggestion as string | null | undefined) ?? null,
      },
      status,
    );
  }
  // Fallback: old `{detail: "..."}` shape.
  let detail = `${status}`;
  if (body !== null && typeof body === "object" && "detail" in body) {
    const v = (body as Record<string, unknown>).detail;
    detail = typeof v === "string" ? v : JSON.stringify(v);
  } else if (typeof body === "string") {
    detail = body;
  }
  // Make the legacy Error.message still readable in old call sites that
  // render `(mutation.error as Error).message`.
  return new Error(detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // M1: destructure headers out of init so the spread below doesn't overwrite
  // our merged headers. Previously `...init` came after `headers: {...}` and
  // clobbered the Content-Type header when callers passed their own headers.
  const { headers: initHeaders, ...restInit } = init || {};
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, {
      ...restInit,
      headers: { "Content-Type": "application/json", ...(initHeaders as Record<string, string> | undefined) },
    });
  } catch (cause: unknown) {
    // Network failure (DNS / CORS / connection-reset). Surface as a
    // FriendlyError(NETWORK_ERROR) so the toast component recognises it.
    throw new FriendlyError(
      {
        code: "NETWORK_ERROR",
        user_message: "网络异常,请检查网络后重试。",
        detail: cause instanceof Error ? cause.message : String(cause),
        suggestion: "retry",
      },
      undefined,
    );
  }
  if (!resp.ok) {
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      try {
        body = await resp.text();
      } catch {
        body = null;
      }
    }
    throw parseErrorBody(resp.status, body);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  research_direction: string | null;
  root_path: string;
  status: string;
  created_at: string;
  updated_at: string;
  paper_count: number;
  downloaded_count: number;
}

export interface CandidatePaper {
  paper_id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  venue_verified: boolean;
  abstract: string | null;
  doi: string | null;
  arxiv_id: string | null;
  pdf_url: string | null;
  source_url: string | null;
  source: string;
  cited_by_count: number | null;
  is_downloaded: boolean;
  /** Set only on recommendation responses; null for plain search. */
  similarity?: number | null;
}

export interface Paper {
  id: string;
  project_id: string;
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  venue_verified: boolean;
  doi: string | null;
  arxiv_id: string | null;
  pdf_url: string | null;
  source_url: string | null;
  local_pdf_path: string | null;
  downloaded: boolean;
  parse_status: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface Annotation {
  id: string;
  paper_id: string;
  page_number: number | null;
  selected_text: string | null;
  rects_json: string | null;
  comment: string | null;
  color: string | null;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface ReadingNote {
  id: string;
  paper_id: string;
  kind: string;
  page: number | null;
  original_text: string | null;
  content: string;
  model: string | null;
  created_at: string;
}

export interface Translation {
  id: string;
  paper_id: string;
  page: number | null;
  original_text: string | null;
  translated_text: string;
  model: string | null;
  created_at: string;
}

// --- Phase 2 ---
export interface Idea {
  id: string;
  project_id: string;
  title: string | null;
  hypothesis: string | null;
  motivation: string | null;
  status: string;
  content: string | null;
  evidence_json: string | null;
  risks_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Input shape for POST /projects/{id}/ideas/bulk. Matches backend
 * `BulkIdeaIn`. NOTE: `content` is a dict (object) here, NOT a pre-serialized
 * string - the backend json.dumps() it into the TEXT column. Sending a string
 * here is rejected with INPUT_INVALID (the bug that previously blocked the
 * Multi-Idea -> experiment handoff).
 */
export interface BulkIdeaIn {
  title?: string | null;
  hypothesis?: string | null;
  motivation?: string | null;
  content?: Record<string, unknown> | null;
  evidence_json?: unknown[] | null;
  risks_json?: string[] | null;
  status?: string;
}

/** Phase B: Multi-Idea research direction candidate from LLM
 *  (`research.generate_hypothesis_candidates`). The user picks 0-N of these
 *  in the comparison view, then the chosen ones are POSTed to /ideas/bulk. */
export interface MultiIdeaCandidate {
  name: string;
  hypothesis: string;
  motivation: string;
  /** 25-60 字中文一句话介绍。 */
  one_liner: string;
  /** 1-3 ★ 。 */
  feasibility: number;
  /** 1-3 ★ 。 */
  novelty: number;
  /** "low" | "medium" | "high"。 */
  est_cost: string;
  /** 1-10 天。 */
  est_days: number;
  recommended: boolean;
  targets: string[];
  baseline_methods: string[];
  key_differences: string[];
  evidence_paper_ids: string[];
}

export interface Repository {
  id: string;
  project_id: string;
  paper_id: string | null;
  repo_url: string;
  full_name: string | null;
  local_path: string | null;
  commit_sha: string | null;
  official_status: string;
  license: string | null;
  stars: number | null;
  evidence: string | null;
  created_at: string;
}

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

// --- Active workflows (global sidebar status) ---
export interface ActiveWorkflowTask {
  id: string;
  project_id: string;
  task_type: string;
  status: string;
  experiment_id: string | null;
  last_message: string | null;
  /** True for tasks that just reached a terminal state (recent window) - shown
   * dimmed in the sidebar so fast sync tasks (generate idea, etc.) leave a
   * visible trace even if they finished between polls. */
  recent: boolean;
  created_at: string;
  updated_at: string;
}

export interface ActiveWorkflowRun {
  run_id: string;
  experiment_id: string;
  project_id: string;
  experiment_title: string | null;
  command: string | null;
  created_at: string;
}

export interface ActiveWorkflows {
  tasks: ActiveWorkflowTask[];
  runs: ActiveWorkflowRun[];
  jobs: Job[];
}

// A generic long-running operation (literature search, paper download, parse,
// translation, reading note, LaTeX compile, benchmark search). Surfaced in the
// global sidebar so navigating away from the triggering page doesn't lose it.
export interface Job {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  title: string | null;
  target_id: string | null;
  target_type: string | null; // paper | experiment | run | literature | writing
  message: string | null;
  error: string | null;
  result_summary: string | null;
  recent: boolean;
  created_at: string;
  updated_at: string;
}

// --- Phase 3 ---
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
  // 9-stage interactive workflow (see app/experiments/states.py). Older
  // experiments pre-dating the refactor will have `mode='interactive'` +
  // empty `current_stage` / `overall_status='archived'`.
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

// --- LLM provider settings (mirrors backend schemas.py LLM*) ---

export interface LLMProviderPreset {
  id: string;
  name_zh: string;
  provider: string;
  model: string;
  base_url: string | null;
  api_key_env: string | null;
  needs_key: boolean;
  key_hint: string;
}

export interface LLMCurrentConfig {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_env: string | null;
  api_key_set: boolean;
  matched_preset_id: string | null;
}

export interface LLMConfig {
  presets: LLMProviderPreset[];
  current: LLMCurrentConfig;
}

export interface LLMConfigUpdate {
  provider_id: string;
  /** Override the preset's default model. */
  model?: string;
  /** Override the preset's base_url. Empty string clears it. */
  base_url?: string;
  /** The API key to persist. Omit/blank to keep any existing key. */
  api_key?: string;
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

export interface Benchmark {
  id: string;
  project_id: string;
  experiment_id: string | null;
  name: string;
  kind: string; // "dataset" | "task" | "sota"
  source: string; // "paperswithcode" | "hf" | "manual"
  url: string | null;
  task_name: string | null;
  dataset_name: string | null;
  metric_name: string | null;
  metric_value: number | null;
  paper_id: string | null;
  description: string | null;
  tags: string[];
  downloads: number | null;
  is_mainstream: boolean;
  author: string | null;
  created_at: string;
}

/** Ephemeral HF search hit — not yet added to the project library. */
export interface BenchmarkHit {
  name: string;
  kind: string;
  source: string;
  url: string | null;
  task_name: string | null;
  dataset_name: string | null;
  metric_name: string | null;
  metric_value: number | null;
  description: string | null;
  tags: string[];
  downloads: number | null;
  is_mainstream: boolean;
  author: string | null;
}

// --- Projects ---
export const api = {
  listProjects: () => request<Project[]>("/projects"),
  createProject: (body: { name: string; research_direction?: string; slug?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),

  // --- Literature ---
  searchLiterature: (
    projectId: string,
    body: {
      query: string;
      years?: [number, number];
      venues?: string[];
      sources?: string[];
      limit?: number;
      top_venues_only?: boolean;
    }
  ) =>
    request<{ query: string; count: number; papers: CandidatePaper[] }>(
      `/projects/${projectId}/literature/search`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  recommendLiterature: (projectId: string) =>
    request<{ query: string; count: number; papers: CandidatePaper[] }>(
      `/projects/${projectId}/literature/recommend`,
      { method: "POST" }
    ),
  listPapers: (projectId: string) =>
    request<Paper[]>(`/projects/${projectId}/papers`),
  getPaper: (paperId: string) => request<Paper>(`/papers/${paperId}`),
  downloadPaper: (
    projectId: string,
    body: { confirmed: boolean } & Partial<CandidatePaper>
  ) =>
    request<Paper>(`/projects/${projectId}/papers/download`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  parsePaper: (paperId: string) =>
    request<{ paper_id: string; pages: number; parse_status: string; sections: any[] }>(
      `/papers/${paperId}/parse`,
      { method: "POST" }
    ),
  paperPdfUrl: (paperId: string) => `${BASE}/papers/${paperId}/pdf`,

  // --- Notes ---
  translate: (paperId: string, body: { text: string; page?: number; target_lang?: string }) =>
    request<Translation>(`/papers/${paperId}/translate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  generateReadingNote: (paperId: string) =>
    request<ReadingNote>(`/papers/${paperId}/reading-note`, { method: "POST" }),
  getReadingNote: (paperId: string) =>
    request<ReadingNote | null>(`/papers/${paperId}/reading-note`),
  updateReadingNote: (paperId: string, content: string) =>
    request<ReadingNote>(`/papers/${paperId}/reading-note`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),
  listTranslations: (paperId: string) =>
    request<Translation[]>(`/papers/${paperId}/translations`),
  deleteTranslation: (translationId: string) =>
    request<void>(`/translations/${translationId}`, { method: "DELETE" }),

  // --- Annotations ---
  listAnnotations: (paperId: string) =>
    request<Annotation[]>(`/papers/${paperId}/annotations`),
  createAnnotation: (paperId: string, body: Partial<Annotation>) =>
    request<Annotation>(`/papers/${paperId}/annotations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAnnotation: (id: string, body: { comment?: string; color?: string }) =>
    request<Annotation>(`/annotations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAnnotation: (id: string) =>
    request<void>(`/annotations/${id}`, { method: "DELETE" }),

  // --- System ---
  health: () =>
    request<{ status: string; version: string; workspace: string; db_ok?: boolean; db_error?: string | null }>("/health"),
  getSettings: () =>
    request<{ workspace_path: string; models: any; venues: string[] }>("/settings"),

  // --- LLM provider settings (Settings page model-gateway editor) ---
  getLLMConfig: () => request<LLMConfig>("/llm/config"),
  saveLLMConfig: (body: LLMConfigUpdate) =>
    request<LLMCurrentConfig>("/llm/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // --- Phase 2: ideas ---
  listIdeas: (projectId: string) =>
    request<Idea[]>(`/projects/${projectId}/ideas`),
  createIdea: (projectId: string, body: Partial<Idea>) =>
    request<Idea>(`/projects/${projectId}/ideas`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * Phase B: Multi-Ideas 候选对比屏。先把 LLM 选出来让用户挑,挑完再入库。
   * 后端契约:POST /projects/{projectId}/ideas/bulk, body { ideas: [...] }。
   */
  bulkInsertIdeas: (
    projectId: string,
    body: { ideas: BulkIdeaIn[] },
  ) =>
    request<{ inserted: Idea[]; skipped: number[] }>(
      `/projects/${projectId}/ideas/bulk`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /**
   * Phase B: 让 LLM 一次性产出 3-5 个差异化候选方向供用户挑选。
   * 后端契约:POST /projects/{projectId}/agent/tasks task_type=
   *   "research.generate_hypothesis_candidates"
   * 入参:{ user_request: string }。
   * 返回:AgentTask 同步返回,result_json 解析为
   *   { candidates: Array<MultiIdeaCandidate> }。
   */
  generateIdeaCandidates: (
    projectId: string,
    userRequest: string,
  ) =>
    request<AgentTask>(
      `/projects/${projectId}/agent/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          task_type: "research.generate_hypothesis_candidates",
          input: { user_request: userRequest },
        }),
      },
    ),
  /** Phase B: 从一个候选方向快速建实验(自动填 RQ + hypothesis, status=draft)。
   * 后端契约:POST /projects/{projectId}/experiments
   * 入参:{ title: string; research_question: string; hypothesis: string; ... }。
   * (此方法也在 Phase 3 段重复定义,留这一份即可,见下方。) */

  updateIdea: (id: string, body: Partial<Idea>) =>
    request<Idea>(`/ideas/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteIdea: (id: string) => request<void>(`/ideas/${id}`, { method: "DELETE" }),

  // --- Phase 2: repositories ---
  listRepositories: (projectId: string) =>
    request<Repository[]>(`/projects/${projectId}/repositories`),
  deleteRepository: (id: string) =>
    request<void>(`/repositories/${id}`, { method: "DELETE" }),

  // --- Phase 2: agent tasks ---
  listAgentSkills: () => request<{ skills: string[] }>("/agent/skills"),
  runAgentTask: (projectId: string, task_type: string, input: any) =>
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
  // Active workflows across all projects (global sidebar status).
  listActiveWorkflows: () =>
    request<ActiveWorkflows>("/workflows/active"),

  // --- Phase 3: experiments + runs ---
  listExperiments: (projectId: string) =>
    request<Experiment[]>(`/projects/${projectId}/experiments`),
  createExperiment: (projectId: string, body: any) =>
    request<Experiment>(`/projects/${projectId}/experiments`, {
      method: "POST", body: JSON.stringify(body),
    }),
  getExperiment: (expId: string) => request<Experiment>(`/experiments/${expId}`),
  listRuns: (expId: string) => request<Run[]>(`/experiments/${expId}/runs`),
  createRun: (expId: string, body: { command: string; seed?: number; confirmed: boolean }) =>
    request<Run>(`/experiments/${expId}/runs`, { method: "POST", body: JSON.stringify(body) }),
  getRun: (runId: string) => request<Run>(`/runs/${runId}`),
  getRunLogs: (runId: string) => request<{ logs: string }>(`/runs/${runId}/logs`),
  getRunMetrics: (runId: string) => request<Metric[]>(`/runs/${runId}/metrics`),
  stopRun: (runId: string) => request<{ stopped: boolean }>(`/runs/${runId}/stop`, { method: "POST" }),
  runStreamUrl: (runId: string) => `${BASE}/runs/${runId}/stream`,

  // --- Phase A: benchmarks (dataset/task/SOTA discovery) ---
  searchBenchmarks: (
    projectId: string,
    body: { query: string; limit?: number }
  ) =>
    request<{ hits: BenchmarkHit[]; benchmarks?: BenchmarkHit[]; warnings: string[]; query_used?: string[] }>(
      `/projects/${projectId}/benchmarks/search`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),
  listBenchmarks: (projectId: string) =>
    request<Benchmark[]>(`/projects/${projectId}/benchmarks`),
  addBenchmark: (
    projectId: string,
    body: {
      name: string;
      kind?: string;
      source?: string;
      url?: string | null;
      task_name?: string | null;
      dataset_name?: string | null;
      metric_name?: string | null;
      metric_value?: number | null;
      experiment_id?: string | null;
      description?: string | null;
      tags?: string[];
      downloads?: number | null;
      is_mainstream?: boolean;
      author?: string | null;
    }
  ) =>
    request<Benchmark>(`/projects/${projectId}/benchmarks/add`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createManualBenchmark: (
    projectId: string,
    body: {
      name: string;
      kind?: "dataset" | "task" | "sota";
      url?: string | null;
      task_name?: string | null;
      dataset_name?: string | null;
      metric_name?: string | null;
      metric_value?: number | null;
      experiment_id?: string | null;
      description?: string | null;
      tags?: string[];
      is_mainstream?: boolean;
    }
  ) =>
    request<Benchmark>(`/projects/${projectId}/benchmarks/manual`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateBenchmark: (
    benchmarkId: string,
    body: { experiment_id?: string | null }
  ) =>
    request<Benchmark>(`/benchmarks/${benchmarkId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteBenchmark: (benchmarkId: string) =>
    request<{ ok: boolean }>(`/benchmarks/${benchmarkId}`, { method: "DELETE" }),
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
  /** PATCH /experiments/{id} — used to fill in research_question before
   * launching the workflow, or to edit the title. */
  updateExperiment: (expId: string, body: ExperimentUpdate) =>
    request<Experiment>(`/experiments/${expId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  decideStage: (
    expId: string,
    body: {
      decision: "approve" | "edit" | "skip" | "abort";
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
    request<Array<{
      id: string;
      experiment_id: string;
      parent_experiment_id: string | null;
      parent_branch_id: string | null;
      fork_stage_id: string | null;
      fork_stage_key: string | null;
      branch_name: string;
      created_at: string;
    }>>(`/experiments/${expId}/branches`),
  listExperimentFiles: (expId: string) =>
    request<{ files: string[] }>(`/experiments/${expId}/files`),
  getExperimentFile: (expId: string, path: string) =>
    request<{ path: string; content: string }>(
      `/experiments/${expId}/file?path=${encodeURIComponent(path)}`
    ),

  // --- Phase C/D: 研究计划确认 / 结果下一步 ---
  /** Phase C: 研究计划确认页消费的非技术化预览。
   * 后端契约:GET /experiments/{exp_id}/preview-plan。 */
  previewPlan: (expId: string) =>
    request<{
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
    } | null>(`/experiments/${expId}/preview-plan`),
  /** Phase D: 实验结果后续研究方向。
   * 后端契约:GET /experiments/{exp_id}/next-steps。
   * 若尚未到 analysis 阶段,返回 has_analysis=false 与空 next_steps。 */
  nextSteps: (expId: string) =>
    request<{
      conclusion: string | null;
      judgement: string | null;
      metrics: Record<string, number | string>;
      risks: string[];
      next_steps: Array<{ id: string; title: string; description?: string | null; est_cost?: string | null; template?: string | null }>;
      has_analysis: boolean;
    } | null>(`/experiments/${expId}/next-steps`),

  // --- Phase 4: writing ---
  initWriting: (projectId: string, template: string = "generic", force: boolean = false) =>
    request<{ root: string; files: string[] }>(`/projects/${projectId}/writing/init`, {
      method: "POST",
      body: JSON.stringify({ template, force }),
    }),
  listWritingTemplates: (projectId: string) =>
    request<{ templates: { key: string; label: string; note: string }[] }>(
      `/projects/${projectId}/writing/templates`
    ),
  listWritingFiles: (projectId: string) =>
    request<{ files: string[] }>(`/projects/${projectId}/writing/files`),
  getWritingFile: (projectId: string, path: string) =>
    request<{ path: string; content: string }>(`/projects/${projectId}/writing/file?path=${encodeURIComponent(path)}`),
  putWritingFile: (projectId: string, path: string, content: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/writing/file?path=${encodeURIComponent(path)}`, {
      method: "PUT", body: JSON.stringify({ content }),
    }),
  compileWriting: (projectId: string) =>
    request<{ job_id: string }>(`/projects/${projectId}/writing/compile`, { method: "POST" }),
  writingPdfUrl: (projectId: string) => `${BASE}/projects/${projectId}/writing/pdf`,
  getCitations: (projectId: string) =>
    request<{ available_keys: string[]; used_keys: string[]; missing: string[]; ok: boolean; used_in: Record<string, string[]> }>(`/projects/${projectId}/writing/citations`),
};
