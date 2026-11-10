// FILE: slidesTools.ts
// Purpose: The PPT skill for agents: make a deck from an outline / template / JSON / .pptx,
//          read it as structured text, edit slides and elements by ordered ops, place
//          pictures, apply themes, and export to .pptx.
// Layer: Agent gateway tool catalog (beside pageTools.ts / pageTypeTools.ts)
// Why: A deck is a typed 资料空间 item (kind `slides`). Edits to a deck the agent did not just
//      make on its own arrive as drafts (pages_drafts, op kind `deck`). The deck editor applies
//      them as they arrive, one undo step each, and reports any that no longer fit back as
//      failed; nothing an agent sends is written over the person's unsaved edits.

import { promises as fs } from "node:fs";
import path from "node:path";

import { PageId, ThreadId, type SpaceId } from "@moss/contracts";
import {
  SLIDES_DECK_ACTIVITY_KIND,
  slidesCoverText,
  slidesDeckActivityPayload,
  THREAD_OUTPUT_FILE_ACTIVITY_KIND,
  threadOutputFileActivityPayload,
  type SlidesDeckChange,
} from "@moss/shared/chatArtifactActivity";
import { DECK_AGENT_GUIDE } from "@moss/shared/spaceItems/deckGuide";
import {
  applyDeckOps,
  deckFromOutline,
  diffDecks,
  isBlankDeck,
  replaceDeckOps,
  type DeckOp,
  type DeckOutline,
} from "@moss/shared/spaceItems/deckOps";
import { exportDeckToPptx, importPptxToDeck } from "@moss/shared/spaceItems/deckPptx";
import { newLayoutFaults, type DeckLayoutFault } from "@moss/shared/spaceItems/deckLayoutCheck";
import { deckTemplateData, findDeckTemplate } from "@moss/shared/spaceItems/deckTemplates";
import {
  bodyText,
  elementText,
  parseSlidesDeck,
  projectSlidesDeck,
  type SlideElement,
  type SlidesDeck,
} from "@moss/shared/spaceItems/slidesDeck";
import { Effect } from "effect";
import { threadOutputHref } from "@moss/shared/threadWorkspace";
import { publishThreadOutput } from "../threadOutputFile";

import type { PageDraftsServiceShape } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceError } from "../pages/Services/PagesService";
import type { PageTypesServiceShape } from "../pages/types/PageTypesService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime";

const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description:
    "Existing project authorization-space id; null is the default local domain. This is not a document-space id.",
};
const nullableId = { anyOf: [{ type: "string" }, { type: "null" }] };
const MAX_FILE_BYTES = 60 * 1024 * 1024;

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
  if ((value === undefined || value === null) && optional) return undefined;
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
const parseInput = <A>(build: () => A) =>
  Effect.try({
    try: build,
    catch: (error) =>
      error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
  });
const jsonArg = (args: Args, name: string): unknown => {
  const value = args[name];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ToolInputError(`${name} must be JSON`);
  }
};

/** A path the caller gave, bounded to its workspace (no escapes, no links). */
async function workspaceFile(root: string | null, raw: string, mustExist: boolean) {
  if (!root) throw new ToolInputError("This conversation has no workspace folder for files");
  const resolved = path.resolve(root, raw);
  const rootReal = await fs.realpath(root);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new ToolInputError("The path must be inside this conversation's workspace");
  if (mustExist) {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ToolInputError("Not a regular file");
    if (stat.size > MAX_FILE_BYTES) throw new ToolInputError("The file is larger than 60 MB");
    const real = await fs.realpath(resolved);
    const realRelative = path.relative(rootReal, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative))
      throw new ToolInputError("The path must be inside this conversation's workspace");
  }
  return resolved;
}

/** What an agent reads of an element: id, kind, box and words (bounded). */
function elementSummary(element: SlideElement) {
  const text = elementText(element);
  return {
    id: element.id,
    type: element.type,
    ...(element.type === "text" && element.role ? { role: element.role } : {}),
    ...(element.type === "shape" ? { shape: element.shape } : {}),
    ...(element.type === "chart" ? { chart: element.kind } : {}),
    ...(element.type === "text" ? { style: element.body.style } : {}),
    box: [element.x, element.y, element.w, element.h],
    ...(element.name ? { name: element.name } : {}),
    ...(text ? { text: text.length > 600 ? `${text.slice(0, 600)}…` : text } : {}),
    ...(element.type === "image"
      ? { src: element.src.startsWith("data:") ? "(inline image)" : element.src }
      : {}),
  };
}

