import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Persistent banner that surfaces a degraded / unreachable backend.
 *
 * Wraps the entire app once. Polls `/health` every 15s; if the backend is
 * unreachable OR returns `status="degraded"`, the banner explains the issue
 * with a retry button. We deliberately keep this OUT of the page-level
 * error boundary: a single page can still render OK even if the backend is
 * briefly flaky, and the user doesn't need a full-screen error takeover for
 * a transient network blip.
 *
 * No banner = healthy. Compact (single line) so it doesn't disrupt the
 * layout when a backend is fully healthy.
 */
export default function BackendHealthBanner() {
  const { data, isError, refetch, isFetching } = useQuery({
    queryKey: ["system", "health"],
    queryFn: () => api.health(),
    // 15s polling is a balance: short enough to recover quickly when the
    // backend comes back, long enough not to spam the log.
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // Distinguish "unreachable" (network error) from "degraded" (DB offline).
  // Users recover from the two differently: unreachable = restart backend,
  // degraded = check the SQLite file / WAL.
  if (isError) {
    return (
      <div className="bg-destructive text-destructive-foreground text-xs px-4 py-1.5 flex items-center gap-2 z-toast relative">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          后端无响应。所有数据请求都会失败,请检查后端进程是否启动。
        </span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1 hover:underline shrink-0"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          重试
        </button>
      </div>
    );
  }
  if (data && data.status === "degraded") {
    return (
      <div className="bg-amber-100 text-amber-900 text-xs px-4 py-1.5 flex items-center gap-2 z-toast relative border-b border-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          后端处于降级状态:数据库读写异常 — {data.db_error || "请检查 SQLite 文件"}
        </span>
      </div>
    );
  }
  return null;
}
