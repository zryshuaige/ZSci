// Projects domain: CRUD for research projects.
import { request } from "./client";

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

export const projectsApi = {
  listProjects: () => request<Project[]>("/projects"),
  createProject: (body: { name: string; research_direction?: string; slug?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  updateProject: (id: string, body: { name?: string; research_direction?: string }) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),
};
