// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { useRef, useState } from "react";
import type { RoomBot } from "./host";
import { RoomDialog } from "./host";
import { BotPickerList } from "./BotPickerList";
import { nextMemberIds } from "./room-members";
import { DefaultResponderSelect } from "./DefaultResponderSelect";
import { useMossbotCopy } from "../mossbot.copy";
export function ManageMembersPanel({
  group,
  bots,
  onClose,
  onSave,
}: {
  group: { name: string; memberIds: string[]; responder: string };
  bots: RoomBot[];
  onClose: () => void;
  onSave: (memberIds: string[], responder: string, expected: string[]) => Promise<void>;
}) {
  const { t, errorText } = useMossbotCopy();
  const [picked, setPicked] = useState(() => new Set(group.memberIds));
  const [responder, setResponder] = useState(group.responder);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openedMemberIds = useRef([...group.memberIds]);
  const toggle = (id: string) => {
    if (picked.has(id) && responder === `member:${id}`) {
      const next = [...picked].filter((one) => one !== id);
      setResponder(next.length ? `member:${next[0]}` : "mentions");
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    bots.map((b) => b.id),
  );
  const changed =
    memberIds.length !== group.memberIds.length ||
    memberIds.some((id, i) => id !== group.memberIds[i]);

  const save = async () => {
    if (!memberIds.length || busy) return;
    const opened = openedMemberIds.current;
    if (
      opened.length !== group.memberIds.length ||
      opened.some((id, index) => id !== group.memberIds[index])
    ) {
      setSaveError(t("Group members changed. Reopen the member list."));
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      if (changed || responder !== group.responder) await onSave(memberIds, responder, opened);
      onClose();
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <RoomDialog title={group.name} onClose={onClose} busy={busy}>
      <label className="mb-4 flex items-center justify-between gap-2 text-ui-sm">
        {t("Default responder")}
        <DefaultResponderSelect
          members={bots.filter((b) => picked.has(b.id))}
          value={responder}
          onChange={setResponder}
          disabled={busy}
        />
      </label>
      <BotPickerList
        disabled={busy}
        bots={bots}
        picked={picked}
        onToggle={toggle}
        emptyHint={t("Create an assistant first.")}
      />
      {!memberIds.length && (
        <div className="mt-2 text-ui-xs text-muted-foreground">
          {t("Choose at least one assistant.")}
        </div>
      )}
      {saveError && (
        <div role="alert" className="mt-2 text-ui-xs text-destructive">
          {saveError}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          disabled={busy}
          onClick={onClose}
          className="flex-1 rounded-lg bg-muted py-2 text-ui font-medium text-foreground hover:brightness-110"
        >
          {t("Cancel")}
        </button>
        <button
          onClick={() => void save()}
          disabled={!memberIds.length || memberIds.length > 12 || busy}
          className="flex-1 rounded-lg bg-primary py-2 text-ui font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {!memberIds.length
            ? t("Save changes")
            : memberIds.length === 1
              ? t("Save changes")
              : t("Save changes")}
        </button>
      </div>
    </RoomDialog>
  );
}
