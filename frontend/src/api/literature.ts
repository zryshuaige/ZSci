// Literature domain: paper search / recommend / download / local import.
import { request } from "./client";

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

export const literatureApi = {
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
  downloadPaper: (
    projectId: string,
    body: { confirmed: boolean } & Partial<CandidatePaper>
  ) =>
    request<import("./papers").Paper>(`/projects/${projectId}/papers/download`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Import PDF files already on disk into the project's library. */
  /** Bulk-import local PDF paths. The backend endpoint imports ONE paper per
   *  call (ImportLocalPdfRequest); the UI offers a bulk textarea, so this
   *  wrapper fans out and aggregates. The modal's 导入 button IS the user's
   *  explicit approval, hence confirmed=true (design.md §16.1). The first
   *  failing path aborts with that path's friendly error. */
  importLocalPapers: async (projectId: string, paths: string[]) => {
    const papers: import("./papers").Paper[] = [];
    for (const p of paths) {
      const sourcePath = p.trim();
      if (!sourcePath) continue;
      const title =
        sourcePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "本地论文";
      const paper = await request<import("./papers").Paper>(
        `/projects/${projectId}/papers/import-local`,
        {
          method: "POST",
          body: JSON.stringify({
            paper_id: `paper_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
            title,
            source_path: sourcePath,
            confirmed: true,
          }),
        }
      );
      papers.push(paper);
    }
    return { imported: papers.length, papers };
  },
};
