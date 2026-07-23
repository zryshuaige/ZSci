import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/** Lightweight approval dialog (design.md §16.1) used for PDF downloads.
   Materialize, don't just fade: scrim blurs in while the panel pops
   (scale 0.96 -> 1 + opacity), so the surface reads as arriving rather
   than appearing. Modal is exempt from origin-anchoring (stays centered). */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-float animate-pop">
        <h3 className="text-lg font-semibold">{title}</h3>
        {description && <div className="mt-2 text-sm text-muted-foreground">{description}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary",
        className
      )}
    />
  );
}
