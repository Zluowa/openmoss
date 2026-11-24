// Walk WALK-8 (N8-5): under a new Mossbot room's first choice card 「你最想让我帮你做什么？ A…E」
// sat 「或在下方聊天中回答」, explaining what the composer under it is for.

import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { CoordinatorSuggestions } from "./CoordinatorSuggestions";

afterEach(() => cleanup());

it("asks its first question without 「或在下方聊天中回答」 (walk N8-5)", async () => {
  await render(
    <CoordinatorSuggestions
      chips={[]}
      composerHeightPx={120}
      onOpenSettings={vi.fn()}
      personal
      onPrompt={vi.fn()}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: /Email and calendar|邮件/u }))
    .toBeVisible();
  expect(document.body.textContent).not.toMatch(
    /Or answer in the conversation below|在下方聊天中回答/u,
  );
});
