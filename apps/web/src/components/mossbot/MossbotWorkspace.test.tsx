// @vitest-environment happy-dom
// FILE: MossbotWorkspace.test.tsx
// Purpose: The empty Mossbot page is the companion alone (walk N6-5): no tagline, and no
//          second or third way to create beside the sidebar's 新建助手.
// Layer: Mossbot route UI test

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/components/chat/project/useProjectAgentSummaries", () => ({
  useProjectAgentSummaries: () => ({ summariesByProjectId: new Map(), loaded: true }),
}));
vi.mock("./MossbotRooms", () => ({
  useMossbotRoomList: () => ({ isSuccess: true, data: [] }),
  MossbotRoomCreateDialog: () => null,
}));
vi.mock("./MossbotCompanion", () => ({
  MossbotCompanion: () => <div data-testid="mossbot-companion" />,
}));
vi.mock("./MossbotCreateLauncher", () => ({ MossbotCreateLauncher: () => null }));
vi.mock("./MossbotConversationRoster", () => ({ MossbotConversationRoster: () => null }));
vi.mock("./MossbotConversationFolders", () => ({
  MossbotFolderDialog: () => null,
  MossbotNewConversationMenu: () => null,
}));
vi.mock("~/components/RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/RouteSurface", () => ({
  RouteSurfaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

import { MossbotWorkspace } from "./MossbotWorkspace";

afterEach(() => cleanup());

describe("MossbotWorkspace empty page", () => {
  it("N6-5: shows the companion alone, without a tagline or another create button", () => {
    render(<MossbotWorkspace />);

    const main = screen.getByRole("main");
    expect(main.querySelector('[data-testid="mossbot-companion"]')).not.toBeNull();
    expect(main.textContent?.trim()).toBe("");
    expect(main.querySelectorAll("button")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("A little help, always at hand.");
    expect(document.body.textContent).not.toContain("随时在身边");
  });
});
