// FILE: window.ts
// Purpose: Last-30-day chat window helpers for workspace import.
// Layer: Server import helper

import { WORKSPACE_IMPORT_CHAT_WINDOW_MS } from "@synara/contracts";

export function workspaceImportWindowStart(now: Date): Date {
  return new Date(now.getTime() - WORKSPACE_IMPORT_CHAT_WINDOW_MS);
}

export function isWithinWorkspaceImportWindow(input: {
  readonly now: Date;
  readonly timestamp: Date | null;
}): boolean {
  if (input.timestamp === null) {
    return false;
  }
  const timestamp = input.timestamp.getTime();
  const now = input.now.getTime();
  // Future-dated records are not recent chats.  Treating a malformed clock
  // value as importable would let an untrusted transcript bypass the window.
  return timestamp >= workspaceImportWindowStart(input.now).getTime() && timestamp <= now;
}

export function parseImportTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // JSON session stores commonly use either epoch seconds or milliseconds.
    const millis = Math.abs(value) < 1e12 ? value * 1_000 : value;
    const parsedNumber = new Date(millis);
    return Number.isNaN(parsedNumber.getTime()) ? null : parsedNumber;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
