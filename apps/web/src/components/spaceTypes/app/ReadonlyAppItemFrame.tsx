// FILE: ReadonlyAppItemFrame.tsx
// Purpose: Shared readonly rendering for authorized AppItems and template previews.
// Layer: Web view; authorization stays in the owner/guest adapter

import {
  isReadonlyAppItemDocument,
  prepareReadonlyAppItemHtml,
  type ReadonlyAppItemContext,
} from "@moss/shared/readonlyAppItem";
import { useEffect, useRef, useState } from "react";

import {
  createReadonlyAppItemFrameController,
  type ReadonlyAppItemFrameStatus,
} from "./readonlyAppItemFrameController";
import { ReadonlyAppItemFrameSurface } from "./ReadonlyAppItemFrameSurface";

export function ReadonlyAppItemFrame(props: {
  readonly context: ReadonlyAppItemContext;
  readonly height?: number;
  readonly className?: string;
}) {
  const element = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<ReadonlyAppItemFrameStatus>("loading");
  const { context } = props;
  const { document } = context;
  const valid =
    isReadonlyAppItemDocument(document) &&
    (context.audience !== "guest" || (!!context.grantId && typeof context.expiresAt === "string"));
  const html = document.html;
  const identity = JSON.stringify([context.audience, document.source, document.publicMetadata]);
  const grantId = context.audience === "guest" ? context.grantId : "";
  const expiresAt = context.audience === "guest" ? context.expiresAt : undefined;
  useEffect(() => {
    const frame = element.current;
    if (!frame) return;
    if (!valid || (expiresAt !== undefined && !grantId)) {
      frame.src = "about:blank";
      setStatus("invalid");
      return;
    }
    const controller = createReadonlyAppItemFrameController({
      element: frame,
      hostUrl: new URL(`${import.meta.env.BASE_URL}space-app-preview.html`, window.location.href)
        .href,
      parentOrigin: window.location.origin,
      html: prepareReadonlyAppItemHtml(html),
      ...(expiresAt === undefined ? {} : { expiresAt: Date.parse(expiresAt) }),
      onStatus: setStatus,
    });
    return controller.dispose;
    // Identity includes every source/revision/metadata field; HTML is compared
    // by complete content, so equal-length edits also reopen with a fresh nonce.
  }, [identity, html, valid, grantId, expiresAt]);
  return (
    <ReadonlyAppItemFrameSurface
      frameRef={element}
      title={document.publicMetadata.title}
      audience={context.audience}
      status={status}
      {...(props.height === undefined ? {} : { height: props.height })}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}
