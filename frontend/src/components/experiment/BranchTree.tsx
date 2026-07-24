import { GitBranch, ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

interface BranchTreeProps {
  experimentId: string;
  /** Called when the user clicks a branch row (e.g. to navigate). */
  onSelectBranch?: (experimentId: string) => void;
}

interface BranchRow {
  id: string;
  experiment_id: string;
  parent_experiment_id: string | null;
  parent_branch_id: string | null;
  fork_stage_id: string | null;
  fork_stage_key: string | null;
  branch_name: string;
  created_at: string;
}

/** Renders the fork ancestry + children of an experiment as a simple tree.
 *
 *  The branch graph is stored in `experiment_branches` (one row per fork):
 *  - the current experiment's own row (if it's a fork) points to its parent;
 *  - any rows whose `parent_experiment_id` is this experiment are its forks.
 *
 *  We render parent above + children below, indented by depth. Clicking a
 *  row fires `onSelectBranch(experiment_id)` so the page can navigate. */
export function BranchTree({ experimentId, onSelectBranch }: BranchTreeProps) {
  const { data: branches, isLoading } = useQuery({
    queryKey: ["branches", experimentId],
    queryFn: () => api.listBranches(experimentId),
    refetchInterval: false,
  });

  if (isLoading) {
    return <div className="text-xs text-muted-foreground px-3 py-2">加载分支…</div>;
  }
  if (!branches || branches.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-2 flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5" />
        暂无分支(可在 CheckpointCard 的"更多"中从此阶段分叉)
      </div>
    );
  }

  const parents = branches.filter((b) => b.experiment_id === experimentId);
  const children = branches.filter((b) => b.parent_experiment_id === experimentId);

  const Row = ({ b, isSelf }: { b: BranchRow; isSelf?: boolean }) => (
    <button
      type="button"
      onClick={() => onSelectBranch?.(b.experiment_id)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left",
        "hover:bg-muted/60 transition-colors",
        isSelf && "bg-primary/5 border border-primary/20"
      )}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate flex-1">{b.branch_name}</span>
      {b.fork_stage_key && (
        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
          @ {b.fork_stage_key}
        </span>
      )}
    </button>
  );

  return (
    <div className="space-y-1 text-sm">
      {parents.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2">
            上游(父实验)
          </div>
          {parents.map((b) => (
            <div key={b.id} className="flex items-center gap-1">
              <ArrowLeft className="h-3 w-3 text-muted-foreground shrink-0" />
              <button
                type="button"
                onClick={() => b.parent_experiment_id && onSelectBranch?.(b.parent_experiment_id)}
                className="flex-1 text-left rounded-md px-2 py-1.5 hover:bg-muted/60 truncate"
              >
                {b.branch_name}
              </button>
            </div>
          ))}
        </div>
      )}
      {children.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2">
            下游(从此处分叉)
          </div>
          {children.map((b) => (
            <Row key={b.id} b={b} />
          ))}
        </div>
      )}
    </div>
  );
}
