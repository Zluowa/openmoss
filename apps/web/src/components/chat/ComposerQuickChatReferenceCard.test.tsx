import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerQuickChatReferenceCard } from "./ComposerQuickChatReferenceCard";

describe("ComposerQuickChatReferenceCard", () => {
  it("renders the conversation title and stable identity without exposing serialized context", () => {
    const html = renderToStaticMarkup(
      <ComposerQuickChatReferenceCard
        reference={{
          type: "quick-chat",
          version: 1,
          conversationId: "provider-conversation-1",
          threadId: "moss-thread-1",
          title: "Release notes",
        }}
        onRemove={vi.fn()}
      />,
    );

    expect(html).toContain("Release notes");
    expect(html).toContain("Quick Chat reference");
    expect(html).toContain('data-quick-chat-reference-id="provider-conversation-1"');
    expect(html).not.toContain("quick_chat_reference");
  });
});
