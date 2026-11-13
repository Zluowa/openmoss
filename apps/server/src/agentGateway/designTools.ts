// FILE: designTools.ts
// Purpose: The design skill for agents: read the guide, make a 设计 canvas (blank, from a
//          template, or with artboards), read it, add or replace artboards, move frames and
//          notes, manage pages, and install or define a design system.
// Layer: Agent gateway tool catalog (beside pageTypeTools.ts / slidesTools.ts)
// Why: A design is a typed 资料空间 item (kind `design`). Every write is saved against the revision
//      the agent last read, so it never overwrites the person's edits; the open editor reloads a
//      newer revision as soon as it has no unsaved edits, which is how a canvas fills in live.

import { PageId, ThreadId, type PageTypedItem, type SpaceId } from "@moss/contracts";
import {
  applyDesignOps,
  createDesignCanvas,
  designBoardText,
  parseDesignCanvas,
  type DesignBoard,
  type DesignCanvas,
  type DesignOp,
} from "@moss/shared/spaceItems/designCanvas";
import { DESIGN_AGENT_GUIDE } from "@moss/shared/spaceItems/designGuide";
import {
  BUILT_IN_DESIGN_SYSTEMS,
  findBuiltInDesignSystem,
  parseDesignSystemTokens,
  type DesignSystemTokens,
} from "@moss/shared/spaceItems/designSystems";
import { DESIGN_TEMPLATES, findDesignTemplate } from "@moss/shared/spaceItems/designTemplates";
import { Effect } from "effect";

import { PagesServiceError } from "../pages/Services/PagesService";
import { designRooms } from "../pages/designRoom/designRooms";
import type { PageTypesServiceShape } from "../pages/types/PageTypesService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description:
    "Existing project authorization-space id; null is the default local domain. This is not a document-space id.",
};
const nullableId = { anyOf: [{ type: "string" }, { type: "null" }] };
const boardSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: 'Stable id: letters, digits, _ or -. Links: href="board:<id>".',
    },
    name: { type: "string", description: "Shown above the frame, in the user's language." },
    page: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number", minimum: 40, maximum: 8000 },
    h: { type: "number", minimum: 40, maximum: 8000 },
    html: {
      type: "string",
      maxLength: 400_000,
      description: "The artboard's whole HTML with inline styles.",
    },
    layout: { type: "string", enum: ["fixed", "page"] },
    interactive: { type: "boolean" },
    radius: { type: "number" },
    tweaks: { type: "array", items: { type: "object" } },
    guides: { type: "array", items: { type: "object" } },
  },
  required: ["id"],
};

const errorResult = (error: unknown) =>
  error instanceof PagesServiceError
    ? {
        ...mcpToolResultJson({
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentRevision === undefined
              ? {}
              : { currentRevision: error.currentRevision }),
          },
        }),
        isError: true,
      }
    : mcpToolResultError(errorText(error));

type Args = Record<string, unknown>;
const str = (args: Args, name: string, optional = false): string | undefined => {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new ToolInputError(`${name} must be a non-empty string`);
  return value;
};
const scopeOf = (args: Args): SpaceId | null => {
  const value = args.scopeSpaceId;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ToolInputError("scopeSpaceId must be a string or null");
  return value as SpaceId;
};
const revisionOf = (args: Args): number => {
  const value = args.expectedRevision;
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new ToolInputError("expectedRevision must be the revision from the last read or write");
  return value as number;
};
const parseInput = <A>(build: () => A) =>
  Effect.try({
    try: build,
    catch: (error) =>
      error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
  });

export const designHref = (pageId: string) => `moss://space-page/${encodeURIComponent(pageId)}`;

