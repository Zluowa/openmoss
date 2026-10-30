import type {
  PagesCommentsInput,
  PagesCommentsResult,
  PagesListInput,
  PagesListResult,
  PagesMutateInput,
  PagesMutateResult,
  PagesReadInput,
  PagesReadResult,
  PagesScopeInput,
  PagesSpacesResult,
  PagesVersionsInput,
  PagesVersionsResult,
  ThreadId,
} from "@synara/contracts";
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
}

export class PagesService extends ServiceMap.Service<PagesService, PagesServiceShape>()(
  "moss/pages/Services/PagesService",
) {}
