// Writing domain: LaTeX scaffold, file editing, compile, citations.
import { BASE, request } from "./client";

export interface WritingTemplate {
  key: string;
  label: string;
  note: string;
}

export interface Citations {
  available_keys: string[];
  used_keys: string[];
  missing: string[];
  ok: boolean;
  used_in: Record<string, string[]>;
}

export const writingApi = {
  initWriting: (projectId: string, template: string = "generic", force: boolean = false) =>
    request<{ root: string; files: string[] }>(`/projects/${projectId}/writing/init`, {
      method: "POST",
      body: JSON.stringify({ template, force }),
    }),
  listWritingTemplates: (projectId: string) =>
    request<{ templates: WritingTemplate[] }>(
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
    request<Citations>(`/projects/${projectId}/writing/citations`),
};
