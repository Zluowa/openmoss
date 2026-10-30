// FILE: PluginLibraryImportDialog.browser.tsx
// Purpose: Focused build6234 browser checks for import source/scan/conflict/
//          preview/progress/result/rollback behavior.
// Layer: Browser UI test

import "../index.css";
import "./PluginLibrary.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as renderBrowser } from "vitest-browser-react";
import { useRef, useState, type ReactNode } from "react";

import {
  PLUGIN_IMPORT_MAX_BYTES,
  type PluginImportFileAdapter,
  type PluginImportWriteReceipt,
} from "~/lib/pluginImportAdapter";
import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { PluginLibraryNativeFixture } from "~/test/pluginLibraryBrowserHarness";
import { PluginLibraryImportDialog } from "./PluginLibraryImportDialog";

function setFile(name: string, contents: string, type: string) {
  const input = document.querySelector<HTMLInputElement>(
    "[data-testid='plugin-import-source-file']",
  );
  if (!input) throw new Error("Missing plugin import file input.");
  const transfer = new DataTransfer();
  transfer.items.add(new File([contents], name, { type }));
  Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

let previousAppSettings: string | null = null;

const FIXTURE_WRITE_RECEIPT: PluginImportWriteReceipt = {
  transactionId: "fixture-transaction",
  operationId: "fixture-operation",
  planHash: "a".repeat(64),
  afterState: [
    {
      operationId: "fixture-operation",
      targetPath: "/workspace/.moss/fixture",
      state: "present",
      afterHash: "b".repeat(64),
      durable: true,
    },
  ],
};
type PluginImportWriteInput = Parameters<PluginImportFileAdapter["apply"]>[0];

function createDialogTestQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  return queryClient;
}

function DialogTestProviders({
  children,
  queryClient,
}: {
  readonly children: ReactNode;
  readonly queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>{children}</MossLocalizationProvider>
    </QueryClientProvider>
  );
}

async function render(children: ReactNode) {
  const queryClient = createDialogTestQueryClient();
  try {
    const mounted = await renderBrowser(
      <DialogTestProviders queryClient={queryClient}>{children}</DialogTestProviders>,
    );
    const unmount = mounted.unmount.bind(mounted);
    return Object.assign(mounted, {
      queryClient,
      async unmount() {
        try {
          await unmount();
        } finally {
          queryClient.clear();
        }
      },
    });
  } catch (error) {
    queryClient.clear();
    throw error;
  }
}

function Harness({ adapter }: { readonly adapter: PluginImportFileAdapter }) {
  const [open, setOpen] = useState(true);
  return (
    <PluginLibraryImportDialog
      open={open}
      cwd="/workspace"
      adapter={adapter}
      onOpenChange={setOpen}
    />
  );
}

function TriggerHarness({ adapter }: { readonly adapter: PluginImportFileAdapter }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="plugin-import-trigger"
        onClick={() => setOpen(true)}
      >
        Open import
      </button>
      <PluginLibraryImportDialog
        open={open}
        cwd="/workspace"
        adapter={adapter}
        returnFocusRef={triggerRef}
        onOpenChange={setOpen}
      />
    </>
  );
}

function ProductionHarness({
  open = true,
  cwd = "/workspace",
}: {
  readonly open?: boolean;
  readonly cwd?: string | null;
}) {
  const [isOpen, setOpen] = useState(open);
  return <PluginLibraryImportDialog open={isOpen} cwd={cwd} onOpenChange={setOpen} />;
}

function assertImportDialogFitsViewport(): void {
  const dialog = page.getByRole("dialog").element();
  for (const element of [document.documentElement, document.body, dialog]) {
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  }

  const visibleButtons = [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => !button.disabled && button.getClientRects().length > 0,
  );
  expect(visibleButtons.length).toBeGreaterThan(0);
  for (const button of visibleButtons) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(-1);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(rect.top).toBeGreaterThanOrEqual(-1);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    button.focus();
    expect(document.activeElement).toBe(button);
  }
}

beforeEach(() => {
  previousAppSettings = localStorage.getItem("moss:app-settings:v1");
  localStorage.setItem("moss:app-settings:v1", JSON.stringify({ localeOverride: "en" }));
});

