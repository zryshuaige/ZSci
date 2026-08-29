import { cn } from "@/lib/cn";

/** Loading placeholder with a moving sheen (apple-design polish).
   Use for known-shape content instead of a bare spinner, so the layout
   doesn't jump when content arrives. GPU-only (transform). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-muted", className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  );
}

/** A stack of list-row placeholders, for page-load before the list arrives.
   `rows` controls how many; the shape mirrors a typical card row (title +
   one-line subtitle + meta). Keeps layout stable so content doesn't jump. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{ animationDelay: `${i * 60}ms` }}
          className="rounded-lg border border-border bg-card p-4 animate-slide-up"
        >
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4 mt-2.5" />
          <Skeleton className="h-3 w-1/4 mt-2.5" />
        </div>
      ))}
    </div>
  );
}

/** A few lines of text-shaped placeholders, for body/paragraph loading. */
