// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { useState } from "react";
import type { RoomBot } from "./host";
import { RoomDialog } from "./host";
import { useMossbotCopy } from "../mossbot.copy";
import { BotPickerList } from "./BotPickerList";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/** Sidebar → New channel: name it, optionally file it under a context, pick its bots. */
export function NewRoomPanel({
  bots,
  onCreate,
  onClose,
  initialMemberIds = [],
}: {
  bots: RoomBot[];
  onCreate: (value: { name: string; section: string; memberIds: string[] }) => Promise<void>;
  onClose: () => void;
  initialMemberIds?: readonly string[];
}) {
  const { t, errorText } = useMossbotCopy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initialMemberIds.filter((id) => bots.some((bot) => bot.id === id))),
  );
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = async () => {
    if (!picked.size || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        memberIds: [...picked],
        name:
          name.trim() ||
          [...picked]
            .map((id) => bots.find((b) => b.id === id)?.name)
            .join(", ")
            .slice(0, 100),
        section: section.trim(),
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <RoomDialog
      title={t("New group chat")}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => void create()} disabled={!picked.size || busy || picked.size > 12}>
            {picked.size === 0 ? t("Choose assistants") : t("Create group")}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void create();
        }}
        aria-label={t("Group name")}
        placeholder={t("Name this conversation")}
        className="mb-2"
      />
      <Input
        value={section}
        maxLength={60}
        onChange={(e) => setSection(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void create();
        }}
        placeholder={t("Context (optional)")}
        aria-label={t("Group context")}
        className="mb-3"
      />
      <BotPickerList
        disabled={busy}
        bots={bots}
        picked={picked}
        onToggle={toggle}
        emptyHint={t("Create an assistant first.")}
      />
      {error && (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      )}
    </RoomDialog>
  );
}
