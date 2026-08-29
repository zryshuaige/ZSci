// Ideas domain: research idea backlog + multi-idea candidate generation.
import { request } from "./client";
import type { AgentTask } from "./agent";

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
 * string - the backend json.dumps() it into the TEXT column.
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

/** Multi-Idea research direction candidate from LLM
 *  (`research.generate_hypothesis_candidates`). */
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

export const ideasApi = {
  listIdeas: (projectId: string) =>
    request<Idea[]>(`/projects/${projectId}/ideas`),
  createIdea: (projectId: string, body: Partial<Idea>) =>
    request<Idea>(`/projects/${projectId}/ideas`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** 先把 LLM 选出来让用户挑,挑完再入库。
   *  后端契约:POST /projects/{projectId}/ideas/bulk, body { ideas: [...] }。 */
  bulkInsertIdeas: (
    projectId: string,
    body: { ideas: BulkIdeaIn[] },
  ) =>
    request<{ inserted: Idea[]; skipped: number[] }>(
      `/projects/${projectId}/ideas/bulk`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** 让 LLM 一次性产出 3-5 个差异化候选方向供用户挑选。 */
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
  updateIdea: (id: string, body: Partial<Idea>) =>
    request<Idea>(`/ideas/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteIdea: (id: string) => request<void>(`/ideas/${id}`, { method: "DELETE" }),
};
