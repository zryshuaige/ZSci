import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: string;
  /** Render at smaller height for dense toolbars. */
  size?: "sm" | "md";
}

/** The one styled select for the whole app — replaces raw inline <select>
 *  elements. A styled native control (not a custom listbox): full keyboard
 *  and screen-reader behaviour for free. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, size = "md", children, disabled, ...props }, ref) => {
    const select = (
      <div className={cn("relative inline-flex items-center", !label && "w-full")}>
        <select
          ref={ref}
          disabled={disabled}
          className={cn(
            "w-full appearance-none rounded-md border border-input bg-card pr-8 text-sm text-foreground",
            "focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            size === "sm" ? "h-8 pl-2.5" : "h-9 pl-3",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 text-muted-foreground" />
      </div>
    );
    if (!label) return select;
    return (
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="shrink-0">{label}</span>
        {select}
      </label>
    );
  }
);
Select.displayName = "Select";

/** Convenience: build <option> list from [{value, label}] pairs. */
export function SelectOptions({
  items,
  placeholder,
}: {
  items: { value: string; label: ReactNode }[];
  placeholder?: string;
}) {
  return (
    <>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {items.map((it) => (
        <option key={it.value} value={it.value}>
          {it.label}
        </option>
      ))}
    </>
  );
}
