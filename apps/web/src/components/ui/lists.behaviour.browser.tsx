// FILE: lists.behaviour.browser.tsx
// Purpose: Behaviour contract of Moss's searchable list wrappers (command palette list, autocomplete
//          field): the search field keeps focus while the keyboard moves the highlight, Enter runs
//          or picks the highlighted row, the Enter that confirms an input-method candidate does
//          neither, and the highlight is reported to callers that draw their own state. Written
//          against the wrappers' exported API, so it passes on the primitive library underneath
//          them today and after it changes (round 20261118-ui-sdk, PR 2b).
// Layer: Web component tests (real Chromium, real rendered parts, trusted keyboard input).

import "../../index.css";

import { useState, type ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { composeChineseWithEnter } from "../../test/imeComposition";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./autocomplete";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./combobox";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandStatus,
} from "./command";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

const ACTIONS = [
  { id: "action:new-chat", label: "新建对话" },
  { id: "action:settings", label: "打开设置" },
  { id: "action:theme", label: "切换主题" },
  { id: "action:fengche", label: "fengche 风车" },
];

/** The highlighted row: the one the keyboard would run. */
function highlighted(): string | null {
  return (
    document.querySelector<HTMLElement>('[data-slot="command-item"][data-highlighted]')
      ?.textContent ?? null
  );
}

