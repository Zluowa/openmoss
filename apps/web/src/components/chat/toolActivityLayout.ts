import { cn } from "~/lib/utils";

// app-initial pna/KV: offset is on the outer row, indentation is opt-in.
export function toolActivityBodyClassName(
  variant: "default" | "grouped" | "flush" = "default",
  indent = false,
): string {
  return cn(
    "flex flex-col",
    variant === "default" && "gap-2 pt-2 pb-1",
    variant === "grouped" && "gap-[var(--conversation-grouped-item-gap,4px)] pt-1",
    indent && "ps-6",
  );
}
