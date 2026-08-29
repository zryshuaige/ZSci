import { type ReactNode } from "react";
import { Loader2 } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Destructive action styling (delete / abort): red confirm button. */
  danger?: boolean;
}

/** Yes/no confirmation dialog. Composes `Modal` (./Modal) for the chrome —
 *  portal, Esc + backdrop cancel (unless busy), autofocus — and only adds
 *  the cancel/confirm button pair. No `onSubmit` is passed, so the content
 *  is NOT wrapped in a <form> (there are no inputs to submit). Cancel stays
 *  first in DOM order with autoFocus so the safe action is the focused one.
 *  For dialogs containing form inputs, use `Modal` directly. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
  busy,
  danger,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      busy={busy}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={busy} autoFocus>
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            variant={danger ? "destructive" : "default"}
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner className="h-3.5 w-3.5" /> 处理中…
              </span>
            ) : (
              confirmLabel
            )}
          </Button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn("h-5 w-5 animate-spin text-primary", className)}
    />
  );
}
