// FILE: automationsOneSet.browser.tsx
// Purpose: 定时任务 on the shared parts (WO-24): a boolean option is the shared Switch, the
//          fields carry no native tooltip (the page's proposal banner says why they are locked),
//          a row's delete is the shared icon button named by the Moss tooltip, and a run's status
//          dot is the shared status dot.
// Layer: Automations presentation browser regression

import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { AutomationListRow } from "~/routes/-automations.list";
import { RunStatusIndicator } from "~/routes/-automations.shared";
import { AutomationNameField } from "./AutomationHeadingFields";
import { InlineSelect, InlineToggle } from "./automationInlineFields";
import { RunArchiveButton } from "./RunArchiveButton";

afterEach(async () => {
  await cleanup();
});

it("draws a boolean option as the shared Switch, named by its row, and keeps it locked while disabled", async () => {
  const onChange = vi.fn();
  await render(
    <div className="p-4">
      <InlineToggle label="Fast mode" value={false} onChange={onChange} />
      <InlineToggle label="Web search" value={true} onChange={onChange} disabled />
    </div>,
  );
  const fast = page.getByRole("switch", { name: "Fast mode", exact: true });
  await expect.element(fast).toBeVisible();
  expect(fast.element().getAttribute("data-slot")).toBe("switch");
  expect(fast.element().hasAttribute("title")).toBe(false);
  await fast.click();
  expect(onChange).toHaveBeenCalledWith(true);
  const locked = page.getByRole("switch", { name: "Web search", exact: true });
  await expect.element(locked).toBeChecked();
  const lockedElement = locked.element();
  expect(
    lockedElement.hasAttribute("disabled") ||
      lockedElement.getAttribute("aria-disabled") === "true" ||
      lockedElement.hasAttribute("data-disabled"),
  ).toBe(true);
});

it("warns with the Moss tooltip that archiving keeps a worktree run's branches, and only then", async () => {
  const onArchive = vi.fn();
  await render(
    <div className="flex gap-4 p-4">
      <RunArchiveButton archived={false} keepsGeneratedWork onArchive={onArchive} />
      <RunArchiveButton archived keepsGeneratedWork={false} onArchive={onArchive} />
    </div>,
  );
  const archive = page.getByRole("button", { name: "Archive", exact: true });
  await expect.element(archive).toBeVisible();
  expect(archive.element().hasAttribute("title")).toBe(false);
  await userEvent.hover(archive);
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>("[data-slot='tooltip-popup']")].map(
        (popup) => popup.textContent,
      ),
    )
    .toContain("Archiving does not remove generated worktrees or branches.");
  await archive.click();
  expect(onArchive).toHaveBeenCalledWith(true);
  const unarchive = page.getByRole("button", { name: "Unarchive", exact: true });
  expect(unarchive.element().closest("[data-slot='tooltip-trigger']")).toBeNull();
});

it("leaves the locked fields without a native tooltip", async () => {
  await render(
    <div className="p-4">
      <AutomationNameField value="Daily report" onCommit={() => {}} disabled />
      <InlineSelect
        value="standalone"
        options={[
          { value: "standalone", label: "New chat each run" },
          { value: "heartbeat", label: "Heartbeat", disabled: true },
        ]}
        onChange={() => {}}
        disabled
      />
    </div>,
  );
  const name = page.getByRole("textbox", { name: "Automation name" });
  await expect.element(name).toBeVisible();
  expect(document.querySelectorAll("[title]")).toHaveLength(0);
});

it("names a row's delete with the Moss tooltip on the shared icon button", async () => {
  const onDelete = vi.fn();
  const onClick = vi.fn();
  await render(
    <div className="w-96 p-4">
      <AutomationListRow
        onClick={onClick}
        leading={<span />}
        title="Daily report"
        detail="Every day at 09:00"
        onDelete={onDelete}
      />
    </div>,
  );
  const remove = page.getByRole("button", { name: "Delete automation", exact: true });
  await expect.element(remove).toBeInTheDocument();
  const element = remove.element() as HTMLElement;
  expect(element.hasAttribute("title")).toBe(false);
  expect(element.getAttribute("data-slot")).not.toBeNull();
  await userEvent.hover(page.elementLocator(element));
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>("[data-slot='tooltip-popup']")].map(
        (popup) => popup.textContent,
      ),
    )
    .toContain("Delete");
  await remove.click();
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(onClick).not.toHaveBeenCalled();
});

it("draws a failed run's mark as the shared 6 px status dot", async () => {
  await render(<RunStatusIndicator status="failed" />);
  const dot = document.querySelector<HTMLElement>("span > span")!;
  expect(dot.getBoundingClientRect().width).toBe(6);
  expect(dot.getBoundingClientRect().height).toBe(6);
  expect(getComputedStyle(dot).borderTopLeftRadius).not.toBe("0px");
});
