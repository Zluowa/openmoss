// FILE: ChatArtifactCards.tsx
// Purpose: The cards an answer shows for what the agent made: a slides deck (opens in the deck
//          editor beside the chat) and an exported file (打开 in the side panel, 另存为).
//          Replaces the plain download link the agent used to paste.
// Layer: Chat transcript UI
// Exports: ChatArtifactCards, ChatDeckCard, ChatOutputFileCard, openDeckInSidePanel

import type { PageAppArtifact, SlidesDeckArtifact } from "@moss/shared/chatArtifactActivity";
import { formatBytes } from "@moss/shared/formatBytes";
import { threadOutputHref } from "@moss/shared/threadWorkspace";
import type { ThreadId } from "@moss/contracts";
import type { ReactNode } from "react";

import { basenameOfPath } from "~/file-icons";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { visibleChatArtifacts, type TurnChatArtifact } from "~/lib/chatArtifacts";
import { SlideDeckIcon, WindowAppIcon } from "~/lib/icons";
import { useIsSharedViewer } from "~/lib/sharedViewer";
import { cn } from "~/lib/utils";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { useTranslation } from "~/localization";
import { useRightDockStore } from "~/rightDockStore";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { FileEntryIcon } from "./FileEntryIcon";

const CARD_CLASS_NAME =
  "flex w-full max-w-[26rem] min-w-0 items-center gap-2.5 rounded-card border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] p-2 text-left";
const TILE_CLASS_NAME =
  "flex size-9 shrink-0 items-center justify-center rounded-control bg-[var(--color-background-elevated-secondary)] text-muted-foreground";
// Two weights only in reply visuals: the name is medium, everything else normal.
const NAME_CLASS_NAME = "truncate text-ui font-medium text-foreground";
const DETAIL_CLASS_NAME = "truncate text-ui-sm text-muted-foreground";

/** Shows a deck in the deck editor beside the chat (one deck pane per conversation). */
export function openDeckInSidePanel(
  threadId: string,
  deck: Pick<SlidesDeckArtifact, "pageId" | "scopeSpaceId" | "title">,
): void {
  useRightDockStore.getState().openPane(threadId as ThreadId, {
    kind: "deck",
    deck: { pageId: deck.pageId, scopeSpaceId: deck.scopeSpaceId, title: deck.title },
  });
}

/** Shows an 应用页 in the right-hand side panel beside the chat. */
export function openPageAppInSidePanel(
  threadId: string,
  pageApp: Pick<PageAppArtifact, "appId" | "title">,
): void {
  useRightDockStore.getState().openPane(threadId as ThreadId, {
    kind: "pageApp",
    pageApp: { appId: pageApp.appId, title: pageApp.title },
  });
}

function ChatSidePanelArtifactCard(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  threadId: string | undefined;
  sharedViewer: boolean;
  ariaLabel: string;
  openLabel: string;
  dataAttributes: Record<string, string>;
  onOpen: () => void;
}) {
  const body = (
    <>
      <span className={TILE_CLASS_NAME} aria-hidden>
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className={NAME_CLASS_NAME}>{props.title}</span>
        <span className={DETAIL_CLASS_NAME}>{props.detail}</span>
      </span>
    </>
  );
  if (props.sharedViewer || !props.threadId) {
    return (
      <span className={CARD_CLASS_NAME} {...props.dataAttributes}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        CARD_CLASS_NAME,
        "group/deck-card cursor-interaction transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-text-foreground)_3.5%,var(--color-background-elevated-primary))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
      )}
      {...props.dataAttributes}
      aria-label={props.ariaLabel}
      onClick={props.onOpen}
    >
      {body}
      <span
        aria-hidden
        className="inline-flex h-6 shrink-0 items-center rounded-control bg-[color-mix(in_srgb,var(--color-text-foreground)_5%,transparent)] px-2 text-ui font-medium text-foreground group-hover/deck-card:bg-[color-mix(in_srgb,var(--color-text-foreground)_10%,transparent)]"
      >
        {props.openLabel}
      </span>
    </button>
  );
}

export function ChatPageAppCard(props: { pageApp: PageAppArtifact; threadId: string | undefined }) {
  const { t, format } = useTranslation();
  const sharedViewer = useIsSharedViewer();
  const { pageApp } = props;
  const detail = [t("chat.artifact.pageApp.kind"), `v${pageApp.revision}`, pageApp.description]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <ChatSidePanelArtifactCard
      icon={<WindowAppIcon className="size-4" />}
      title={pageApp.title}
      detail={detail}
      threadId={props.threadId}
      sharedViewer={sharedViewer}
      ariaLabel={format("chat.artifact.pageApp.openLabel", { title: pageApp.title })}
      openLabel={t("chat.artifact.pageApp.open")}
      dataAttributes={{ "data-chat-page-app-card": pageApp.appId }}
      onOpen={() => {
        if (props.threadId) openPageAppInSidePanel(props.threadId, pageApp);
      }}
    />
  );
}

