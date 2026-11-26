# Feature Map: Desktop Chat & Composer

**Primary Owners:** `moss-desktop-core`, `moss-qa-eval`
**Core Sources:** `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/**`, `apps/web/src/localization.tsx`, `apps/server/src/orchestration/**`, `apps/server/src/provider/**`

## User-Perspective Journeys & Proof Criteria

1. **New Chat, Draft Persistence & Thread Switching**
   - _User path:_ Start a new chat (no project required), type or attach files, switch threads/projects, and return.
   - _Proof criteria:_ Unsent edits and queued attachments survive thread switching (`ChatView.newChat.browser.tsx`), empty untouched drafts drop cleanly, and clicking rail items from full-width routes does not re-push stale URLs.
2. **Agent / Model Picker & Effort Controls**
   - _User path:_ Open the composer agent/model/effort popover, switch between Moss-managed and local CLIs, and send a turn.
   - _Proof criteria:_ Picker fits narrow/wide widths cleanly, selected provider & effort persist per thread, and zero retired provider names leak onto UI surfaces.
3. **In-Flight Steering & Background Tasks**
   - _User path:_ Send a steering message (`now` / `next`) while an agent is streaming or executing tools.
   - _Proof criteria:_ Native steering runs without false `assistantError` banners (`ChatView.steering.browser.tsx`), foreground commands background cleanly when steered, and timeline shows only minimal active indicator.
4. **Tool Calls, Work Log & Verbatim Approval Cards**
   - _User path:_ Observe folded tool groups, expand work log details, and approve/deny a shell or tool request.
   - _Proof criteria:_ Approval cards show verbatim commands & all tool arguments, never steal keyboard focus (no accidental `Enter` approval), and pause elapsed work timer during `awaitingUser`.
5. **Markdown, Code Blocks, Produced Files & Mermaid/KaTeX**
   - _User path:_ Inspect streamed assistant prose, tables, math, diagrams, narrow code blocks, and produced-file cards.
   - _Proof criteria:_ Narrow code blocks render top action bar without overlapping text (`ChatMarkdown.test.tsx`), read-only inline code paths do not falsely render `下载`, and streaming flush re-renders only the active row (`MessagesTimeline.renderScope`).
6. **Appearance, Localization & Design Discipline**
   - _User path:_ Toggle Light/Dark themes and `zh-CN` / `en` locales across Chat, Settings, and Tasks.
   - _Proof criteria:_ Zero English placeholders in `zh-CN` (`DynamicTranslationBoundaries.test.tsx`), `bun run design:check` and `bun run copy:check` do not regress, and `bun run brand:check` passes.
