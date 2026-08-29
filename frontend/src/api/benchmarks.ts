// Benchmarks domain: dataset / task / SOTA discovery + project library.
import { request } from "./client";

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

export const benchmarksApi = {
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
};
