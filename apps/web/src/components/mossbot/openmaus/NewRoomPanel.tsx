// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { useState } from "react";
import type { RoomBot } from "./host";
import { RoomDialog } from "./host";
import { useMossbotCopy } from "../mossbot.copy";
import { BotPickerList } from "./BotPickerList";

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
    <RoomDialog title={t("New group chat")} onClose={onClose} busy={busy}>
      <input
        autoFocus
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void create();
        }}
        aria-label={t("Group name")}
        placeholder={t("Name this conversation")}
        className="mb-3 w-full rounded-lg bg-muted/70 px-3 py-2 text-ui text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <input
        value={section}
        maxLength={60}
        onChange={(e) => setSection(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void create();
        }}
        placeholder={t("Context (optional)")}
        aria-label={t("Group context")}
        className="mb-3 w-full rounded-lg bg-muted/70 px-3 py-2 text-ui text-foreground placeholder:text-muted-foreground focus:outline-none"
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
      <button
        onClick={() => void create()}
        disabled={!picked.size || busy || picked.size > 12}
        className="mt-3 w-full rounded-lg bg-primary py-2 text-ui font-medium text-white hover:brightness-110 disabled:opacity-40"
      >
        {picked.size === 0
          ? t("Choose assistants")
          : picked.size === 1
            ? t("Create group")
            : t("Create group")}
      </button>
    </RoomDialog>
  );
}
