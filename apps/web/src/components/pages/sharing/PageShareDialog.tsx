// FILE: PageShareDialog.tsx
// Purpose: The 分享 dialog of a 资料空间 page: invite people, link access and roles (inherited
//          from the space, raised per page), access requests, copy and rotate the link, publish
//          the page as a 站点, and see who opened or commented.
// Layer: Space sharing (owned by sharing); opened from the page top bar's 分享 slot
// Depends on: pageSharing.* RPCs through ensurePageSharingApi

import {
  PAGE_SHARE_ACCESS_RANK,
  PAGE_SHARE_ROLE_RANK,
  type Page,
  type PageShareLinkSetting,
  type PageShareMutateInput,
  type PageShareRole,
  type PageShareState,
  type PageShareTarget,
  type SpaceId,
} from "@moss/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon, GlobeIcon, LinkIcon, LockIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensurePageSharingApi } from "~/nativeApi";
import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { IconButton } from "../../ui/icon-button";
import { Input } from "../../ui/input";
import { StatusDot } from "../../ui/status-chip";
import { toastManager } from "../../ui/toast";
import { PageShareActivity } from "./PageShareActivity";
import { PagePublishPanel } from "./PagePublishPanel";
import { PagePublishedAppsPanel } from "./PagePublishedAppsPanel";
import {
  LINK_ACCESS_OPTIONS,
  RELAY_STATUS_LABELS,
  ROLE_OPTIONS,
  describePageSharingError,
  linkAccessLabel,
  pageSharingQueryKeys,
  roleLabel,
} from "./pageSharing.logic";
import { ShareSelect } from "./ShareSelect";

export type PageShareTab = "share" | "publish" | "activity";

export interface PageShareDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly page: Page;
  /** Saves pending editor changes before a publish freezes the page. */
  readonly flush?: () => Promise<boolean>;
  readonly initialTab?: PageShareTab;
}

export function PageShareDialog(props: PageShareDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg" showCloseButton>
        {/* Popup children unmount after the close transition, so each open starts fresh. */}
        <PageShareDialogContent {...props} />
      </DialogPopup>
    </Dialog>
  );
}

const TABS: ReadonlyArray<{ readonly id: PageShareTab; readonly label: string }> = [
  { id: "share", label: "分享" },
  { id: "publish", label: "发布" },
  { id: "activity", label: "动态" },
];

