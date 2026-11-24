// WALK-6 N6-1 in a Mossbot group: a member's reply offers 下载 beside a file its own command made
// during the turn, as the main chat does, and not beside a file it only read. A group has no
// work log or checkpoint diff on the page, so the reply's turn times and the server's file times
// tell the two apart.

import "~/index.css";

import type { ReactNode } from "react";
import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type MossbotRoomView,
  type NativeApi,
  type ProjectStatThreadOutputFilesInput,
  type ProjectStatThreadOutputFilesResult,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "zh-CN" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("zh-CN", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("zh-CN", key, values),
    }),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => {},
}));
vi.mock("~/components/chat/project/useProjectAgentSummaries", () => ({
  useProjectAgentSummaries: () => ({ summariesByProjectId: new Map(), loaded: true }),
}));
vi.mock("~/components/RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/RouteSurface", () => ({
  RouteSurfaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./MossbotRoomMenu", () => ({ MossbotRoomMenu: () => null }));

import { MossbotRoomConversation } from "./MossbotRooms";

// The group's own folder, where its members run their commands.
const ROOM_DIR = "/tmp/moss-walk/rooms/team";
const MEMBER_ID = ProjectId.makeUnsafe("walk-room-analyst");
const MEMBER_THREAD_ID = ThreadId.makeUnsafe("walk-room-analyst-thread");
const REPLY_ID = MessageId.makeUnsafe("walk-room-reply");
const at = (second: number) => `2026-11-24T11:00:${String(second).padStart(2, "0")}.000Z`;

const ROOM_VIEW: MossbotRoomView = {
  room: {
    id: "walk-room",
    name: "数据小组",
    projectId: ProjectId.makeUnsafe("walk-room-project"),
    createdAt: "2026-11-24T10:00:00.000Z",
    responder: "lead",
    members: [
      {
        id: MEMBER_ID,
        name: "分析员",
        icon: null,
        color: null,
        threadId: MEMBER_THREAD_ID,
        modelSelection: { provider: "codex", model: "gpt-5" },
      },
    ],
    lines: [
      {
        id: "walk-room-post",
        senderId: null,
        text: "看一下 README.md，把里面的数据做成一个 Excel 表",
        createdAt: at(0),
      },
    ],
    deliveries: [
      { requestId: "walk-room-post", memberId: MEMBER_ID, state: "completed", error: null },
    ],
  },
  secretRequests: [],
  // The member ran `cat README.md`, then `python make_report.py`, which wrote report.xlsx.
  replies: [
    {
      memberId: MEMBER_ID,
      threadId: MEMBER_THREAD_ID,
      message: {
        id: REPLY_ID,
        role: "assistant",
        text: `读了 [README.md](${ROOM_DIR}/README.md)，表格做好了：[report.xlsx](${ROOM_DIR}/report.xlsx)。`,
        turnId: TurnId.makeUnsafe("walk-room-turn"),
        streaming: false,
        source: "native",
        createdAt: at(12),
        updatedAt: at(13),
      },
    },
  ],
};

// The server's file times: README.md was last written weeks before; the script wrote
// report.xlsx during the member's turn.
const README_WRITTEN_MS = Date.parse("2026-10-30T09:00:00.000Z");
function fileTimes(path: string) {
  if (path.endsWith("/README.md"))
    return { modifiedAtMs: README_WRITTEN_MS, createdAtMs: README_WRITTEN_MS };
  if (path.endsWith("/report.xlsx"))
    return { modifiedAtMs: Date.parse(at(9)), createdAtMs: Date.parse(at(9)) };
  return null;
}
const statThreadOutputFiles = vi.fn(
  async (
    input: ProjectStatThreadOutputFilesInput,
  ): Promise<ProjectStatThreadOutputFilesResult> => ({
    files: input.paths.map(fileTimes),
  }),
);
const getRoom = vi.fn(async () => ROOM_VIEW);

beforeEach(() => {
  statThreadOutputFiles.mockClear();
  getRoom.mockClear();
  vi.stubGlobal("nativeApi", {
    projects: { statThreadOutputFiles },
    mossbotRooms: { get: getRoom, list: async () => [] },
  } as unknown as NativeApi);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const reply = () => document.querySelector<HTMLElement>(`[data-chat-entry="${REPLY_ID}"]`);
const downloads = () => [
  ...(reply()?.querySelectorAll<HTMLElement>("[data-thread-output-download]") ?? []),
];
const downloadLabels = () => downloads().map((link) => link.getAttribute("aria-label"));

it("WALK-6 N6-1: in a Mossbot group, a member's reply offers 下载 beside the report.xlsx its command made, not beside the README.md it only read", async () => {
  await page.viewport(1100, 780);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 900, height: 720 }} className="flex flex-col">
        <MossbotRoomConversation roomId="walk-room" />
      </div>
    </QueryClientProvider>,
  );
  try {
    await expect.poll(() => reply()?.textContent ?? "").toContain("report.xlsx");
    // One download, for the workbook the member's script wrote during its turn.
    await expect.poll(() => downloadLabels()).toEqual(["下载 report.xlsx"]);
    // The README.md chip has its answer too, so a 下载 that would come late fails here.
    await expect
      .poll(() =>
        statThreadOutputFiles.mock.calls.some(([input]) =>
          input.paths.includes(`${ROOM_DIR}/README.md`),
        ),
      )
      .toBe(true);
    await Promise.all(statThreadOutputFiles.mock.results.map((result) => result.value));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(downloadLabels()).toEqual(["下载 report.xlsx"]);
    const [download] = downloads() as [HTMLElement];
    expect(download.textContent).toBe("下载");
    const box = download.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(reply()!.textContent).toContain("report.xlsx下载");
    // README.md was only read: its name stays, with no 下载 after it.
    expect(reply()!.textContent).toContain("读了 README.md，");
    expect(reply()!.textContent).not.toContain("README.md下载");
    // The times came from the member's thread, which works in the group's folder.
    expect(statThreadOutputFiles.mock.calls.map(([input]) => input.threadId)).toContain(
      MEMBER_THREAD_ID,
    );
  } finally {
    await screen.unmount();
    queryClient.clear();
  }
});