afterEach(async () => {
  await page.viewport(1280, 760);
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
  delete window.nativeApi;
  if (previousAppSettings === null) localStorage.removeItem("moss:app-settings:v1");
  else localStorage.setItem("moss:app-settings:v1", previousAppSettings);
  previousAppSettings = null;
});

describe("PluginLibraryImportDialog", () => {
  it("walks a new plugin through scan, preview, progress, result, and rollback", async () => {
    const writes: PluginImportWriteInput[] = [];
    const rollbacks: Array<{ readonly receipt: PluginImportWriteReceipt }> = [];
    const adapter = {
      readFile: async () => {
        throw new Error("ENOENT: destination missing");
      },
      apply: async (input: PluginImportWriteInput) => {
        writes.push(input);
        return FIXTURE_WRITE_RECEIPT;
      },
      rollback: async (input: { readonly receipt: PluginImportWriteReceipt }) => {
        rollbacks.push(input);
        return { rolledBack: true };
      },
    } satisfies PluginImportFileAdapter;
    const screen = await render(<Harness adapter={adapter} />);

    try {
      for (const step of ["source", "scan", "conflict", "preview", "progress", "result"]) {
        await expect.element(page.getByTestId(`plugin-import-step-${step}`)).toBeInTheDocument();
      }
      setFile(
        "plugin.json",
        JSON.stringify({ name: "Local tools", description: "A local fixture" }),
        "application/json",
      );
      await expect.element(page.getByTestId("plugin-import-conflict-missing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-review-preview").click();
      await expect.element(page.getByTestId("plugin-import-preview-panel")).toBeInTheDocument();
      await page.getByTestId("plugin-import-confirm").click();
      await expect.element(page.getByTestId("plugin-import-result-panel")).toBeInTheDocument();
      await expect.element(page.getByTestId("plugin-import-result-status")).toBeInTheDocument();
      expect(writes).toContainEqual(
        expect.objectContaining({
          kind: "plugin",
          sourceName: "plugin.json",
          contents: JSON.stringify({ name: "Local tools", description: "A local fixture" }),
        }),
      );

      await page.getByTestId("plugin-import-rollback").click();
      await expect.element(page.getByTestId("plugin-import-rollback-done")).toBeInTheDocument();
      expect(rollbacks).toContainEqual({ receipt: FIXTURE_WRITE_RECEIPT });
    } finally {
      await screen.unmount();
    }
  });

  it("requires an explicit conflict choice and uses a CAS rollback receipt when replacing", async () => {
    const writes: PluginImportWriteInput[] = [];
    const rollbacks: Array<{ readonly receipt: PluginImportWriteReceipt }> = [];
    const adapter = {
      readFile: async () => ({ contents: "old skill", truncated: false }),
      apply: async (input: PluginImportWriteInput) => {
        writes.push(input);
        return FIXTURE_WRITE_RECEIPT;
      },
      rollback: async (input: { readonly receipt: PluginImportWriteReceipt }) => {
        rollbacks.push(input);
        return { rolledBack: true };
      },
    } satisfies PluginImportFileAdapter;
    const screen = await render(<Harness adapter={adapter} />);

    try {
      await page.getByTestId("plugin-import-kind-skill").click();
      setFile("review.md", "---\nname: review\n---\n# New", "text/markdown");
      await expect.element(page.getByTestId("plugin-import-conflict-existing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-conflict-replace-option").click();
      await expect.element(page.getByTestId("plugin-import-conflict-replace")).toBeChecked();
      await page.getByTestId("plugin-import-review-preview").click();
      await expect
        .element(page.getByTestId("plugin-import-preview-panel"))
        .toHaveAttribute("data-import-operation", "replace");
      await page.getByTestId("plugin-import-confirm").click();
      await expect
        .element(page.getByTestId("plugin-import-result-panel"))
        .toHaveAttribute("data-import-status", "imported");
      await page.getByTestId("plugin-import-rollback").click();
      await expect.element(page.getByTestId("plugin-import-rollback-done")).toBeInTheDocument();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual(
        expect.objectContaining({
          kind: "skill",
          sourceName: "review.md",
          contents: "---\nname: review\n---\n# New",
          replaceExisting: true,
        }),
      );
      expect(rollbacks).toEqual([{ receipt: FIXTURE_WRITE_RECEIPT }]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the preview action disabled until an existing conflict is explicitly resolved", async () => {
    const adapter = {
      readFile: async () => ({ contents: "old skill", truncated: false }),
      apply: async () => FIXTURE_WRITE_RECEIPT,
    } satisfies PluginImportFileAdapter;
    const screen = await render(<Harness adapter={adapter} />);

    try {
      await page.getByTestId("plugin-import-kind-skill").click();
      setFile("review.md", "---\nname: review\n---\n# New", "text/markdown");
      await expect.element(page.getByTestId("plugin-import-conflict-existing")).toBeInTheDocument();
      await expect.element(page.getByTestId("plugin-import-review-preview")).toBeDisabled();
      await page.getByTestId("plugin-import-conflict-replace-option").click();
      await expect.element(page.getByTestId("plugin-import-review-preview")).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });

  it("sends source bytes to the production-shaped apply seam, not a client path precondition", async () => {
    const writes: unknown[] = [];
    const adapter = {
      readFile: async () => ({ contents: "old skill", truncated: false }),
      apply: async (input: unknown) => {
        writes.push(input);
        return FIXTURE_WRITE_RECEIPT;
      },
      rollback: async () => ({ rolledBack: true }),
    } satisfies PluginImportFileAdapter;
    const screen = await render(<Harness adapter={adapter} />);

    try {
      await page.getByTestId("plugin-import-kind-skill").click();
      setFile("review.md", "---\nname: review\n---\n# New", "text/markdown");
      await expect.element(page.getByTestId("plugin-import-conflict-existing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-conflict-replace-option").click();
      await page.getByTestId("plugin-import-review-preview").click();
      await page.getByTestId("plugin-import-confirm").click();
      await expect.element(page.getByTestId("plugin-import-result-panel")).toBeInTheDocument();
      expect(writes[0]).toEqual(
        expect.objectContaining({
          kind: "skill",
          sourceName: "review.md",
          contents: "---\nname: review\n---\n# New",
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps malformed sources in the scan error state with a retry path", async () => {
    let readCount = 0;
    let writeCount = 0;
    const adapter = {
      readFile: async () => {
        readCount += 1;
        throw new Error("unexpected read");
      },
      apply: async () => {
        writeCount += 1;
        return FIXTURE_WRITE_RECEIPT;
      },
    } satisfies PluginImportFileAdapter;
    const screen = await render(<Harness adapter={adapter} />);

    try {
      setFile("broken.json", "{not json}", "application/json");
      await expect.element(page.getByTestId("plugin-import-scan-panel")).toBeInTheDocument();
      await expect.element(page.getByRole("alert")).toHaveTextContent("not valid JSON");
      expect(readCount).toBe(0);
      expect(writeCount).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("uses the default production adapter for typed plan/apply/rollback and never direct-writes", async () => {
    const fixture = new PluginLibraryNativeFixture();
    const nativeApi = fixture.nativeApi();
    window.nativeApi = nativeApi;
    const screen = await render(<ProductionHarness />);

    try {
      setFile(
        "plugin.json",
        JSON.stringify({ name: "Local tools", description: "A local fixture" }),
        "application/json",
      );
      await expect.element(page.getByTestId("plugin-import-conflict-missing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-review-preview").click();
      await page.getByTestId("plugin-import-confirm").click();
      await expect
        .element(page.getByTestId("plugin-import-result-panel"))
        .toHaveAttribute("data-import-status", "imported");
      await expect.element(page.getByTestId("plugin-import-rollback")).toBeInTheDocument();

      expect(fixture.importReadFileCalls).toEqual([
        {
          cwd: "/workspace",
          relativePath: ".moss/plugins/local-tools/plugin.json",
          maxBytes: 1_000_000,
        },
      ]);
      expect(fixture.importWriteFileCalls).toHaveLength(0);
      expect(fixture.importDeleteMossResourceCalls).toHaveLength(0);
      expect(fixture.importPlanCalls).toHaveLength(1);
      expect(fixture.importApplyCalls).toHaveLength(1);
      expect(fixture.importApplyCalls[0]?.plan.operations[0]?.targetPath).toBe(
        "/workspace/.moss/plugins/local-tools/plugin.json",
      );
      expect(
        JSON.parse(
          fixture.importFiles.get("/workspace:.moss/plugins/local-tools/plugin.json") ?? "{}",
        ).name,
      ).toBe("Local tools");
      await page.getByTestId("plugin-import-rollback").click();
      await expect.element(page.getByTestId("plugin-import-rollback-done")).toBeInTheDocument();
      expect(fixture.importRollbackCalls).toHaveLength(1);
      expect(fixture.importFiles.has("/workspace:.moss/plugins/local-tools/plugin.json")).toBe(
        false,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("previews MCP merge through the typed RPC receipt and never direct-writes", async () => {
    const fixture = new PluginLibraryNativeFixture();
    fixture.importFiles.set(
      "/workspace:.moss/mcp/config.json",
      JSON.stringify({ mcpServers: { linear: { command: "npx" } } }),
    );
    window.nativeApi = fixture.nativeApi();
    const screen = await render(<ProductionHarness />);

    try {
      await page.getByTestId("plugin-import-kind-mcp").click();
      setFile(
        "mcp.json",
        JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "github-mcp"] } } }),
        "application/json",
      );
      await expect.element(page.getByTestId("plugin-import-conflict-merge")).toBeInTheDocument();
      await page.getByTestId("plugin-import-review-preview").click();
      await expect
        .element(page.getByTestId("plugin-import-preview-panel"))
        .toHaveTextContent(".moss/mcp/config.json");
      await expect
        .element(page.getByTestId("plugin-import-preview-panel"))
        .toHaveAttribute("data-import-operation", "merge");
      await page.getByTestId("plugin-import-confirm").click();
      await expect
        .element(page.getByTestId("plugin-import-result-panel"))
        .toHaveAttribute("data-import-status", "imported");
      await expect.element(page.getByTestId("plugin-import-rollback")).toBeInTheDocument();
      expect(fixture.importReadFileCalls).toEqual([
        {
          cwd: "/workspace",
          relativePath: ".moss/mcp/config.json",
          maxBytes: 1_000_000,
        },
      ]);
      expect(fixture.importWriteFileCalls).toHaveLength(0);
      expect(fixture.importDeleteMossResourceCalls).toHaveLength(0);
      expect(fixture.importPlanCalls[0]?.localSource?.kind).toBe("mcp");
      expect(fixture.importApplyCalls[0]?.plan.operations[0]?.action).toBe("merge");
      expect(fixture.importFiles.get("/workspace:.moss/mcp/config.json")).toContain('"github"');
      await page.getByTestId("plugin-import-rollback").click();
      await expect.element(page.getByTestId("plugin-import-rollback-done")).toBeInTheDocument();
      expect(fixture.importRollbackCalls).toHaveLength(1);
      expect(fixture.importFiles.get("/workspace:.moss/mcp/config.json")).toBe(
        JSON.stringify({ mcpServers: { linear: { command: "npx" } } }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("applies through the typed RPC and never exposes recursive rollback beside a sibling file", async () => {
    const fixture = new PluginLibraryNativeFixture();
    const siblingKey = "/workspace:.moss/plugins/local-tools/README.md";
    fixture.importFiles.set(siblingKey, "keep this sibling");
    window.nativeApi = fixture.nativeApi();
    const screen = await render(<ProductionHarness />);

    try {
      setFile(
        "plugin.json",
        JSON.stringify({ name: "Local tools", description: "A local fixture" }),
        "application/json",
      );
      await expect.element(page.getByTestId("plugin-import-conflict-missing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-review-preview").click();
      await page.getByTestId("plugin-import-confirm").click();
      await expect
        .element(page.getByTestId("plugin-import-result-panel"))
        .toHaveAttribute("data-import-status", "imported");
      await expect.element(page.getByTestId("plugin-import-rollback")).toBeInTheDocument();
      expect(fixture.importWriteFileCalls).toHaveLength(0);
      expect(fixture.importDeleteMossResourceCalls).toHaveLength(0);
      expect(fixture.importFiles.get(siblingKey)).toBe("keep this sibling");
      expect(fixture.importApplyCalls).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("rejects an oversized File before invoking File.text", async () => {
    const adapter = {
      readFile: async () => {
        throw new Error("unexpected read");
      },
      apply: async () => FIXTURE_WRITE_RECEIPT,
    } satisfies PluginImportFileAdapter;
    const screen = await render(<Harness adapter={adapter} />);
    const oversized = new File(["x".repeat(PLUGIN_IMPORT_MAX_BYTES + 1)], "plugin.json", {
      type: "application/json",
    });
    const textSpy = vi.spyOn(File.prototype, "text");

    try {
      const input = page.getByTestId("plugin-import-source-file").element();
      const transfer = new DataTransfer();
      transfer.items.add(oversized);
      Object.defineProperty(input, "files", {
        configurable: true,
        value: transfer.files,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await expect.element(page.getByRole("alert")).toHaveTextContent("1 MB");
      expect(textSpy).not.toHaveBeenCalled();
    } finally {
      textSpy.mockRestore();
      await screen.unmount();
    }
  });

  it("uses native radio semantics and restores trigger focus after Escape and Done", async () => {
    const adapter = {
      readFile: async () => {
        throw new Error("ENOENT: destination missing");
      },
      apply: async () => FIXTURE_WRITE_RECEIPT,
    } satisfies PluginImportFileAdapter;
    const screen = await render(<TriggerHarness adapter={adapter} />);

    try {
      const trigger = page.getByTestId("plugin-import-trigger").element();
      await userEvent.click(trigger);
      await expect.element(page.getByTestId("plugin-import-title")).toBeInTheDocument();

      const pluginRadio = page.getByRole("radio", { name: /Plugin/u });
      await expect.element(pluginRadio).toBeInTheDocument();
      const plugin = pluginRadio.element();
      const dialog = page.getByRole("dialog").element();
      expect(plugin.tagName).toBe("INPUT");
      plugin.focus();
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(plugin);
      plugin.focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(page.getByRole("radio", { name: /Skill/u })).toBeChecked();
      await userEvent.keyboard("{Space}");
      await expect.element(page.getByRole("radio", { name: /Skill/u })).toBeChecked();
      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(page.getByRole("radio", { name: /Plugin/u })).toBeChecked();
      expect(document.activeElement).toBe(plugin);

      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId("plugin-import-title")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    } finally {
      await screen.unmount();
    }
  });

  it("does not close while the native write is pending, then restores focus on Done", async () => {
    let resolveWrite!: () => void;
    const writePending = new Promise<PluginImportWriteReceipt>((resolve) => {
      resolveWrite = () => resolve(FIXTURE_WRITE_RECEIPT);
    });
    const adapter = {
      readFile: async () => {
        throw new Error("ENOENT: destination missing");
      },
      apply: async () => writePending,
    } satisfies PluginImportFileAdapter;
    const screen = await render(<TriggerHarness adapter={adapter} />);

    try {
      const trigger = page.getByTestId("plugin-import-trigger").element();
      await userEvent.click(trigger);
      setFile("plugin.json", JSON.stringify({ name: "Pending" }), "application/json");
      await expect.element(page.getByTestId("plugin-import-conflict-missing")).toBeInTheDocument();
      await page.getByTestId("plugin-import-review-preview").click();
      await page.getByTestId("plugin-import-confirm").click();
      await expect.element(page.getByTestId("plugin-import-progress-panel")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId("plugin-import-title")).toBeInTheDocument();
      resolveWrite();
      await expect.element(page.getByTestId("plugin-import-result-panel")).toBeInTheDocument();
      await page.getByRole("button", { name: "Done" }).click();
      expect(document.activeElement).toBe(trigger);
    } finally {
      resolveWrite?.();
      await screen.unmount();
    }
  });

  it.each(["success", "failure"] as const)(
    "keeps Escape blocked during rollback-%s and restores trigger focus after settlement",
    async (outcome) => {
      let settleRollback!: (error?: Error) => void;
      const rollbackPending = new Promise<{ readonly rolledBack: boolean }>((resolve, reject) => {
        settleRollback = (error) => (error ? reject(error) : resolve({ rolledBack: true }));
      });
      const adapter = {
        readFile: async () => ({ contents: "old skill", truncated: false }),
        apply: async () => FIXTURE_WRITE_RECEIPT,
        rollback: async () => rollbackPending,
      } satisfies PluginImportFileAdapter;
      const screen = await render(<TriggerHarness adapter={adapter} />);

      try {
        const trigger = page.getByTestId("plugin-import-trigger").element();
        await userEvent.click(trigger);
        await page.getByTestId("plugin-import-kind-skill").click();
        setFile("review.md", "---\nname: review\n---\n# New", "text/markdown");
        await expect
          .element(page.getByTestId("plugin-import-conflict-existing"))
          .toBeInTheDocument();
        await page.getByTestId("plugin-import-conflict-replace-option").click();
        await page.getByTestId("plugin-import-review-preview").click();
        await page.getByTestId("plugin-import-confirm").click();
        await expect.element(page.getByTestId("plugin-import-result-panel")).toBeInTheDocument();

        await page.getByTestId("plugin-import-rollback").click();
        await expect
          .element(page.getByTestId("plugin-import-rollback"))
          .toHaveTextContent("Rolling back");
        await userEvent.keyboard("{Escape}");
        await expect.element(page.getByTestId("plugin-import-title")).toBeInTheDocument();

        if (outcome === "failure") settleRollback(new Error("rollback fixture failed"));
        else settleRollback();

        if (outcome === "failure") {
          const rollbackAlert = page.getByRole("alert");
          await expect.element(rollbackAlert).toHaveTextContent("Rollback could not be completed.");
          await expect.element(rollbackAlert).not.toHaveTextContent("rollback fixture failed");
        } else {
          await expect.element(page.getByTestId("plugin-import-rollback-done")).toBeInTheDocument();
        }
        await userEvent.keyboard("{Escape}");
        await expect.element(page.getByTestId("plugin-import-title")).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
      } finally {
        settleRollback?.();
        await screen.unmount();
      }
    },
  );

  it.each([
    ["light", 375],
    ["dark", 375],
    ["light", 768],
    ["dark", 768],
    ["light", 1440],
    ["dark", 1440],
  ] as const)(
    "keeps conflict, preview, and result stages inside the document at %s %dpx",
    async (theme, width) => {
      await page.viewport(width, 760);
      document.documentElement.classList.toggle("dark", theme === "dark");
      const adapter = {
        readFile: async () => ({
          contents: "existing canonical content ".repeat(80),
          truncated: false,
        }),
        apply: async () => FIXTURE_WRITE_RECEIPT,
      } satisfies PluginImportFileAdapter;
      const screen = await render(<Harness adapter={adapter} />);

      try {
        const longName = `Import ${"very-long-".repeat(18)}`;
        const longManifest = {
          name: longName,
          description: "manifest description ".repeat(180),
          interface: { shortDescription: "short description" },
        };
        setFile(
          `${"source-".repeat(16)}plugin.json`,
          JSON.stringify(longManifest),
          "application/json",
        );
        await expect
          .element(page.getByTestId("plugin-import-conflict-existing"))
          .toBeInTheDocument();
        assertImportDialogFitsViewport();
        await page.getByTestId("plugin-import-conflict-replace-option").click();
        await page.getByTestId("plugin-import-review-preview").click();
        await expect.element(page.getByTestId("plugin-import-preview-panel")).toBeInTheDocument();
        assertImportDialogFitsViewport();
        await page.getByTestId("plugin-import-confirm").click();
        await expect.element(page.getByTestId("plugin-import-result-panel")).toBeInTheDocument();
        assertImportDialogFitsViewport();
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each([
    ["light", 375],
    ["dark", 375],
    ["light", 768],
    ["dark", 768],
    ["light", 1440],
    ["dark", 1440],
  ] as const)(
    "keeps long import content and controls usable at %s %dpx (focused responsive check)",
    async (theme, width) => {
      await page.viewport(width, 760);
      document.documentElement.classList.toggle("dark", theme === "dark");
      const adapter = {
        readFile: async () => {
          throw new Error("ENOENT: destination missing");
        },
        apply: async () => FIXTURE_WRITE_RECEIPT,
      } satisfies PluginImportFileAdapter;
      const screen = await render(<Harness adapter={adapter} />);

      try {
        const longDescription = "long manifest ".repeat(180);
        setFile(
          "plugin.json",
          JSON.stringify({
            name: "A plugin with a deliberately long name",
            description: longDescription,
          }),
          "application/json",
        );
        await expect
          .element(page.getByTestId("plugin-import-conflict-missing"))
          .toBeInTheDocument();
        const dialog = page.getByRole("dialog").element();
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
        const reviewImport = page.getByTestId("plugin-import-review-preview").element();
        const reviewRect = reviewImport.getBoundingClientRect();
        expect(reviewRect.left).toBeGreaterThanOrEqual(0);
        expect(reviewRect.right).toBeLessThanOrEqual(window.innerWidth + 1);
        reviewImport.focus();
        expect(document.activeElement).toBe(reviewImport);
      } finally {
        await screen.unmount();
      }
    },
  );
});
