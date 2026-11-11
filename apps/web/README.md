# apps/web

The React/Vite interface of Moss: session UX, conversation rendering and client
state. It talks to the local server over WebSocket. Repository-wide rules are in
`AGENTS.md` and `docs/handbook/engineering.md`; how things should look is in
`docs/design/moss-design-standard.md` (kept in the private repository). This page holds the conventions that are
specific to this package.

## Running and testing

- Start it only through the `run-isolated` skill (`.agents/skills/run-isolated/`),
  never the default `bun run dev` next to another Moss.
- Unit tests: `bun run --cwd apps/web test <files>`.
- Browser tests: `bun run --cwd apps/web test:browser <file>`. Known flaky or
  machine-specific browser tests are listed in `BROWSER_TEST_QUARANTINE.md`.
- `bun run lint` includes `design:check`, which fails when a file gains hard-coded
  colours, size-named radii, one-off sizes, extra bold weights or bare `<button>`s
  over `scripts/design-check-baseline.json`.

## Reuse before you build

Before adding a dialog, sheet, input, button, row, hook, store or helper, search
for one that already does the job, and extend it with a prop or variant when it
almost fits. Controls come from `src/components/ui/` (`button.tsx`, `input.tsx`,
`textarea.tsx`, `select.tsx`, `menu.tsx`, `collapsible.tsx` and the rest). When a
second surface needs the same shape as an existing one, extract the shared piece
and switch both to it, as `src/components/AnnouncementSheet.tsx` does for one-time
announcements.

## Open and close motion: one source

Every element that opens and closes (expand and collapse, show and hide,
disclosure) uses `src/lib/disclosureMotion.ts`. Never write bespoke height or
opacity transitions, one-off `@keyframes` or local timing constants for a toggle.
The default is 220 ms `ease-out` with a `motion-reduce` fallback.

- Shell and content: `disclosureShellClassName(open)` on the grid shell,
  `DISCLOSURE_INNER_CLASS` on the inner wrapper, `disclosureContentClassName(open)`
  on the content, or the ready-made `DisclosureRegion`
  (`src/components/ui/DisclosureRegion.tsx`).
- Base UI `<Collapsible>` panels: wrap with `CollapsiblePanel`
  (`src/components/ui/collapsible.tsx`), which applies
  `DISCLOSURE_COLLAPSIBLE_PANEL_CLASS`.
- Rotating chevron: `DisclosureChevron` (`src/components/ui/DisclosureChevron.tsx`)
  or `disclosureChevronClassName(open)`.
- Transcript rows use the conversation profile from the same module
  (`conversationDisclosureTransition`, `conversationDisclosureStyle`,
  `conversationSummaryStyle`), so they never define their own timing either.

Reference usage: opening and closing a project and the sidebar sections in
`src/components/Sidebar.tsx`. A toggle that animates differently is migrated to
this module, not copied.

## Text follows the user's font size

UI text follows the font size chosen in Settings. Use the `text-ui` tokens from
the `@theme` block of `src/index.css`, driven by `src/hooks/useAppTypography.ts`:
`text-ui` for body copy, `text-ui-sm` and `text-ui-xs` for secondary text,
`text-ui-lg` for emphasised lines and small panel titles, and `text-chat*` for
transcript content. Inherit the UI font family. Do not use fixed Tailwind sizes
(`text-sm`, `text-xs`, `text-[11px]`) or the long
`text-[length:var(--app-font-size-…)]` form. Only dialog titles and large
headings may use a fixed size. `src/uiFontSize.test.ts` fails when fixed sizes
are added.

## Compact menus

Variants of one action (handoff targets, copy variants, fork targets, hub moves)
share one parent row that opens a submenu, instead of each taking a top-level
line. Imperative context menus get this from `children` on `ContextMenuItem`
through `contextMenuGroup` (`src/lib/contextMenuGroup.ts`), which renders a native
submenu on desktop and a flyout in the browser. React menus use `MenuSub` from
`src/components/ui/menu.tsx`. A group with a single entry stays a plain row.

## Transcript scrolling

The transcript is a `LegendList` (`src/components/chat/ChatTranscriptPane.tsx`).
Scroll follow lives in `src/components/chat/useChatTranscriptScroll.ts` and
`transcriptScroll.ts`; the follow signal is built by
`buildTranscriptAutoFollowSignal` in `src/components/ChatView.logic.ts`.

- Auto-scroll is a live-output feature, not a generic "working" feature. Keep
  end-follow while the reader stays at the bottom, including tool and work growth
  between assistant messages and the final settled layout. Scrolling away from
  the bottom releases follow.
- Buffering, reconnecting, pending approvals and tool-only activity must not be
  wired as if assistant text were streaming, and must not re-arm a detached
  reader or retrigger the message-arrival stick.
- Count real transcript messages only when deciding that new content arrived.
- Never couple list measurement to a second bottom-stick or height-follow loop.
  Height-follow for live output stays one-way, so measurement and scrolling cannot
  feed each other.
- Cover changes to scrolling, timeline measurement or sidebar-driven transcript
  updates with focused tests, such as `MessagesTimeline.scroll.browser.tsx`,
  `LegendList.endFollow.browser.tsx` and `useChatTranscriptScroll.browser.tsx` in
  `src/components/chat/`.

## Copy

Every string a person can see, aria labels included, lives in
`src/localization.tsx` with both zh-CN and en. Use the terms in
`docs/zh-CN-product-glossary.md`. Failures read as one plain sentence plus one
action; no command lines, file paths, raw English errors or stack traces.
