// Backward-compat shim — the implementation moved to useActiveWorkflows.ts
// (which shares the single /workflows/active observer). Existing imports of
// useAgentTaskStatus keep working.
export { useAgentTaskStatus } from "./useActiveWorkflows";
