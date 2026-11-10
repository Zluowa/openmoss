// FILE: pageSharing.logic.ts
// Purpose: Query keys, labels and error wording for 资料空间 sharing and 站点.
// Layer: Space sharing (owned by sharing)

import type {
  PageGuestComment,
  PageShareEventAction,
  PageShareLinkAccess,
  PageShareRelayStatus,
  PageShareRole,
  PageShareTarget,
  PageSiteVisibility,
  SpaceId,
} from "@moss/contracts";
import type { useTranslation } from "~/localization";

/** One identity label for comments shown in the share dialog and the page's combined feed. */
export function guestCommentAuthorLabel(
  comment: Pick<PageGuestComment, "authorKind" | "authorName">,
  translation: ReturnType<typeof useTranslation>,
) {
  if (comment.authorKind === "owner") return translation.t("page.comments.you");
  return translation.format(
    comment.authorKind === "member" ? "page.comments.member" : "page.comments.guest",
    { name: comment.authorName },
  );
}

export const pageSharingQueryKeys = {
  all: (account: string, scopeSpaceId: SpaceId | null) =>
    ["pageSharing", account, scopeSpaceId] as const,
  state: (account: string, scopeSpaceId: SpaceId | null, target: PageShareTarget) =>
    [...pageSharingQueryKeys.all(account, scopeSpaceId), "state", target.kind, target.id] as const,
  activity: (account: string, scopeSpaceId: SpaceId | null, pageId: string) =>
    [...pageSharingQueryKeys.all(account, scopeSpaceId), "activity", pageId] as const,
  sites: (account: string, scopeSpaceId: SpaceId | null) =>
    [...pageSharingQueryKeys.all(account, scopeSpaceId), "sites"] as const,
  siteForPage: (account: string, scopeSpaceId: SpaceId | null, pageId: string) =>
    [...pageSharingQueryKeys.all(account, scopeSpaceId), "site", pageId] as const,
};

export const LINK_ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: PageShareLinkAccess;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "invited", label: "仅限受邀者", hint: "只有你邀请的人能打开" },
  { value: "link", label: "有链接的人", hint: "拿到链接的人都能打开" },
  { value: "anyone", label: "所有人", hint: "不需要链接里的密钥，知道地址就能打开" },
];

export const ROLE_OPTIONS: ReadonlyArray<{
  readonly value: PageShareRole;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "view", label: "查看", hint: "只能阅读" },
  { value: "comment", label: "评论", hint: "可以阅读和评论" },
  { value: "edit", label: "编辑", hint: "可以评论；网页端暂不能直接改正文" },
];

export const SITE_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: PageSiteVisibility;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "private", label: "仅自己可见", hint: "只在你的 Moss 里打开" },
  { value: "link", label: "有链接", hint: "拿到链接的人可以访问" },
  { value: "anyone", label: "所有人", hint: "任何知道地址的人都能访问" },
];

export const linkAccessLabel = (value: PageShareLinkAccess) =>
  LINK_ACCESS_OPTIONS.find((option) => option.value === value)?.label ?? value;
export const roleLabel = (value: PageShareRole) =>
  ROLE_OPTIONS.find((option) => option.value === value)?.label ?? value;
export const siteVisibilityLabel = (value: PageSiteVisibility) =>
  SITE_VISIBILITY_OPTIONS.find((option) => option.value === value)?.label ?? value;

export const RELAY_STATUS_LABELS: Record<PageShareRelayStatus, string> = {
  online: "分享服务已连接",
  connecting: "正在连接分享服务…",
  offline: "分享服务暂时断开，Moss 会自动重连",
  unavailable: "登录 Moss 账号后才能生成链接",
};

const EVENT_LABELS: Record<PageShareEventAction, string> = {
  opened: "打开了页面",
  commented: "发表了评论",
  requested: "申请了访问权限",
  approved: "批准了访问请求",
  rejected: "拒绝了访问请求",
  invited: "邀请了成员",
  "member-changed": "修改了成员权限",
  "member-removed": "移除了成员",
  "link-changed": "修改了链接访问权限",
  "link-rotated": "更换了分享链接",
  published: "发布了站点",
  unpublished: "取消发布了站点",
  "visibility-changed": "修改了站点可见性",
};
export const eventLabel = (action: PageShareEventAction) => EVENT_LABELS[action];

export function actorLabel(event: {
  readonly actorKind: "owner" | "member" | "guest" | "visitor";
  readonly actorName: string | null;
}): string {
  if (event.actorKind === "owner") return "你";
  if (event.actorName) return event.actorName;
  return "访客";
}

const ERROR_FALLBACK = "操作没有完成，请重试。";

/** The server words every refusal in Chinese; anything else gets a generic line. */
export function describePageSharingError(error: unknown): {
  readonly code: string | null;
  readonly message: string;
} {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const { code, message } = error as { code: unknown; message: unknown };
    if (typeof code === "string" && typeof message === "string" && message.length > 0) {
      return { code, message };
    }
  }
  return { code: null, message: ERROR_FALLBACK };
}

/** "3 分钟前", "昨天", or a date, for list rows. */
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  if (hours < 48) return "昨天";
  const date = new Date(then);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
