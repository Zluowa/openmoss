// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { Check } from "./icons";
import type { RoomBot as Bot } from "./host";
import { BotAvatar } from "./host";
import { cn } from "~/lib/utils";
import { CHECKBOX_BOX_CLASS_NAME } from "~/components/ui/checkbox";

export function BotPickerList({
  bots,
  picked,
  onToggle,
  emptyHint,
  disabled = false,
}: {
  bots: Bot[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  emptyHint: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
      {bots.length === 0 && (
        <div className="px-2 py-4 text-center text-ui-sm text-muted-foreground">{emptyHint}</div>
      )}
      {bots.map((b) => (
        <button
          key={b.id}
          disabled={disabled}
          onClick={() => onToggle(b.id)}
          role="checkbox"
          aria-label={b.name}
          aria-checked={picked.has(b.id)}
          className="flex min-h-control items-center gap-2 rounded-row px-2 text-left outline-none hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] focus-visible:ring-1 focus-visible:ring-ring/60"
        >
          <BotAvatar bot={b} state="happy" size={20} animated={false} />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground">{b.name}</span>
          <span
            className={cn(
              CHECKBOX_BOX_CLASS_NAME,
              "size-4",
              picked.has(b.id) && "border-primary bg-primary text-primary-foreground",
            )}
          >
            {picked.has(b.id) && <Check size={12} />}
          </span>
        </button>
      ))}
    </div>
  );
}
