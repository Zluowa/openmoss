import {
  AutomationDefinition,
  AutomationId,
  DEFAULT_SERVER_SETTINGS_VIEW,
  PageId,
  PagesMutateInput,
  PagesMutateResult,
  PagesReadResult,
  type NativeApi,
  type PageComment,
  type PageSpace,
  PageSpaceId,
  type PageVersion,
  type LibraryItem,
} from "@synara/contracts";
import { Schema } from "effect";
import { vi } from "vitest";

const NOW = "2026-10-25T00:00:00.000Z";

export function pageDocument(
  id = "page-one",
  title = "Research page",
  content = "Saved page content",
) {
  return Schema.decodeUnknownSync(PagesReadResult)({
    page: {
      id,
      scopeSpaceId: null,
      spaceId: null,
      parentPageId: null,
      rootPageId: id,
      title,
      revision: 1,
      pinned: false,
      trashedAt: null,
      sourceThreadId: null,
      assetIds: [],
      automationIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    content,
  });
}

/** Only the NativeApi boundary is replaced. UI, editor, query and mutation code stay real. */
export function createDataSpaceFixture() {
  const state = {
    account: "account-a",
    loseCreateResponse: false,
    loseAttachResponse: false,
    loseAutomationCreateResponse: false,
    readError: null as Error | null,
    automationGate: null as Promise<void> | null,
    events: [] as string[],
  };
  const documents = new Map<string, Map<PageId, PagesReadResult>>();
  const spaces: PageSpace[] = [];
  const receipts = new Map<string, PagesMutateResult>();
  const versions = new Map<PageId, PageVersion[]>();
  const comments = new Map<PageId, PageComment[]>();
  const automations = new Map<string, AutomationDefinition[]>();
  const automationReceipts = new Map<string, AutomationDefinition>();
  const ownedDocuments = () => {
    let owned = documents.get(state.account);
    if (!owned) {
      owned = new Map();
      documents.set(state.account, owned);
    }
    return owned;
  };
  const put = (document: PagesReadResult) => {
    ownedDocuments().set(document.page.id, structuredClone(document));
    versions.set(document.page.id, [
      ...(versions.get(document.page.id) ?? []),
      {
        ...structuredClone(document),
        operation: "update",
        author: "local-user",
        authorThreadId: null,
        createdAt: NOW,
      },
    ]);
    return document;
  };
  const libraryItem: LibraryItem = {
    id: "existing-file",
    title: "Research.pdf",
    kind: "document",
    source: "user:import",
    sourceCli: "moss",
    path: "D:/fixture/Research.pdf",
    mimeType: "application/pdf",
    size: 128,
    favorite: false,
    folderId: null,
    trashedAt: null,
    originationThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const mutate = vi.fn(async (raw: PagesMutateInput): Promise<PagesMutateResult> => {
    const input = Schema.decodeUnknownSync(PagesMutateInput)(raw);
    const receiptKey = `${state.account}:${input.requestId}`;
    const previous = receipts.get(receiptKey);
    if (previous) return structuredClone(previous);
    let document: PagesReadResult;
    let space: PageSpace | undefined;
    let comment: PageComment | undefined;
    if (input.op === "create" || input.op === "create-space") {
      const id = PageId.makeUnsafe(`created-${receipts.size + 1}`);
      document = pageDocument(id, input.title, input.content ?? "");
      if (input.op === "create-space") {
        space = {
          id: PageSpaceId.makeUnsafe(`space-${id}`),
          scopeSpaceId: input.scopeSpaceId,
          rootPageId: id,
          title: input.title,
          revision: 1,
          trashedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        spaces.push(space);
        document = { ...document, page: { ...document.page, spaceId: space.id } };
      } else {
        const parent = input.parentPageId ? ownedDocuments().get(input.parentPageId) : undefined;
        document = {
          ...document,
          page: {
            ...document.page,
            spaceId: input.spaceId,
            parentPageId: input.parentPageId,
            rootPageId: parent?.page.rootPageId ?? id,
          },
        };
      }
    } else {
      const current = ownedDocuments().get(input.pageId);
      if (!current) throw new Error("Page not found");
      if (current.page.revision !== input.expectedRevision)
        throw new Error("Page revision conflict");
      document = structuredClone(current);
      if (input.op === "update") {
        document = {
          ...document,
          content: input.content ?? document.content,
          page: {
            ...document.page,
            title: input.title ?? document.page.title,
            assetIds: input.assetIds ?? document.page.assetIds,
            automationIds: input.automationIds ?? document.page.automationIds,
          },
        };
      } else if (input.op === "pin")
        document = { ...document, page: { ...document.page, pinned: input.pinned } };
      else if (input.op === "comment") {
        comment = {
          id: `comment-${input.requestId}`,
          pageId: input.pageId,
          revision: document.page.revision + 1,
          content: input.content,
          author: "local-user",
          authorThreadId: null,
          createdAt: NOW,
        };
        comments.set(input.pageId, [...(comments.get(input.pageId) ?? []), comment]);
      } else if (input.op === "restore-version") {
        const old = versions
          .get(input.pageId)
          ?.find((entry) => entry.page.revision === input.revision);
        if (!old) throw new Error("Version not found");
        document = {
          ...document,
          content: old.content,
          page: { ...document.page, title: old.page.title },
        };
      } else throw new Error(`Unexpected fixture operation: ${input.op}`);
      document = { ...document, page: { ...document.page, revision: current.page.revision + 1 } };
    }
    put(document);
    const result = Schema.decodeUnknownSync(PagesMutateResult)({
      ...document,
      affectedPageIds: [document.page.id],
      ...(space ? { space } : {}),
      ...(comment ? { comment } : {}),
    });
    receipts.set(receiptKey, structuredClone(result));
    state.events.push(`pages:${input.op}`);
    if ((input.op === "create-space" || input.op === "create") && state.loseCreateResponse) {
      state.loseCreateResponse = false;
      throw new Error("Create response lost");
    }
    if (input.op === "update" && input.automationIds && state.loseAttachResponse) {
      state.loseAttachResponse = false;
      throw new Error("Attachment response lost");
    }
    return result;
  });
  const read = vi.fn(async ({ pageId }: { pageId: PageId }) => {
    if (state.readError) throw state.readError;
    const document = ownedDocuments().get(pageId);
    if (!document) throw new Error("Page not found");
    return structuredClone(document);
  });
  let automationSequence = 0;
  const createAutomation = vi.fn(
    async (input: Parameters<NativeApi["automation"]["create"]>[0]) => {
      const owner = state.account;
      const requestKey = input.requestId ? `${owner}:${input.projectId}:${input.requestId}` : null;
      const previous = requestKey ? automationReceipts.get(requestKey) : null;
      if (previous) return structuredClone(previous);
      const definition = Schema.decodeUnknownSync(AutomationDefinition)({
        ...input,
        id: AutomationId.makeUnsafe(`automation-${++automationSequence}`),
        sourceThreadId: input.sourceThreadId ?? null,
        nextRunAt: null,
        targetThreadId: null,
        minimumIntervalSeconds: 60,
        maxRuntimeSeconds: 3600,
        retryPolicy: { type: "none" },
        misfirePolicy: "coalesce",
        acknowledgedRisks: input.acknowledgedRisks ?? [],
        iterationCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      });
      automations.set(owner, [...(automations.get(owner) ?? []), definition]);
      if (requestKey) automationReceipts.set(requestKey, structuredClone(definition));
      state.events.push(`automation:create:${definition.enabled}`);
      if (state.automationGate) await state.automationGate;
      if (state.loseAutomationCreateResponse) {
        state.loseAutomationCreateResponse = false;
        throw new Error("Automation creation response lost");
      }
      return definition;
    },
  );
  const updateAutomation = vi.fn(
    async (input: Parameters<NativeApi["automation"]["update"]>[0]) => {
      const entries = automations.get(state.account) ?? [];
      const definition = entries.find((entry) => entry.id === input.id);
      if (!definition) throw new Error("Automation not found");
      const saved = Schema.decodeUnknownSync(AutomationDefinition)({
        ...definition,
        ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      });
      automations.set(
        state.account,
        entries.map((entry) => (entry.id === input.id ? saved : entry)),
      );
      state.events.push(`automation:update:${input.enabled}`);
      return saved;
    },
  );
  const libraryList = vi.fn(async () => ({ items: [libraryItem], folders: [] }));
  const libraryImport = vi.fn(async () => {
    throw new Error("Unexpected file import");
  });
  const api = {
    pages: {
      spaces: vi.fn(async () => ({ spaces: state.account === "account-a" ? spaces : [] })),
      list: vi.fn(async () => ({
        pages: [...ownedDocuments().values()].map((entry) => structuredClone(entry.page)),
      })),
      read,
      mutate,
      versions: vi.fn(async ({ pageId }: { pageId: PageId }) => ({
        versions: [...(versions.get(pageId) ?? [])].reverse(),
      })),
      comments: vi.fn(async ({ pageId }: { pageId: PageId }) => ({
        comments: comments.get(pageId) ?? [],
      })),
    },
    automation: {
      list: vi.fn(async () => ({ definitions: automations.get(state.account) ?? [], runs: [] })),
      create: createAutomation,
      update: updateAutomation,
      onEvent: () => () => undefined,
    },
    library: { list: libraryList, importFiles: libraryImport },
    server: {
      getConfig: vi.fn(async () => ({
        cwd: "D:/fixture",
        platform: "win32",
        keybindings: [],
        providers: [
          {
            provider: "codex",
            driver: "codex",
            instanceId: "codex",
            enabled: true,
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: NOW,
          },
        ],
      })),
      getSettings: vi.fn(async () => DEFAULT_SERVER_SETTINGS_VIEW),
    },
    provider: {
      listModels: vi.fn(async () => ({
        models: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
        source: "runtime",
        cached: false,
      })),
      listAgents: vi.fn(async () => ({ agents: [], source: "empty", cached: false })),
    },
  };
  return {
    state,
    put,
    read,
    mutate,
    createAutomation,
    updateAutomation,
    libraryList,
    libraryImport,
    documents: ownedDocuments,
    api: api as unknown as NativeApi,
  };
}
