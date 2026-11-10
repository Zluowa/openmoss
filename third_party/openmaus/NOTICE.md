# OpenMausBot adaptations

Source: https://github.com/milind-soni/OpenMausBot/tree/58378e85449ca49f3370d72e6c70cece4fee413f
License: Apache-2.0 (included in LICENSE).

Moss adapts shared/mention-boundary.ts, shared/room-mentions.ts and the routing
portion of src/lib/group-routing.ts. Changes include native Moss types, immutable
sorting, exception-based ambiguity reporting, and the native queue/CLI adapter.
The room member picker, sequential speaker queue and simple conversation layout
follow src/components/SidebarNewRoomPanel.tsx and server/room-queue.ts.
Moss supplies its own artwork, components, execution, persistence and permissions.
