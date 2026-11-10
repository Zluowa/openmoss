// FILE: readAloud.ts
// Purpose: The desktop chat's "Read aloud" message action: one message speaks at a
//          time through the system voice (Web Speech API), and its button reads
//          Read aloud / Pause / Resume for that message.
// Layer: Chat transcript behavior
// Exports: ReadAloudState, useReadAloud, readAloudSupported, prepareReadAloudText

import { useCallback, useSyncExternalStore } from "react";

export type ReadAloudState = "idle" | "playing" | "paused";

interface Playback {
  messageId: string;
  paused: boolean;
}

let playback: Playback | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
}

export function readAloudSupported(): boolean {
  return synth() !== null && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Markdown read as prose: drop code fences, link targets and emphasis marks. */
export function prepareReadAloudText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stop() {
  synth()?.cancel();
  playback = null;
  emit();
}

function start(messageId: string, text: string, lang: string | undefined) {
  const speech = synth();
  if (!speech) return;
  speech.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (lang) utterance.lang = lang;
  const finish = () => {
    if (playback?.messageId === messageId) {
      playback = null;
      emit();
    }
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  playback = { messageId, paused: false };
  speech.speak(utterance);
  emit();
}

/** Playback state of one message and a toggle that plays, pauses or resumes it. */
export function useReadAloud(
  messageId: string,
  getText: () => string,
): { state: ReadAloudState; toggle: () => void } {
  const state = useSyncExternalStore(
    subscribe,
    (): ReadAloudState =>
      playback?.messageId !== messageId ? "idle" : playback.paused ? "paused" : "playing",
    (): ReadAloudState => "idle",
  );
  const toggle = useCallback(() => {
    const speech = synth();
    if (!speech) return;
    if (playback?.messageId === messageId) {
      if (playback.paused) {
        speech.resume();
        playback = { messageId, paused: false };
      } else {
        speech.pause();
        playback = { messageId, paused: true };
      }
      emit();
      return;
    }
    const text = prepareReadAloudText(getText());
    if (!text) {
      stop();
      return;
    }
    start(
      messageId,
      text,
      typeof document !== "undefined" ? document.documentElement.lang : undefined,
    );
  }, [getText, messageId]);
  return { state, toggle };
}
