import "~/index.css";
import type { ComponentProps } from "react";
import { ProjectId, ThreadId, type ProjectAgentSummary } from "@moss/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  summaries: {
    summariesByProjectId: new Map(),
    loaded: false,
    loadFailed: false,
  } as {
    summariesByProjectId: Map<unknown, unknown>;
    loaded: boolean;
    loadFailed: boolean;
  },
  rooms: { data: undefined, isPending: true, isSuccess: false, isError: false } as {
    data: unknown[] | undefined;
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useRouterState: (options: { select: (state: unknown) => unknown }) =>
    options.select({ location: { search: {} } }),
}));
vi.mock("~/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
  SidebarMenu: (props: ComponentProps<"ul">) => <ul data-slot="sidebar-menu" {...props} />,
  SidebarMenuItem: (props: ComponentProps<"li">) => <li data-slot="sidebar-menu-item" {...props} />,
  SidebarMenuButton: ({
    isActive,
    ...props
  }: ComponentProps<"button"> & { isActive?: boolean }) => (
    <button data-slot="sidebar-menu-button" data-active={isActive || undefined} {...props} />
  ),
}));
vi.mock("~/components/chat/project/useProjectAgentSummaries", () => ({
  useProjectAgentSummaries: () => mocks.summaries,
}));
vi.mock("./MossbotRooms", () => ({ useMossbotRoomList: () => mocks.rooms }));
vi.mock("./MossbotAssistantMenu", () => ({ MossbotAssistantMenu: () => null }));
vi.mock("./MossbotRoomMenu", () => ({ MossbotRoomMenu: () => null }));

import { MossbotConversationRoster } from "./MossbotConversationRoster";

const assistant: ProjectAgentSummary = {
  projectId: ProjectId.makeUnsafe("mossbot-1"),
  agentKind: "mossbot",
  configured: true,
  coordinatorName: "Personal assistant",
  coordinatorThreadId: ThreadId.makeUnsafe("thread-mossbot-1"),
  coordinatorIcon: null,
  coordinatorColor: null,
  coordinatorStatus: "idle",
  pausedAt: null,
  archivedAt: null,
  revision: 1,
};

function setState(input: {
  loaded: boolean;
  loadFailed: boolean;
  roomsPending: boolean;
  assistants?: ProjectAgentSummary[];
}) {
  mocks.summaries = {
    summariesByProjectId: new Map((input.assistants ?? []).map((row) => [row.projectId, row])),
    loaded: input.loaded,
    loadFailed: input.loadFailed,
  };
  mocks.rooms = input.roomsPending
    ? { data: undefined, isPending: true, isSuccess: false, isError: false }
    : { data: [], isPending: false, isSuccess: true, isError: false };
}

function roster(compact: boolean, sidebar = true, query = "") {
  render(
    <MossbotConversationRoster
      sidebar={sidebar}
      compact={compact}
      query={query}
      onNewRoom={() => {}}
    />,
  );
  return page.getByRole("region", { name: "Conversations" });
}

describe("MossbotConversationRoster loading", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the compact sidebar list quiet while it loads", async () => {
    setState({ loaded: false, loadFailed: false, roomsPending: true });
    const region = roster(true);
    await expect.element(region).toBeInTheDocument();
    expect(region.element().getAttribute("aria-busy")).toBe("true");
    expect(region.element().textContent).not.toContain("Loading");
  });

  it("shows loading on the full list until both lists settle", async () => {
    setState({ loaded: false, loadFailed: false, roomsPending: true });
    const region = roster(false);
    await expect.element(region.getByRole("status")).toHaveTextContent("Loading conversations…");
  });

  it("stops loading when the assistant list fails, and says so", async () => {
    setState({ loaded: false, loadFailed: true, roomsPending: false });
    const region = roster(false);
    await expect.element(region.getByRole("alert")).toHaveTextContent("Could not load assistants.");
    expect(region.element().getAttribute("aria-busy")).toBe("false");
    expect(region.element().textContent).not.toContain("Loading");
    // A failed list is not an empty one.
    expect(region.element().textContent).not.toContain("Your conversations will live here.");
  });

  it("lists assistants once loaded", async () => {
    setState({ loaded: true, loadFailed: false, roomsPending: false, assistants: [assistant] });
    const region = roster(true);
    await expect.element(region.getByText("Personal assistant")).toBeInTheDocument();
    expect(region.element().getAttribute("aria-busy")).toBe("false");
  });
});

describe("MossbotConversationRoster rows", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("draws sidebar rows as Moss's one-line menu rows", async () => {
    setState({ loaded: true, loadFailed: false, roomsPending: false, assistants: [assistant] });
    const region = roster(false);
    const row = region.getByRole("button", { name: "Personal assistant" });
    await expect.element(row).toBeInTheDocument();
    expect(row.element().getAttribute("data-slot")).toBe("sidebar-menu-button");
    // No preview line or time under the name in the sidebar.
    expect(row.element().textContent).toBe("Personal assistant");
  });

  it("keeps the landing list's preview rows", async () => {
    setState({ loaded: true, loadFailed: false, roomsPending: false, assistants: [assistant] });
    const region = roster(false, false);
    await expect.element(region.getByText("Personal assistant")).toBeInTheDocument();
    expect(region.element().querySelector("[data-slot=sidebar-menu-button]")).toBeNull();
    expect(region.element().querySelector(".mossbot-list-item")).not.toBeNull();
  });

  it("leaves the empty invitation to the landing page", async () => {
    setState({ loaded: true, loadFailed: false, roomsPending: false });
    const region = roster(false);
    await expect.element(region).toBeInTheDocument();
    expect(region.element().textContent).not.toContain("Your conversations will live here.");
  });

  it("still says when a sidebar search finds nothing", async () => {
    setState({ loaded: true, loadFailed: false, roomsPending: false, assistants: [assistant] });
    const region = roster(false, true, "zzz");
    await expect.element(region.getByText("No matching conversations.")).toBeInTheDocument();
  });
});
