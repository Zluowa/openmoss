import type {
  PagesCommentsInput,
  PagesCommentsResult,
  PagesListInput,
  PagesListResult,
  PagesMutateInput,
  PagesMutateResult,
  PagesOutputStateInput,
  PagesOutputsInput,
  PagesOutputsResult,
  PagesReadInput,
  PagesReadResult,
  PagesScopeInput,
  PagesSpacesResult,
  PagesTextCommentMutateInput,
  PagesTextCommentMutateResult,
  PagesTextCommentsInput,
  PagesTextCommentsResult,
  PagesVersionsInput,
  PagesVersionsResult,
  ThreadId,
} from "@moss/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

/** Trusted local UI or a gateway-authenticated thread; never supplied in tool args. */
export type PagesPrincipal =
  | { readonly kind: "local-user" }
  | { readonly kind: "agent"; readonly threadId: ThreadId };

export const LOCAL_PAGES_PRINCIPAL: PagesPrincipal = { kind: "local-user" };

export class PagesServiceError extends Schema.TaggedErrorClass<PagesServiceError>()(
  "PagesServiceError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "cycle", "storage"]),
    message: Schema.String,
    currentRevision: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface PagesServiceShape {
  readonly spaces: (
    input: PagesScopeInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesSpacesResult, PagesServiceError>;
  readonly list: (
    input: PagesListInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesListResult, PagesServiceError>;
  readonly read: (
    input: PagesReadInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesReadResult, PagesServiceError>;
  readonly versions: (
    input: PagesVersionsInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesVersionsResult, PagesServiceError>;
  readonly comments: (
    input: PagesCommentsInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesCommentsResult, PagesServiceError>;
  readonly mutate: (
    input: PagesMutateInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesMutateResult, PagesServiceError>;
  /** Comment threads on words in a page (stored as the web app's thread JSON). */
  readonly textComments: (
    input: PagesTextCommentsInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesTextCommentsResult, PagesServiceError>;
  readonly textCommentMutate: (
    input: PagesTextCommentMutateInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesTextCommentMutateResult, PagesServiceError>;
  /** Files agents wrote in chat turns of this scope (auto-ingest; nothing is copied). */
  readonly outputs: (
    input: PagesOutputsInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesOutputsResult, PagesServiceError>;
  readonly outputState: (
    input: PagesOutputStateInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<void, PagesServiceError>;
}

export class PagesService extends ServiceMap.Service<PagesService, PagesServiceShape>()(
  "moss/pages/Services/PagesService",
) {}
