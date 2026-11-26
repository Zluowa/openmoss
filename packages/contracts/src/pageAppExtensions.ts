// FILE: pageAppExtensions.ts
// Purpose: Wire shapes and limits of the 应用页 capabilities that reach past
// the page itself: `mcp` (the viewer's connected tools), `files` (a Moss
// project's files, read-only), `assets` (files the page keeps), `room`
// (live presence and events among current viewers) and `comments`.
// Layer: Shared contract (plain types; each capability validates its own args)

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const PAGE_APP_EXTENSION_CAPABILITIES = [
  "mcp",
  "files",
  "assets",
  "room",
  "comments",
  "media",
  "chat",
  "mossbot",
  "voice",
] as const;

/** Error codes these capabilities add to `PAGE_APP_ERROR_CODES`. */
export const PAGE_APP_EXTENSION_ERROR_CODES = [
  /** mcp: the viewer has not yet answered whether this page may use a server. */
  "consent_required",
  /** mcp: a destructive tool needs the viewer's confirmation for this call. */
  "confirmation_required",
  /** mcp/files: the viewer said no to this one call or save. */
  "declined",
  /** mcp: the tool ran and reported an error; `detail` carries its content. */
  "tool_error",
  /** mcp: an administrator's policy blocks this server or tool for pages. */
  "policy_blocked",
  /** files/assets: over a size cap. */
  "too_large",
  /** files: the file changed between two reads of one download. */
  "changed",
] as const;
export type PageAppExtensionErrorCode = (typeof PAGE_APP_EXTENSION_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

export const PAGE_APP_MCP_MAX_SERVERS = 16;
export const PAGE_APP_MCP_MAX_TOOLS_PER_SERVER = 64;
export const PAGE_APP_MCP_MAX_ARGS_BYTES = 256 * 1024;
export const PAGE_APP_MCP_MAX_RESULT_BYTES = 4 * 1024 * 1024;
export const PAGE_APP_MCP_CALL_TIMEOUT_MS = 120_000;
/** Default and floor for how long a read-only result stays fresh. */
export const PAGE_APP_MCP_DEFAULT_STALE_MS = 30_000;
/** Cached read-only results are dropped after this long. */
export const PAGE_APP_MCP_CACHE_GC_MS = 5 * 60_000;
export const PAGE_APP_MCP_MIN_WATCH_INTERVAL_MS = 15_000;
/** The name a page uses for Moss 应用 (hosted apps the viewer connected). */
export const PAGE_APP_MCP_MOSS_APPS_SERVER = "moss_apps";

/** Where a server comes from in this Moss. */
export type PageAppMcpServerKind = "moss-apps" | "connector" | "local";

/** One server as a page declares it: `capabilities.mcp.servers[]`. */
export interface PageAppMcpServerDeclaration {
  /** `moss_apps`, a connector's name or id, or a local MCP server's name. */
  readonly server: string;
  /** Tools the page may call; anything else is refused before it leaves Moss. */
  readonly tools: readonly string[];
}

export interface PageAppMcpConfig {
  readonly servers: readonly PageAppMcpServerDeclaration[];
}

export type PageAppMcpServerState = "granted" | "prompt" | "denied" | "unavailable";

export interface PageAppMcpToolInfo {
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  /** The tool says it only reads; its results may be cached. */
  readonly readOnly: boolean;
  /** Moss asks the viewer before every call (unless remembered for this page). */
  readonly destructive: boolean;
  /** The server currently offers this tool (only known once granted). */
  readonly available: boolean | null;
}

export interface PageAppMcpServerInfo {
  readonly server: string;
  readonly label: string;
  readonly kind: PageAppMcpServerKind | null;
  readonly state: PageAppMcpServerState;
  /** Why the server is unavailable, written for the viewer. */
  readonly reason: string | null;
  readonly tools: readonly PageAppMcpToolInfo[];
}

export interface PageAppMcpListResult {
  readonly servers: readonly PageAppMcpServerInfo[];
}

export interface PageAppMcpCacheMark {
  /** Epoch ms when the result was fetched from the server. */
  readonly storedAt: number;
  /** A fresh fetch is running and will follow. */
  readonly revalidating: boolean;
}

export interface PageAppMcpCallResult {
  readonly content: readonly unknown[];
  readonly structuredContent: unknown;
  readonly isError: boolean;
  /** Present only when this result came from Moss's read-only cache. */
  readonly cache?: PageAppMcpCacheMark;
}

/** Args of `mcp.call` between shell and server. */
export interface PageAppMcpCallArgs {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly cache?: false | { readonly staleTime?: number; readonly refresh?: boolean };
  /** Set by the shell only, after the viewer confirmed a destructive call. */
  readonly approval?: "once" | "remember";
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export const PAGE_APP_FILES_PAGE_SIZE = 500;
export const PAGE_APP_FILES_MAX_READ_BYTES = 4 * 1024 * 1024;
export const PAGE_APP_FILES_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export interface PageAppFilesConfig {
  /** A Moss project id; omitted means the project of the chat that made the page. */
  readonly project?: string;
}

export interface PageAppFileEntry {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modifiedAt: string | null;
}

export interface PageAppFilesListResult {
  readonly project: { readonly id: string; readonly title: string };
  readonly entries: readonly PageAppFileEntry[];
  readonly cursor: string | null;
}

/** `files.read` on the wire: bytes travel base64-encoded over JSON. */
export interface PageAppFilesReadWire {
  readonly base64: string;
  readonly size: number;
  readonly revision: string;
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

export const PAGE_APP_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const PAGE_APP_ASSETS_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const PAGE_APP_ASSETS_MAX_COUNT = 500;
/** Raw bytes per upload chunk (base64 over JSON stays under the 8 MB body cap). */
export const PAGE_APP_ASSET_CHUNK_BYTES = 3 * 1024 * 1024;
export const PAGE_APP_ASSET_PATH = "/__moss_app/asset";

/** Types an asset may have; everything else is refused at upload. */
export const PAGE_APP_ASSET_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "application/pdf",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "text/csv",
  "application/json",
  "text/plain",
] as const;
export type PageAppAssetType = (typeof PAGE_APP_ASSET_TYPES)[number];

export interface PageAppAsset {
  readonly id: string;
  readonly name: string;
  readonly mimeType: PageAppAssetType;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  /** Path on the page's own origin (the frame adds its token). */
  readonly path: string;
}

// ---------------------------------------------------------------------------
// room
// ---------------------------------------------------------------------------

export const PAGE_APP_ROOM_MAX_PEERS = 32;
export const PAGE_APP_ROOM_MAX_EVENT_BYTES = 16 * 1024;
export const PAGE_APP_ROOM_MAX_PRESENCE_BYTES = 4 * 1024;
export const PAGE_APP_ROOM_MAX_TOPICS = 32;

/** Who may publish to / receive a topic: `capabilities.room.topics[name]`. */
export interface PageAppRoomTopicRule {
  readonly publish?: "view" | "interact" | "admin" | "owner";
  readonly receive?: "view" | "interact" | "admin" | "owner";
}

export interface PageAppRoomConfig {
  /** Undeclared topics are open to every viewer of the page. */
  readonly topics?: Readonly<Record<string, PageAppRoomTopicRule>>;
}

export interface PageAppRoomPeer {
  readonly peerId: string;
  readonly viewerId: string;
  readonly name: string;
  readonly self: boolean;
  readonly state: unknown;
  readonly joinedAt: number;
}

/** Events of the `room.join` stream. */
export type PageAppRoomEvent =
  | {
      readonly type: "welcome";
      readonly peerId: string;
      readonly peers: readonly PageAppRoomPeer[];
    }
  | { readonly type: "peers"; readonly peers: readonly PageAppRoomPeer[] }
  | {
      readonly type: "event";
      readonly topic: string;
      readonly data: unknown;
      readonly from: { readonly peerId: string; readonly name: string };
      readonly at: number;
    };

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

export const PAGE_APP_COMMENT_MAX_CHARS = 4_000;
export const PAGE_APP_COMMENTS_MAX_COUNT = 2_000;

/** Where a comment points inside the page. */
export interface PageAppCommentAnchor {
  /** `data-moss-comment` value when the element has one, else a CSS path. */
  readonly target: string;
  /** Short label for the comment list (element text or tag). */
  readonly label: string;
  /** Position inside the element, 0..1 on each axis. */
  readonly x: number;
  readonly y: number;
  readonly quote: string | null;
}

export interface PageAppComment {
  readonly id: string;
  readonly anchor: PageAppCommentAnchor;
  readonly body: string;
  readonly author: { readonly id: string; readonly name: string };
  readonly mine: boolean;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

export const PAGE_APP_MEDIA_MAX_PROMPT_CHARS = 4_000;
export const PAGE_APP_MEDIA_MAX_REF_IMAGES = 4;

export type PageAppMediaKind = "image" | "video";

export type PageAppMediaJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed_terminal"
  | "reconciliation_required";

export interface PageAppMediaGenerateImageInput {
  readonly prompt: string;
  readonly modelId?: string;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly background?: "auto" | "opaque" | "transparent";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  readonly referenceImages?: readonly string[];
  readonly idempotencyKey?: string;
  readonly waitMs?: number;
}

export interface PageAppMediaGenerateVideoInput {
  readonly prompt: string;
  readonly modelId?: string;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly duration?: number;
  readonly generateAudio?: boolean;
  readonly startFrameUrl?: string;
  readonly endFrameUrl?: string;
  readonly referenceImages?: readonly string[];
  readonly idempotencyKey?: string;
  readonly waitMs?: number;
}

export interface PageAppMediaJobResult {
  readonly jobId: string;
  readonly kind: PageAppMediaKind;
  readonly modelId: string;
  readonly prompt: string;
  readonly status: PageAppMediaJobStatus;
  readonly url: string | null;
  readonly urls: readonly string[];
  readonly assetIds?: readonly string[];
  readonly assetPaths?: readonly string[];
  readonly dataUrls?: readonly string[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
}

export interface PageAppMediaModelInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: PageAppMediaKind;
  readonly available: boolean;
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export const PAGE_APP_CHAT_MAX_PROMPT_CHARS = 32_000;
export const PAGE_APP_CHAT_MAX_SELECTION_CHARS = 16_000;

export interface PageAppChatOpenSidechatInput {
  readonly prompt?: string;
  readonly selectionText?: string;
  readonly context?: string;
  readonly appTitle?: string;
}

export interface PageAppChatOpenSidechatResult {
  readonly opened: boolean;
  readonly mode: "sidechat" | "inline";
  readonly threadId?: string | null;
  readonly answer?: string | null;
  readonly model?: string | null;
}

export interface PageAppChatAskInput {
  readonly prompt: string;
  readonly selectionText?: string;
  readonly context?: string;
  readonly appTitle?: string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly tier?: "default" | "quick" | "complex";
}

export interface PageAppChatAskResult {
  readonly text: string;
  readonly model: string;
  readonly selectionText?: string | null;
}

export interface PageAppChatSummonInput extends PageAppChatOpenSidechatInput {
  readonly action?: "ask" | "sidechat";
}

// ---------------------------------------------------------------------------
// mossbot
// ---------------------------------------------------------------------------

export const PAGE_APP_MOSSBOT_MAX_NOTE_CHARS = 16_000;
export const PAGE_APP_MOSSBOT_MAX_TRANSCRIPT_CHARS = 100_000;

export interface PageAppMossbotInfo {
  readonly id: string;
  readonly name: string;
  readonly icon?: string | null;
  readonly color?: string | null;
}

export interface PageAppMossbotJoinMeetingInput {
  readonly meetingId?: string;
  readonly title?: string;
  readonly topic?: string;
  readonly botId?: string;
  readonly participants?: readonly string[];
}

export interface PageAppMossbotJoinMeetingResult {
  readonly meetingId: string;
  readonly roomId: string | null;
  readonly title: string;
  readonly joined: boolean;
  readonly bots: readonly PageAppMossbotInfo[];
  readonly notesCount: number;
}

export interface PageAppMossbotPostNoteInput {
  readonly meetingId: string;
  readonly author?: string;
  readonly text: string;
  readonly kind?: "note" | "transcript" | "decision" | "action";
}

export interface PageAppMossbotPostNoteResult {
  readonly meetingId: string;
  readonly noteId: string;
  readonly notesCount: number;
}

export interface PageAppMossbotSummarizeMeetingInput {
  readonly meetingId: string;
  readonly prompt?: string;
  readonly transcript?: string;
  readonly focus?: string;
}

export interface PageAppMossbotSummarizeMeetingResult {
  readonly meetingId: string;
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly actionItems: readonly string[];
  readonly decisions: readonly string[];
  readonly model?: string | null;
  readonly botName?: string | null;
}

export interface PageAppMossbotAskInMeetingInput {
  readonly meetingId: string;
  readonly question: string;
  readonly transcript?: string;
  readonly botId?: string;
}

export interface PageAppMossbotAskInMeetingResult {
  readonly meetingId: string;
  readonly answer: string;
  readonly model?: string | null;
  readonly botName?: string | null;
  readonly roomId?: string | null;
}

// ---------------------------------------------------------------------------
// voice
// ---------------------------------------------------------------------------

export const PAGE_APP_VOICE_MAX_AUDIO_BASE64_CHARS = 14_000_000;
export const PAGE_APP_VOICE_MAX_SPEAK_CHARS = 4_000;
export const PAGE_APP_VOICE_MAX_INSTRUCTIONS_CHARS = 8_000;

export interface PageAppVoiceDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface PageAppVoiceListVoicesResult {
  readonly defaultVoice: string;
  readonly preferredTransport: "webrtc" | "websocket-pcm16";
  readonly voices: readonly PageAppVoiceDescriptor[];
}

export interface PageAppVoiceTranscribeInput {
  readonly audioBase64: string;
  readonly mimeType?: string;
  readonly sampleRateHz?: number;
  readonly durationMs?: number;
  readonly language?: string;
}

export interface PageAppVoiceTranscribeResult {
  readonly text: string;
  readonly language?: string | null;
}

export interface PageAppVoiceListenOptions {
  readonly language?: string;
  readonly maxDurationMs?: number;
  readonly autoTranscribe?: boolean;
}

export interface PageAppVoiceStartListeningResult {
  readonly listeningId: string;
  readonly mimeType: string;
  readonly sampleRateHz: number;
}

export interface PageAppVoiceStopListeningOptions {
  readonly listeningId?: string;
  readonly autoTranscribe?: boolean;
  readonly language?: string;
}

export interface PageAppVoiceStopListeningResult {
  readonly listeningId: string;
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly sampleRateHz: number;
  readonly durationMs: number;
  readonly text?: string | null;
}

export interface PageAppVoiceSpeakInput {
  readonly text: string;
  readonly voice?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly format?: "mp3" | "wav" | "opus";
}

export interface PageAppVoiceSpeakResult {
  readonly spoken: boolean;
  readonly source: "moss" | "browser";
  readonly voice?: string | null;
  readonly durationMs?: number | null;
}

export interface PageAppVoiceSynthesizeResult {
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly voice: string;
}

export interface PageAppVoiceStartRealtimeInput {
  readonly threadId?: string;
  readonly voice?: string;
  readonly instructions?: string;
  readonly language?: string;
  readonly outputModality?: "audio" | "text";
  readonly sdp?: string;
}

export interface PageAppVoiceStartRealtimeResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly voice: string;
  readonly transport: "webrtc" | "websocket-pcm16" | "server-bridge";
  readonly status: "active" | "ready";
  readonly controlPath?: string | null;
  readonly answerSdp?: string | null;
  readonly relayUrl?: string | null;
  readonly ticket?: string | null;
  readonly expiresAt?: string | null;
}

export interface PageAppVoiceStopRealtimeInput {
  readonly sessionId?: string;
  readonly reason?: string;
}

export interface PageAppVoiceStopRealtimeResult {
  readonly stopped: boolean;
  readonly sessionId: string | null;
}

export interface PageAppVoiceRealtimeEvent {
  readonly type: "state" | "transcript" | "error";
  readonly sessionId?: string | null;
  readonly phase?: string;
  readonly activity?: string | null;
  readonly role?: "user" | "assistant";
  readonly text?: string;
  readonly isFinal?: boolean;
  readonly error?: string | null;
}
