// Global friendly-error toast renderer.
//
// Mounts once in the Layout (frontend/src/components/Layout.tsx). Reads the
// toast queue from useFriendlyErrorToasts and renders each entry at the
// bottom-right of the screen. Auto-dismiss after 6s. Clicking the action
// dispatches a custom DOM event ("friendly-error-action:{key}") that the
// page can listen for (e.g. navigating to /settings on "go_settings").
//
// Why a DOM event instead of a callback prop: the Layout already has the
// router mounted; if the toast rendered a Settings Link we'd couple the
// toast to the router directly. A CustomEvent lets each page choose how
// to handle "go_settings" / "retry" without re-wiring Layout.

import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";
import {
  dismissToast,
  type FriendlyErrorDisplay,
  useFriendlyErrorToasts,
} from "@/lib/useFriendlyError";
import { cn } from "@/lib/cn";

/** Dispatched by ErrorToast when the user clicks the action button. Listened
 *  to by individual pages that want custom behaviour (e.g. re-running a
 *  failed mutation). The event target is `window`. */
export const FRIENDLY_ERROR_ACTION_EVENT = "friendly-error-action";

function dispatchAction(key: string, id: number) {
  window.dispatchEvent(
    new CustomEvent(FRIENDLY_ERROR_ACTION_EVENT, { detail: { key, id } }),
  );
}

interface ToastProps {
  entry: FriendlyErrorDisplay & { id: number };
  onAction: (key: string) => void;
  onDismiss: (id: number) => void;
}

function Toast({ entry, onAction, onDismiss }: ToastProps) {
  // Auto-dismiss after 6s. Reset the timer when the entry changes.
  useEffect(() => {
    const t = setTimeout(() => onDismiss(entry.id), 6000);
    return () => clearTimeout(t);
  }, [entry.id, onDismiss]);

  const Icon = entry.severity === "info" ? Info : entry.severity === "error" ? AlertTriangle : Info;
  // For success-class we'd render CheckCircle2; we don't currently use it
  // but the import is left for future use (e.g. positive "已采纳" toasts).
  const _CheckIcon = CheckCircle2;

  const palette =
    entry.severity === "error"
      ? { bg: "bg-red-50", border: "border-red-300", icon: "text-red-600", text: "text-red-800" }
      : entry.severity === "warning"
      ? { bg: "bg-amber-50", border: "border-amber-300", icon: "text-amber-600", text: "text-amber-800" }
      : { bg: "bg-blue-50", border: "border-blue-300", icon: "text-blue-600", text: "text-blue-800" };

  return (
    <div
      role="status"
      data-friendly-error-toast
      className={cn(
        "w-80 rounded-lg border bg-card p-3 shadow-float animate-pop",
        palette.border,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", palette.icon)} />
        <div className="flex-1 min-w-0">
          <div className={cn("text-sm font-medium", palette.text)}>{entry.title}</div>
          <div className="mt-1 text-xs text-foreground/80 break-words">{entry.body}</div>
          {(entry.action && entry.actionKey) ? (
            <button
              type="button"
              className={cn(
                "mt-2 inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                palette.border,
                palette.text,
                "hover:bg-card",
              )}
              onClick={() => onAction(entry.actionKey!)}
            >
              {entry.action}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="关闭"
          className="ml-1 text-muted-foreground/60 hover:text-foreground"
          onClick={() => onDismiss(entry.id)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function ErrorToastHost() {
  const toasts = useFriendlyErrorToasts();
  const navigate = useNavigate();

  // Default action handlers. Pages can override by listening for the
  // FRIENDLY_ERROR_ACTION_EVENT and calling `event.stopPropagation()` / `e.preventDefault()`.
  useEffect(() => {
    function onEvent(e: Event) {
      const key = (e as CustomEvent<{ key: string; id: number }>).detail?.key;
      const id = (e as CustomEvent<{ key: string; id: number }>).detail?.id;
      if (!key) return;
      switch (key) {
        case "go_settings":
          navigate("/settings");
          break;
        case "retry":
          // Pages re-throw their own retry logic by listening too; the host
          // falls back to no-op here so the listener can take over.
          break;
        default:
          break;
      }
      if (typeof id === "number") dismissToast(id);
    }
    window.addEventListener(FRIENDLY_ERROR_ACTION_EVENT, onEvent);
    return () => window.removeEventListener(FRIENDLY_ERROR_ACTION_EVENT, onEvent);
  }, [navigate]);

  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-toast flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast
          key={t.id}
          entry={t}
          onAction={(key) => dispatchAction(key, t.id)}
          onDismiss={(id) => dismissToast(id)}
        />
      ))}
    </div>
  );
}
