// @vitest-environment happy-dom
// FILE: PeerMessageCard.test.tsx
// Purpose: Guards the desktop-chat peer message line: collapsed by default, the
//   sender's live title as a chip (renamed thread renames the chip), a muted
//   fallback for an unknown sender, the caret toggle, and Show more for long bodies.
// Layer: Component interaction tests

import { MessageId, ThreadId } from "@moss/contracts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStore } from "~/store";
import type { SidebarThreadSummary } from "~/types";

import { PEER_MESSAGE_CLAMP_CHARS, PeerMessageCard } from "./PeerMessageCard";

const SENDER = ThreadId.makeUnsafe("thread-sender");

function seedSender(title: string) {
  useStore.setState((state) => ({
    sidebarThreadSummaryById: {
      ...state.sidebarThreadSummaryById,
      [SENDER]: {
        id: SENDER,
        title,
        session: null,
        latestTurn: null,
        createdAt: "2026-11-04T00:00:00.000Z",
      } as unknown as SidebarThreadSummary,
    },
  }));
}

function renderCard(messageId: string, text = "Please rebase onto main.", onOpenThread = vi.fn()) {
  const view = render(
    <PeerMessageCard
      messageId={MessageId.makeUnsafe(messageId)}
      sourceThreadId={SENDER}
      textLength={text.length}
      onOpenThread={onOpenThread}
    >
      <p data-test-body="">{text}</p>
    </PeerMessageCard>,
  );
  return { ...view, onOpenThread };
}

afterEach(() => {
  cleanup();
  useStore.setState((state) => {
    const next = { ...state.sidebarThreadSummaryById };
    delete next[SENDER];
    return { sidebarThreadSummaryById: next };
  });
});

describe("PeerMessageCard", () => {
  it("reads 'Received message from <sender>' and starts collapsed", () => {
    seedSender("Release coordinator");
    const { container, getByRole } = renderCard("m-collapsed");
    expect(container.textContent).toContain("Received message from");
    expect(container.querySelector('[data-thread-link="live"]')?.textContent).toContain(
      "Release coordinator",
    );
    const toggle = getByRole("button", { name: "Show message from Release coordinator" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-test-body]")).toBeNull();
  });

  it("opens and closes from the caret, keeping the body mounted once shown", () => {
    seedSender("Release coordinator");
    const { container, getByRole } = renderCard("m-toggle");
    fireEvent.click(getByRole("button", { name: "Show message from Release coordinator" }));
    expect(container.querySelector("[data-test-body]")).not.toBeNull();
    const hide = getByRole("button", { name: "Hide message from Release coordinator" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    const body = container.querySelector("[data-test-body]");
    expect(body).not.toBeNull();
    expect(body?.closest('[aria-hidden="true"][inert]')).not.toBeNull();
  });

  it("follows a rename of the sending thread", () => {
    seedSender("Old title");
    const { container } = renderCard("m-rename");
    act(() => seedSender("New title"));
    expect(container.querySelector('[data-thread-link="live"]')?.textContent).toContain(
      "New title",
    );
  });

  it("opens the sending thread from its chip", () => {
    seedSender("Release coordinator");
    const { container, onOpenThread } = renderCard("m-open-thread");
    fireEvent.click(container.querySelector('[data-thread-link="live"]')!);
    expect(onOpenThread).toHaveBeenCalledWith(SENDER);
  });

  it("falls back to plain 'another chat' text when the sender is unknown", () => {
    const { container } = renderCard("m-unknown");
    expect(container.querySelector('[data-thread-link="unknown"]')?.textContent).toContain(
      "another chat",
    );
  });

  it("clamps a long body behind Show more", () => {
    seedSender("Release coordinator");
    const { container, getByRole } = renderCard("m-long", "x".repeat(PEER_MESSAGE_CLAMP_CHARS + 1));
    fireEvent.click(getByRole("button", { name: "Show message from Release coordinator" }));
    const body = container.querySelector("[data-peer-message-body]");
    expect(body?.className).toContain("max-h-64");
    fireEvent.click(getByRole("button", { name: "Show more" }));
    expect(container.querySelector("[data-peer-message-body]")?.className).not.toContain(
      "max-h-64",
    );
    expect(getByRole("button", { name: "Show less" })).toBeTruthy();
  });
});