export function deckOutline(deck: SlidesDeck, slideIds?: readonly string[]) {
  const wanted = slideIds?.length ? new Set(slideIds) : null;
  return {
    theme: deck.theme.name ?? null,
    coverSlideId: deck.coverSlideId ?? deck.slides[0]?.id ?? null,
    sections: deck.sections,
    slideCount: deck.slides.length,
    slides: deck.slides.flatMap((slide, index) =>
      wanted && !wanted.has(slide.id)
        ? []
        : [
            {
              index,
              id: slide.id,
              sectionId: slide.sectionId,
              layout: slide.layout,
              ...(slide.hidden ? { hidden: true } : {}),
              title:
                slide.elements
                  .filter((e) => e.type === "text" && e.role === "title")
                  .map((e) => (e.type === "text" ? bodyText(e.body) : ""))[0] ?? null,
              elements: slide.elements.map(elementSummary),
              ...(slide.notes ? { notes: slide.notes } : {}),
            },
          ],
    ),
  };
}

function diffSummary(before: SlidesDeck, after: SlidesDeck) {
  const diff = diffDecks(before, after);
  return {
    addedSlides: diff.addedSlides,
    removedSlides: diff.removedSlides,
    changedSlides: diff.changedSlides,
    movedSlides: diff.movedSlides,
    themeChanged: diff.themeChanged,
  };
}

/** What the agent must fix before it reports back: boxes it made cover each other, or run off. */
const layoutCheck = (faults: readonly DeckLayoutFault[]) =>
  faults.length
    ? {
        layoutFaults: faults.slice(0, 20),
        fixFirst:
          "These slides now have overlapping or off-slide elements. Move or resize them with moss_slides_edit (read the boxes with moss_slides_read) before you tell the person you are done.",
      }
    : {};

/** A link the chat renders as an 打开 button for the deck in 资料空间. */
const openLink = (pageId: string, title: string) =>
  `[打开「${title.replace(/[[\]]/gu, "")}」](moss://space-page/${encodeURIComponent(pageId)})`;

/** The cover slide's title and subtitle, for the chat's deck card. */
function deckCoverText(deck: SlidesDeck): string | null {
  const cover = deck.slides.find((slide) => slide.id === deck.coverSlideId) ?? deck.slides[0];
  if (!cover) return null;
  const texts = cover.elements.flatMap((element) =>
    element.type === "text" ? [{ role: element.role, text: bodyText(element.body) }] : [],
  );
  const title = texts.find((entry) => entry.role === "title");
  const subtitle = texts.find((entry) => entry.role === "subtitle");
  return slidesCoverText(
    title || subtitle
      ? [title?.text ?? "", subtitle?.text ?? ""]
      : texts.slice(0, 2).map((entry) => entry.text),
  );
}

/** A thread activity the chat draws as a card (see chatArtifactActivity.ts). */
export interface SlidesToolActivity {
  readonly kind: typeof SLIDES_DECK_ACTIVITY_KIND | typeof THREAD_OUTPUT_FILE_ACTIVITY_KIND;
  readonly summary: string;
  readonly payload:
    | ReturnType<typeof slidesDeckActivityPayload>
    | ReturnType<typeof threadOutputFileActivityPayload>;
}

