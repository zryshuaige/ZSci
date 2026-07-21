import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-sm ease-out focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-sm ease-out focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
