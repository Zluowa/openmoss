// FILE: ShareSelect.tsx
// Purpose: The compact option picker the share dialog and the 站点 list use for access,
//          roles and visibility: the current label in a small trigger, a hint under each item.
// Layer: Space sharing (owned by sharing)

import { ComposerPickerSelectPopup } from "../../chat/ComposerPickerMenuPopup";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";

export function ShareSelect<T extends string>(props: {
  readonly value: T;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly hint?: string;
  }>;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly variant?: "default" | "ghost";
  readonly className?: string;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null && value !== props.value) props.onChange(value as T);
      }}
    >
      <SelectTrigger
        size="xs"
        variant={props.variant ?? "ghost"}
        aria-label={props.label}
        className={props.className ?? "w-auto min-w-0 shrink-0"}
      >
        <SelectValue>{current?.label ?? props.value}</SelectValue>
      </SelectTrigger>
      <ComposerPickerSelectPopup align="end">
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex flex-col">
              <span>{option.label}</span>
              {option.hint ? (
                <span className="text-ui-xs text-muted-foreground">{option.hint}</span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </ComposerPickerSelectPopup>
    </Select>
  );
}
