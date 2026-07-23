// Typed API client for the Z-Sci backend.

const BASE = "/api/v1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // M1: destructure headers out of init so the spread below doesn't overwrite
  // our merged headers. Previously `...init` came after `headers: {...}` and
  // clobbered the Content-Type header when callers passed their own headers.
  const { headers: initHeaders, ...restInit } = init || {};
  const resp = await fetch(`${BASE}${path}`, {
    ...restInit,
    headers: { "Content-Type": "application/json", ...(initHeaders as Record<string, string> | undefined) },
  });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      const body = await resp.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      detail = await resp.text().catch(() => detail);
    }
    throw new Error(detail);
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
  source: string; // "paperswithcode" | "hf"
  url: string | null;
  task_name: string | null;
  dataset_name: string | null;
  metric_name: string | null;
  metric_value: number | null;
  paper_id: string | null;
  created_at: string;
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
  health: () => request<{ status: string; version: string; workspace: string }>("/health"),
  getSettings: () =>
    request<{ workspace_path: string; models: any; venues: string[] }>("/settings"),

  // --- Phase 2: ideas ---
  listIdeas: (projectId: string) =>
    request<Idea[]>(`/projects/${projectId}/ideas`),
  createIdea: (projectId: string, body: Partial<Idea>) =>
    request<Idea>(`/projects/${projectId}/ideas`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
    body: { query: string; experiment_id?: string; limit?: number }
  ) =>
    request<{ benchmarks: Benchmark[]; warnings: string[] }>(
      `/projects/${projectId}/benchmarks`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),
  listBenchmarks: (projectId: string) =>
    request<Benchmark[]>(`/projects/${projectId}/benchmarks`),
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
    }
  ) =>
    request<Benchmark>(`/projects/${projectId}/benchmarks/manual`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteBenchmark: (benchmarkId: string) =>
    request<{ ok: boolean }>(`/benchmarks/${benchmarkId}`, { method: "DELETE" }),
  startAutonomous: (
    expId: string,
    body: { selected_papers?: string[]; selected_repositories?: string[]; run_configs?: string[] }
  ) =>
    request<{ task_id: string; experiment_id: string }>(`/experiments/${expId}/autonomous`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listExperimentFiles: (expId: string) =>
    request<{ files: string[] }>(`/experiments/${expId}/files`),
  getExperimentFile: (expId: string, path: string) =>
    request<{ path: string; content: string }>(
      `/experiments/${expId}/file?path=${encodeURIComponent(path)}`
    ),

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
