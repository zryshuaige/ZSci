import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams, useLocation, useSearchParams } from "react-router-dom";
import { api, qk } from "@/api";
import { Spinner } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { AlertTriangle } from "@/components/ui/icons";

/**
 * Resolves bare /experiments/:expId links (and their suffixed forms
 * /preview, /result, /runs) to the canonical project-scoped route,
 * preserving the suffix and the query string (?task= deep links keep
 * working through the redirect).
 */
export default function ExperimentRedirect() {
  const { expId } = useParams<{ expId: string }>();
  const location = useLocation();
  const [search] = useSearchParams();
  const { data: exp, isError, refetch } = useQuery({
    queryKey: qk.experiments.one(expId!),
    queryFn: () => api.getExperiment(expId!),
    enabled: !!expId,
    staleTime: 60_000,
  });

  if (isError) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="找不到这个实验"
          subtitle="它可能已被删除，或者网络暂时不可用。"
          action={
            <button
              className="text-sm text-primary hover:underline"
              onClick={() => refetch()}
            >
              重试
            </button>
          }
        />
      </div>
    );
  }
  if (!exp) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  // Preserve any suffix after the expId: /experiments/:id/preview → /preview.
  const m = location.pathname.match(/^\/experiments\/[^/]+(\/.*)?$/);
  const suffix = m?.[1] ?? "";
  const qs = search.toString();
  return (
    <Navigate
      to={`/projects/${exp.project_id}/experiments/${exp.id}${suffix}${qs ? `?${qs}` : ""}`}
      replace
    />
  );
}
