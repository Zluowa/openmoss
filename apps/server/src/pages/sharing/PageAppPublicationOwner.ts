import {
  PageAppId,
  type PageShareAppPublicationsInput,
  type PageShareAppPublicationsResult,
} from "@moss/contracts";
import { type PageRichNode, parsePageRichContent } from "@moss/shared/pageRichContent";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { PagesPrincipal } from "../Services/PagesService.ts";
import { AppPublicationFailure, makePageAppPublications } from "./pageAppPublications.ts";
import {
  PageSharingService,
  pageSharingError,
  type PageSharingError,
} from "./PageSharingService.ts";
import { scopeKey } from "./pageSharingStore.ts";

type AppReference = {
  nodePath: number[];
  appId: PageAppId;
  pinned: number | null;
  invalidRevision: boolean;
};
/** Traverse real elements only. A text leaf's arbitrary attributes cannot put an app on the confirmation list. */
function references(body: string | null): AppReference[] {
  if (!body) return [];
  const refs: AppReference[] = [];
  const visit = (nodes: readonly PageRichNode[], parent: readonly number[]) => {
    for (const [index, node] of nodes.entries()) {
      if (typeof node.text === "string" || !Array.isArray(node.children)) continue;
      const nodePath = [...parent, index];
      if (nodePath.length > 64) continue;
      if (node.type === "moss_visualization") {
        const appId = Schema.decodeUnknownOption(PageAppId)(node.appPageId);
        if (Option.isSome(appId))
          refs.push({
            nodePath,
            appId: appId.value,
            pinned: typeof node.appRevision === "number" ? node.appRevision : null,
            invalidRevision:
              node.appRevision !== undefined &&
              !(
                typeof node.appRevision === "number" &&
                Number.isSafeInteger(node.appRevision) &&
                node.appRevision > 0
              ),
          });
      }
      visit(node.children, nodePath);
    }
  };
  visit(parsePageRichContent(body).nodes, []);
  return refs;
}
type Manage = (
  input: PageShareAppPublicationsInput,
  principal: PagesPrincipal,
) => Effect.Effect<PageShareAppPublicationsResult, PageSharingError>;
export class PageAppPublicationOwner extends ServiceMap.Service<
  PageAppPublicationOwner,
  { manage: Manage }
>()("moss/pages/PageAppPublicationOwner") {}
export const makePageAppPublicationOwner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sharing = yield* PageSharingService;
  const publications = yield* makePageAppPublications;
  const manage: Manage = (input, principal) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (principal.kind !== "local-user")
            return yield* pageSharingError("invalid", "只有本机所有者可以管理应用预览。");
          const host = yield* sharing
            .resolveOwnerAppHostPage(input.entry, input.pageId, input.pageRevision, principal)
            .pipe(
              Effect.mapError(() =>
                pageSharingError("conflict", "分享页面或版本已变化，请刷新后重试。"),
              ),
            );
          if (host.scopeSpaceId !== input.scopeSpaceId)
            return yield* pageSharingError("not-found", "找不到该分享页面。");
          const refs = yield* Effect.try({
            try: () => references(host.richContent),
            catch: () => pageSharingError("invalid", "无法读取页面中的应用。"),
          });
          let offset = input.op === "list" ? input.offset : 0;
          if (input.op !== "list") {
            const index = refs.findIndex(
              (ref) => JSON.stringify(ref.nodePath) === JSON.stringify(input.nodePath),
            );
            if (index < 0) return yield* pageSharingError("conflict", "页面中的应用引用已变化。");
            offset = Math.floor(index / 16) * 16;
            if (input.op === "publish") yield* publications.publish(input, principal);
            else yield* publications.revoke(input, input.expectedGeneration, principal);
          }
          const items: Array<PageShareAppPublicationsResult["items"][number]> = [];
          for (const ref of refs.slice(offset, offset + 16)) {
            const key = JSON.stringify(ref.nodePath);
            const [app] = ref.invalidRevision
              ? []
              : yield* sql<{ revision: number; title: string }>`SELECT v.revision,v.title
        FROM page_apps a JOIN page_app_versions v ON v.app_id=a.app_id AND v.revision=COALESCE(${ref.pinned},a.revision)
        WHERE a.app_id=${ref.appId} AND a.scope_key=${scopeKey(host.scopeSpaceId)} AND a.space_id IS ${host.spaceId} AND a.trashed_at IS NULL`;
            const [slot] = yield* sql<{
              generation: number;
              confirmed_revision: number | null;
            }>`SELECT s.generation,
        CASE WHEN p.app_id=${ref.appId} AND p.page_revision=${host.pageRevision} AND p.policy_stamp=${host.policyStamp}
          THEN p.app_revision ELSE NULL END AS confirmed_revision FROM page_app_publication_slots s
        LEFT JOIN page_app_publications p ON p.entry_kind=s.entry_kind AND p.entry_id=s.entry_id AND p.page_id=s.page_id AND p.node_path=s.node_path
        WHERE s.entry_kind=${host.entry.kind} AND s.entry_id=${host.entry.id} AND s.page_id=${host.pageId} AND s.node_path=${key}`;
            items.push({
              nodePath: ref.nodePath,
              appId: ref.appId,
              revision: app?.revision ?? null,
              title: app?.title ?? null,
              generation: slot?.generation ?? 0,
              confirmedRevision: slot?.confirmed_revision ?? null,
            });
          }
          return { items, nextOffset: offset + 16 < refs.length ? offset + 16 : null };
        }),
      )
      .pipe(
        Effect.mapError((cause) => {
          if (cause._tag === "PageSharingError") return cause;
          if (cause instanceof AppPublicationFailure && cause.reason === "conflict")
            return pageSharingError("conflict", "发布状态已改变，请刷新后重试。");
          return pageSharingError("storage", "应用预览未更新，请检查引用、版本和分享状态后重试。");
        }),
      );
  return { manage };
});
export const PageAppPublicationOwnerLive = Layer.effect(
  PageAppPublicationOwner,
  makePageAppPublicationOwner,
);
