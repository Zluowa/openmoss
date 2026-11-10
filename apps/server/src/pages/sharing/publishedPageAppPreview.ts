import {
  isReadonlyAppItemDocument,
  type PublishedPageAppSource,
} from "@moss/shared/readonlyAppItem";
import { Effect } from "effect";
import type { makePageAppPublications } from "./pageAppPublications.ts";
import { pageGuestFailure } from "./pageGuestHandler.ts";
import {
  preparePageAppPreviewDocument,
  type PageAppPreviewDocument,
} from "./pageAppPreviewDocument.ts";
import {
  PageAppPreviewTickets,
  type GuestPreviewDocument,
  type PageAppPreviewIssuer,
  type PageAppPreviewRenderContext,
} from "./pageAppPreviewTickets.ts";

type PublicationReader = Pick<Effect.Success<typeof makePageAppPublications>, "resolve">;
export function publishedGuestDocument(
  result: Effect.Success<ReturnType<PublicationReader["resolve"]>>,
) {
  const document: GuestPreviewDocument<PublishedPageAppSource> = {
    source: {
      sourceKind: "page-app",
      pageId: result.pageId,
      pageRevision: result.pageRevision,
      publicationId: result.publicationId,
      generation: result.generation,
      appId: result.appId,
      appRevision: result.appRevision,
    },
    html: result.html,
    publicMetadata: { title: result.title, revision: result.appRevision },
    availableCapabilities: result.availableCapabilities,
  };
  if (!isReadonlyAppItemDocument(document)) throw pageGuestFailure("unavailable");
  return document;
}
/** One publisher-owned ticket pool. The caller supplies its registered, trusted
 * issuer, never origins from a guest request. No accounts or capabilities are
 * exposed. This factory is not registered as a public route. */
export function createPublishedPageAppPreview(
  publications: PublicationReader,
  issuer: () => PageAppPreviewIssuer | null,
  render: (
    document: GuestPreviewDocument<PublishedPageAppSource>,
    context: PageAppPreviewRenderContext,
    signal: AbortSignal,
  ) => Promise<PageAppPreviewDocument> = preparePageAppPreviewDocument,
) {
  return new PageAppPreviewTickets<PageAppPreviewDocument, PublishedPageAppSource>({
    issuer,
    render,
    resolve: async (request, signal) => {
      if (!request.publicationId) throw pageGuestFailure("unavailable");
      const result = await Effect.runPromise(publications.resolve(request, request.publicationId), {
        signal,
      });
      return publishedGuestDocument(result);
    },
  });
}
