/**
 * The access rules, kept free of storage so they can be tested on their own.
 *
 * - A page inherits its space's link access. Its own setting can open it further (a wider
 *   audience or a stronger role) but never narrow it: anyone who can open the space can open
 *   every page in it, so a page-level "only invited" would be a promise Moss cannot keep.
 * - A member invited to a space is a member of every page in it; the stronger role wins.
 */
import {
  DEFAULT_PAGE_SHARE_LINK_SETTING,
  PAGE_SHARE_ACCESS_RANK,
  PAGE_SHARE_ROLE_RANK,
  type PageShareLinkAccess,
  type PageShareLinkSetting,
  type PageShareRole,
} from "@moss/contracts";

export const strongerRole = (a: PageShareRole, b: PageShareRole): PageShareRole =>
  PAGE_SHARE_ROLE_RANK[a] >= PAGE_SHARE_ROLE_RANK[b] ? a : b;

const widerAccess = (a: PageShareLinkAccess, b: PageShareLinkAccess): PageShareLinkAccess =>
  PAGE_SHARE_ACCESS_RANK[a] >= PAGE_SHARE_ACCESS_RANK[b] ? a : b;

export function effectiveLinkSetting(
  direct: PageShareLinkSetting | null,
  inherited: PageShareLinkSetting | null,
): PageShareLinkSetting {
  if (direct === null) return inherited ?? DEFAULT_PAGE_SHARE_LINK_SETTING;
  if (inherited === null) return direct;
  // An inherited "only invited" does not raise the role of a page's own link.
  if (inherited.access === "invited") return direct;
  return {
    access: widerAccess(direct.access, inherited.access),
    role: direct.access === "invited" ? inherited.role : strongerRole(direct.role, inherited.role),
  };
}

/** A page setting that changes nothing over what the space already grants. */
export function isRedundantPageSetting(
  setting: PageShareLinkSetting,
  inherited: PageShareLinkSetting | null,
): boolean {
  const base = inherited ?? DEFAULT_PAGE_SHARE_LINK_SETTING;
  const effective = effectiveLinkSetting(setting, inherited);
  return effective.access === base.access && effective.role === base.role;
}

export type LinkEntryDecision =
  | { readonly ok: true; readonly role: PageShareRole }
  | { readonly ok: false; readonly reason: "invite-only" | "forbidden" };

/**
 * Whether a link holder gets in. `credentialValid` is null when the request carried no
 * credential for this link.
 */
export function decideLinkEntry(
  setting: PageShareLinkSetting,
  credentialValid: boolean | null,
): LinkEntryDecision {
  switch (setting.access) {
    case "anyone":
      return { ok: true, role: setting.role };
    case "link":
      if (credentialValid === true) return { ok: true, role: setting.role };
      return credentialValid === false
        ? { ok: false, reason: "forbidden" }
        : { ok: false, reason: "invite-only" };
    case "invited":
      return { ok: false, reason: "invite-only" };
  }
}

/** The page ids under `rootId` (itself included), following parent links in `pages`. */
export function descendantPageIds(
  rootId: string,
  pages: ReadonlyArray<{ readonly id: string; readonly parentPageId: string | null }>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const page of pages) {
    if (page.parentPageId === null) continue;
    const list = children.get(page.parentPageId) ?? [];
    list.push(page.id);
    children.set(page.parentPageId, list);
  }
  const result = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const next = queue.pop()!;
    for (const child of children.get(next) ?? []) {
      if (result.has(child)) continue;
      result.add(child);
      queue.push(child);
    }
  }
  return result;
}
