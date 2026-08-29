// Workflows domain: the global "what is the agent doing right now" feed
// backing the sidebar indicator. Single endpoint, single shared observer
// (see lib/hooks/useActiveWorkflows).
import { request } from "./client";

export interface ActiveWorkflowTask {
  id: string;
  project_id: string;
  task_type: string;
  status: string;
  experiment_id: string | null;
  last_message: string | null;
  /** True for tasks that just reached a terminal state (recent window) —
   *  shown dimmed so fast tasks leave a visible trace between polls. */
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

/** A generic long-running operation (literature search, paper download,
 *  parse, translation, reading note, LaTeX compile, benchmark search). */
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

export interface ActiveWorkflows {
  tasks: ActiveWorkflowTask[];
  runs: ActiveWorkflowRun[];
  jobs: Job[];
}

export const workflowsApi = {
  listActiveWorkflows: () =>
    request<ActiveWorkflows>("/workflows/active"),
};
