// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { Select } from "./Select";
import type { RoomBot } from "./host";
import { useMossbotCopy } from "../mossbot.copy";
export function DefaultResponderSelect({
  members,
  value,
  onChange,
  disabled,
}: {
  members: RoomBot[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useMossbotCopy();
  return (
    <Select
      disabled={disabled}
      variant="ghost"
      className="shrink-0 max-w-[190px]"
      aria-label={t("Default responder")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <optgroup label={t("Lead assistant")}>
        {members.map((member) => (
          <option key={member.id} value={`member:${member.id}`}>
            {member.name}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("Reply behavior")}>
        <option value="everyone">{t("Everyone")}</option>
        <option value="mentions">{t("Only when mentioned")}</option>
      </optgroup>
    </Select>
  );
}