/** What an agent needs to see of a canvas: the index, and the HTML of the artboards it asked for. */
export function designReadView(
  item: PageTypedItem,
  canvas: DesignCanvas,
  boardIds: readonly string[] | "all",
) {
  const wanted = (board: DesignBoard) => boardIds === "all" || boardIds.includes(board.id);
  return {
    pageId: item.page.id,
    title: item.page.title,
    revision: item.page.revision,
    href: designHref(item.page.id),
    pages: canvas.pages,
    boards: canvas.boards.map((board) => {
      const { html, ...frame } = board;
      return wanted(board)
        ? { ...frame, html }
        : { ...frame, bytes: html.length, text: designBoardText(html).slice(0, 160) };
    }),
    notes: canvas.notes,
    ...(canvas.launch ? { launch: canvas.launch } : {}),
    theme: canvas.theme ?? "light",
    system: canvas.system
      ? {
          source: canvas.system.source,
          name: canvas.system.name,
          ...tokenSummary(canvas.system.tokens),
        }
      : null,
    ...(canvas.ownSystem ? { ownSystem: canvas.ownSystem } : {}),
  };
}

function tokenSummary(tokens: DesignSystemTokens) {
  return {
    colors: tokens.colors.map(
      (token) =>
        `--ds-${token.name} (${token.label}: ${token.light}${token.dark ? ` / ${token.dark}` : ""})`,
    ),
    text: tokens.text.map(
      (style) => `${style.name} ${style.size}/${style.lineHeight} ${style.weight} ${style.family}`,
    ),
    spacing: tokens.spacing.map((token) => `--ds-space-${token.name} ${token.value}px`),
    radius: tokens.radius.map((token) => `--ds-radius-${token.name} ${token.value}px`),
    ...(tokens.readme ? { readme: tokens.readme } : {}),
  };
}

const LAYOUT_OPS = new Set([
  "moveBoard",
  "deleteBoard",
  "reorderBoard",
  "upsertNote",
  "deleteNote",
  "upsertPage",
  "deletePage",
  "setLaunch",
  "setTheme",
  "setThumbnail",
  "upsertComponent",
  "deleteComponent",
]);

