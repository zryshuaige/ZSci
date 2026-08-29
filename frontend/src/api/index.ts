// Domain index: assembles the flat `api` object (backward-compatible with
// the old lib/api.ts) and re-exports every domain type.

import { agentApi } from "./agent";
import { benchmarksApi } from "./benchmarks";
import { experimentsApi } from "./experiments";
import { ideasApi } from "./ideas";
import { literatureApi } from "./literature";
import { papersApi } from "./papers";
import { projectsApi } from "./projects";
import { repositoriesApi } from "./repositories";
import { systemApi } from "./system";
import { workflowsApi } from "./workflows";
import { writingApi } from "./writing";

export * from "./client";
export * from "./keys";
export * from "./agent";
export * from "./benchmarks";
export * from "./experiments";
export * from "./ideas";
export * from "./literature";
export * from "./papers";
export * from "./projects";
export * from "./repositories";
export * from "./system";
export * from "./workflows";
export * from "./writing";

/** Flat facade — every method the old `api` object exposed, unchanged. */
export const api = {
  ...projectsApi,
  ...literatureApi,
  ...papersApi,
  ...systemApi,
  ...ideasApi,
  ...repositoriesApi,
  ...agentApi,
  ...workflowsApi,
  ...experimentsApi,
  ...benchmarksApi,
  ...writingApi,
};
