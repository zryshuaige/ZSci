// Papers domain: library papers + annotations + reading notes + translations.
import { BASE, request } from "./client";

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

export const papersApi = {
  listPapers: (projectId: string) =>
    request<Paper[]>(`/projects/${projectId}/papers`),
  getPaper: (paperId: string) => request<Paper>(`/papers/${paperId}`),
  parsePaper: (paperId: string) =>
    request<{ paper_id: string; pages: number; parse_status: string; sections: unknown[] }>(
      `/papers/${paperId}/parse`,
      { method: "POST" }
    ),
  paperPdfUrl: (paperId: string) => `${BASE}/papers/${paperId}/pdf`,

  // --- Translation ---
  translate: (paperId: string, body: { text: string; page?: number; target_lang?: string }) =>
    request<Translation>(`/papers/${paperId}/translate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listTranslations: (paperId: string) =>
    request<Translation[]>(`/papers/${paperId}/translations`),
  deleteTranslation: (translationId: string) =>
    request<void>(`/translations/${translationId}`, { method: "DELETE" }),

  // --- Reading notes ---
  generateReadingNote: (paperId: string) =>
    request<ReadingNote>(`/papers/${paperId}/reading-note`, { method: "POST" }),
  getReadingNote: (paperId: string) =>
    request<ReadingNote | null>(`/papers/${paperId}/reading-note`),
  updateReadingNote: (paperId: string, content: string) =>
    request<ReadingNote>(`/papers/${paperId}/reading-note`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),

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
};
