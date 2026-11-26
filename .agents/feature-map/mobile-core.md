# Feature Map: Mobile Core (`apps/mobile`)

**Primary Owners:** `moss-mobile-owner`, `moss-qa-eval`
**Core Sources:** `apps/mobile/src/**`, `apps/mobile/app.json`, `apps/mobile/ROADMAP-LIVE.md`, `apps/mobile/scripts/sync-moss-assets.mjs`

## User-Perspective Journeys & Proof Criteria

1. **Single-Source Assets, Icons, Theme & Tool Labels**
   - _User path:_ View chat, tool rows, file icons, provider logos, and light/dark surfaces on Android/iOS.
   - _Proof criteria:_ `node apps/mobile/scripts/sync-moss-assets.mjs --check` exits 0, `bun run boundaries:check` finds zero duplicated tool tables or drifted versions, and every desktop tool has both `zh-CN` and `en` mobile labels.
2. **Mobile Chat, Approvals, Steering & Error Recovery**
   - _User path:_ Start a chat via `codex_moss` or paired desktop instance, steer/stop mid-run, inspect Git diffs (line-wrapped), and handle approval/error cards.
   - _Proof criteria:_ `instanceId` routes across agent switches, running `停止` cancels cleanly, error details stay collapsed by default, and `bun run mobile:check` passes.
3. **Mobile Voice Dictation & Permissions**
   - _User path:_ Tap microphone in composer (`VoiceDictationBar.tsx`), grant mic permission, and transcribe speech.
   - _Proof criteria:_ `apps/mobile/app.json` includes `android.permission.RECORD_AUDIO` (not blocked) and `NSMicrophoneUsageDescription` in `ios.infoPlist`, and `VoiceDictationBar` handles permission denial/grant cleanly in `zh-CN`/`en`.
4. **M2 Images Viewer & Inline Edit Composer**
   - _User path:_ Open generated images from chat or gallery, pinch/zoom/swipe, save/share, or dispatch an inline "描述修改 / Describe a change" turn.
   - _Proof criteria:_ Full-screen image viewer handles enterprise API key boundaries cleanly, inline edit composer matches Moss design tokens with zero explanatory clutter, and unit tests pass.
5. **Space Viewers & `/apps` Marketplace**
   - _User path:_ Open shared/space Slides, Sheets, or `/apps` plugin cards from mobile.
   - _Proof criteria:_ Slides render full body content, Sheet formula evaluator works, `/apps` headers keep top/bottom fade and fallback icons, and `apps/mobile` Vitest + `tsc --noEmit` stay green.