function PageShareDialogContent(props: PageShareDialogProps) {
  const [tab, setTab] = useState<PageShareTab>(props.initialTab ?? "share");
  const [target, setTarget] = useState<PageShareTarget>({ kind: "page", id: props.page.id });
  return (
    <div className="flex max-h-[min(640px,85vh)] flex-col">
      <div className="px-5 pt-5">
        <DialogTitle className="truncate pr-8">分享“{props.page.title}”</DialogTitle>
        <div
          role="tablist"
          aria-label="分享选项"
          className="mt-3 flex gap-1 border-b border-border"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={cn(
                "-mb-px border-b-2 px-2.5 pb-2 text-ui-sm outline-none focus-visible:text-foreground",
                tab === item.id
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === "share" ? (
          <ShareTab {...props} target={target} onTargetChange={setTarget} />
        ) : tab === "publish" ? (
          <PagePublishPanel
            account={props.account}
            scopeSpaceId={props.scopeSpaceId}
            page={props.page}
            {...(props.flush ? { flush: props.flush } : {})}
          />
        ) : (
          <PageShareActivity
            account={props.account}
            scopeSpaceId={props.scopeSpaceId}
            pageId={props.page.id}
          />
        )}
      </div>
    </div>
  );
}

function ShareTab(
  props: PageShareDialogProps & {
    readonly target: PageShareTarget;
    readonly onTargetChange: (target: PageShareTarget) => void;
  },
) {
  const { account, scopeSpaceId, target } = props;
  const client = useQueryClient();
  const queryKey = pageSharingQueryKeys.state(account, scopeSpaceId, target);
  const state = useQuery({
    queryKey,
    queryFn: () => ensurePageSharingApi().get({ scopeSpaceId, target }),
    // The relay status and new access requests show up without reopening the dialog.
    refetchInterval: 10_000,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mutate = async (input: PageShareMutateInput): Promise<PageShareState | null> => {
    setBusy(true);
    setError(null);
    try {
      const next = await ensurePageSharingApi().mutate(input);
      client.setQueryData(queryKey, next);
      return next;
    } catch (cause) {
      const described = describePageSharingError(cause);
      setError(described.message);
      if (described.code === "conflict") void state.refetch();
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (state.isPending) {
    return (
      <p role="status" className="py-6 text-center text-ui-sm text-muted-foreground">
        正在读取分享设置…
      </p>
    );
  }
  if (state.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 py-6 text-ui-sm text-destructive">
        <span>{describePageSharingError(state.error).message}</span>
        <Button size="xs" variant="outline" onClick={() => void state.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  const share = state.data;
  const base = { scopeSpaceId, target } as const;
  const spaceId = props.page.spaceId;

  return (
    <div className="flex flex-col gap-5">
      {target.kind === "space" ? (
        <TargetSwitch
          label={`正在分享整个资料空间“${share.title}”，其中所有页面都会一起分享。`}
          action="只分享这个页面"
          onClick={() => props.onTargetChange({ kind: "page", id: props.page.id })}
        />
      ) : spaceId !== null && share.inheritedFrom ? (
        <TargetSwitch
          label={`这个页面在资料空间“${share.inheritedFrom.title}”中。`}
          action="分享整个资料空间"
          onClick={() => props.onTargetChange({ kind: "space", id: spaceId })}
        />
      ) : null}

      <InviteRow
        disabled={busy}
        onInvite={(name, role) => mutate({ op: "invite", ...base, name, role })}
      />

      {share.requests.length > 0 ? (
        <Section title={`访问请求（${share.requests.length}）`}>
          {share.requests.map((request) => (
            <AccessRequestRow
              key={request.id}
              name={request.name}
              note={request.note}
              role={request.role}
              disabled={busy}
              onDecide={(decision, role) =>
                void mutate({
                  op: "decide-request",
                  ...base,
                  requestId: request.id,
                  decision,
                  role,
                })
              }
            />
          ))}
        </Section>
      ) : null}

      <Section title="有访问权限的人">
        <PersonRow name="你" detail="所有者" />
        {share.members.map((member) => (
          <PersonRow
            key={member.id}
            name={member.name}
            detail={
              member.source === "space" && target.kind === "page" ? "来自资料空间" : member.contact
            }
            url={member.url}
          >
            {member.source === "space" && target.kind === "page" ? (
              <span className="px-2 text-ui-sm text-muted-foreground">
                {roleLabel(member.role)}
              </span>
            ) : (
              <ShareSelect
                label={`${member.name}的权限`}
                value={member.role as PageShareRole | "remove"}
                options={[...ROLE_OPTIONS, { value: "remove" as const, label: "移除" }]}
                disabled={busy}
                onChange={(value) =>
                  void mutate({
                    op: "set-member",
                    ...base,
                    memberId: member.id,
                    role: value === "remove" ? null : value,
                  })
                }
              />
            )}
          </PersonRow>
        ))}
      </Section>

      <Section title="一般访问">
        <LinkAccessEditor
          share={share}
          disabled={busy}
          onChange={(setting) =>
            mutate({ op: "set-link", ...base, expectedVersion: share.version, setting })
          }
        />
      </Section>

      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}

      {share.appPublicationEntryId && (props.page.kind ?? "page") === "page" ? (
        <PagePublishedAppsPanel
          account={account}
          scopeSpaceId={scopeSpaceId}
          pageId={props.page.id}
          pageRevision={props.page.revision}
          entry={{ kind: "link", id: share.appPublicationEntryId }}
          policyVersion={JSON.stringify([share.version, share.effective, share.inheritedFrom])}
        />
      ) : null}
      <LinkFooter
        share={share}
        disabled={busy}
        onRotate={() => mutate({ op: "rotate-link", ...base, expectedVersion: share.version })}
      />
    </div>
  );
}

function TargetSwitch(props: { label: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-card bg-muted/60 px-3 py-2 text-ui-sm text-muted-foreground">
      <span className="min-w-0">{props.label}</span>
      <Button size="xs" variant="ghost" className="shrink-0" onClick={props.onClick}>
        {props.action}
      </Button>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-ui-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Initial(props: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-ui-xs font-medium text-foreground"
    >
      {Array.from(props.name)[0] ?? "?"}
    </span>
  );
}

function PersonRow(props: {
  name: string;
  detail?: string | null;
  url?: string | null;
  children?: ReactNode;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "已复制个人链接，发给对方即可打开" }),
    onError: () => toastManager.add({ type: "error", title: "无法复制链接" }),
  });
  return (
    <div className="flex min-h-10 items-center gap-2.5">
      <Initial name={props.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-foreground">{props.name}</div>
        {props.detail ? (
          <div className="truncate text-ui-xs text-muted-foreground">{props.detail}</div>
        ) : null}
      </div>
      {props.url ? (
        <IconButton label="复制个人链接" onClick={() => copyToClipboard(props.url!)}>
          {isCopied ? <CheckIcon /> : <LinkIcon />}
        </IconButton>
      ) : null}
      {props.children}
    </div>
  );
}

function InviteRow(props: {
  disabled: boolean;
  onInvite: (name: string, role: PageShareRole) => Promise<PageShareState | null>;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<PageShareRole>("comment");
  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const next = await props.onInvite(trimmed, role);
    if (next === null) return;
    setName("");
    const member = next.members.findLast((item) => item.name === trimmed);
    if (member?.url) {
      await navigator.clipboard?.writeText(member.url).catch(() => undefined);
      toastManager.add({ type: "success", title: `已邀请${trimmed}，个人链接已复制` });
    } else {
      toastManager.add({ type: "success", title: `已邀请${trimmed}` });
    }
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        size="sm"
        aria-label="邀请的人"
        placeholder="输入名字，邀请协作者"
        maxLength={60}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="min-w-0 flex-1"
      />
      <ShareSelect
        label="被邀请者的权限"
        value={role}
        options={ROLE_OPTIONS}
        onChange={setRole}
        variant="default"
      />
      <Button type="submit" size="sm" disabled={props.disabled || name.trim() === ""}>
        邀请
      </Button>
    </form>
  );
}

function AccessRequestRow(props: {
  name: string;
  note: string | null;
  role: PageShareRole;
  disabled: boolean;
  onDecide: (decision: "approve" | "reject", role: PageShareRole) => void;
}) {
  const [role, setRole] = useState(props.role);
  return (
    <div className="flex min-h-10 items-center gap-2.5">
      <Initial name={props.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-foreground">{props.name}</div>
        <div className="truncate text-ui-xs text-muted-foreground">
          {props.note ?? `请求${roleLabel(props.role)}权限`}
        </div>
      </div>
      <ShareSelect
        label={`给${props.name}的权限`}
        value={role}
        options={ROLE_OPTIONS}
        onChange={setRole}
      />
      <Button
        size="xs"
        variant="ghost"
        disabled={props.disabled}
        onClick={() => props.onDecide("reject", role)}
      >
        拒绝
      </Button>
      <Button size="xs" disabled={props.disabled} onClick={() => props.onDecide("approve", role)}>
        批准
      </Button>
    </div>
  );
}

const ACCESS_ICON = { invited: LockIcon, link: LinkIcon, anyone: GlobeIcon } as const;

function LinkAccessEditor(props: {
  share: PageShareState;
  disabled: boolean;
  onChange: (setting: PageShareLinkSetting | null) => void;
}) {
  const { share } = props;
  const inherited = share.inheritedFrom?.setting ?? null;
  const effective = share.effective;
  const Icon = ACCESS_ICON[effective.access];
  // A page can open further than its space, never less: offer only what keeps that true.
  const accessOptions = LINK_ACCESS_OPTIONS.filter(
    (option) =>
      inherited === null ||
      PAGE_SHARE_ACCESS_RANK[option.value] >= PAGE_SHARE_ACCESS_RANK[inherited.access],
  );
  const roleOptions = ROLE_OPTIONS.filter(
    (option) =>
      inherited === null ||
      inherited.access === "invited" ||
      PAGE_SHARE_ROLE_RANK[option.value] >= PAGE_SHARE_ROLE_RANK[inherited.role],
  );
  const set = (next: Partial<PageShareLinkSetting>) => props.onChange({ ...effective, ...next });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-10 items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <ShareSelect
            label="谁可以通过链接打开"
            value={effective.access}
            options={accessOptions}
            disabled={props.disabled}
            onChange={(access) => set({ access })}
            className="-ml-2 w-auto"
          />
          <div className="text-ui-xs text-muted-foreground">
            {LINK_ACCESS_OPTIONS.find((option) => option.value === effective.access)?.hint}
          </div>
        </div>
        {effective.access === "invited" ? null : (
          <ShareSelect
            label="通过链接打开的人的权限"
            value={effective.role}
            options={roleOptions}
            disabled={props.disabled}
            onChange={(role) => set({ role })}
          />
        )}
      </div>
      {share.inheritedFrom ? (
        <div className="flex items-center justify-between gap-2 text-ui-xs text-muted-foreground">
          <span className="min-w-0">
            {share.direct === null
              ? `访问权限继承自资料空间“${share.inheritedFrom.title}”`
              : `资料空间“${share.inheritedFrom.title}”：${linkAccessLabel(share.inheritedFrom.setting.access)}，本页设置更开放`}
          </span>
          {share.direct !== null ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.disabled}
              onClick={() => props.onChange(null)}
            >
              使用资料空间的访问权限
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LinkFooter(props: {
  share: PageShareState;
  disabled: boolean;
  onRotate: () => Promise<PageShareState | null>;
}) {
  const { share } = props;
  const [confirmRotate, setConfirmRotate] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => toastManager.add({ type: "error", title: "无法复制链接" }),
  });
  const tone =
    share.relayStatus === "online"
      ? "bg-success"
      : share.relayStatus === "connecting"
        ? "bg-warning"
        : "bg-muted-foreground/50";
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      {confirmRotate ? (
        <div className="flex items-center justify-between gap-2 text-ui-sm">
          <span className="text-muted-foreground">旧链接会立即失效，已邀请的人不受影响。</span>
          <div className="flex shrink-0 gap-1">
            <Button size="xs" variant="ghost" onClick={() => setConfirmRotate(false)}>
              取消
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={props.disabled}
              onClick={() =>
                void props.onRotate().then((next) => {
                  setConfirmRotate(false);
                  if (next) toastManager.add({ type: "success", title: "已更换链接" });
                })
              }
            >
              更换链接
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ui-xs text-muted-foreground">
          <StatusDot className={tone} pulse={share.relayStatus === "connecting"} />
          <span className="truncate">{RELAY_STATUS_LABELS[share.relayStatus]}</span>
        </span>
        <IconButton
          label="更换链接"
          tooltip="更换链接"
          disabled={props.disabled || share.linkUrl === null}
          onClick={() => setConfirmRotate(true)}
        >
          <RefreshCwIcon />
        </IconButton>
        <Button
          size="sm"
          variant="outline"
          disabled={share.linkUrl === null}
          onClick={() => {
            if (share.linkUrl) copyToClipboard(share.linkUrl);
          }}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "已复制" : "复制链接"}
        </Button>
      </div>
      {share.effective.access === "invited" && share.linkUrl !== null ? (
        <p className="text-ui-xs text-muted-foreground">
          仅限受邀者时，其他人打开链接只能申请访问，你批准后才能查看。
        </p>
      ) : null}
    </div>
  );
}
