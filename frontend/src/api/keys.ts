// Hierarchical queryKey factory — the single source for every react-query
// key in the app. Rules:
//   1. Never write an inline `queryKey: ["..."]` array in a page/component;
//      add a builder here instead.
//   2. Keys nest so prefix invalidation works: invalidating qk.experiments.all
//      hits every experiments query.
//   3. Historical duplicates were collapsed here (e.g. ["health"] and
//      ["system","health"] are both gone; qk.health is the only key).

export const qk = {
  projects: {
    all: ["projects"] as const,
    one: (id: string) => ["projects", id] as const,
  },
  papers: {
    all: ["papers"] as const,
    byProject: (projectId: string) => ["papers", "project", projectId] as const,
    one: (id: string) => ["papers", id] as const,
    annotations: (paperId: string) => ["papers", paperId, "annotations"] as const,
    translations: (paperId: string) => ["papers", paperId, "translations"] as const,
    readingNote: (paperId: string) => ["papers", paperId, "reading-note"] as const,
  },
  ideas: {
    all: ["ideas"] as const,
    byProject: (projectId: string) => ["ideas", projectId] as const,
    exploreCandidates: (projectId: string, ideaText: string) =>
      ["ideas", "explore", "candidates", projectId, ideaText] as const,
  },
  repos: {
    all: ["repos"] as const,
    byProject: (projectId: string) => ["repos", projectId] as const,
  },
  agent: {
    all: ["agent"] as const,
    task: (taskId: string) => ["agent", "task", taskId] as const,
    events: (taskId: string) => ["agent", "task", taskId, "events"] as const,
    approvals: (taskId: string) => ["agent", "task", taskId, "approvals"] as const,
  },
  workflows: {
    all: ["workflows"] as const,
    active: ["workflows", "active"] as const,
  },
  experiments: {
    all: ["experiments"] as const,
    byProject: (projectId: string) => ["experiments", "project", projectId] as const,
    one: (expId: string) => ["experiments", expId] as const,
    stages: (expId: string) => ["experiments", expId, "stages"] as const,
    runs: (expId: string) => ["experiments", expId, "runs"] as const,
    branches: (expId: string) => ["experiments", expId, "branches"] as const,
    previewPlan: (expId: string) => ["experiments", expId, "preview-plan"] as const,
    nextSteps: (expId: string) => ["experiments", expId, "next-steps"] as const,
  },
  runs: {
    all: ["runs"] as const,
    one: (runId: string) => ["runs", runId] as const,
    metrics: (runId: string) => ["runs", runId, "metrics"] as const,
    logs: (runId: string) => ["runs", runId, "logs"] as const,
  },
  benchmarks: {
    all: ["benchmarks"] as const,
    byProject: (projectId: string) => ["benchmarks", projectId] as const,
  },
  writing: {
    all: ["writing"] as const,
    templates: (projectId: string) => ["writing", projectId, "templates"] as const,
    files: (projectId: string) => ["writing", projectId, "files"] as const,
    file: (projectId: string, path: string) => ["writing", projectId, "file", path] as const,
    citations: (projectId: string) => ["writing", projectId, "citations"] as const,
  },
  settings: ["settings"] as const,
  llmConfig: ["llm-config"] as const,
  health: ["system", "health"] as const,
};
