import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, PageId, ProjectId, type NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossDataSpaceDestination } from "./MossDataSpaceDestination";
import { TooltipProvider } from "./ui/tooltip";
import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { readMossImagesAccountIdentity } from "~/lib/mossImagesAccountBoundary";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { mossServerQueryKeys } from "./auth/mossServerReactQuery";
import { useStore } from "~/store";
import { initialState } from "~/storeState";
import { useSpacesUiStore } from "~/spacesUiStore";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";

let fixture: ReturnType<typeof createDataSpaceFixture>;
let client: QueryClient;
let previousApi: NativeApi | undefined;

function account(id: string) {
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: { user: { id } },
    activeRealm: "cn",
  });
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  account(fixture.state.account);
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocalizationProvider>
          <TooltipProvider>
            <div style={{ height: "100vh", display: "flex" }}>
              <MossDataSpaceDestination
                onClose={() => undefined}
                onStartConversation={async () => undefined}
                onStartPageConversation={async () => undefined}
              />
            </div>
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
  await expect
    .element(page.getByRole("navigation").getByRole("button", { name: "全部", exact: true }))
    .toBeVisible();
}

async function openPage(title = "Research page") {
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
    .toHaveValue(title);
  await expect.element(page.getByTitle("页面富文本编辑器", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("正在加载页面编辑器…", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("页面编辑器尚未连接，请重试。已保存内容仍然保留。", { exact: true }))
    .not.toBeInTheDocument();
}

async function openMarkdownEditor() {
  await expect.element(page.getByRole("button", { name: "预览", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  // In this main region the first textbox is the title, followed by Pierre's
  // real contenteditable textbox inside its shadow root.
  const editor = page
    .getByRole("main", { name: "资料空间内容", exact: true })
    .getByRole("textbox")
    .nth(1);
  await expect.element(editor).toBeVisible();
  expect(editor.element().getAttribute("contenteditable")).toBe("true");
  return editor;
}

async function replaceEditorText(
  editor: Awaited<ReturnType<typeof openMarkdownEditor>>,
  text: string,
) {
  await editor.click({ position: { x: 15, y: 5 } });
  const modifier = isMacNavigatorPlatform() ? "Meta" : "Control";
  await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
  await userEvent.keyboard(text);
}

async function createPageSchedule() {
  const create = page.getByRole("button", { name: "Create", exact: true });
  await expect.element(create).toBeDisabled();
  const localCheckoutConsent = page.getByRole("checkbox", {
    name: /^Auto fallback may use local checkout/,
  });
  await expect.element(localCheckoutConsent).not.toBeChecked();
  await localCheckoutConsent.click();
  await expect.element(localCheckoutConsent).toBeChecked();
  await expect.element(create).toBeEnabled();
  await create.click();
}

describe("Data spaces with the real editor and NativeApi boundary", () => {
  beforeEach(async () => {
    previousApi = window.nativeApi;
    const editorServer = import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL as string | undefined;
    if (!editorServer)
      throw new Error("The real Canvas editor static server is required for Page browser checks.");
    // Confine this new integration dependency to Pages. Existing browser specs
    // retain their original attachment/media server origins and environment.
    vi.stubEnv("VITE_WS_URL", editorServer);
    fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    localStorage.clear();
    localStorage.setItem("moss:server-settings-migrated:v1", "1");
    useSpacesUiStore.setState({ activeSpaceId: null });
    useStore.setState({
      ...initialState,
      projects: [
        {
          id: ProjectId.makeUnsafe("project-a"),
          kind: "project",
          name: "Project A",
          cwd: "D:/fixture",
          remoteName: "Project A",
          folderName: "fixture",
          localName: null,
          expanded: true,
          scripts: [],
          spaceId: null,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        },
      ],
    });
    await page.viewport(1440, 1000);
  });
  afterEach(async () => {
    await cleanup();
    await client?.cancelQueries();
    client?.clear();
    useStore.setState(initialState);
    useSpacesUiStore.setState({ activeSpaceId: null });
    if (previousApi) window.nativeApi = previousApi;
    else delete window.nativeApi;
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("reconciles an unknown create-space result with the original request instead of duplicating it", async () => {
    fixture.state.loseCreateResponse = true;
    await mount();
    await page.getByRole("button", { name: "新建资料空间", exact: true }).click();
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("Weekly research");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Create response lost");
    expect(fixture.mutate).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("textbox", { name: "名称", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "核对创建结果", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
      .toHaveValue("Weekly research");
    expect(fixture.mutate).toHaveBeenCalledTimes(2);
    expect(fixture.mutate.mock.calls[1]?.[0]).toEqual(fixture.mutate.mock.calls[0]?.[0]);
    expect(fixture.documents().size).toBe(1);
    expect(fixture.state.events.filter((event) => event === "pages:create-space")).toHaveLength(1);
  });

  it("preserves the actual editor and unsaved buffer when a page refresh fails", async () => {
    fixture.put(pageDocument());
    await mount();
    await openPage();
    const editor = await openMarkdownEditor();
    const node = editor.element();
    fixture.mutate.mockRejectedValue(new Error("Save connection unavailable"));
    await replaceEditorText(editor, "Local research draft that has not been saved");
    // Fail both the ordinary autosave and the same query used by background polling.
    fixture.state.readError = new Error("Read connection unavailable");
    await client.refetchQueries({
      queryKey: pagesQueryKeys.read(
        readMossImagesAccountIdentity(client),
        null,
        PageId.makeUnsafe("page-one"),
      ),
    });
    await expect.element(page.getByRole("alert").first()).toHaveTextContent("页面刷新失败");
    expect(editor.element()).toBe(node);
    await expect.element(editor).toHaveTextContent("Local research draft that has not been saved");
    expect(fixture.documents().get(PageId.makeUnsafe("page-one"))?.content).toBe(
      "Saved page content",
    );
    expect(
      [...Array(localStorage.length)]
        .map((_, index) => localStorage.key(index))
        .filter(Boolean)
        .some(
          (key) =>
            key!.startsWith("moss:page-draft:") &&
            localStorage.getItem(key!)?.includes("Local research draft"),
        ),
    ).toBe(true);
  });

  it("keeps the real editor and draft mounted when the same account query refresh fails", async () => {
    fixture.put(pageDocument());
    await mount();
    await openPage();
    const editor = await openMarkdownEditor();
    const node = editor.element();
    fixture.mutate.mockRejectedValue(new Error("Save connection unavailable"));
    await replaceEditorText(editor, "A draft owned by the same account");
    const identity = readMossImagesAccountIdentity(client);
    const query = client
      .getQueryCache()
      .find({ queryKey: mossServerQueryKeys.mossAccountSession() });
    expect(query).toBeDefined();
    query!.setState({ status: "error", error: new Error("Account refresh failed") });
    expect(readMossImagesAccountIdentity(client)).toBe(identity);
    await page.getByRole("textbox", { name: "页面标题", exact: true }).click();
    await expect.element(editor).toHaveTextContent("A draft owned by the same account");
    expect(editor.element()).toBe(node);
    await expect
      .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
      .toHaveValue("Research page");
  });

  it("creates a child with its real parent identity and exposes it in the page tree", async () => {
    const parent = fixture.put(pageDocument());
    await mount();
    await page.getByRole("button", { name: "在 Research page 新建子页面", exact: true }).click();
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("Evidence child");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
      .toHaveValue("Evidence child");
    expect(fixture.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "create",
        parentPageId: parent.page.id,
        spaceId: parent.page.spaceId,
        scopeSpaceId: null,
      }),
    );
    await expect
      .element(page.getByRole("button", { name: "Evidence child", exact: true }))
      .toBeVisible();
  });

  it("posts comments and restores a selected saved revision through the actual RPCs", async () => {
    const first = fixture.put(pageDocument("page-one", "Research page", "Original evidence"));
    fixture.put({ ...first, content: "Current evidence", page: { ...first.page, revision: 2 } });
    await mount();
    await openPage();
    await page.getByRole("button", { name: "评论", exact: true }).click();
    await page.getByRole("textbox", { name: "新评论", exact: true }).fill("Check this evidence");
    await page.getByRole("button", { name: "添加评论", exact: true }).click();
    await expect
      .element(
        page
          .getByRole("list", { name: "页面评论", exact: true })
          .getByText("Check this evidence", { exact: true }),
      )
      .toBeVisible();
    expect(fixture.mutate.mock.calls[0]?.[0]).toMatchObject({
      op: "comment",
      pageId: first.page.id,
      expectedRevision: 2,
      content: "Check this evidence",
    });
    await page.getByRole("button", { name: "版本", exact: true }).click();
    const oldVersion = page.getByRole("button", { name: "版本 1 · 你", exact: true });
    await oldVersion.click();
    await expect.element(page.getByText("Original evidence", { exact: true })).toBeVisible();
    const restore = oldVersion
      .element()
      .parentElement!.querySelector<HTMLButtonElement>("button:last-child")!;
    await userEvent.click(restore);
    await vi.waitFor(() =>
      expect(fixture.mutate.mock.calls.at(-1)?.[0]).toMatchObject({
        op: "restore-version",
        pageId: first.page.id,
        expectedRevision: 3,
        revision: 1,
      }),
    );
    expect(fixture.documents().get(first.page.id)?.content).toBe("Original evidence");
  });

  it("associates an existing Library file without importing a duplicate", async () => {
    const document = fixture.put(pageDocument());
    await mount();
    await openPage();
    await page.getByRole("button", { name: "关联文件", exact: true }).click();
    await page.getByRole("checkbox", { name: "Research.pdf", exact: true }).click();
    await vi.waitFor(() =>
      expect(fixture.documents().get(document.page.id)?.page.assetIds).toEqual(["existing-file"]),
    );
    expect(fixture.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "update",
        pageId: document.page.id,
        assetIds: ["existing-file"],
        expectedRevision: 1,
      }),
    );
    await expect
      .element(page.getByRole("button", { name: "Research.pdf", exact: true }))
      .toBeVisible();
    expect(fixture.libraryList).toHaveBeenCalled();
    expect(fixture.libraryImport).not.toHaveBeenCalled();
  });

  it("creates one paused schedule, reconciles a lost attachment response, then enables it", async () => {
    const document = fixture.put(pageDocument());
    fixture.state.loseAttachResponse = true;
    await mount();
    await openPage();
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Automation title", exact: true }))
      .toHaveValue("更新 Research page");
    await createPageSchedule();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Attachment response lost");
    expect(fixture.createAutomation).toHaveBeenCalledTimes(1);
    expect(fixture.createAutomation.mock.calls[0]?.[0]).toMatchObject({
      enabled: false,
      mode: "dedicated",
    });
    expect(fixture.updateAutomation).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Retry setup", exact: true }).click();
    await vi.waitFor(() =>
      expect(fixture.updateAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(fixture.createAutomation).toHaveBeenCalledTimes(1);
    expect(fixture.documents().get(document.page.id)?.page.automationIds).toHaveLength(1);
    const attachments = fixture.mutate.mock.calls
      .map(([input]) => input)
      .filter((input) => input.op === "update" && input.automationIds !== undefined);
    expect(attachments).toHaveLength(2);
    expect(attachments[1]).toEqual(attachments[0]);
    expect(fixture.state.events.indexOf("pages:update")).toBeLessThan(
      fixture.state.events.indexOf("automation:update:true"),
    );
    // A reconciled attachment must not leave the Page mutation ledger stuck.
    await page
      .getByRole("main", { name: "资料空间内容", exact: true })
      .getByRole("button", { name: "置顶", exact: true })
      .click();
    await vi.waitFor(() =>
      expect(fixture.documents().get(document.page.id)?.page.pinned).toBe(true),
    );
  });

  it("retries an unknown schedule creation with its original request after closing and reopening", async () => {
    const document = fixture.put(pageDocument());
    fixture.state.loseAutomationCreateResponse = true;
    await mount();
    await openPage();
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    await createPageSchedule();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Automation creation response lost");
    expect(fixture.createAutomation).toHaveBeenCalledTimes(1);
    expect(fixture.updateAutomation).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    await page.getByRole("button", { name: "Retry creation", exact: true }).click();
    await vi.waitFor(() =>
      expect(fixture.updateAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(fixture.createAutomation).toHaveBeenCalledTimes(2);
    expect(fixture.createAutomation.mock.calls[1]?.[0]).toEqual(
      fixture.createAutomation.mock.calls[0]?.[0],
    );
    expect(fixture.createAutomation.mock.calls[0]?.[0].requestId).toBeTruthy();
    expect(
      fixture.state.events.filter((event) => event === "automation:create:false"),
    ).toHaveLength(1);
    expect(fixture.documents().get(document.page.id)?.page.automationIds).toHaveLength(1);
  });

  it("fences a late schedule creation result after the real account boundary changes", async () => {
    fixture.put(pageDocument());
    let release!: () => void;
    fixture.state.automationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await mount();
      await openPage();
      await page.getByRole("button", { name: "定时任务", exact: true }).click();
      await createPageSchedule();
      await vi.waitFor(() => expect(fixture.createAutomation).toHaveBeenCalledTimes(1));
      fixture.state.account = "account-b";
      account("account-b");
      await expect.element(page.getByText("还没有页面", { exact: true })).toBeVisible();
      release();
      await vi.waitFor(() =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .every((mutation) => mutation.state.status !== "pending"),
        ).toBe(true),
      );
      expect(
        fixture.mutate.mock.calls.some(
          ([input]) => input.op === "update" && input.automationIds !== undefined,
        ),
      ).toBe(false);
      expect(fixture.updateAutomation).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
        .not.toBeInTheDocument();
    } finally {
      release();
    }
  });

  it("does not send a schedule waiting on the real creation lock after its account changes", async () => {
    const document = fixture.put(pageDocument());
    await mount();
    await openPage();
    const identity = readMossImagesAccountIdentity(client);
    const context = `${identity}:null:page:${document.page.id}`;
    const journalKey = `moss:automation-create:v1:${JSON.stringify([identity, context, document.page.sourceThreadId])}`;
    const lockName = `moss:automation-create:${journalKey}`;
    const lockManager = navigator.locks;
    if (
      !lockManager ||
      typeof lockManager.request !== "function" ||
      typeof lockManager.query !== "function"
    ) {
      throw new Error("This control requires the real Web Locks request and query APIs");
    }
    const queryLocks = async () => {
      const { held, pending } = await lockManager.query();
      if (held === undefined || pending === undefined) {
        throw new Error("Web Locks query must provide held and pending lock snapshots");
      }
      return { held, pending };
    };
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = lockManager.request(lockName, async () => {
      enter();
      await gate;
    });
    try {
      await entered;
      await page.getByRole("button", { name: "定时任务", exact: true }).click();
      await createPageSchedule();
      await vi.waitFor(async () =>
        expect((await queryLocks()).pending.some((lock) => lock.name === lockName)).toBe(true),
      );
      expect(fixture.createAutomation).not.toHaveBeenCalled();
      fixture.state.account = "account-b";
      account("account-b");
      await expect.element(page.getByText("还没有页面", { exact: true })).toBeVisible();
      release();
      await holding;
      await vi.waitFor(async () => {
        const locks = await queryLocks();
        expect([...locks.held, ...locks.pending].some((lock) => lock.name === lockName)).toBe(
          false,
        );
      });
      expect(fixture.createAutomation).not.toHaveBeenCalled();
      expect(fixture.updateAutomation).not.toHaveBeenCalled();
      expect(localStorage.getItem(journalKey)).toContain('"requestId"');
    } finally {
      release();
      await holding;
    }
  });

  it("leaves a clean unsupported rich document safely but keeps dirty and unknown saves fenced", async () => {
    const richContent = JSON.stringify([
      { type: "moss-future-review-block", children: [{ text: "原始正文必须保留" }] },
    ]);
    const document = fixture.put({
      ...pageDocument("future-page", "Historical page", "原始正文必须保留"),
      richContent,
    });
    fixture.put(pageDocument("safe-page", "Safe page", "Safely saved content"));
    const hostError = "此编辑器尚不支持页面块 moss-future-review-block；原始内容由 Moss 保留。";
    const openUnsupported = async () => {
      await page.getByRole("button", { name: "Historical page", exact: true }).click();
      await expect
        .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
        .toHaveValue("Historical page");
      await expect.element(page.getByRole("alert").first()).toHaveTextContent(hostError);
    };
    await mount();
    await openUnsupported();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.documents().get(document.page.id)?.richContent).toBe(richContent);
    await openPage("Safe page");
    await openUnsupported();
    fixture.mutate.mockRejectedValue(new Error("Unknown save result"));
    const title = page.getByRole("textbox", { name: "页面标题", exact: true });
    await title.fill("Dirty historical title");
    await page.getByRole("button", { name: "Safe page", exact: true }).click();
    await expect.element(title).toHaveValue("Dirty historical title");
    await expect.element(page.getByRole("alert").first()).toHaveTextContent("Unknown save result");
    // Undoing the visible edit does not resolve the already submitted CAS write.
    await title.fill("Historical page");
    await page.getByRole("button", { name: "Safe page", exact: true }).click();
    await expect.element(title).toHaveValue("Historical page");
    expect(fixture.documents().get(document.page.id)?.page.title).toBe("Historical page");
    expect(fixture.documents().get(document.page.id)?.richContent).toBe(richContent);
    expect(
      [...Array(localStorage.length)]
        .map((_, index) => localStorage.key(index))
        .filter(Boolean)
        .some(
          (key) =>
            key!.startsWith("moss:page-draft:") &&
            localStorage.getItem(key!)?.includes('"pending":{'),
        ),
    ).toBe(true);
  });
});
