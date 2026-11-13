// FILE: PageDictationButton.tsx
// Purpose: 听写 for a 资料空间 page: record, have Moss transcribe it (the same voice transcription
//          the chat composer uses), and type the words at the caret in the page.
// Layer: Space page chrome slot `topBarQuickActions`
// Exports: PageDictationButton, pageDictationFolder

import type { ThreadId } from "@moss/contracts";
import { useState } from "react";

import { MicIcon } from "~/lib/icons";
import { pageAssistantThreads } from "~/lib/pageAi/pageAssistantThread";
import { useVoiceRecorder } from "~/lib/voiceRecorder";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { createProjectSelector, createThreadSelector } from "~/storeSelectors";
import { toastManager } from "../../ui/toast";
import { PageChromeButton } from "./PageChromeButton";

/**
 * The folder transcription runs in: the page assistant's conversation when it has one, else the
 * first project. Moss's voice transcription is tied to an agent's working folder.
 */
export function pageDictationFolder(pageKey: string): { cwd: string; threadId?: ThreadId } | null {
  const state = useStore.getState();
  const threadId = pageAssistantThreads.get(pageKey);
  const thread = createThreadSelector(threadId)(state);
  const project = createProjectSelector(thread?.projectId)(state) ?? state.projects[0];
  const cwd = thread?.worktreePath ?? project?.cwd ?? null;
  if (!cwd) return null;
  return threadId && thread ? { cwd, threadId } : { cwd };
}

export function PageDictationButton(props: {
  pageKey: string;
  disabled: boolean;
  onText: (text: string) => void;
}) {
  const recorder = useVoiceRecorder();
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    if (recorder.isRecording) {
      const folder = pageDictationFolder(props.pageKey);
      const api = readNativeApi();
      setBusy(true);
      void recorder
        .stopRecording()
        .then((payload) => {
          if (!payload) {
            toastManager.add({ type: "warning", title: "没有录到声音" });
            return null;
          }
          if (!api || !folder) {
            toastManager.add({
              type: "error",
              title: "听写没有完成",
              description: "先在 Moss 里打开一个项目，再试一次。",
            });
            return null;
          }
          return api.server.transcribeVoice({ provider: "codex", ...folder, ...payload });
        })
        .then((result) => {
          if (result?.text) props.onText(result.text);
        })
        .catch((cause: unknown) =>
          toastManager.add({
            type: "error",
            title: "听写没有完成",
            description: cause instanceof Error ? cause.message : "请再试一次。",
          }),
        )
        .finally(() => setBusy(false));
      return;
    }
    void recorder.startRecording().catch(() =>
      toastManager.add({
        type: "error",
        title: "无法使用麦克风",
        description: "请在系统设置里允许 Moss 使用麦克风。",
      }),
    );
  };
  const label = recorder.isRecording ? "停止听写" : busy ? "正在转成文字…" : "听写";
  return (
    <PageChromeButton
      icon={MicIcon}
      label={label}
      iconOnly
      active={recorder.isRecording}
      disabled={props.disabled || busy}
      onClick={toggle}
    />
  );
}
