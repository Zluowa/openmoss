// FILE: ComposerPendingApprovalPanel.browser.tsx
// Purpose: Browser regression coverage for the detached approval decision card.
// Layer: Chat composer UI browser test
// Depends on: ComposerPendingApprovalPanel and vitest-browser-react.

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
} from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "../../localization";
import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

const APPROVAL_REQUEST_ID = ApprovalRequestId.makeUnsafe("approval-test-1");
const LIFECYCLE_GENERATION = "generation-test-1";

type ApprovalResponder = (
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  lifecycleGeneration?: string,
  requestKind?: ProviderRequestKind,
) => Promise<void>;

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: APPROVAL_REQUEST_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    requestKind: "command",
    createdAt: "2026-07-03T01:00:00.000Z",
    detail: 'Bash: {"command":"bun run test"}',
    ...overrides,
  };
}

async function mountApprovalPanel(input?: {
  approval?: PendingApproval;
  isResponding?: boolean;
  onRespond?: ApprovalResponder;
}) {
  const onRespond =
    input?.onRespond ??
    vi.fn(
      async (
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
        _lifecycleGeneration?: string,
        _requestKind?: ProviderRequestKind,
      ) => undefined,
    );
  let approval = input?.approval ?? makeApproval();
  let isResponding = input?.isResponding ?? false;
  const renderPanel = () => (
    <ComposerPendingApprovalPanel
      approval={approval}
      pendingCount={1}
      isResponding={isResponding}
      onRespond={onRespond}
    />
  );
  const screen = await render(renderPanel());

  return {
    onRespond,
    rerender: async (update: { approval?: PendingApproval; isResponding?: boolean }) => {
      approval = update.approval ?? approval;
      isResponding = update.isResponding ?? isResponding;
      await screen.rerender(renderPanel());
    },
    cleanup: async () => {
      await screen.unmount();
    },
  };
}

describe("walk H-4: approving is a click or the person's own Tab, never a stray Enter", () => {
  const card = () => document.querySelector<HTMLElement>('[data-codex-approval-surface="true"]')!;
  const allowOnce = () =>
    card().querySelector<HTMLButtonElement>('[data-moss-visible-permission-action="accept"]')!;
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  /** Plain, held (auto-repeat) and IME-committing Enter, dispatched at `target`. */
  async function pressEveryEnter(target: HTMLElement) {
    target.focus();
    await userEvent.keyboard("{Enter}");
    for (const init of [
      { repeat: true },
      { repeat: true },
      { isComposing: true, keyCode: 229 },
    ] as const) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
      );
    }
    await nextFrame();
  }

  it("draws no ⏎ on 允许一次", async () => {
    const mounted = await mountApprovalPanel();
    try {
      await expect.element(page.getByRole("button", { name: /Allow once/u })).toBeVisible();
      const keys = Array.from(card().querySelectorAll("kbd")).map((kbd) => kbd.textContent);
      expect(keys).not.toContain("⏎");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the card pending on an Enter from the composer, a terminal, a rename field, the page or the card", async () => {
    const composer = document.createElement("form");
    composer.dataset.chatComposerForm = "true";
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "and then run the tests";
    composer.append(editor);
    const terminal = document.createElement("textarea");
    terminal.className = "xterm-helper-textarea";
    const rename = document.createElement("input");
    rename.value = "Renamed chat";
    document.body.append(composer, terminal, rename);
    const mounted = await mountApprovalPanel();
    try {
      await expect.element(page.getByRole("button", { name: /Allow once/u })).toBeVisible();
      // The card never takes focus by itself.
      expect(card().contains(document.activeElement)).toBe(false);
      const inCard = card().querySelector<HTMLElement>('[data-approval-command="true"]')!;
      inCard.tabIndex = -1;
      for (const target of [editor, terminal, rename, document.body, inCard]) {
        await pressEveryEnter(target);
      }
      expect(mounted.onRespond).not.toHaveBeenCalled();
      expect(card().isConnected).toBe(true);
    } finally {
      await mounted.cleanup();
      composer.remove();
      terminal.remove();
      rename.remove();
    }
  });

  it("approves when the person tabs to 允许一次 and presses Enter", async () => {
    document.body.tabIndex = -1;
    document.body.focus();
    const mounted = await mountApprovalPanel();
    try {
      await expect.element(page.getByRole("button", { name: /Allow once/u })).toBeVisible();
      for (let step = 0; step < 12 && document.activeElement !== allowOnce(); step += 1) {
        await userEvent.tab();
      }
      expect(document.activeElement).toBe(allowOnce());
      await userEvent.keyboard("{Enter}");
      await expect
        .poll(() => vi.mocked(mounted.onRespond).mock.calls.map((call) => call[1]))
        .toEqual(["accept"]);
    } finally {
      document.body.removeAttribute("tabindex");
      await mounted.cleanup();
    }
  });
});

