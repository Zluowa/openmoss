// FILE: GuestComposer.tsx
// Purpose: Where the guest writes a message and attaches files for the owner to send, on the
//          app's composer surface with its footer, attachment chips, and send control.
// Layer: Guest page UI
// Why: The owner's prompt editor is a Lexical editor wired to mentions, slash commands, and the
//      draft store; a guest only types text, so a plain textarea sits in the same shell, with
//      the editor's own typography and padding tokens.

import {
  GUEST_MESSAGE_MAX_LENGTH,
  GUEST_PENDING_MESSAGE_LIMIT,
  type ChatAttachmentId,
  type GuestThreadModel,
} from "@synara/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { ChatComposerFooter } from "~/components/chat/ChatComposerFooter";
import { ComposerColumnFrame } from "~/components/chat/ComposerColumnFrame";
import { ComposerImageAttachmentChip } from "~/components/chat/ComposerImageAttachmentChip";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { FileAttachmentChip } from "~/components/chat/FileAttachmentChip";
import {
  COMPOSER_ACTION_CIRCLE_CLASS_NAME,
  COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
  COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftDomain";
import { PaperclipIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { guestFilesProblem, isImageFile } from "../files";
import { GUEST_ACCESS_ERROR_KEY, describeGuestFailure } from "../guestCopy";
import { useCoarsePointer } from "../hooks";
import type { GuestTransport } from "../transport";
import { guestModelLabel } from "./GuestHeader";

export interface GuestComposerNotice {
  readonly text: string;
  readonly tone: "hint" | "error";
}

const MAX_TEXTAREA_HEIGHT_PX = 200;

type StagedAttachment = ComposerImageAttachment | ComposerFileAttachment;

const stagedId = (() => {
  let next = 0;
  return () => `guest-staged-${(next += 1)}` as ChatAttachmentId;
})();

function stageFile(file: File): StagedAttachment {
  const base = {
    id: stagedId(),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    file,
  };
  return isImageFile(file)
    ? { ...base, type: "image", previewUrl: URL.createObjectURL(file) }
    : { ...base, type: "file" };
}

const releaseStaged = (staged: StagedAttachment) => {
  if (staged.type === "image") URL.revokeObjectURL(staged.previewUrl);
};

export function GuestComposer({
  transport,
  model,
  pendingCount,
  panels,
  onExpandImage,
  onSubmitted,
  onNotice,
}: {
  readonly transport: GuestTransport;
  readonly model: GuestThreadModel;
  readonly pendingCount: number;
  /** Panels stacked above the input (the guest's own waiting messages). */
  readonly panels?: React.ReactNode;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onSubmitted: () => void;
  /** The line under the composer: the standing hint, or the latest error. */
  readonly onNotice: (notice: GuestComposerNotice) => void;
}) {
  const { t, format } = useTranslation();
  const coarsePointer = useCoarsePointer();
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<ReadonlyArray<StagedAttachment>>([]);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  useEffect(() => () => stagedRef.current.forEach(releaseStaged), []);

  const limitReached = pendingCount >= GUEST_PENDING_MESSAGE_LIMIT;
  const trimmed = text.trim();
  const hasContent = trimmed !== "" || staged.length > 0;

  const hint = limitReached
    ? format("guest.composer.limitReached", { count: pendingCount })
    : coarsePointer
      ? t("guest.composer.hint")
      : t("guest.composer.hintDesktop");
  const showHint = useCallback(() => onNotice({ text: hint, tone: "hint" }), [hint, onNotice]);
  useEffect(() => {
    showHint();
  }, [showHint]);

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, []);

  const addFiles = (added: ReadonlyArray<File>) => {
    if (added.length === 0) return;
    const problem = guestFilesProblem([...staged.map((item) => item.file), ...added]);
    if (problem !== null) {
      onNotice({ text: t(GUEST_ACCESS_ERROR_KEY[problem]), tone: "error" });
      return;
    }
    showHint();
    setStaged((current) => [...current, ...added.map(stageFile)]);
  };

  const removeStaged = (id: string) => {
    setStaged((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed) releaseStaged(removed);
      return current.filter((item) => item.id !== id);
    });
    showHint();
  };

  const send = async () => {
    if (!hasContent || sending || limitReached) return;
    setSending(true);
    const sent = staged;
    const failure = await transport.submit(
      trimmed,
      sent.map((item) => item.file),
    );
    setSending(false);
    if (failure !== null) {
      onNotice({ text: describeGuestFailure(failure, t), tone: "error" });
      return;
    }
    // Keep anything typed or attached while the request was in flight.
    setText((current) => (current.trim() === trimmed ? "" : current));
    setStaged((current) => {
      const remaining = current.filter((item) => !sent.includes(item));
      sent.forEach(releaseStaged);
      return remaining;
    });
    requestAnimationFrame(resize);
    showHint();
    onSubmitted();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // As in the app: Enter sends, Shift+Enter adds a line; touch keyboards send with the button.
    if (coarsePointer || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void send();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) return;
    const hasImage = pasted.some(isImageFile);
    if (!hasImage && event.clipboardData.getData("text/plain") !== "") return;
    event.preventDefault();
    addFiles(pasted);
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    resize();
  };

  const images = staged.filter((item): item is ComposerImageAttachment => item.type === "image");
  const files = staged.filter((item): item is ComposerFileAttachment => item.type === "file");
  const modelLabel = guestModelLabel(model);

  return (
    <form
      className="relative z-10 w-full overflow-visible"
      data-chat-composer-form="true"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <ComposerColumnFrame>
        <div data-composer-panels="">{panels}</div>
        <div
          className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, limitReached && "opacity-70")}
          aria-disabled={limitReached}
        >
          <div data-chat-composer-surface="" className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
            <div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
              {staged.length > 0 ? (
                <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap items-start gap-1.5">
                  {images.map((image) => (
                    <ComposerImageAttachmentChip
                      key={image.id}
                      image={image}
                      images={images}
                      nonPersisted={false}
                      onExpandImage={onExpandImage}
                      onRemoveImage={removeStaged}
                    />
                  ))}
                  {files.map((file) => (
                    <FileAttachmentChip
                      key={file.id}
                      file={file}
                      variant="card"
                      onRemove={removeStaged}
                    />
                  ))}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                aria-label={t("guest.composer.label")}
                placeholder={t("guest.composer.placeholder")}
                rows={1}
                maxLength={GUEST_MESSAGE_MAX_LENGTH}
                value={text}
                disabled={limitReached}
                enterKeyHint={coarsePointer ? "enter" : "send"}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                className={cn(
                  "block max-h-[200px] w-full resize-none bg-transparent text-foreground focus:outline-none disabled:cursor-not-allowed",
                  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
                  COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
                  // Phones zoom into fields set below 16px.
                  "max-sm:text-[16px]",
                  `placeholder:${COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME}`,
                )}
              />
            </div>
            <ChatComposerFooter
              layout="block"
              isComposerFooterCompact={coarsePointer}
              leadingControls={
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    tabIndex={-1}
                    aria-hidden
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files ?? []));
                      // The same file can be picked again after it is removed.
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="circle"
                    className={COMPOSER_ACTION_CIRCLE_CLASS_NAME}
                    aria-label={t("guest.composer.attach")}
                    title={t("guest.composer.attach")}
                    disabled={limitReached}
                    data-moss-visible-attachment-control="true"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <PaperclipIcon aria-hidden="true" className="size-4" />
                  </Button>
                </>
              }
              composerPickerControls={
                <span
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 px-2 py-1",
                    COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
                  )}
                  aria-label={format("guest.model", { label: modelLabel })}
                  title={modelLabel}
                >
                  <ProviderIcon provider={model.provider} className="size-4" />
                  <span className="min-w-0 truncate">{modelLabel}</span>
                </span>
              }
              contextMeter={null}
              interactionMode="default"
              resetInteractionMode={() => {}}
              sidebarAction={null}
              voice={{
                enabled: false,
                recording: false,
                starting: false,
                waitingForAudio: false,
                transcribing: false,
                durationLabel: "",
                waveformLevels: [],
                onCancel: () => {},
                onSubmit: () => {},
                onToggle: () => {},
              }}
              pendingInput={null}
              sendState={hasContent ? "ready" : "empty"}
              submission={{
                phase: "ready",
                busy: sending,
                connecting: false,
                expired: limitReached,
                preparingImages: false,
                preparingWorktree: false,
                hasContent,
                hasPendingUserInputs: false,
                showPlanFollowUp: false,
                hasPrompt: trimmed !== "",
                onInterrupt: () => {},
                onImplementInNewThread: () => {},
              }}
            />
          </div>
        </div>
      </ComposerColumnFrame>
    </form>
  );
}
