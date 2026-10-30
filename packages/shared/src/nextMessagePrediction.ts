// Shared constants for the Codex-aligned next-message prediction path.

/** Codex's prediction request deadline (cumberbatch `Lq=3e4`). */
export const NEXT_MESSAGE_PREDICTION_TIMEOUT_MS = 30_000;

/** Transcript fallback bound used when a provider cannot fork its native thread. */
export const NEXT_MESSAGE_PREDICTION_TRANSCRIPT_MAX_CHARS = 6_000;

/** Local prompt revision; the remote Codex prompt remains unavailable to Moss. */
export const NEXT_MESSAGE_PREDICTION_PROMPT_VERSION = "moss-codex-aligned-v1";

/** Codex predictions run at low effort; its remote `prediction_reasoning_effort` is unavailable. */
export const NEXT_MESSAGE_PREDICTION_CODEX_REASONING_EFFORT = "low";