describe("ComposerPendingApprovalPanel", () => {
  it("explains task consent and keeps it separate from provider session approval", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({
        requestKind: "tool",
        approvalScope: "computer-task",
        toolName: "computer_click",
      }),
    });
    try {
      await expect.element(page.getByText(/^Allow Computer for this task\?/)).toBeInTheDocument();
      await expect.element(page.getByText(/Stop cancels access/)).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Always allow$/ }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: /Allow Computer for this task/ }).click();
      expect(mounted.onRespond).toHaveBeenCalledExactlyOnceWith(
        APPROVAL_REQUEST_ID,
        "accept",
        LIFECYCLE_GENERATION,
        "tool",
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("asks to show the screen as its own decision, without session approval", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({
        requestKind: "tool",
        approvalScope: "computer-foreground",
        toolName: "computer_activate_window",
      }),
    });
    try {
      await expect.element(page.getByText(/^Show this on your screen\?/)).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /^Always allow/ }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Cancel turn/ }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText(/Use Stop to end the agent turn/)).toBeInTheDocument();
      await page.getByRole("button", { name: /Keep it in the background/ }).click();
      expect(mounted.onRespond).toHaveBeenCalledExactlyOnceWith(
        APPROVAL_REQUEST_ID,
        "decline",
        LIFECYCLE_GENERATION,
        "tool",
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it.each([
    ["Allow once", "accept"],
    ["Deny", "decline"],
  ] as const)("sends %s as an approval decision", async (label, decision) => {
    const mounted = await mountApprovalPanel();

    try {
      await page.getByRole("button", { name: new RegExp(label, "u") }).click();

      expect(mounted.onRespond).toHaveBeenCalledTimes(1);
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        decision,
        LIFECYCLE_GENERATION,
        "command",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("names Moss Apps actions and other MCP servers instead of placeholders", async () => {
    const question = 'Allow the moss_apps MCP server to run tool "COMPOSIO_MULTI_EXECUTE_TOOL"?';
    const mounted = await mountApprovalPanel({
      approval: makeApproval({
        requestKind: "tool",
        detail: question,
        toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
        toolServerName: "moss_apps",
        toolParamsDisplay: [{ name: "current_step", value: "READ_GITHUB_PROFILE" }],
      }),
    });
    try {
      await expect
        .element(page.getByText("Allow Moss Apps to run app actions?"))
        .toBeInTheDocument();
      await expect.element(page.getByText("Moss Apps", { exact: true })).toBeInTheDocument();
      await page.getByRole("button", { name: "Show details" }).click();
      await expect.element(page.getByText("READ_GITHUB_PROFILE")).toBeInTheDocument();
      // The card already asks the question the provider phrased.
      await expect.element(page.getByText(question)).not.toBeInTheDocument();

      await mounted.rerender({
        approval: makeApproval({
          requestKind: "tool",
          detail: 'Allow the github MCP server to run tool "list_issues"?',
          toolName: "list_issues",
          toolServerName: "github",
        }),
      });
      await expect
        .element(page.getByText("Allow github to run list_issues tool?"))
        .toBeInTheDocument();

      await mounted.rerender({
        approval: makeApproval({
          requestKind: "tool",
          detail: "",
          toolParamsDisplay: [{ name: "query", value: "open issues" }],
        }),
      });
      await expect.element(page.getByText("Allow this tool to run?")).toBeInTheDocument();
      await expect.element(page.getByText(/Server|tool tool/)).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  // WALK-7 N7-2: the card for Moss's own tool read 「允许 moss 运行 moss_canvas_open 工具？」 with
  // Codex's English question under it. REVIEW-RULES rule 9: the card adds a sentence in the
  // person's language on top of the facts; the tool's name and every argument stay, a tool
  // without wording falls back to its name, and no card shows less than main.
  async function mountInLocale(locale: "en" | "zh-CN", approval: PendingApproval) {
    return render(
      <MossLocaleScope locale={locale}>
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={1}
          isResponding={false}
          onRespond={vi.fn(async () => undefined)}
        />
      </MossLocaleScope>,
    );
  }
  const cardText = () =>
    document.querySelector<HTMLElement>('[data-codex-approval-surface="true"]')?.textContent ?? "";

  it.each([
    // A Moss tool with wording: the sentence, and the tool's name under it.
    { locale: "zh-CN", server: "moss", tool: "moss_canvas_open", title: "允许打开画布？" },
    { locale: "en", server: "moss", tool: "moss_canvas_open", title: "Allow opening Canvas?" },
    // A Moss tool without wording: its name, never "this tool".
    {
      locale: "zh-CN",
      server: "moss",
      tool: "moss_dashboard_write",
      title: "允许运行 moss_dashboard_write？",
    },
    {
      locale: "en",
      server: "moss",
      tool: "moss_dashboard_write",
      title: "Allow moss_dashboard_write to run?",
    },
    // A third-party server: its name and its tool's name.
    {
      locale: "zh-CN",
      server: "github",
      tool: "list_issues",
      title: "允许 github 运行 list_issues 工具？",
    },
    {
      locale: "en",
      server: "github",
      tool: "list_issues",
      title: "Allow github to run list_issues tool?",
    },
  ] as const)(
    "writes the approval for $server's $tool in the person's language and keeps its name (WALK-7 N7-2, $locale)",
    async ({ locale, server, tool, title }) => {
      const question = `Allow the ${server} MCP server to run tool "${tool}"?`;
      const screen = await mountInLocale(
        locale,
        makeApproval({
          requestKind: "tool",
          detail: question,
          toolName: tool,
          toolServerName: server,
        }),
      );
      try {
        await expect.element(page.getByText(title, { exact: true })).toBeVisible();
        expect(cardText()).toContain(tool);
        // Codex's generated question only repeated the names: it is the one thing that goes.
        expect(cardText()).not.toContain(question);
        expect(cardText()).not.toMatch(/MCP server|Review the request/u);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps a Moss tool's arguments on its card (WALK-7 N7-2)", async () => {
    const screen = await mountInLocale(
      "zh-CN",
      makeApproval({
        requestKind: "tool",
        detail: 'Allow the moss MCP server to run tool "moss_app_publish"?',
        toolName: "moss_app_publish",
        toolServerName: "moss",
        toolParamsDisplay: [{ name: "appId", value: "app-quarterly-report" }],
      }),
    );
    try {
      await expect.element(page.getByText("允许发布应用页？", { exact: true })).toBeVisible();
      expect(cardText()).toContain("moss_app_publish");
      await page.getByRole("button", { name: "显示详情" }).click();
      await expect.element(page.getByText("app-quarterly-report")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  // An ACP or OpenCode approval carries what it touches in its own text, with no argument
  // rows: the path or URL stays on the card, as on main (REVIEW-RULES rule 9).
  it.each([
    {
      label: "an ACP read of a path",
      detail: "Read /Users/me/project/notes.md",
      fact: "/Users/me/project/notes.md",
    },
    {
      label: "an OpenCode fetch of a URL",
      detail: "webfetch: https://example.com/docs/setup",
      fact: "https://example.com/docs/setup",
    },
  ] as const)("keeps what $label touches on the card (WALK-7 N7-2)", async ({ detail, fact }) => {
    for (const locale of ["zh-CN", "en"] as const) {
      const screen = await mountInLocale(locale, makeApproval({ requestKind: "tool", detail }));
      try {
        await vi.waitFor(() => expect(cardText()).toContain(fact));
      } finally {
        await screen.unmount();
      }
    }
  });

  it("keeps Allow once and Allow this conversation on different decisions", async () => {
    const mounted = await mountApprovalPanel();
    try {
      await page.getByRole("button", { name: "Approval options" }).click();
      await page.getByRole("menuitem", { name: "Allow once" }).click();
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        "accept",
        LIFECYCLE_GENERATION,
        "command",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends Allow this conversation as a session grant", async () => {
    const mounted = await mountApprovalPanel();
    try {
      await page.getByRole("button", { name: "Approval options" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Always allow" }))
        .not.toBeInTheDocument();
      await page.getByRole("menuitem", { name: "Allow this conversation" }).click();
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        "acceptForSession",
        LIFECYCLE_GENERATION,
        "command",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends Allow similar commands as an execpolicy amendment", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({
        execpolicyAmendment: ["python3", "-c", "pass"],
      }),
    });
    try {
      await page.getByRole("button", { name: "Approval options" }).click();
      await page.getByRole("menuitem", { name: "Allow similar commands" }).click();
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        "acceptWithExecpolicyAmendment",
        LIFECYCLE_GENERATION,
        "command",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends Allow all edits for a file change, not the execpolicy decision", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ requestKind: "file-change", detail: "src/app.ts" }),
    });
    try {
      await page.getByRole("button", { name: "Approval options" }).click();
      await page.getByRole("menuitem", { name: "Allow all edits" }).click();
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        "acceptForSession",
        LIFECYCLE_GENERATION,
        "file-change",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the Codex approval reason as the title and keeps the command in the body", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({
        approvalReason: "The sandbox launcher is unavailable. May I run this outside the sandbox?",
      }),
    });
    try {
      await expect
        .element(
          page.getByText(
            "The sandbox launcher is unavailable. May I run this outside the sandbox?",
          ),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Allow Moss to run this command?"))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("bun run test")).toBeInTheDocument();
      await expect.element(page.getByText("Terminal")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the request kind prompt and parsed command detail", async () => {
    const requestKind: ProviderRequestKind = "command";
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ requestKind }),
    });

    try {
      await expect.element(page.getByText("Allow Moss to run this command?")).toBeInTheDocument();
      await expect.element(page.getByText("Terminal")).toBeInTheDocument();
      await expect.element(page.getByText("bun run test")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides session approval when the provider cannot persist it", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ sessionApprovalAvailable: false }),
    });

    try {
      await expect.element(page.getByRole("button", { name: /Allow once/u })).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /^Always allow/u }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits a request only once while its first response is still pending", async () => {
    let resolveResponse: (() => void) | undefined;
    const pendingResponse = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const onRespond = vi.fn(() => pendingResponse);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = page.getByRole("button", { name: /Allow once/u });
      await approve.click();
      await approve.click();

      expect(onRespond).toHaveBeenCalledTimes(1);
    } finally {
      resolveResponse?.();
      await pendingResponse;
      await mounted.cleanup();
    }
  });

  it("shares the same synchronous claim between keyboard and click", async () => {
    let resolveResponse: (() => void) | undefined;
    const pendingResponse = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const onRespond = vi.fn(() => pendingResponse);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = document.querySelector<HTMLButtonElement>("button");
      expect(approve).not.toBeNull();
      approve!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      approve!.click();

      expect(onRespond).toHaveBeenCalledTimes(1);
    } finally {
      resolveResponse?.();
      await pendingResponse;
      await mounted.cleanup();
    }
  });

  it("allows a retry after the response callback rejects", async () => {
    const onRespond = vi
      .fn<ApprovalResponder>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(undefined);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = page.getByRole("button", { name: /Allow once/u });
      await approve.click();
      await expect.poll(() => onRespond.mock.calls.length).toBe(1);
      await approve.click();

      expect(onRespond).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("allows one new submission when a newer durable attempt becomes retryable", async () => {
    const onRespond = vi.fn<ApprovalResponder>().mockResolvedValue(undefined);
    const mounted = await mountApprovalPanel({ onRespond });

    try {
      const approve = page.getByRole("button", { name: /Allow once/u });
      await approve.click();
      await approve.click();
      expect(onRespond).toHaveBeenCalledTimes(1);

      await mounted.rerender({
        approval: makeApproval({ responseAttemptKey: "response-attempt-2" }),
      });
      await approve.click();
      await approve.click();

      expect(onRespond).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });
});
