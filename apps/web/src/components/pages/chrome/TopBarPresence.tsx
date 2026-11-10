// FILE: TopBarPresence.tsx
// Purpose: Who else is on this page right now, and whether this window is offline.
// Layer: Space page chrome slot, first part of `topBarRight` — owned by collab.
// Renders nothing until the page's live editor reports presence. Other windows are colored
// initials, an agent that is writing is the Moss agent glyph, and offline is one muted cloud icon
// with the details in its tooltip. The page body never shows routine sync status.

import { BotIcon, CloudSyncIcon } from "~/lib/icons";
import { usePagePresence, type PagePresencePeer } from "~/lib/pageRealtime/pagePresenceStore";
import { cn } from "~/lib/utils";

import type { PageChromeSlotProps } from "./pageChromeContext";

const MAX_AVATARS = 4;

export function TopBarPresence({ context }: PageChromeSlotProps) {
  const presence = usePagePresence(context.page.id);
  if (!presence) return null;
  const others = presence.peers.filter((peer) => !peer.self);
  const agents = others.filter((peer) => peer.kind === "agent");
  const people = others.filter((peer) => peer.kind === "person");
  const shown = [...agents, ...people].slice(0, MAX_AVATARS);
  const hidden = agents.length + people.length - shown.length;
  const offline = presence.link === "offline";
  // Central glyphs are CSS masks fetched from the Moss server on first paint. The offline glyph
  // first shows after the server is gone and an agent's appears only for a few seconds, so both
  // are painted invisibly while the page is live.
  const warmGlyphs = (
    <span aria-hidden className="pointer-events-none absolute flex size-4 opacity-0">
      <CloudSyncIcon className="size-4" />
      <BotIcon className="size-4" />
    </span>
  );
  if (!shown.length && !offline) return warmGlyphs;
  return (
    <div className="relative flex h-7 shrink-0 items-center gap-1" data-testid="page-presence">
      {offline ? <OfflineMarker pending={presence.pending} /> : null}
      {warmGlyphs}
      {shown.length ? (
        <div
          role="group"
          aria-label={[
            agents.length ? `${agents.map((agent) => agent.name).join("、")}正在编辑` : null,
            people.length ? `另有 ${people.length} 个窗口在此页面` : null,
          ]
            .filter(Boolean)
            .join("；")}
          className="flex items-center -space-x-1.5"
        >
          {shown.map((peer) => (
            <PresenceAvatar key={peer.clientId} peer={peer} />
          ))}
          {hidden > 0 ? (
            <span className="flex size-6 items-center justify-center rounded-full bg-muted text-ui-xs font-medium text-muted-foreground ring-2 ring-background">
              +{hidden}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OfflineMarker({ pending }: { pending: boolean }) {
  const label = pending
    ? "离线：修改已保存在这台设备上，恢复连接后会自动同步"
    : "离线：恢复连接后会自动同步";
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-page-offline={pending ? "pending" : "synced"}
      className="relative flex size-7 items-center justify-center rounded-control text-muted-foreground"
    >
      <CloudSyncIcon aria-hidden className="size-4" />
      {pending ? (
        <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-muted-foreground" />
      ) : null}
    </span>
  );
}

function PresenceAvatar({ peer }: { peer: PagePresencePeer }) {
  if (peer.kind === "agent") {
    return (
      <span
        className="flex size-6 items-center justify-center rounded-full text-white ring-2 ring-background"
        style={{ backgroundColor: peer.color }}
        title={`${peer.name}正在编辑`}
        data-presence-kind="agent"
      >
        <BotIcon aria-hidden className="size-3.5" />
      </span>
    );
  }
  const initial = Array.from(peer.name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      className={cn(
        "flex size-6 items-center justify-center rounded-full text-ui-xs font-medium text-white ring-2 ring-background",
        peer.typing && "outline-2 outline-offset-1",
      )}
      style={{ backgroundColor: peer.color, outlineColor: peer.typing ? peer.color : undefined }}
      title={peer.typing ? `${peer.name}（正在输入）` : peer.name}
      data-presence-kind="person"
    >
      {initial}
    </span>
  );
}
