// Repositories domain: code repos linked to the project (from papers/GitHub).
import { request } from "./client";

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

export const repositoriesApi = {
  listRepositories: (projectId: string) =>
    request<Repository[]>(`/projects/${projectId}/repositories`),
  updateRepository: (id: string, body: { official_status?: string }) =>
    request<Repository>(`/repositories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteRepository: (id: string) =>
    request<void>(`/repositories/${id}`, { method: "DELETE" }),
};
