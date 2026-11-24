// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
// Moss: the shared IconButton (solid when ready, secondary while a message waits to queue),
// with the Moss tooltip naming the action.
import { IconButton } from "~/components/ui/icon-button";
import { ArrowUp, Clock } from "./icons";

export function ComposerSendButton({
  waits,
  label,
  disabled,
  onSend,
}: {
  waits: boolean;
  label: string;
  disabled: boolean;
  onSend: (alternate: boolean) => void;
}) {
  return (
    <IconButton
      variant={waits ? "secondary" : "default"}
      size="icon"
      shape="capsule"
      label={label}
      tooltip={label}
      disabled={disabled}
      onClick={(event) => onSend(event.metaKey || event.ctrlKey)}
    >
      {waits ? <Clock size={15} /> : <ArrowUp size={16} strokeWidth={1.75} absoluteStrokeWidth />}
    </IconButton>
  );
}