export function ChatDeckCard(props: { deck: SlidesDeckArtifact; threadId: string | undefined }) {
  const { t, format } = useTranslation();
  const sharedViewer = useIsSharedViewer();
  const { deck } = props;
  const detail = [
    t("chat.artifact.deck.kind"),
    format("chat.artifact.deck.slideCount", { count: deck.slideCount }),
    deck.change === "proposed" ? t("chat.artifact.deck.proposed") : deck.coverText,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <ChatSidePanelArtifactCard
      icon={<SlideDeckIcon className="size-4" />}
      title={deck.title}
      detail={detail}
      threadId={props.threadId}
      sharedViewer={sharedViewer}
      ariaLabel={format("chat.artifact.deck.openLabel", { title: deck.title })}
      openLabel={t("chat.artifact.deck.open")}
      dataAttributes={{ "data-chat-deck-card": deck.pageId }}
      onOpen={() => {
        if (props.threadId) openDeckInSidePanel(props.threadId, deck);
      }}
    />
  );
}

function fileTypeLabel(name: string): string | null {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(name)?.[1];
  return extension ? extension.toUpperCase() : null;
}

/**
 * One exported file. 打开 shows it in the side panel's file viewer (PowerPoint, Excel, Word
 * and PDF render there); 另存为 downloads it through the app, which asks where to save.
 */
export function ChatOutputFileCard(props: {
  /** The conversation the file belongs to; its download link is scoped to it. */
  threadId: string;
  /** Workspace-relative path, as the download link names it. */
  file: string;
  name?: string | undefined;
  /** Absolute path on this device when known; opens more reliably than the relative path. */
  path?: string | null | undefined;
  bytes?: number | null | undefined;
  sha256?: string | null | undefined;
  className?: string | undefined;
}) {
  const { t, format } = useTranslation();
  const opener = useWorkspaceFileOpener();
  const sharedViewer = useIsSharedViewer();
  const name = props.name ?? basenameOfPath(props.file);
  const detail = [
    fileTypeLabel(name),
    props.bytes != null && props.bytes > 0 ? formatBytes(props.bytes) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const href = threadOutputHref(props.threadId, props.file, props.sha256 ?? undefined);
  return (
    <span
      className={cn(CARD_CLASS_NAME, "my-1", props.className)}
      data-chat-file-card={props.file}
      title={name}
    >
      <span className={TILE_CLASS_NAME} aria-hidden>
        <FileEntryIcon pathValue={name} kind="file" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className={NAME_CLASS_NAME}>{name}</span>
        {detail ? <span className={DETAIL_CLASS_NAME}>{detail}</span> : null}
      </span>
      {sharedViewer ? null : (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            aria-label={format("chat.artifact.file.openLabel", { name })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openWorkspaceFileReference(opener, props.path ?? props.file);
            }}
          >
            {t("chat.artifact.file.open")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={format("chat.artifact.file.saveAsLabel", { name })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void downloadUrlAsBlob({ url: resolveWsHttpUrl(href), filename: name }).catch(() =>
                toastManager.add({
                  type: "error",
                  title: t("chat.artifact.file.saveFailed"),
                  description: t("chat.artifact.file.retry"),
                }),
              );
            }}
          >
            {t("chat.artifact.file.saveAs")}
          </Button>
        </span>
      )}
    </span>
  );
}

/** The cards under a turn's answer, minus files the answer already shows as cards in its text. */
export function ChatArtifactCards(props: {
  artifacts: ReadonlyArray<TurnChatArtifact> | undefined;
  answerMarkdown: string;
  threadId: string | undefined;
}) {
  const { t } = useTranslation();
  const visible = visibleChatArtifacts(props.artifacts, props.answerMarkdown);
  if (visible.length === 0) return null;
  return (
    <div
      className="mt-2 flex flex-col gap-1.5"
      role="group"
      aria-label={t("chat.artifact.region")}
      data-chat-artifact-cards=""
    >
      {visible.map(({ id, artifact }) =>
        artifact.kind === "deck" ? (
          <ChatDeckCard key={id} deck={artifact.deck} threadId={props.threadId} />
        ) : artifact.kind === "pageApp" ? (
          <ChatPageAppCard key={id} pageApp={artifact.pageApp} threadId={props.threadId} />
        ) : props.threadId ? (
          <ChatOutputFileCard
            key={id}
            className="my-0"
            threadId={props.threadId}
            file={artifact.file.file}
            name={artifact.file.name}
            path={artifact.file.path}
            bytes={artifact.file.bytes}
            sha256={artifact.file.sha256}
          />
        ) : null,
      )}
    </div>
  );
}
