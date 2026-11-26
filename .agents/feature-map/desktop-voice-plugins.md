# Feature Map: Desktop Voice, Plugins & Lifecycle

**Primary Owners:** `moss-ops-voice`, `moss-desktop-core`, `moss-release-bot`
**Core Sources:** `apps/realtime-relay/**`, `apps/cloudflare-realtime-relay/**`, `apps/cloudflare-model-gateway/**`, `apps/web/src/components/MossApps*`, `apps/desktop/src/backendShutdown.ts`, `apps/desktop/src/codeUpdateClient.ts`, `apps/desktop/src/voiceTranscription.ts`

## User-Perspective Journeys & Proof Criteria

1. **CN & Global Realtime Voice Mode**
   - _User path:_ Click realtime voice orb in CN mode (`rt.mossbotai.com`) or Global mode (`rt-global.mossbotai.com`) and hold a live turn.
   - _Proof criteria:_ Both `/readyz` endpoints return HTTP 200 (`cloudRegion` matches deployment), CN mode enforces `websocket-pcm16` relay route, and `apps/realtime-relay` tests pass.
2. **Voice Dictation (Audio Transcriptions)**
   - _User path:_ Hold/click microphone in composer to dictate in Chinese or English.
   - _Proof criteria:_ `/v1/audio/transcriptions` accepts valid auth (returns 401 unauthenticated, 200 on valid turn), `voiceTranscription.test.ts` passes, and failures surface plain-Chinese actionable status.
3. **Unified Plugin Marketplace & Official Plugins**
   - _User path:_ Open `/apps`, install/uninstall official plugins (e.g., Moss Handbook), connect MCP/service connectors, or resume chat after in-thread binding.
   - _Proof criteria:_ Marketplace cards match design tokens, plugin icons fall back cleanly when remote SVG probes fail, and uninstall/reconnect flows pass contract tests.
4. **Desktop Clean Exit & Shutdown**
   - _User path:_ Close Moss Desktop (and Quit from tray when `closeToTray` is enabled).
   - _Proof criteria:_ `apps/desktop/src/backendShutdown.windows.integration.test.ts` passes 7/7, backend exits within ~2s with zero orphan child processes, and `HKCU\Software\Classes\moss\shell\open\command` stays untouched in isolated runs.
5. **Desktop Auto-Update vs. Agent CLI Updates**
   - _User path:_ Check for Moss app updates separately from agent CLI updates (Codex / Claude Code).
   - _Proof criteria:_ Desktop update client (`codeUpdateClient.test.ts`) verifies Ed25519 signatures and resumes interrupted downloads cleanly without hijacking user-managed agent CLIs.
