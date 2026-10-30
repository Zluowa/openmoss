import type { ModelSelection } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { resolveNewConversationDefaultModelSelection, useAppSettings } from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useScratchComposerDraft } from "~/hooks/useScratchComposerDraft";
import { useScratchModelCatalog } from "~/hooks/useScratchModelCatalog";
import { buildModelSelection } from "~/providerModelOptions";
import { ComposerSendArrowIcon, PlusIcon } from "~/lib/icons";
import { resolveProviderSendAdmission } from "~/lib/providerAvailability";
import type { Project } from "~/types";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ScratchModelPickers } from "../chat/ScratchAgentControls";
import { Button } from "../ui/button";
import { MossImagesVoiceInput } from "./MossImagesVoiceInput";

/** The normal chat editor, CLI/model picker and voice controls in the Images layout. */
export function MossImagesComposer(props: {
  readonly project?: Project | undefined;
  readonly prompt: string;
  readonly isEditing: boolean;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly canAttach: boolean;
  readonly requireProviderAdmission?: boolean;
  readonly onPromptChange: (value: string) => void;
  readonly onSend: (selection: ModelSelection) => void;
  readonly onSelectionChange?: (
    selection: ModelSelection,
    unavailableReason: string | null,
  ) => void;
  readonly onStop: () => void;
  readonly onAttach: () => void;
  readonly onPasteFiles: (files: readonly File[]) => void;
  readonly beforeEditor?: ReactNode;
  readonly attachments?: ReactNode;
  readonly notice?: ReactNode;
}) {
  const { settings } = useAppSettings();
  const draft = useScratchComposerDraft({
    defaultProvider: "codex",
    initialModelSelection: resolveNewConversationDefaultModelSelection(settings, "codex"),
    settings,
  });
  const providerStatuses = useProviderStatusesForLocalConfig();
  const catalog = useScratchModelCatalog({
    draft,
    providerStatuses,
    discoveryCwd: props.project?.cwd ?? null,
  });
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [cursor, setCursor] = useState(0);
  const selection = useMemo(
    () =>
      buildModelSelection(
        draft.selectedProvider,
        draft.selectedModel ?? "",
        draft.selectedProviderModelOptions,
        draft.selectedModelSupportsAutoMode,
        { instanceId: draft.selectedProviderInstanceId },
      ),
    [
      draft.selectedProvider,
      draft.selectedModel,
      draft.selectedProviderModelOptions,
      draft.selectedModelSupportsAutoMode,
      draft.selectedProviderInstanceId,
    ],
  );
  const admission = resolveProviderSendAdmission(
    catalog.selectedProviderStatus,
    draft.selectedProviderInstanceId,
  );
  const unavailableReason = !draft.selectedModel
    ? "当前 CLI 尚未提供可用模型，请打开模型选择器刷新或选择其他连接。"
    : props.requireProviderAdmission !== false && admission.state === "blocked"
      ? admission.unavailableReason
      : null;
  useEffect(() => {
    props.onSelectionChange?.(selection, unavailableReason);
  }, [props.onSelectionChange, selection, unavailableReason]);
  const send = () => {
    if (props.busy || !props.canSend || !draft.selectedModel || unavailableReason) return;
    props.onSend(selection);
  };
  const placeholder = props.isEditing ? "描述要如何修改当前图像" : "描述要创建的图像";
  return (
    <form
      data-moss-images-composer-frame
      data-moss-composer-provider={selection.provider}
      data-moss-composer-provider-instance={selection.instanceId}
      className="mx-auto w-full max-w-[768px] rounded-composer border border-border/60 bg-surface p-2 shadow-[0_2px_3px_rgba(0,0,0,0.02),0_12px_32px_rgba(0,0,0,0.03)]"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onPasteCapture={(event) => {
        const files = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === "file")
          .flatMap((item) => {
            const file = item.getAsFile();
            return file ? [file] : [];
          });
        if (files.length) {
          event.preventDefault();
          event.stopPropagation();
          props.onPasteFiles(files);
        }
      }}
    >
      {props.beforeEditor}
      <div data-moss-images-composer className="px-1 pt-1.5 pb-1">
        <ComposerPromptEditor
          ref={editorRef}
          value={props.prompt}
          cursor={cursor}
          terminalContexts={[]}
          disabled={props.busy}
          placeholder={placeholder}
          ariaLabel={placeholder}
          onRemoveTerminalContext={() => {}}
          onChange={(value, nextCursor) => {
            setCursor(Math.min(nextCursor, 8_000));
            props.onPromptChange(value.slice(0, 8_000));
          }}
          onPaste={() => {}}
          onCommandKeyDown={(key, event) => {
            if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
            send();
            return true;
          }}
        />
      </div>
      {props.attachments}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="添加参考图"
          disabled={!props.canAttach}
          onClick={props.onAttach}
        >
          <PlusIcon className="size-4" />
        </Button>
        <span className="flex-1" />
        <ScratchModelPickers
          variant="combined"
          draft={draft}
          catalog={catalog}
          providerStatuses={providerStatuses}
          prompt={props.prompt}
          onPromptChange={props.onPromptChange}
          onSelectionCommitted={() => editorRef.current?.focus()}
          disabled={props.busy}
        />
        <MossImagesVoiceInput
          project={props.project}
          scopeId={draft.scratchThreadId}
          selection={selection}
          disabled={props.busy}
          onTranscript={(text) =>
            props.onPromptChange([props.prompt, text].filter(Boolean).join(" ").slice(0, 8_000))
          }
        />
        {props.busy ? (
          <Button type="button" variant="ghost" size="sm" onClick={props.onStop}>
            停止等待
          </Button>
        ) : (
          <Button
            type="submit"
            variant="prominent"
            size="icon-sm"
            aria-label={props.isEditing ? "编辑图像" : "生成图像"}
            data-moss-images-generate
            className="rounded-full"
            disabled={!props.canSend || !draft.selectedModel || Boolean(unavailableReason)}
          >
            <ComposerSendArrowIcon aria-hidden="true" className="size-5 shrink-0 translate-y-px" />
          </Button>
        )}
      </div>
      {unavailableReason && (
        <p role="status" className="px-2 pt-2 text-ui-sm text-muted-foreground">
          {unavailableReason}
        </p>
      )}
      {props.notice}
    </form>
  );
}
