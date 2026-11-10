/**
 * The `pageSharing.*` RPC handlers, spread into the server's one handler map (`wsRpc.ts`).
 * Owner-only: they run as the local user, like `pages.*`.
 */
import {
  PAGE_SHARING_WS_METHODS,
  PageSharingRpcError,
  type PageShareActivityInput,
  type PageShareGetInput,
  type PageShareAppPublicationsInput,
  type PageShareMutateInput,
  type PageShareReplyInput,
  type PageSiteForPageInput,
  type PageSiteMutateInput,
  type PageSitesListInput,
} from "@moss/contracts";
import { Effect, type ServiceMap } from "effect";

import { requireWsOwnerSession } from "../../wsOwnerAuthorization.ts";
import type { PageSharingError, PageSharingServiceShape } from "./PageSharingService.ts";
import type { PageAppPublicationOwner } from "./PageAppPublicationOwner.ts";
import { LOCAL_PAGES_PRINCIPAL } from "../Services/PagesService.ts";

const toRpcError = (error: PageSharingError) =>
  new PageSharingRpcError({
    code: error.code,
    message: error.message,
    ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
  });

export const makePageSharingRpcHandlers = (
  service: PageSharingServiceShape | undefined,
  appOwner?: ServiceMap.Service.Shape<typeof PageAppPublicationOwner>,
) => {
  const asOwner = <A>(operation: () => Effect.Effect<A, PageSharingRpcError>) =>
    requireWsOwnerSession.pipe(
      Effect.mapError(
        () =>
          new PageSharingRpcError({ code: "owner-required", message: "只有所有者可以管理分享。" }),
      ),
      Effect.andThen(operation),
    );
  const call = <A>(
    operation: (service: PageSharingServiceShape) => Effect.Effect<A, PageSharingError>,
  ) =>
    asOwner(() =>
      service === undefined
        ? Effect.fail(new PageSharingRpcError({ code: "storage", message: "分享服务暂不可用。" }))
        : operation(service).pipe(Effect.mapError(toRpcError)),
    );
  return {
    [PAGE_SHARING_WS_METHODS.appPublications]: (input: PageShareAppPublicationsInput) =>
      asOwner(() =>
        appOwner === undefined
          ? Effect.fail(
              new PageSharingRpcError({ code: "storage", message: "应用预览服务不可用。" }),
            )
          : appOwner.manage(input, LOCAL_PAGES_PRINCIPAL).pipe(Effect.mapError(toRpcError)),
      ),
    [PAGE_SHARING_WS_METHODS.get]: (input: PageShareGetInput) => call((s) => s.get(input)),
    [PAGE_SHARING_WS_METHODS.mutate]: (input: PageShareMutateInput) => call((s) => s.mutate(input)),
    [PAGE_SHARING_WS_METHODS.activity]: (input: PageShareActivityInput) =>
      call((s) => s.activity(input)),
    [PAGE_SHARING_WS_METHODS.reply]: (input: PageShareReplyInput) => call((s) => s.reply(input)),
    [PAGE_SHARING_WS_METHODS.sitesList]: (input: PageSitesListInput) =>
      call((s) => s.sitesList(input)),
    [PAGE_SHARING_WS_METHODS.siteForPage]: (input: PageSiteForPageInput) =>
      call((s) => s.siteForPage(input)),
    [PAGE_SHARING_WS_METHODS.siteMutate]: (input: PageSiteMutateInput) =>
      call((s) => s.siteMutate(input)),
  } as const;
};