export function makeDesignTools({
  types,
}: {
  readonly types: PageTypesServiceShape;
}): ReadonlyArray<ToolEntry> {
  const principal = (threadId: string) => ({
    kind: "agent" as const,
    threadId: ThreadId.makeUnsafe(threadId),
  });
  const tool = (
    kind: "read" | "write",
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: Args, threadId: string) => Effect.Effect<unknown, unknown>,
  ): ToolEntry => ({
    requiredCapability: kind === "read" ? "thread:read" : "thread:write",
    ...(kind === "write" ? { requiresActiveTurn: true } : {}),
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          ...(kind === "write" ? { requestId: { type: "string", maxLength: 128 } } : {}),
          scopeSpaceId: scopeProperty,
          ...properties,
        },
        required: [...(kind === "write" ? ["requestId"] : []), "scopeSpaceId", ...required],
      },
      annotations: kind === "read" ? READ_ONLY_TOOL_ANNOTATIONS : WRITE_TOOL_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        if (kind === "write") yield* context.assertCallerTurnActive();
        return mcpToolResultJson(yield* handler(args as Args, context.callerThreadId));
      }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
  });

  const readDesign = (args: Args, threadId: string, pageArg = "pageId") =>
    Effect.gen(function* () {
      const pageId = PageId.makeUnsafe(yield* parseInput(() => str(args, pageArg)!));
      // With the design open in a live room, what people did in the last moment is saved first.
      yield* Effect.promise(
        () =>
          designRooms()
            ?.flush(pageId)
            .catch(() => null) ?? Promise.resolve(null),
      );
      const item = yield* types.read({ scopeSpaceId: scopeOf(args), pageId }, principal(threadId));
      if (item.kind !== "design" || item.data === null)
        return yield* Effect.fail(new ToolInputError(`This item is a ${item.kind}, not a design`));
      const canvas = yield* parseInput(() => parseDesignCanvas(item.data!));
      return { item, canvas };
    });

  /** Reads, checks the revision, applies `change`, saves. */
  const edit = (
    args: Args,
    threadId: string,
    change: (canvas: DesignCanvas, item: PageTypedItem) => Effect.Effect<DesignCanvas, unknown>,
  ) =>
    Effect.gen(function* () {
      const expectedRevision = yield* parseInput(() => revisionOf(args));
      const requestId = yield* parseInput(() => str(args, "requestId")!);
      const { item, canvas } = yield* readDesign(args, threadId);
      if (item.page.revision !== expectedRevision) {
        return yield* Effect.fail(
          new PagesServiceError({
            code: "conflict",
            message:
              "The design changed since it was read (the person may have edited it); read it again and redo the change",
            currentRevision: item.page.revision,
          }),
        );
      }
      const next = yield* change(canvas, item);
      const saved = yield* types.save(
        {
          requestId,
          scopeSpaceId: scopeOf(args),
          pageId: item.page.id,
          expectedRevision,
          data: JSON.stringify(next),
        },
        principal(threadId),
      );
      designRooms()?.replaced(saved.page.id, JSON.stringify(next), saved.page.revision);
      return {
        pageId: saved.page.id,
        revision: saved.page.revision,
        href: designHref(saved.page.id),
        boards: next.boards.map((board) => ({
          id: board.id,
          name: board.name,
          page: board.page,
          x: board.x,
          y: board.y,
          w: board.w,
          h: board.h,
        })),
      };
    });

  const systemFrom = (source: string, args: Args, threadId: string) =>
    Effect.gen(function* () {
      if (source.startsWith("builtin:")) {
        const builtIn = findBuiltInDesignSystem(source.slice("builtin:".length));
        if (!builtIn)
          return yield* Effect.fail(new ToolInputError(`No built-in design system ${source}`));
        return {
          source,
          name: builtIn.name,
          tokens: builtIn.tokens,
          copiedAt: new Date().toISOString(),
        };
      }
      if (source.startsWith("page:")) {
        const { item, canvas } = yield* readDesign(
          { ...args, systemPageId: source.slice(5) },
          threadId,
          "systemPageId",
        );
        if (!canvas.ownSystem)
          return yield* Effect.fail(
            new ToolInputError(
              `${item.page.title} is not a design system (it has no ownSystem tokens)`,
            ),
          );
        return {
          source,
          name: item.page.title.slice(0, 80),
          tokens: canvas.ownSystem,
          copiedAt: new Date().toISOString(),
          ...(canvas.components?.length ? { components: canvas.components } : {}),
        };
      }
      return yield* Effect.fail(
        new ToolInputError("system must be builtin:<id> or page:<design-system pageId>"),
      );
    });

  const boardsArg = (args: Args): DesignOp[] => {
    if (!Array.isArray(args.boards) || args.boards.length === 0)
      throw new ToolInputError("boards must be a non-empty array");
    if (args.boards.length > 20) throw new ToolInputError("send at most 20 artboards per call");
    return args.boards.map((board) => {
      if (
        typeof board !== "object" ||
        board === null ||
        typeof (board as { id?: unknown }).id !== "string"
      )
        throw new ToolInputError("every artboard needs an id");
      return { op: "upsertBoard", board: board as DesignOp & { id: string } } as DesignOp;
    });
  };

  return [
    tool(
      "read",
      "moss_design_guide",
      "Read this before making or changing a 设计 (design canvas of live HTML artboards: web pages, app screens, posters, social posts, wireframes, design systems). Returns the artboard format, sizes, links/prototypes, tweaks, design-system variables and craft rules, plus the built-in design systems and templates.",
      {},
      [],
      () =>
        Effect.succeed({
          guide: DESIGN_AGENT_GUIDE,
          systems: BUILT_IN_DESIGN_SYSTEMS.map((system) => ({
            source: `builtin:${system.id}`,
            name: system.name,
            description: system.description,
          })),
          templates: DESIGN_TEMPLATES.map((template) => ({
            templateId: template.id,
            title: template.title,
            description: template.description,
          })),
        }),
    ),
    tool(
      "write",
      "moss_design_create",
      "Create a 设计 in the 资料空间: blank, from templateId (see moss_design_guide), or with its first artboards and notes. system: builtin:<id> or page:<design-system pageId> (default builtin:moss unless a template sets one). Add the remaining artboards one or two per call with moss_design_write_boards so the person sees the canvas fill in. Link the result in your reply as [title](href).",
      {
        title: { type: "string", maxLength: 256 },
        spaceId: { ...nullableId, description: "Document space id, or null for Personal." },
        parentPageId: nullableId,
        templateId: { type: "string" },
        system: { type: "string" },
        boards: { type: "array", maxItems: 20, items: boardSchema },
        notes: { type: "array", items: { type: "object" } },
      },
      ["title", "spaceId", "parentPageId"],
      (args, threadId) =>
        Effect.gen(function* () {
          const templateId = yield* parseInput(() => str(args, "templateId", true));
          const template = templateId ? findDesignTemplate(templateId) : undefined;
          if (templateId && !template)
            return yield* Effect.fail(new ToolInputError(`No design template ${templateId}`));
          let canvas: DesignCanvas = template ? template.canvas : createDesignCanvas();
          const systemSource =
            (yield* parseInput(() => str(args, "system", true))) ??
            (template ? undefined : "builtin:moss");
          if (systemSource)
            canvas = { ...canvas, system: yield* systemFrom(systemSource, args, threadId) };
          const ops: DesignOp[] = [];
          if (Array.isArray(args.boards) && args.boards.length)
            ops.push(...(yield* parseInput(() => boardsArg(args))));
          if (Array.isArray(args.notes))
            for (const note of args.notes)
              ops.push({ op: "upsertNote", note: note as DesignOp & { id: string } } as DesignOp);
          if (ops.length) canvas = yield* parseInput(() => applyDesignOps(canvas, ops));
          const created = yield* types.create(
            {
              requestId: yield* parseInput(() => str(args, "requestId")!),
              scopeSpaceId: scopeOf(args),
              kind: "design",
              title: yield* parseInput(() => str(args, "title")!.trim().slice(0, 256)),
              spaceId: (args.spaceId ?? null) as never,
              parentPageId: (args.parentPageId ?? null) as never,
              data: JSON.stringify(canvas),
            },
            principal(threadId),
          );
          return {
            pageId: created.page.id,
            revision: created.page.revision,
            title: created.page.title,
            href: designHref(created.page.id),
            boards: canvas.boards.map((board) => ({
              id: board.id,
              name: board.name,
              x: board.x,
              y: board.y,
              w: board.w,
              h: board.h,
            })),
          };
        }),
    ),
    tool(
      "read",
      "moss_design_read",
      "Read a 设计: revision, pages, artboard frames (with a text excerpt), notes, theme and the installed design system's tokens. Pass boardIds (or [\"*\"]) to get those artboards' full HTML before changing them.",
      {
        pageId: { type: "string" },
        boardIds: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
      ["pageId"],
      (args, threadId) =>
        Effect.gen(function* () {
          const { item, canvas } = yield* readDesign(args, threadId);
          const ids = Array.isArray(args.boardIds)
            ? args.boardIds.filter((id): id is string => typeof id === "string")
            : [];
          return designReadView(item, canvas, ids.includes("*") ? "all" : ids);
        }),
    ),
    tool(
      "write",
      "moss_design_write_boards",
      "Add artboards to a 设计 or replace existing ones (matched by id; fields you leave out stay as they are, so a move-only change can omit html). A new artboard without x/y goes right of the page's top row. Requires expectedRevision from the last read or write; returns the new revision.",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        boards: { type: "array", minItems: 1, maxItems: 20, items: boardSchema },
      },
      ["pageId", "expectedRevision", "boards"],
      (args, threadId) =>
        edit(args, threadId, (canvas) => parseInput(() => applyDesignOps(canvas, boardsArg(args)))),
    ),
    tool(
      "write",
      "moss_design_update",
      "Change a 设计's layout in order: moveBoard {id,x?,y?,w?,h?}, deleteBoard {id}, reorderBoard {id,to:'front'|'back'|index}, upsertNote {note:{id,kind:'sticky'|'title'|'shape'|'link',page?,x,y,w?,h?,text,color?, shape?:'rect'|'oval'|'line'|'arrow'|'path', points?:[x1,y1,x2,y2], d?, stroke?, fill?, strokeWidth?, href?:'moss://space-page/<id>'|'https://…', subtitle?}}, deleteNote {id}, upsertPage {page:{id,name}}, deletePage {id}, setLaunch {launch:{view:'canvas'|'focused',boardId?,pageId?}|null}, setTheme {theme:'light'|'dark'}, setThumbnail {id|null}, upsertComponent {component:{id,name,html,description?}}, deleteComponent {id}. Each op is {op:<name>, …}. When you make another 资料空间 item from this design (a deck, a doc), add a link card note pointing at it.",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        ops: { type: "array", minItems: 1, maxItems: 200, items: { type: "object" } },
      },
      ["pageId", "expectedRevision", "ops"],
      (args, threadId) =>
        edit(args, threadId, (canvas) =>
          parseInput(() => {
            if (!Array.isArray(args.ops) || args.ops.length === 0)
              throw new ToolInputError("ops must be a non-empty array");
            for (const op of args.ops) {
              const name = (op as { op?: unknown } | null)?.op;
              if (typeof name !== "string" || !LAYOUT_OPS.has(name))
                throw new ToolInputError(
                  `unknown op ${String(name)}; artboard content goes through moss_design_write_boards`,
                );
            }
            return applyDesignOps(canvas, args.ops as DesignOp[]);
          }),
        ),
    ),
    tool(
      "read",
      "moss_design_systems",
      "List the built-in design systems with their tokens and readme, or read one design-system item (a 设计 with ownSystem tokens) by pageId.",
      { pageId: { type: "string" } },
      [],
      (args, threadId) =>
        Effect.gen(function* () {
          if (typeof args.pageId === "string" && args.pageId) {
            const { item, canvas } = yield* readDesign(args, threadId);
            if (!canvas.ownSystem)
              return yield* Effect.fail(
                new ToolInputError(`${item.page.title} is not a design system`),
              );
            return {
              source: `page:${item.page.id}`,
              name: item.page.title,
              tokens: canvas.ownSystem,
            };
          }
          return {
            systems: BUILT_IN_DESIGN_SYSTEMS.map((system) => ({
              source: `builtin:${system.id}`,
              name: system.name,
              description: system.description,
              ...tokenSummary(system.tokens),
            })),
          };
        }),
    ),
    tool(
      "write",
      "moss_design_set_system",
      "Install a design system into a 设计 (system: builtin:<id> or page:<design-system pageId>; its tokens are copied in and every artboard reads them as var(--ds-*)), remove it (system: none), or make this design a design system itself (system: own, with tokens {fonts?,colors:[{name,label,light,dark?,usage}],text:[{name,label,family,size,lineHeight,weight}],spacing:[{name,value}],radius:[{name,value}],readme?}).",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        system: { type: "string" },
        tokens: { type: "object" },
      },
      ["pageId", "expectedRevision", "system"],
      (args, threadId) =>
        edit(args, threadId, (canvas, item) =>
          Effect.gen(function* () {
            const source = yield* parseInput(() => str(args, "system")!);
            if (source === "none") return { ...canvas, system: null };
            if (source === "own") {
              const tokens = yield* parseInput(() => parseDesignSystemTokens(args.tokens));
              // A design system's own artboards preview it, so it is also the system they use.
              return parseDesignCanvas({
                ...canvas,
                ownSystem: tokens,
                system: {
                  source: `page:${item.page.id}`,
                  name: item.page.title.slice(0, 80),
                  tokens,
                  copiedAt: new Date().toISOString(),
                },
              });
            }
            return { ...canvas, system: yield* systemFrom(source, args, threadId) };
          }),
        ),
    ),
  ];
}
