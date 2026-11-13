// FILE: SheetLocaleDialog.tsx
// Purpose: 区域和时区 for one 电子表格: how numbers are written for everyone who opens it
//          (1,234.5 or 1.234,5) and the time zone TODAY and NOW use.
// Layer: 资料空间 电子表格 (dialog)
// Exports: SheetLocaleDialog.

import { SHEET_LOCALES, type SheetLocale } from "@moss/shared/spaceItems/sheetWorkbook";
import { useMemo, useState } from "react";

import { Button } from "../../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Choice } from "./sheetControls";

const DEVICE = "device";

function zoneList(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [
      "Asia/Shanghai",
      "Asia/Tokyo",
      "Europe/London",
      "Europe/Berlin",
      "America/New_York",
      "America/Los_Angeles",
      "UTC",
    ];
  }
}

export function SheetLocaleDialog(props: {
  readonly locale: SheetLocale;
  readonly timeZone: string | null;
  readonly readOnly: boolean;
  readonly onApply: (locale: SheetLocale, timeZone: string | null) => void;
  readonly onCancel: () => void;
}) {
  const [locale, setLocale] = useState<SheetLocale>(props.locale);
  const [zone, setZone] = useState(props.timeZone ?? DEVICE);
  const device = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const zones = useMemo(
    () => [
      { value: DEVICE, label: `你的时区（${device}）` },
      ...zoneList().map((name) => ({ value: name, label: name })),
    ],
    [device],
  );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogPopup className="max-w-md" showCloseButton>
        <form
          className="flex flex-col gap-4 p-5"
          data-sheet-locale-dialog
          onSubmit={(event) => {
            event.preventDefault();
            props.onApply(locale, zone === DEVICE ? null : zone);
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>区域和时区</DialogTitle>
            <DialogDescription>对打开这张表格的每个人都一样。</DialogDescription>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-ui-sm text-muted-foreground">区域</span>
            <Choice
              label="区域"
              value={locale}
              options={Object.entries(SHEET_LOCALES).map(([value, { label, sample }]) => ({
                value,
                label: `${label} · ${sample}`,
              }))}
              onChange={(value) => setLocale(value as SheetLocale)}
              className="w-full"
            />
            <span className="text-ui-sm text-muted-foreground">
              决定数字怎么写：小数点、千位分隔。日期按单元格自己的格式显示。
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-ui-sm text-muted-foreground">时区</span>
            <Choice
              label="时区"
              value={zone}
              options={zones}
              onChange={setZone}
              className="w-full"
            />
            <span className="text-ui-sm text-muted-foreground">
              当前日期和时间（NOW 和 TODAY）按这个时区算。
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={props.readOnly} data-testid="sheet-locale-apply">
              确定
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
