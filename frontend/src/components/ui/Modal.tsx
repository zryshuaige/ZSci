import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { Spinner } from "./Dialog";

/** Proper modal dialog — the container for every form/picker in the app.
 *  ConfirmDialog stays for yes/no confirmations; anything with inputs
 *  belongs in a Modal.
 *
 *  - Portal-rendered, Esc + backdrop close (unless `dismissable={false}`
 *    or `busy`)
 *  - Pass `onSubmit` to wrap children in a <form> so Enter submits
 *  - Autofocuses the first focusable element inside
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  size = "md",
  dismissable = true,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Rendered right-aligned in the footer. When `onSubmit` is set and no
   *  custom footer is given, a default 取消/确认 pair is rendered. */
  footer?: ReactNode;
  onSubmit?: () => void;
  size?: "sm" | "md" | "lg";
  dismissable?: boolean;
  busy?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    // Autofocus the first input inside the panel.
    const t = window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("input, textarea, select, [autofocus]")
        ?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open, dismissable, busy, onClose]);

  if (!open) return null;

  const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" };

  const body = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      className={cn(
        "w-full rounded-xl border border-border/60 bg-card p-6 shadow-float animate-pop",
        sizes[size]
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-6">{title}</h3>
          {description && (
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          )}
        </div>
        {dismissable && (
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="mt-4">{children}</div>
      {(footer ?? onSubmit) && (
        <div className="mt-5 flex justify-end gap-2">
          {footer ?? (
            <>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner className="h-3.5 w-3.5" /> 处理中…
                  </span>
                ) : (
                  "确认"
                )}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );

  const wrapped = onSubmit ? (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      {body}
    </form>
  ) : (
    body
  );

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable && !busy) onClose();
      }}
    >
      {wrapped}
    </div>,
    document.body
  );
}
