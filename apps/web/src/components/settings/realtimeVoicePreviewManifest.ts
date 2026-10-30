import type { RealtimeVoiceId } from "@synara/contracts";

import { isRealtimeVoiceId } from "~/lib/realtimeVoicePreferences";

export const REALTIME_VOICE_PREVIEW_MANIFEST_PATH = "/realtime-voice-previews/manifest.json";

export type RealtimeVoicePreviewUrls = Readonly<Partial<Record<RealtimeVoiceId, string>>>;

function isControlledPreviewUrl(voice: RealtimeVoiceId, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return new RegExp(
    `^/realtime-voice-previews/${voice}(?:[._-][a-z0-9_-]+)?\\.(?:m4a|mp3|ogg|wav)$`,
    "i",
  ).test(value);
}

export function parseRealtimeVoicePreviewManifest(value: unknown): RealtimeVoicePreviewUrls {
  if (!value || typeof value !== "object") return {};
  const voices = Reflect.get(value, "voices");
  if (!voices || typeof voices !== "object") return {};

  const previewUrls: Partial<Record<RealtimeVoiceId, string>> = {};
  for (const [voice, previewUrl] of Object.entries(voices)) {
    if (!isRealtimeVoiceId(voice) || !isControlledPreviewUrl(voice, previewUrl)) continue;
    previewUrls[voice] = previewUrl;
  }
  return previewUrls;
}

export async function loadRealtimeVoicePreviewManifest(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealtimeVoicePreviewUrls> {
  const response = await fetcher(REALTIME_VOICE_PREVIEW_MANIFEST_PATH, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Realtime voice preview manifest is unavailable.");
  return parseRealtimeVoicePreviewManifest(await response.json());
}
