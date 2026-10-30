// FILE: OpenUIFrame.browser.tsx
// Purpose: End-to-end browser proof of the OpenUI native-component track: the
//          real react-lang Renderer streams an OpenUI Lang program into native
//          React components inside the transcript, and a follow-up click
//          reflows into the thread's composer draft.
// Layer: Chat UI browser tests

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import ChatMarkdown from "../ChatMarkdown";
import { mossServerQueryKeys } from "../auth/mossServerReactQuery";

const PROGRAM = [
  "root = Card([header, followups])",
  'header = CardHeader("Paris", "City guide")',
  "followups = FollowUpBlock([f1])",
  'f1 = FollowUpItem("Best museums in Paris")',
].join("\n");

const FORM_PROGRAM = [
  "root = Card([form])",
  '$draft = ""',
  'form = Form("details", buttons, [field])',
  'field = FormControl("Synthetic name", Input("name", "Type synthetic name", "text", {}, $draft))',
  'buttons = Buttons([Button("Continue", { type: "continue_conversation", context: "Continue" }, "primary")])',
].join("\n");

function accountClient(userId = "synthetic-owner-a") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    activeRealm: "cn",
    session: { user: { id: userId } },
  });
  return client;
}

function scopedForm(client: QueryClient, threadId: string, messageId: string, copies = 1) {
  return (
    <QueryClientProvider client={client}>
      <ChatMarkdown
        cwd="/workspace"
        text={Array.from({ length: copies }, () => `\`\`\`openui\n${FORM_PROGRAM}\n\`\`\``).join(
          "\n\n",
        )}
        threadId={threadId}
        messageId={messageId}
        renderInlineVisualizations
      />
    </QueryClientProvider>
  );
}

it("restores a form after remounting the same account, thread, message and block", async () => {
  const client = accountClient();
  const first = await render(scopedForm(client, "restore-thread", "restore-message"));
  await first.getByRole("textbox").fill("synthetic saved draft");
  await first.unmount();
  const second = await render(scopedForm(client, "restore-thread", "restore-message"));
  try {
    await expect.element(second.getByRole("textbox")).toHaveValue("synthetic saved draft");
  } finally {
    await second.unmount();
  }
});

it.each(["thread", "message"])(
  "does not restore identical programs across %s boundaries",
  async (boundary) => {
    const client = accountClient();
    const first = await render(scopedForm(client, `origin-${boundary}`, "origin-message"));
    await first.getByRole("textbox").fill(`synthetic ${boundary} private draft`);
    await first.unmount();
    const second = await render(
      scopedForm(
        client,
        boundary === "thread" ? "other-thread" : `origin-${boundary}`,
        boundary === "message" ? "other-message" : "origin-message",
      ),
    );
    try {
      await expect.element(second.getByRole("textbox")).toHaveValue("");
    } finally {
      await second.unmount();
    }
  },
);

it("isolates identical blocks in one message and clears the mounted form on account switch", async () => {
  const client = accountClient();
  const first = await render(scopedForm(client, "blocks-thread", "blocks-message", 2));
  await first.getByRole("textbox").nth(0).fill("synthetic first block draft");
  await first.unmount();
  const second = await render(scopedForm(client, "blocks-thread", "blocks-message", 2));
  try {
    await expect
      .element(second.getByRole("textbox").nth(0))
      .toHaveValue("synthetic first block draft");
    await expect.element(second.getByRole("textbox").nth(1)).toHaveValue("");
    client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      activeRealm: "cn",
      session: { user: { id: "synthetic-owner-b" } },
    });
    await expect.element(second.getByRole("textbox").nth(0)).toHaveValue("");
  } finally {
    await second.unmount();
  }
});

it("does not persist a form without a known account", async () => {
  const client = new QueryClient();
  const first = await render(scopedForm(client, "unknown-thread", "unknown-message"));
  await first.getByRole("textbox").fill("synthetic unknown owner draft");
  await first.unmount();
  const second = await render(scopedForm(client, "unknown-thread", "unknown-message"));
  try {
    await expect.element(second.getByRole("textbox")).toHaveValue("");
  } finally {
    await second.unmount();
  }
});

it("resets mounted drafts across a batched account A-to-B-to-A transition", async () => {
  const client = accountClient();
  const mounted = await render(scopedForm(client, "aba-thread", "aba-message"));
  try {
    await mounted.getByRole("textbox").fill("synthetic old a draft");
    for (const id of ["synthetic-owner-b", "synthetic-owner-a"]) {
      client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
        authenticated: true,
        activeRealm: "cn",
        session: { user: { id } },
      });
    }
    await expect.element(mounted.getByRole("textbox"), { timeout: 2_000 }).toHaveValue("");
  } finally {
    await mounted.unmount();
  }
});

it("keeps the same native form node while the OpenUI program is streaming", async () => {
  const client = accountClient();
  const content = (suffix: string, isStreaming: boolean) => (
    <QueryClientProvider client={client}>
      <ChatMarkdown
        cwd="/workspace"
        text={`\`\`\`openui\n${FORM_PROGRAM}${suffix}\n\`\`\``}
        threadId="stream-thread"
        messageId="stream-message"
        isStreaming={isStreaming}
        renderInlineVisualizations
      />
    </QueryClientProvider>
  );
  const mounted = await render(content("", true));
  try {
    await expect.element(mounted.getByRole("textbox")).toBeInTheDocument();
    const original = mounted.getByRole("textbox").element();
    await mounted.rerender(content('\nextra = TextContent("Streamed detail")', true));
    expect(mounted.getByRole("textbox").element()).toBe(original);
    await mounted.rerender(content('\nextra = TextContent("Streamed detail")', false));
    await expect.element(mounted.getByRole("textbox"), { timeout: 2_000 }).toHaveValue("");
  } finally {
    await mounted.unmount();
  }
});

function renderMarkdown(text: string, threadId = "openui-browser-thread") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 600 }}>
        <ChatMarkdown
          cwd="/workspace"
          text={text}
          isStreaming={false}
          threadId={threadId}
          renderInlineVisualizations
        />
      </div>
    </QueryClientProvider>,
  );
}

it("renders an openui fenced block as native components", async () => {
  const mounted = await renderMarkdown(`Here you go:\n\n\`\`\`openui\n${PROGRAM}\n\`\`\``);
  try {
    // The lazy renderer chunk loads, then native components appear inline.
    await expect.element(mounted.getByText("Best museums in Paris")).toBeInTheDocument();
    await expect.element(mounted.getByText("City guide")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(
        mounted.baseElement.querySelector("[data-openui-state]")?.getAttribute("data-openui-state"),
      ).toBe("ready");
    });
    // Native React rendering — no iframe involved.
    expect(mounted.baseElement.querySelector("iframe")).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it("renders an <openui> html block as native components", async () => {
  const mounted = await renderMarkdown(`<openui>\n${PROGRAM}\n</openui>`);
  try {
    await expect.element(mounted.getByText("Best museums in Paris")).toBeInTheDocument();
  } finally {
    await mounted.unmount();
  }
});

it("reflows a follow-up click into the thread composer draft", async () => {
  const threadId = "openui-browser-reflow";
  useComposerDraftStore.getState().setPrompt(threadId as never, "");
  const mounted = await renderMarkdown(`\`\`\`openui\n${PROGRAM}\n\`\`\``, threadId);
  try {
    const followUp = mounted.getByText("Best museums in Paris");
    await expect.element(followUp).toBeInTheDocument();
    await followUp.click();
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId as never]?.prompt).toBe(
        "Best museums in Paris",
      );
    });
  } finally {
    await mounted.unmount();
  }
});
