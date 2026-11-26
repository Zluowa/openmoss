import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerCommandMenuItems } from "../../hooks/useComposerCommandMenuItems";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

async function mountMenu(input: {
  isLoading: boolean;
  triggerKind: "mention" | "skill" | "slash-command" | null;
  emptyStateText?: string;
  items?: ComposerCommandItem[];
  onSelect?: (item: ComposerCommandItem) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onSelect = input.onSelect ?? vi.fn();
  const screen = await render(
    <ComposerCommandMenu
      items={input.items ?? []}
      resolvedTheme="dark"
      isLoading={input.isLoading}
      triggerKind={input.triggerKind}
      {...(input.emptyStateText === undefined ? {} : { emptyStateText: input.emptyStateText })}
      activeItemId={null}
      onHighlightedItemChange={vi.fn()}
      onSelect={onSelect}
    />,
    { container: host },
  );

  return {
    onSelect,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerCommandMenu empty states", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["mention", "mention", "Searching mentions..."],
    ["slash command", "slash-command", "Loading commands..."],
  ] as const)(
    "shows the %s loading label before results are available",
    async (_label, triggerKind, text) => {
      const menu = await mountMenu({ isLoading: true, triggerKind });

      try {
        await expect.element(page.getByText(text, { exact: true })).toBeVisible();
        if (triggerKind === "mention") {
          await expect.element(page.getByText("Files", { exact: true })).toBeVisible();
        } else {
          expect(document.querySelector('[data-slot="command-list"]')).toBeNull();
        }
      } finally {
        await menu.cleanup();
      }
    },
  );

  it("uses the supplied empty copy after loading completes", async () => {
    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "slash-command",
      emptyStateText: "No commands are available for this provider.",
    });

    try {
      await expect
        .element(page.getByText("No commands are available for this provider.", { exact: true }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Loading commands...");
    } finally {
      await menu.cleanup();
    }
  });
});

describe("ComposerCommandMenu provider command notices", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("explains an unavailable provider command from a warning tooltip", async () => {
    const notice = "/design needs Claude Artifacts, which are off in Moss sessions by default.";
    const summary = "Artifacts are off. Turn them on in Settings.";
    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "slash-command",
      items: [
        {
          id: "provider-command:claudeAgent:design",
          type: "provider-native-command",
          provider: "claudeAgent",
          command: "design",
          label: "/design",
          description: "Make a new Design artifact from a brief",
          notice: { summary, detail: notice },
        },
        {
          id: "provider-command:claudeAgent:compact",
          type: "provider-native-command",
          provider: "claudeAgent",
          command: "compact",
          label: "/compact",
          description: "Compact context",
        },
      ],
    });

    try {
      // Readable from the row alone, since keyboard use never focuses the icon.
      await expect.element(page.getByText(summary, { exact: true })).toBeVisible();
      const badge = page.getByRole("img", { name: notice });
      await expect.element(badge).toBeVisible();
      expect(document.querySelectorAll('[role="img"][aria-label]').length).toBe(1);
      await badge.hover();
      await expect.element(page.getByText(notice, { exact: true })).toBeVisible();
    } finally {
      await menu.cleanup();
    }
  });
});

describe("ComposerCommandMenu connected Moss Apps", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders connected Moss Apps in @ mention menu with localized zh-CN description and selects mention", async () => {
    const items = useComposerCommandMenuItems({
      composerTrigger: { kind: "mention", query: "", rangeStart: 0, rangeEnd: 1 },
      provider: "codex",
      providerPlugins: [],
      providerNativeCommands: [],
      providerSkills: [],
      workspaceEntries: [],
      searchableModelOptions: [],
      supportsFastSlashCommand: false,
      canOfferCompactCommand: false,
      canOfferReviewCommand: false,
      canOfferForkCommand: false,
      canOfferSideCommand: false,
      canOfferExportCommand: false,
      dynamicAgents: [],
      connectedMossApps: [
        { slug: "gmail", name: "Gmail" },
        { slug: "notion", name: "Notion" },
      ],
      locale: "zh-CN",
    });

    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "mention",
      items,
    });

    try {
      await expect.element(page.getByText("Gmail", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Notion", { exact: true })).toBeVisible();
      const zhDescriptions = page.getByText("Moss 应用", { exact: true }).elements();
      expect(zhDescriptions).toHaveLength(2);
      expect(document.body.textContent).not.toContain("Moss App");

      await page.getByText("Gmail", { exact: true }).click();
      expect(menu.onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "moss-app:gmail",
          type: "connector",
          label: "Gmail",
          description: "Moss 应用",
          mention: { name: "Gmail", path: "connector://moss_apps" },
        }),
      );
    } finally {
      await menu.cleanup();
    }
  });

  it("renders connected Moss Apps with English description in en locale", async () => {
    const items = useComposerCommandMenuItems({
      composerTrigger: { kind: "mention", query: "gmail", rangeStart: 0, rangeEnd: 6 },
      provider: "codex",
      providerPlugins: [],
      providerNativeCommands: [],
      providerSkills: [],
      workspaceEntries: [],
      searchableModelOptions: [],
      supportsFastSlashCommand: false,
      canOfferCompactCommand: false,
      canOfferReviewCommand: false,
      canOfferForkCommand: false,
      canOfferSideCommand: false,
      canOfferExportCommand: false,
      dynamicAgents: [],
      connectedMossApps: [{ slug: "gmail", name: "Gmail" }],
      locale: "en",
    });

    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "mention",
      items,
    });

    try {
      await expect.element(page.getByText("Gmail", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Moss App", { exact: true })).toBeVisible();
    } finally {
      await menu.cleanup();
    }
  });
});
