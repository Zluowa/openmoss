import type {
  PageDraftsListInput,
  PageDraftsListResult,
  PageDraftsMutateInput,
  PageDraftsMutateResult,
} from "@moss/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PagesPrincipal, PagesServiceError } from "../../Services/PagesService";

/** Proposed page changes. Agents may create them; only the local person resolves them. */
export interface PageDraftsServiceShape {
  readonly list: (
    input: PageDraftsListInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageDraftsListResult, PagesServiceError>;
  readonly mutate: (
    input: PageDraftsMutateInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageDraftsMutateResult, PagesServiceError>;
}

export class PageDraftsService extends ServiceMap.Service<
  PageDraftsService,
  PageDraftsServiceShape
>()("moss/pages/drafts/Services/PageDraftsService") {}
