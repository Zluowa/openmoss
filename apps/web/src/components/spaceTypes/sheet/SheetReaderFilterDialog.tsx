// FILE: SheetReaderFilterDialog.tsx
// Purpose: 筛选这一列 for someone who can only view a 电子表格: the column's values with a search,
//          ticked to keep, untick to hide those rows — a view of the sheet, never saved.
// Layer: 资料空间 电子表格 (dialog)
// Exports: SheetReaderFilterDialog.

import { useMemo, useState } from "react";

import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";

const SHOWN_AT_MOST = 500;

export function SheetReaderFilterDialog(props: {
  /** "B 列（金额）". */
  readonly columnLabel: string;
  readonly values: readonly string[];
  /** The values kept now; all when the column is not filtered. */
  readonly keep: readonly string[];
  readonly onApply: (keep: string[]) => void;
  readonly onClear: () => void;
  readonly onCancel: () => void;
}) {
  const [keep, setKeep] = useState(() => new Set(props.keep));
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    return props.values
      .filter((v) => !words || v.toLowerCase().includes(words))
      .slice(0, SHOWN_AT_MOST);
  }, [props.values, search]);
  const toggle = (value: string, on: boolean) =>
    setKeep((now) => {
      const next = new Set(now);
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogPopup className="max-w-sm" showCloseButton>
        <div className="flex flex-col gap-3 p-5" data-sheet-reader-filter>
          <div className="flex flex-col gap-1">
            <DialogTitle>筛选 {props.columnLabel}</DialogTitle>
            <DialogDescription>只改变你看到的行，不会保存到表格里。</DialogDescription>
          </div>
          <Input
            size="sm"
            aria-label="搜索值"
            placeholder="搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setKeep(new Set([...keep, ...shown]))}
            >
              全选
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setKeep(new Set([...keep].filter((v) => !shown.includes(v))))}
            >
              全不选
            </Button>
          </div>
          <div
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
            role="group"
            aria-label="值"
          >
            {shown.map((value) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 text-ui">
                <Checkbox
                  checked={keep.has(value)}
                  onCheckedChange={(checked) => toggle(value, checked === true)}
                />
                <span className="truncate">{value === "" ? "（空白）" : value}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" className="me-auto" onClick={props.onClear}>
              清除筛选
            </Button>
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              取消
            </Button>
            <Button
              type="button"
              data-testid="sheet-reader-filter-apply"
              onClick={() => props.onApply([...keep])}
            >
              确定
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
