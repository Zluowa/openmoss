// FILE: sheetControls.tsx
// Purpose: Small form parts the 电子表格 panes and dialogs share: a labelled choice (Moss Select).
// Layer: 资料空间 电子表格 (UI parts)
// Exports: Choice.

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";

export function Choice(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly className?: string;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(next) => {
        if (next !== null) props.onChange(next as string);
      }}
    >
      <SelectTrigger size="xs" aria-label={props.label} className={cn("min-w-0", props.className)}>
        <SelectValue>{props.options.find((o) => o.value === props.value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup surface="composer">
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
