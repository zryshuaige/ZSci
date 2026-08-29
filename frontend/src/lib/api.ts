// Backward-compatible facade. The implementation now lives in `src/api/`
// (one module per backend router domain) — this file only re-exports so
// existing `import { api, ... } from "@/lib/api"` call sites keep working.
// New code should import from "@/api" directly.
export * from "../api";