export function makeSlidesTools({
  types,
  drafts,
  resolveWorkspaceRoot,
  recordActivity,
}: {
  readonly types: PageTypesServiceShape;
  readonly drafts?: PageDraftsServiceShape;
  readonly resolveWorkspaceRoot?: (context: ToolContext) => Effect.Effect<string | null>;
  /** Records a deck or exported file in the caller's thread, so the chat shows it as a card. */
  readonly recordActivity?: (
    context: ToolContext,
    activity: SlidesToolActivity,
  ) => Effect.Effect<void, unknown>;
}): ReadonlyArray<ToolEntry> {
  const principal = (threadId: string) => ({
    kind: "agent" as const,
    threadId: ThreadId.makeUnsafe(threadId),
  });
  const root = (context: ToolContext) =>
    resolveWorkspaceRoot ? resolveWorkspaceRoot(context) : Effect.succeed(null);

  const tool = (
    kind: "read" | "write",
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: Args, context: ToolContext) => Effect.Effect<unknown, unknown>,
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
      handler(args as Args, context).pipe(
        Effect.map(mcpToolResultJson),
        Effect.catch((error) => Effect.succeed(errorResult(error))),
      ),
  });

  const readDeck = (args: Args, threadId: string) =>
    Effect.gen(function* () {
      const pageId = PageId.makeUnsafe(str(args, "pageId")!);
      const item = yield* types.read({ scopeSpaceId: scopeOf(args), pageId }, principal(threadId));
      if (item.kind !== "slides" || !item.data)
        return yield* Effect.fail(new ToolInputError("That item is not a slides deck"));
      const deck = yield* parseInput(() => parseSlidesDeck(item.data!));
      return { item, deck, pageId };
    });

  /** Tells the chat about the deck as it is now. Never fails the tool call. */
  const announceDeck = (
    args: Args,
    context: ToolContext,
    pageId: string,
    change: SlidesDeckChange,
  ) =>
    recordActivity
      ? Effect.gen(function* () {
          const { item, deck } = yield* readDeck({ ...args, pageId }, context.callerThreadId);
          yield* recordActivity(context, {
            kind: SLIDES_DECK_ACTIVITY_KIND,
            summary: item.page.title,
            payload: slidesDeckActivityPayload({
              pageId: item.page.id,
              scopeSpaceId: scopeOf(args),
              title: item.page.title,
              slideCount: deck.slides.length,
              coverText: deckCoverText(deck),
              change,
            }),
          });
        }).pipe(Effect.catch(() => Effect.void))
      : Effect.void;
  const announceCommit = (args: Args, context: ToolContext, result: { applied: boolean }) =>
    typeof args.pageId === "string"
      ? announceDeck(args, context, args.pageId, result.applied ? "edited" : "proposed")
      : Effect.void;

  const createDeck = (args: Args, threadId: string, deck: SlidesDeck, title: string) =>
    Effect.gen(function* () {
      const created = yield* types.create(
        {
          requestId: str(args, "requestId")!,
          scopeSpaceId: scopeOf(args),
          kind: "slides",
          title,
          spaceId: (args.spaceId ?? null) as never,
          parentPageId: (args.parentPageId ?? null) as never,
          data: JSON.stringify(deck),
        },
        principal(threadId),
      );
      const stored = parseSlidesDeck(created.data!);
      return {
        pageId: created.page.id,
        revision: created.page.revision,
        title: created.page.title,
        ...deckOutline(stored),
        ...layoutCheck(newLayoutFaults(null, stored)),
        openLink: openLink(created.page.id, created.page.title),
        next: "Check it with moss_slides_read, fix with moss_slides_edit. You may edit this deck directly until someone else changes it. When you answer, include openLink as it is so the person can open the deck; do not export a .pptx unless they ask for a file.",
      };
    });

  /**
   * Applies ops to the agent's own untouched deck, or files them as a reviewable draft.
   * `mode`: auto (default) | propose | apply.
   */
  const commit = (
    args: Args,
    threadId: string,
    ops: readonly DeckOp[],
    summary: string | undefined,
    target?: { slideIds: string[]; elementIds: string[] },
  ) =>
    Effect.gen(function* () {
      const { item, deck, pageId } = yield* readDeck(args, threadId);
      const revision = item.page.revision;
      const expected = args.expectedRevision;
      if (expected !== undefined && expected !== revision)
        return yield* Effect.fail(
          new PagesServiceError({
            code: "conflict",
            message: "The deck changed since you read it; read it again",
            currentRevision: revision,
          }),
        );
      const next = yield* parseInput(() => applyDeckOps(deck, ops));
      const mode = (args.mode ?? "auto") as string;
      if (!["auto", "propose", "apply"].includes(mode))
        return yield* Effect.fail(new ToolInputError("mode must be auto, propose or apply"));
      const author = yield* types.dataAuthor(pageId);
      // An agent writes directly only into its own untouched deck, or a blank one (新建幻灯片
      // → 让 Moss 生成); anything else becomes a reviewable change.
      const own =
        (author?.threadId === threadId && author.revision === revision) ||
        isBlankDeck(deck, item.page.title);
      if (mode === "apply" && !own)
        return yield* Effect.fail(
          new ToolInputError(
            "Someone else has changed this deck (or you did not make it); send mode 'propose' so the person can review the change",
          ),
        );
      const changes = diffSummary(deck, next);
      const check = layoutCheck(newLayoutFaults(deck, next));
      if ((mode === "auto" && own) || mode === "apply") {
        const saved = yield* types.save(
          {
            requestId: str(args, "requestId")!,
            scopeSpaceId: scopeOf(args),
            pageId,
            expectedRevision: revision,
            data: JSON.stringify(next),
          },
          principal(threadId),
        );
        return { applied: true, pageId, revision: saved.page.revision, changes, ...check };
      }
      if (!drafts)
        return yield* Effect.fail(
          new ToolInputError("Reviewable changes are not available in this build"),
        );
      const result = yield* drafts.mutate(
        {
          op: "create",
          requestId: str(args, "requestId")!,
          scopeSpaceId: scopeOf(args),
          pageId,
          baseRevision: revision,
          kind: ops.some(
            (op) => op.op === "add-element" && (op.element as { type?: string }).type === "image",
          )
            ? "image"
            : "text",
          ...(summary ? { summary: summary.slice(0, 500) } : {}),
          ops: [{ kind: "deck", deckOps: JSON.stringify(ops), ...(target ? { target } : {}) }],
        },
        principal(threadId),
      );
      return {
        applied: false,
        proposed: true,
        draftId: result.drafts[0]?.id,
        pageId,
        baseRevision: revision,
        changes,
        ...check,
        next: "The deck editor applies this change as soon as the deck is open, and the person can undo it. Tell them in one sentence what you changed.",
      };
    });

  const opsArg = (args: Args): DeckOp[] => {
    const ops = jsonArg(args, "ops");
    if (!Array.isArray(ops) || ops.length === 0)
      throw new ToolInputError("ops must be a non-empty array");
    return ops as DeckOp[];
  };

  const opItem = {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: [
          "add-slide",
          "update-slide",
          "delete-slide",
          "move-slide",
          "duplicate-slide",
          "add-element",
          "update-element",
          "delete-element",
          "reorder-element",
          "set-text",
          "apply-theme",
          "upsert-section",
          "delete-section",
          "set-cover",
        ],
      },
    },
    required: ["op"],
    additionalProperties: true,
  };

  return [
    tool(
      "read",
      "moss_slides_guide",
      "Read this before making or editing a Moss deck (幻灯片): how to plan a good deck, layouts, themes, templates, the deck operations and element shapes.",
      {},
      [],
      () => Effect.succeed({ guide: DECK_AGENT_GUIDE }),
    ),
    tool(
      "write",
      "moss_slides_create",
      "Create a slides deck in 资料空间 (or, with pageId, fill that existing deck: written directly when it is blank, otherwise proposed as one reviewable change). Give exactly one of: outline {title, subtitle?, theme?, sections?:[{title, slides:[{layout?, title?, bullets?, body?, left?, right?, table?, quote?, image?, caption?, notes?}]}], slides?:[...], closing?} (preferred), templateId (e.g. builtin:weekly-report-deck), deck (full v2 JSON), or pptxPath (a .pptx file inside this conversation's workspace, imported as editable slides). Read moss_slides_guide first. Returns the deck outline with slide/element ids. requestId is idempotent.",
      {
        title: { type: "string", maxLength: 256 },
        spaceId: { ...nullableId, description: "Document space id, or null for Personal." },
        parentPageId: nullableId,
        pageId: { type: "string", description: "Fill this existing deck instead of creating one." },
        summary: { type: "string", maxLength: 500 },
        outline: { type: "object", additionalProperties: true },
        templateId: { type: "string" },
        theme: {
          type: "string",
          description:
            "Theme id or name for a template/outline: paper, ink, celadon, sea, sand, graphite.",
        },
        deck: { type: "string", maxLength: 2_000_000 },
        pptxPath: { type: "string", maxLength: 4096 },
      },
      ["title"],
      (args, context) =>
        Effect.gen(function* () {
          const title = str(args, "title")!;
          const sources = ["outline", "templateId", "deck", "pptxPath"].filter(
            (key) => args[key] !== undefined && args[key] !== null,
          );
          if (sources.length !== 1)
            return yield* Effect.fail(
              new ToolInputError("Give exactly one of outline, templateId, deck or pptxPath"),
            );
          let deck: SlidesDeck;
          let notes: string[] = [];
          if (args.outline !== undefined) {
            const outline = jsonArg(args, "outline") as DeckOutline;
            deck = yield* parseInput(() =>
              deckFromOutline({
                ...outline,
                title: outline?.title ?? title,
                ...(typeof args.theme === "string" ? { theme: args.theme } : {}),
              }),
            );
          } else if (args.templateId !== undefined) {
            const template = findDeckTemplate(str(args, "templateId")!);
            if (!template)
              return yield* Effect.fail(
                new ToolInputError("Unknown slides template; see moss_slides_guide"),
              );
            deck = yield* parseInput(() => parseSlidesDeck(deckTemplateData(template)));
            if (typeof args.theme === "string")
              deck = yield* parseInput(() =>
                applyDeckOps(deck, [{ op: "apply-theme", theme: args.theme as string }]),
              );
          } else if (args.deck !== undefined) {
            deck = yield* parseInput(() => parseSlidesDeck(args.deck));
          } else {
            const cwd = yield* root(context);
            const file = yield* Effect.tryPromise({
              try: () => workspaceFile(cwd, str(args, "pptxPath")!, true),
              catch: (error) =>
                error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
            });
            const bytes = yield* Effect.tryPromise({
              try: () => fs.readFile(file),
              catch: (error) => new ToolInputError(errorText(error)),
            });
            const imported = yield* Effect.tryPromise({
              try: () => importPptxToDeck(new Uint8Array(bytes)),
              catch: (error) =>
                new ToolInputError(`Could not read that .pptx: ${errorText(error)}`),
            });
            deck = imported.deck;
            notes = [
              ...imported.notes,
              ...(imported.skipped
                ? [`${imported.skipped} 个对象无法转换为可编辑元素，已跳过。`]
                : []),
            ];
          }
          if (typeof args.pageId === "string" && args.pageId.trim()) {
            const { deck: current } = yield* readDeck(args, context.callerThreadId);
            const filled = yield* commit(
              args,
              context.callerThreadId,
              replaceDeckOps(current, deck),
              typeof args.summary === "string" ? args.summary : `生成“${title}”`,
            );
            yield* announceCommit(args, context, filled);
            return {
              ...filled,
              ...deckOutline(deck),
              openLink: openLink(String(args.pageId), title),
              ...(notes.length ? { importNotes: notes } : {}),
            };
          }
          const result = yield* createDeck(args, context.callerThreadId, deck, title);
          yield* announceDeck(args, context, String(result.pageId), "created");
          return notes.length ? { ...result, importNotes: notes } : result;
        }),
    ),
    tool(
      "read",
      "moss_slides_read",
      "Read a slides deck as structured text: sections, and per slide its id, layout, title, notes and elements (id, type, role, box [x,y,w,h] on 1920×1080, text). format 'json' returns the full deck JSON instead. Also lists open reviewable changes. Use the ids in moss_slides_edit.",
      {
        pageId: { type: "string" },
        slideIds: { type: "array", items: { type: "string" }, maxItems: 300 },
        format: { type: "string", enum: ["outline", "json"] },
      },
      ["pageId"],
      (args, context) =>
        Effect.gen(function* () {
          const { item, deck } = yield* readDeck(args, context.callerThreadId);
          const open = drafts
            ? yield* drafts
                .list(
                  { scopeSpaceId: scopeOf(args), pageId: item.page.id },
                  principal(context.callerThreadId),
                )
                .pipe(
                  Effect.map((result) =>
                    result.drafts.map((draft) => ({
                      draftId: draft.id,
                      summary: draft.summary,
                      baseRevision: draft.baseRevision,
                      author:
                        draft.authorThreadId === context.callerThreadId ? "you" : draft.author,
                    })),
                  ),
                  Effect.orElseSucceed(() => []),
                )
            : [];
          const base = {
            pageId: item.page.id,
            title: item.page.title,
            revision: item.page.revision,
            openChanges: open,
          };
          if (args.format === "json") return { ...base, deck };
          const slideIds = Array.isArray(args.slideIds) ? (args.slideIds as string[]) : undefined;
          return { ...base, ...deckOutline(deck, slideIds) };
        }),
    ),
    tool(
      "write",
      "moss_slides_edit",
      "Edit a deck with ordered operations (see moss_slides_guide for every op and element shape). On a deck you created in this conversation that nobody changed since, edits apply directly; otherwise they are filed as one change that the open deck editor applies right away and the person can undo (mode 'propose' forces that). If the result lists layoutFaults, fix them before you answer. Give expectedRevision from your last read. summary: one short sentence of what this change does, shown to the person. target: the slide/element ids the user's request was about.",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        ops: { type: "array", maxItems: 200, items: opItem },
        summary: { type: "string", maxLength: 500 },
        mode: { type: "string", enum: ["auto", "propose", "apply"] },
        target: {
          type: "object",
          properties: {
            slideIds: { type: "array", items: { type: "string" } },
            elementIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      ["pageId", "ops"],
      (args, context) =>
        Effect.gen(function* () {
          const ops = yield* parseInput(() => opsArg(args));
          const target = args.target as { slideIds?: string[]; elementIds?: string[] } | undefined;
          const result = yield* commit(
            args,
            context.callerThreadId,
            ops,
            typeof args.summary === "string" ? args.summary : undefined,
            target
              ? {
                  slideIds: (target.slideIds ?? []).slice(0, 300),
                  elementIds: (target.elementIds ?? []).slice(0, 500),
                }
              : undefined,
          );
          yield* announceCommit(args, context, result);
          return result;
        }),
    ),
    tool(
      "write",
      "moss_slides_image",
      "Put a picture on a slide: src is an https URL or a Moss /api/... media path (e.g. a moss_media_generate output or the user's upload), or path is a PNG/JPEG/WebP file inside this conversation's workspace (≤ 1 MB, stored inline). With elementId, replaces that picture or image placeholder in place; otherwise adds it at box [x,y,w,h] (default: the free area under the title). Same apply/propose rule as moss_slides_edit.",
      {
        pageId: { type: "string" },
        slideId: { type: "string" },
        elementId: { type: "string" },
        src: { type: "string", maxLength: 4096 },
        path: { type: "string", maxLength: 4096 },
        alt: { type: "string", maxLength: 1000 },
        fit: { type: "string", enum: ["cover", "contain"] },
        box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        expectedRevision: { type: "integer", minimum: 1 },
        summary: { type: "string", maxLength: 500 },
        mode: { type: "string", enum: ["auto", "propose", "apply"] },
      },
      ["pageId", "slideId"],
      (args, context) =>
        Effect.gen(function* () {
          let src = str(args, "src", true);
          if (!src) {
            const cwd = yield* root(context);
            const file = yield* Effect.tryPromise({
              try: () => workspaceFile(cwd, str(args, "path")!, true),
              catch: (error) =>
                error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
            });
            const bytes = yield* Effect.tryPromise({
              try: () => fs.readFile(file),
              catch: (error) => new ToolInputError(errorText(error)),
            });
            if (bytes.length > 1_000_000)
              return yield* Effect.fail(
                new ToolInputError(
                  "That picture is over 1 MB; pass its https URL or Moss media path as src",
                ),
              );
            const ext = path.extname(file).toLowerCase();
            const mime =
              ext === ".png"
                ? "png"
                : ext === ".webp"
                  ? "webp"
                  : ext === ".jpg" || ext === ".jpeg"
                    ? "jpeg"
                    : null;
            if (!mime)
              return yield* Effect.fail(new ToolInputError("Use a PNG, JPEG or WebP file"));
            src = `data:image/${mime};base64,${bytes.toString("base64")}`;
          }
          const { deck } = yield* readDeck(args, context.callerThreadId);
          const slideId = str(args, "slideId")!;
          const slide = deck.slides.find((s) => s.id === slideId);
          if (!slide) return yield* Effect.fail(new ToolInputError(`No slide ${slideId}`));
          const fit = args.fit === "contain" ? "contain" : "cover";
          const alt = typeof args.alt === "string" ? { alt: args.alt } : {};
          const elementId = str(args, "elementId", true);
          let ops: DeckOp[];
          if (elementId) {
            const current = slide.elements.find((e) => e.id === elementId);
            if (!current)
              return yield* Effect.fail(
                new ToolInputError(`No element ${elementId} on that slide`),
              );
            ops =
              current.type === "image"
                ? [{ op: "update-element", slideId, elementId, set: { src, fit, ...alt } }]
                : [
                    { op: "delete-element", slideId, elementId },
                    {
                      op: "add-element",
                      slideId,
                      index: slide.elements.indexOf(current),
                      element: {
                        type: "image",
                        x: current.x,
                        y: current.y,
                        w: current.w,
                        h: current.h,
                        radius: current.radius,
                        src,
                        fit,
                        ...alt,
                      },
                    },
                  ];
          } else {
            const box = Array.isArray(args.box) ? (args.box as number[]) : [128, 280, 1664, 672];
            ops = [
              {
                op: "add-element",
                slideId,
                element: {
                  type: "image",
                  x: box[0],
                  y: box[1],
                  w: box[2],
                  h: box[3],
                  src,
                  fit,
                  ...alt,
                },
              },
            ];
          }
          const result = yield* commit(
            args,
            context.callerThreadId,
            ops,
            typeof args.summary === "string" ? args.summary : "放入一张图片",
            { slideIds: [slideId], elementIds: elementId ? [elementId] : [] },
          );
          yield* announceCommit(args, context, result);
          return result;
        }),
    ),
    tool(
      "write",
      "moss_slides_export",
      "Export a deck to this conversation's workspace as editable PowerPoint (pptx) or Markdown (md). The person sees the exported file as a card in the chat (open in the side panel, save as), so name the file in your answer; no link is needed. markdownLink is the same file as a link if your text must point to it. PDF and PNG are available in the editor.",
      {
        pageId: { type: "string" },
        format: { type: "string", enum: ["pptx", "md"] },
        path: {
          type: "string",
          maxLength: 4096,
          description: "Relative file path in the workspace; default <title>.<format>.",
        },
        slideIds: { type: "array", items: { type: "string" }, maxItems: 300 },
      },
      ["pageId", "format"],
      (args, context) =>
        Effect.gen(function* () {
          const { item, deck } = yield* readDeck(args, context.callerThreadId);
          const format = args.format === "md" ? "md" : "pptx";
          const safeTitle =
            item.page.title.replace(/[\\/:*?"<>|\x00-\x1f]/gu, "_").slice(0, 80) || "幻灯片";
          const cwd = yield* root(context);
          const file = yield* Effect.tryPromise({
            try: () =>
              workspaceFile(cwd, str(args, "path", true) ?? `${safeTitle}.${format}`, false),
            catch: (error) =>
              error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
          });
          if (path.extname(file).toLowerCase() !== `.${format}`)
            return yield* Effect.fail(new ToolInputError(`The path must end in .${format}`));
          let notes: string[] = [];
          let bytes: Uint8Array;
          if (format === "md") {
            bytes = new TextEncoder().encode(`# ${item.page.title}

${projectSlidesDeck(deck)}
`);
          } else {
            const slideIds = Array.isArray(args.slideIds) ? (args.slideIds as string[]) : undefined;
            const report = yield* Effect.tryPromise({
              try: () => exportDeckToPptx(deck, slideIds ? { slideIds } : {}),
              catch: (error) => new ToolInputError(`Export failed: ${errorText(error)}`),
            });
            bytes = report.bytes;
            notes = report.notes;
          }
          const output = yield* Effect.tryPromise({
            try: () => publishThreadOutput(cwd!, file, bytes, args.path == null),
            catch: (error) => new ToolInputError(errorText(error)),
          });
          const downloadUrl = threadOutputHref(
            String(context.callerThreadId),
            output.relative,
            output.sha256,
          );
          const name = path.basename(output.file);
          if (recordActivity)
            yield* recordActivity(context, {
              kind: THREAD_OUTPUT_FILE_ACTIVITY_KIND,
              summary: name,
              payload: threadOutputFileActivityPayload({
                file: output.relative,
                name,
                path: output.file,
                bytes: bytes.length,
                sha256: output.sha256,
              }),
            }).pipe(Effect.catch(() => Effect.void));
          const label = name.replace(/[\\\[\]]/gu, "\\$&");
          return {
            path: output.file,
            downloadUrl,
            markdownLink: `[${label}](${downloadUrl})`,
            bytes: bytes.length,
            slides: deck.slides.length,
            ...(notes.length ? { notes } : {}),
          };
        }),
    ),
  ];
}
