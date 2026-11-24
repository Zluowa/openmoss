import { TodoId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../index.css";
import type { TaskRowModel } from "../tasks/tasks.logic";

const fixture = vi.hoisted(() => ({
  now: new Date(2026, 9, 2, 13).getTime(),
  surfaceWidth: 1100,
  rows: [] as TaskRowModel[],
  createTodo: vi.fn(),
  deleteTodo: vi.fn(),
  updateTodo: vi.fn(),
  updateTodoAsync: vi.fn(),
}));
vi.mock("~/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/betaFeatures")>()),
  INBOX_ON: true,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({ settings: { showAutomationRunThreads: true } }),
}));
vi.mock("~/tasksSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/tasksSurface")>()),
  useTasksSurfaceEnabled: () => true,
}));
vi.mock("~/hooks/useNowMs", () => ({ useNowMs: () => fixture.now }));
vi.mock("~/hooks/useActivityThreads", () => ({
  useActivityThreads: () => ({ visibleNonGroupThreads: [] }),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({
    stats: { getRecap: () => new Promise(() => {}) },
    automation: { list: async () => ({ runs: [] }) },
    server: { listProviderUsage: async () => [] },
  }),
}));
vi.mock("../RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => (
    <div className="flex h-[700px]" style={{ width: fixture.surfaceWidth }}>
      {children}
    </div>
  ),
}));
vi.mock("../RouteSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../RouteSurface")>()),
  RouteSurfaceHeader: () => null,
}));
vi.mock("../tasks/useTodos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/useTodos")>()),
  useTodoList: () => ({ todos: fixture.rows.map((row) => row.todo) }),
  useTaskRows: () => fixture.rows,
  useTodoMutations: () => fixture,
}));
// The floating card's fields are independent of the Inbox grid's width calculation.
vi.mock("../tasks/TaskCard", () => ({
  TaskCard: ({ className, onClose }: { className: string; onClose: () => void }) => (
    <section aria-label="Task details" className={className}>
      <button onClick={onClose}>Close task</button>
    </section>
  ),
}));

import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../../localization/zhCN";
import InboxView from "./InboxView";
import { toLocalDueDate } from "../tasks/tasks.logic";

it("keeps today's tasks beside the recap when their card opens on a laptop", async () => {
  await page.viewport(1440, 900);
  fixture.rows = [
    {
      todo: {
        id: TodoId.makeUnsafe("inbox-layout-task"),
        title: "Review today's task",
        notes: "",
        priority: "none",
        projectId: null,
        dueDate: toLocalDueDate(new Date(fixture.now)),
        threadId: null,
        delegationBaseTurnId: null,
        linkedAt: null,
        completedAt: null,
        createdAt: new Date(fixture.now).toISOString(),
        updatedAt: new Date(fixture.now).toISOString(),
      },
      thread: null,
      status: {
        kind: "todo",
        label: "To do",
        detail: null,
        workStartedAt: null,
        chatMissing: false,
      },
    },
  ];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <InboxView />
    </QueryClientProvider>,
  );
  try {
    const taskSection = page
      .getByRole("heading", { name: "Today’s tasks" })
      .element()
      .closest("section")!;
    const taskColumn = taskSection.parentElement!.parentElement!;
    const recapColumn = taskColumn.nextElementSibling!;
    const besideRecap = () => {
      const task = taskColumn.getBoundingClientRect();
      const recap = recapColumn.getBoundingClientRect();
      return Math.abs(task.top - recap.top) < 1 && task.right <= recap.left;
    };
    expect(besideRecap()).toBe(true);
    await page.getByRole("button", { name: "Review today's task", exact: true }).click();
    await expect.element(page.getByRole("region", { name: "Task details" })).toBeVisible();
    // Wait past the card's padding transition before checking settled geometry.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(besideRecap()).toBe(true);
    await page.getByRole("button", { name: "Close task" }).click();
    await expect.poll(besideRecap).toBe(true);
  } finally {
    await view.unmount();
    client.clear();
  }
});

// The tester's window: 1101 x 782 in Chinese, the inbox beside the app rail, at 03:28.
it("greets in whole Chinese sentences at night and shows the task hint uncut", async () => {
  await page.viewport(1101, 782);
  const previousNow = fixture.now;
  fixture.now = new Date(2026, 10, 19, 3, 28).getTime();
  fixture.surfaceWidth = 1050;
  fixture.rows = [];
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <InboxView />
    </QueryClientProvider>,
  );
  try {
    const title = await vi.waitFor(() => {
      const heading = document.querySelector<HTMLElement>("h1");
      expect(heading?.textContent).toBe("收信箱");
      return heading!;
    });
    const headline = title.nextElementSibling as HTMLElement;
    // At 03:28 the working day is still in its evening slot: the headline says so in the
    // same word as the slot card (walk R-9), Chinese punctuation all through.
    await vi.waitFor(() => expect(headline.textContent).toMatch(/^晚上好。/));
    expect(headline.textContent).not.toMatch(/[.]/);

    const input = await vi.waitFor(() => {
      const field = document.querySelector<HTMLInputElement>('input[placeholder="添加任务"]');
      expect(field).not.toBeNull();
      return field!;
    });
    // The whole hint fits the field: measured in the field's own font.
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const hintWidth = context.measureText(input.placeholder).width;
    const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    expect(hintWidth).toBeGreaterThan(0);
    expect(hintWidth).toBeLessThanOrEqual(room);
  } finally {
    await view.unmount();
    client.clear();
    uninstallZhCnUiLocalization();
    document.documentElement.lang = "en";
    delete document.documentElement.dataset.mossLocale;
    fixture.now = previousNow;
    fixture.surfaceWidth = 1100;
  }
});
