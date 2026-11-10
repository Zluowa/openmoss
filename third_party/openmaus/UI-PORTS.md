# OpenMaus UI ports

Upstream: https://github.com/milind-soni/OpenMausBot, commit `58378e85449ca49f3370d72e6c70cece4fee413f`. Apache-2.0; see LICENSE and UPSTREAM-NOTICE in this directory. This document records actual code ports, not visual inspiration.

The ports are in `apps/web/src/components/mossbot/openmaus/`:

| Moss file | Upstream source | Adaptation |
| --- | --- | --- |
| NewRoomPanel | SidebarNewRoomPanel.tsx | Same selection, optional context, Enter/Escape and creation layout; async native create, busy/error states, 12-member cap |
| BotPickerList | BotPickerList.tsx | Same checkbox rows, chosen marks and order; Moss pixel avatars |
| RoomEmpty | GroupView.tsx empty-room branch | Original stacked avatars, room name and routing hint layout |
| RoomHeader | RoomHeader.tsx simple branch | Identity button, three stacked faces and overflow count; native navigation and member dialog callbacks |
| ManageMembersPanel, room-members | ManageMembersPanel.tsx, lib/room-members.ts | Selection/order/stale-roster check retained; native save waits for acknowledgement, Moss dialog owns focus trapping |
| DefaultResponderSelect, Select | RoomHeader.tsx DefaultResponderSelect, Select.tsx | Actual lead/behavior select; only executable choices offered; no model-based auto-decider |
| Composer | Composer.tsx mention selection, textarea and simple-mode shell | Native controlled draft and async send/stop; keyboard selection/IME guard; cloud teammates, slash/voice/calls/attachment features excluded |
| MentionTextarea, MentionText | Same filenames | Mirror, six-line sizing, width-only ResizeObserver retained |
| MentionMenu, ComposerMenuRow | Same filenames | Actual option rows and highlights; bot/everyone only; shared Moss disclosure motion |
| ComposerSendButton | ComposerSendButton.tsx send-only branch | Round clock/arrow branch; native send/queue, no one-to-one steering submenu |
| mentions, mention-picks; shared mention helpers | lib/mentions.ts bot/everyone helpers, lib/mention-picks.ts, shared/room-mentions.ts, shared/mention-boundary.ts | Original draft choice identity resolution; boundary and resolution code reused from the existing @moss/shared port; upstream cloud-person tags removed |
| RoomBubble | ChatView.tsx simple Bubble wrapper; chat-bubble.ts shape and joinedCorners | Native Markdown/OpenUI/secret rendering retained as host content; native conversation link in speaker slot |
| RoomQueueList, JumpToLatestButton | Same filenames | Native queue projection and scroll callbacks |
| room.css | styles.css mention-editor rules | Scoped to rooms; Moss foreground/accent tokens |
| ConversationSectionHeader | SidebarSectionHeader.tsx Simple label/disclosure/menu branch | Shared Moss Collapsible, DisclosureChevron, keyboard reorder and scalable typography; native section menu |
| MossbotConversationFolders | SidebarSectionPicker.tsx assign/new/ungroup flow | Native submenu and RenameDialog; host stable folder IDs include both personal and group conversations |
| lib/openmausFolderOrder | lib/folder-order.ts placeFolder, moveFolder | Original bounded reorder algorithms; no upstream drag MIME or store dependency |

Mechanical changes: import paths, Moss central icon adapter, shared dialog focus/portal, Moss typography and theme tokens, localized presentation copy, upstream analytics removed. No upstream store, provider executor, gateway or cloud account system is installed.

The 2026-11-07 follow-up adapts the user's additional mobile references: mixed bot/room rows,
overlapping member portraits, named collapsible conversation sections, room identity pill,
speaker portraits and rounded gray bubbles. The new green companion drawings are original
Moss SVGs; existing saved avatar keys remain valid. Folder assignment, ordering, collapse,
room pin/unread/hidden and visit timestamps are presentation preferences on this device, as
in the upstream sidebar layout. Removing a folder only ungroups its conversations. Native
room membership, account/model selection, queue, transcript and cancellation remain server-owned.

`MossbotRooms.tsx` is the native data adapter: native project/thread identities, CLI/account selection, durable drafts, room RPCs, Markdown/OpenUI and secret requests remain Moss-owned. Threebot's reading-position and mobile-focus behaviors are attributed separately in `third_party/threebot/NOTICE.md`.