/** A palette like the sidebar's: the caller filters (no library filtering), rows run on Enter. */
function Palette({ onRun }: { onRun: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const rows = ACTIONS.filter((action) => action.label.includes(query));
  return (
    <div className="w-96 p-4">
      <Command autoHighlight="always" mode="none">
        <CommandInput
          aria-label="搜索命令"
          placeholder="搜索命令"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <CommandStatus>{rows.length === 0 ? "没有结果" : null}</CommandStatus>
        <CommandList>
          <CommandGroup>
            <CommandGroupLabel>操作</CommandGroupLabel>
            {rows.map((action) => (
              <CommandItem key={action.id} value={action.id} onClick={() => onRun(action.id)}>
                {action.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

describe("Command palette list", () => {
  it("keeps focus in the search field while arrows move the highlight, and Enter runs it", async () => {
    const onRun = vi.fn();
    await render(<Palette onRun={onRun} />);
    const search = page.getByRole("combobox", { name: "搜索命令" });
    await expect.element(search).toHaveFocus();
    await expect.poll(highlighted).toBe("新建对话");
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(highlighted).toBe("打开设置");
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledExactlyOnceWith("action:settings");
  });

  it("runs the first row the caller's filter leaves, on Enter", async () => {
    const onRun = vi.fn();
    await render(<Palette onRun={onRun} />);
    await userEvent.keyboard("主题");
    await expect.poll(highlighted).toBe("切换主题");
    await userEvent.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledExactlyOnceWith("action:theme");
  });

  it("runs a row on press", async () => {
    const onRun = vi.fn();
    await render(<Palette onRun={onRun} />);
    await page.getByRole("option", { name: "切换主题" }).click();
    expect(onRun).toHaveBeenCalledExactlyOnceWith("action:theme");
  });

  it.each(["Enter", "Process"] as const)(
    "runs nothing while Enter (%s) confirms a pinyin candidate",
    async (confirmKey) => {
      const onRun = vi.fn();
      await render(<Palette onRun={onRun} />);
      const search = page.getByRole("combobox", { name: "搜索命令" }).element() as HTMLElement;
      await composeChineseWithEnter(search, "feng", "风车", confirmKey, async () => {
        // The pinyin being composed matches a row the confirming Enter could run.
        await expect.element(page.getByRole("option", { name: "fengche 风车" })).toBeVisible();
      });
      await expect.poll(() => (search as HTMLInputElement).value).toBe("风车");
      // After the commit the row is highlighted, so a next Enter would run it; this one did not.
      await expect.poll(highlighted).toBe("fengche 风车");
      expect(onRun).not.toHaveBeenCalled();
    },
  );

  it("reports the highlighted row to a caller that draws its own state (no search field)", async () => {
    const onHighlight = vi.fn();
    await render(
      <div className="w-96 p-4">
        <Command autoHighlight={false} mode="none" onItemHighlighted={onHighlight}>
          <CommandList>
            {ACTIONS.map((action) => (
              <CommandItem key={action.id} value={action.id}>
                {action.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </div>,
    );
    await page.getByRole("option", { name: "切换主题" }).hover();
    await expect
      .poll(() =>
        onHighlight.mock.calls
          .map(([value]) => value)
          .filter(Boolean)
          .at(-1),
      )
      .toBe("action:theme");
  });
});

const FONTS = ["JetBrains Mono", "Menlo", "SF Mono", "Fira Code", "Cascadia Code"];

/** The terminal font field: suggestions the caller filters, the text is the value. */
function FontField({ onValueChange }: { onValueChange: (value: string) => void }) {
  const [value, setValue] = useState("");
  const suggestions = FONTS.filter((font) => font.toLowerCase().includes(value.toLowerCase()));
  return (
    <div className="w-80 p-4">
      <Autocomplete
        items={suggestions}
        mode="none"
        value={value}
        onValueChange={(next: string) => {
          setValue(next);
          onValueChange(next);
        }}
      >
        <AutocompleteInput aria-label="终端字体" placeholder="终端字体" size="sm" />
        <AutocompletePopup>
          <AutocompleteList>
            {suggestions.map((font) => (
              <AutocompleteItem key={font} value={font}>
                {font}
              </AutocompleteItem>
            ))}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
    </div>
  );
}

function suggestionsShown(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="autocomplete-item"]')]
    .filter((item) => !item.closest("[hidden]") && item.getBoundingClientRect().height > 0)
    .map((item) => item.textContent ?? "");
}

describe("Autocomplete field", () => {
  it("suggests as the person types and fills the field with the chosen suggestion", async () => {
    const onValueChange = vi.fn();
    await render(<FontField onValueChange={onValueChange} />);
    const field = page.getByRole("combobox", { name: "终端字体" });
    await field.click();
    await userEvent.keyboard("co");
    await expect.poll(suggestionsShown).toEqual(["Fira Code", "Cascadia Code"]);
    await page.getByRole("option", { name: "Cascadia Code" }).click();
    await expect.element(field).toHaveValue("Cascadia Code");
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe("Cascadia Code");
  });

  it("picks the highlighted suggestion from the keyboard and closes on Escape", async () => {
    await render(<FontField onValueChange={vi.fn()} />);
    const field = page.getByRole("combobox", { name: "终端字体" });
    await field.click();
    await userEvent.keyboard("m");
    await expect.poll(() => suggestionsShown().length).toBeGreaterThan(0);
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => (field.element() as HTMLInputElement).value).not.toBe("m");
    await field.click();
    await userEvent.keyboard("{Escape}");
    await expect.poll(suggestionsShown).toEqual([]);
    await expect.element(field).toHaveFocus();
  });

  it.each(["Enter", "Process"] as const)(
    "keeps the composed text while Enter (%s) confirms a pinyin candidate",
    async (confirmKey) => {
      const onValueChange = vi.fn();
      await render(<FontField onValueChange={onValueChange} />);
      const field = page.getByRole("combobox", { name: "终端字体" }).element() as HTMLInputElement;
      await composeChineseWithEnter(field, "song", "宋体", confirmKey);
      await expect.poll(() => field.value).toBe("宋体");
    },
  );
});

/** Whether the named dialog is in the page and painted. */
function dialogShown(name: string): boolean {
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.includes(name),
  );
  if (!dialog || dialog.closest("[hidden]")) return false;
  const box = dialog.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

const BRANCHES = ["main", "release/1.0.7", "feat/ui-sdk-controls", "fix/login"];

/** A branch picker like the chat's: the caller filters and keeps the search text. */
function BranchPicker({ onQueryChange }: { onQueryChange?: (query: string) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rows = BRANCHES.filter((branch) => branch.includes(query));
  return (
    <Combobox
      items={BRANCHES}
      filteredItems={rows}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <ComboboxTrigger data-testid="branch-trigger">分支</ComboboxTrigger>
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <ComboboxInput
          aria-label="搜索分支"
          placeholder="搜索分支"
          showTrigger={false}
          size="sm"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            onQueryChange?.(event.target.value);
          }}
        />
        <ComboboxList>
          {rows.map((branch, index) => (
            <ComboboxItem key={branch} value={branch} index={index}>
              {branch}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/** A Base UI dialog (dialogs move to UI SDK in part 3) holding one searchable popup. */
function InDialog({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogTitle>{title}</DialogTitle>
        <div className="p-4">{children}</div>
      </DialogPopup>
    </Dialog>
  );
}

describe("Searchable popups inside a dialog", () => {
  it("the first Escape closes only the autocomplete's suggestions; the second closes the dialog", async () => {
    await render(
      <InDialog title="设置">
        <FontField onValueChange={vi.fn()} />
      </InDialog>,
    );
    const field = page.getByRole("combobox", { name: "终端字体" });
    await field.click();
    await userEvent.keyboard("co");
    await expect.poll(suggestionsShown).toEqual(["Fira Code", "Cascadia Code"]);
    await userEvent.keyboard("{Escape}");
    await expect.poll(suggestionsShown).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dialogShown("设置")).toBe(true);
    await expect.element(field).toHaveValue("co");
    await expect.element(field).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialogShown("设置")).toBe(false);
  });

  it("the first Escape closes only the combobox, keeping the search text until it closes; the second closes the dialog", async () => {
    const queries: string[] = [];
    await render(
      <InDialog title="选择分支">
        <BranchPicker onQueryChange={(query) => queries.push(query)} />
      </InDialog>,
    );
    await page.getByTestId("branch-trigger").click();
    const search = page.getByRole("combobox", { name: "搜索分支" });
    await search.fill("rel");
    await expect.element(page.getByRole("option", { name: "release/1.0.7" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('input[placeholder="搜索分支"]')).toBeNull();
    // Escape closes the popup; it does not first clear the typed text (as Base UI).
    expect(queries.at(-1)).toBe("rel");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dialogShown("选择分支")).toBe(true);
    await expect.element(page.getByTestId("branch-trigger")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialogShown("选择分支")).toBe(false);
  });

  it("the command dialog closes on the first Escape when no inner popup is open", async () => {
    function PaletteDialog() {
      const [open, setOpen] = useState(true);
      return (
        <CommandDialog open={open} onOpenChange={setOpen}>
          <CommandDialogPopup aria-label="命令面板">
            <Palette onRun={vi.fn()} />
          </CommandDialogPopup>
        </CommandDialog>
      );
    }
    await render(<PaletteDialog />);
    const search = page.getByRole("combobox", { name: "搜索命令" });
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard("设");
    await expect.poll(highlighted).toBe("打开设置");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('input[placeholder="搜索命令"]')).toBeNull();
  });
});
