// @ts-nocheck
// FILE: oiuDashboardControls.tsx
// Purpose: The interactive pieces of the dashboard kit, drawn with Moss's own primitives:
//   the FilterSelect and FilterMultiSelect pickers, and the Expand dialog of a collapsed
//   MediumCard or LargeCard.
// Layer: Chat UI support (a lazy chunk that oiuDashboard.tsx loads on first use)
// Origin: Behaviour follows FilterSelect and ShellCard in the OpenUI dashboard kit
//   (https://github.com/thesysdev/openui, MIT) at 9f01894. See THIRD_PARTY_NOTICES.md.

import { useState, type ReactNode } from "react";
import {
  ComposerPickerMenuPopup,
  ComposerPickerSelectPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuCheckboxItem, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
} from "~/components/ui/select";
import { ChevronDownIcon, ExpandArrowsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

type FilterOption = { value: string; label: string };

/** One choice; the trigger reads "<label> <value>" to assistive tech, as in the kit. */
export function FilterSelectControl({
  labelId,
  options,
  value,
  placeholder,
  disabled,
  onValueChange,
}: {
  labelId: string;
  options: FilterOption[];
  value: string;
  placeholder?: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const triggerId = `${labelId}-trigger`;
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={selected ? selected.value : null}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next);
      }}
    >
      <SelectTrigger
        id={triggerId}
        size="sm"
        aria-labelledby={`${labelId} ${triggerId}`}
        className="w-full min-w-0"
      >
        <SelectValue>
          {selected?.label ?? placeholder ?? t("chat.visualReply.dashboard.choose")}
        </SelectValue>
      </SelectTrigger>
      <ComposerPickerSelectPopup align="start">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </ComposerPickerSelectPopup>
    </Select>
  );
}

/** Several choices; the menu stays open while ticking, and nothing picked reads "All". */
export function FilterMultiSelectControl({
  labelId,
  options,
  values,
  placeholder,
  disabled,
  onValuesChange,
}: {
  labelId: string;
  options: FilterOption[];
  values: string[];
  placeholder?: string;
  disabled: boolean;
  onValuesChange: (values: string[]) => void;
}) {
  const { t, format } = useTranslation();
  const triggerId = `${labelId}-trigger`;
  const picked = options.filter((option) => values.includes(option.value));
  const summary =
    picked.length === 0
      ? (placeholder ?? t("chat.visualReply.dashboard.all"))
      : picked.length === 1
        ? picked[0].label
        : format("chat.visualReply.dashboard.moreSelected", {
            label: picked[0].label,
            count: picked.length - 1,
          });
  const toggle = (value: string, checked: boolean) => {
    const next = new Set(values);
    if (checked) next.add(value);
    else next.delete(value);
    // Keep the options' order so the bound list reads the same however it was picked.
    onValuesChange(options.map((option) => option.value).filter((option) => next.has(option)));
  };
  return (
    <Menu>
      <MenuTrigger
        id={triggerId}
        disabled={disabled}
        aria-labelledby={`${labelId} ${triggerId}`}
        className={cn(selectTriggerVariants({ size: "sm" }), "w-full min-w-0")}
      >
        <span className={cn("flex-1 truncate", picked.length === 0 && "text-muted-foreground")}>
          {summary}
        </span>
        <ChevronDownIcon className="size-3 opacity-50" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start">
        {options.map((option) => (
          <MenuCheckboxItem
            key={option.value}
            variant="checkbox"
            checked={values.includes(option.value)}
            onCheckedChange={(checked) => toggle(option.value, Boolean(checked))}
          >
            {option.label}
          </MenuCheckboxItem>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** A collapsed card's whole body in a dialog titled by the card's header. */
export function CardExpandControl({
  title,
  subtitle,
  body,
}: {
  title: string;
  subtitle: string;
  body: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex justify-center">
        <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
          <ExpandArrowsIcon />
          {t("chat.visualReply.dashboard.expand")}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader className={cn(!title && "sr-only")}>
            <DialogTitle>{title || t("chat.visualReply.dashboard.cardDetails")}</DialogTitle>
            {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
          </DialogHeader>
          <DialogPanel className={cn("flex flex-col gap-3", !title && "pt-10")}>{body}</DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
