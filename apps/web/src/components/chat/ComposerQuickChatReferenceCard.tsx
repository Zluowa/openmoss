// FILE: ComposerQuickChatReferenceCard.tsx
// Purpose: Render a durable Quick Chat conversation reference as a compact
//   composer attachment instead of exposing its serialized context payload.
// Layer: Chat composer presentation

import { ChatBubbleIcon } from "~/lib/icons";
import type { QuickChatReference } from "~/lib/quickChatReference";

import { AttachmentCard } from "./AttachmentCard";

export function ComposerQuickChatReferenceCard({
  reference,
  onRemove,
}: {
  readonly reference: QuickChatReference;
  readonly onRemove: () => void;
}) {
  return (
    <AttachmentCard
      size="sm"
      icon={<ChatBubbleIcon className="size-3" />}
      title={reference.title}
      subtitle="Quick Chat reference"
      onRemove={onRemove}
      removeLabel={`Remove Quick Chat reference (${reference.title})`}
      data-quick-chat-reference-id={reference.conversationId}
      aria-label={`Quick Chat reference: ${reference.title}`}
    />
  );
}
