// Moss adapters for the vendored UI. Execution, identity and focus belong to Moss.
import type { ReactNode } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { MossbotAvatar } from "../MossbotAvatar";
export type RoomBot = {
  id: string;
  name: string;
  icon?: string | null | undefined;
  color?: string | null | undefined;
  hidden?: boolean | undefined;
  title?: string;
};
export function BotAvatar({
  bot,
  size = 28,
}: {
  bot: RoomBot;
  size?: number;
  state?: string;
  animated?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0" style={{ width: size, height: size }}>
      <MossbotAvatar icon={bot.icon} color={bot.color} className="size-full" />
    </span>
  );
}
export function RoomDialog({
  title,
  onClose,
  busy,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className={footer ? undefined : "pb-4"}>{children}</DialogPanel>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogPopup>
    </Dialog>
  );
}
