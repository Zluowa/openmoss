import { useState } from "react";

import { ChevronDownIcon } from "~/lib/icons";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";

export function PresentationZoom({
  zoom,
  fit,
  onChange,
}: {
  zoom: number | "fit";
  fit: number;
  onChange: (zoom: number | "fit") => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const percent = Math.round((zoom === "fit" ? fit : zoom) * 100);
  const applyCustom = () => {
    const parsed = Number(custom.replace(/%$/, "").trim());
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 6400) return;
    onChange(parsed / 100);
    setOpen(false);
  };
  return (
    <Menu
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setCustom(String(percent));
      }}
    >
      <MenuTrigger
        aria-label="Zoom"
        className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-ui-sm tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        {percent}%<ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" className="min-w-36" size="small">
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            aria-label="Zoom percentage"
            inputMode="numeric"
            className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-ui-lg outline-none focus:border-ring"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                applyCustom();
              }
            }}
          />
          <span className="text-ui-sm text-muted-foreground">%</span>
        </div>
        <MenuSeparator />
        <MenuRadioGroup
          value={String(zoom)}
          onValueChange={(value) => {
            onChange(value === "fit" ? "fit" : Number(value));
            setOpen(false);
          }}
        >
          <MenuRadioItem value="fit">Fit</MenuRadioItem>
          {[0.25, 0.5, 1, 1.5, 2].map((value) => (
            <MenuRadioItem key={value} value={String(value)}>
              {value * 100}%
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
