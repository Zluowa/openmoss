import { ThreadId, type ModelSelection } from "@synara/contracts";
import { getProviderInstanceOptions, useAppSettings } from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { resolveVoiceTranscriptionTarget } from "~/lib/providerAvailability";
import type { Project } from "~/types";
import { useComposerVoiceController } from "../chat/useComposerVoiceController";
import { ComposerVoiceButton } from "../chat/ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "../chat/ComposerVoiceRecorderBar";

/** The ordinary composer's recorder and transcription path, without creating a chat. */
export function MossImagesVoiceInput({
  project,
  scopeId,
  disabled,
  onTranscript,
  selection,
}: {
  readonly project: Project | undefined;
  readonly scopeId: string;
  readonly disabled: boolean;
  readonly onTranscript: (text: string) => void;
  readonly selection: ModelSelection;
}) {
  const { settings } = useAppSettings();
  const statuses = useProviderStatusesForLocalConfig();
  const refreshVoiceStatus = useRefreshProviderStatusesNow();
  const target = resolveVoiceTranscriptionTarget({
    statuses,
    providerInstances: getProviderInstanceOptions(settings),
    selectedProvider: selection.provider,
    selectedProviderInstanceId: selection.instanceId ?? selection.provider,
  });
  const voice = useComposerVoiceController({
    activeProject: project,
    activeThreadId: null,
    threadId: ThreadId.makeUnsafe(scopeId),
    selectedProvider: selection.provider,
    selectedProviderInstanceId: selection.instanceId ?? selection.provider,
    voiceProviderInstanceId: target?.instanceId ?? "codex",
    activeProviderStatus: target?.status ?? null,
    pendingUserInputCount: 0,
    onTranscriptReady: onTranscript,
    refreshVoiceStatus,
    locale: "zh-CN",
  });
  if (voice.isVoiceRecording)
    return (
      <ComposerVoiceRecorderBar
        disabled={disabled}
        durationLabel={voice.voiceRecordingDurationLabel}
        isRecording={voice.isVoiceRecording}
        isWaitingForAudio={voice.isVoiceWaitingForAudio}
        isTranscribing={voice.isVoiceTranscribing}
        waveformLevels={voice.voiceWaveformLevels}
        onDiscard={voice.cancelComposerVoiceRecording}
        onStop={() => void voice.submitComposerVoiceRecording()}
      />
    );
  const available = Boolean(
    project && voice.showVoiceNotesControl && target?.status.voiceTranscriptionAvailable,
  );
  return (
    <ComposerVoiceButton
      disabled={disabled || !available}
      isRecording={voice.isVoiceRecording}
      isStarting={voice.isVoiceStarting}
      isTranscribing={voice.isVoiceTranscribing}
      durationLabel={voice.voiceRecordingDurationLabel}
      onClick={() => void voice.startComposerVoiceRecording()}
    />
  );
}
