import {
  PAGE_APP_PREVIEW_LIMITS,
  type PageGuestAppReference,
  type PageGuestView,
  type PageGuestViewRequest,
} from "@moss/contracts";
import { useEffect, useRef, useState } from "react";
import { ReadonlyAppItemFrameSurface } from "~/components/spaceTypes/app/ReadonlyAppItemFrameSurface";
import type { ReadonlyAppItemFrameStatus } from "~/components/spaceTypes/app/readonlyAppItemFrameController";
import { Button } from "~/components/ui/button";
import { AppPageGuestPlaceholder } from "./AppPageGuestPlaceholder";
import { guestAppPreviewOrigin } from "./guestAppPreviewAvailability";
import { createGuestAppPreviewFrameController } from "./guestAppPreviewFrameController";
import type { GuestAppPreviewTransport } from "./guestAppPreviewTransport";
import type { PageGuestCopy } from "./pageGuestCopy";

export function GuestAppItemPreview(props: {
  readonly shareId: string;
  readonly view: PageGuestView;
  readonly request: PageGuestViewRequest;
  readonly transport: GuestAppPreviewTransport | undefined;
  readonly copy: PageGuestCopy;
  readonly reference?: PageGuestAppReference;
}) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [broker, setBroker] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const capability = props.view.appPreview;
  useEffect(() => {
    setOrigin(null);
    setOpen(false);
    setBroker(false);
    if (!capability || !props.transport) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PAGE_APP_PREVIEW_LIMITS.operationMs);
    const prepared = Array.from(
      document.querySelectorAll<HTMLMetaElement>('meta[name="moss-app-preview-origin"]'),
      (meta) => meta.content,
    );
    void props.transport
      .config(abort.signal)
      .then((relay) => {
        if (!abort.signal.aborted) {
          const verified = guestAppPreviewOrigin(
            capability,
            relay,
            prepared,
            window.location.origin,
          );
          setBroker(
            !!verified &&
              !!props.reference &&
              capability.brokerProtocol === 1 &&
              relay?.brokerProtocol === 1 &&
              !!props.transport?.inspect,
          );
          setOrigin(verified);
          if (verified && props.reference) setOpen(true);
        }
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    capability?.contentOrigin,
    capability?.protocolVersion,
    capability?.brokerProtocol,
    props.transport,
    props.reference,
  ]);
  if (origin === null || origin !== capability?.contentOrigin || !props.transport)
    return (
      <AppPageGuestPlaceholder appPageId={props.view.page.id} mode="guest" copy={props.copy} />
    );
  return (
    <section data-guest-app-preview="" className="w-full space-y-3">
      <p className="text-ui-sm text-muted-foreground">{props.copy.previewLimit}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAttempt((value) => value + 1);
            setOpen(true);
          }}
        >
          {open ? props.copy.reopenPreview : props.copy.openPreview}
        </Button>
        {open ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {props.copy.closePreview}
          </Button>
        ) : null}
      </div>
      {open ? (
        <RemoteFrame
          key={attempt}
          broker={broker}
          shareId={props.shareId}
          contentOrigin={origin}
          view={props.view}
          request={props.request}
          {...(props.reference ? { reference: props.reference } : {})}
          transport={props.transport}
        />
      ) : null}
    </section>
  );
}

function RemoteFrame(props: {
  readonly shareId: string;
  readonly contentOrigin: string;
  readonly broker: boolean;
  readonly view: PageGuestView;
  readonly request: PageGuestViewRequest;
  readonly transport: GuestAppPreviewTransport;
  readonly reference?: PageGuestAppReference;
}) {
  const element = useRef<HTMLIFrameElement>(null);
  // Set the browsing-context target at insertion; the real two-host browser
  // regression covers the initial opaque window and rejects extra top-level pages.
  const [nonce] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<ReadonlyAppItemFrameStatus>("loading");
  const identity = JSON.stringify([
    props.shareId,
    props.contentOrigin,
    props.request,
    props.view.page.id,
    props.view.page.revision,
    props.view.page.title,
    props.reference,
  ]);
  useEffect(() => {
    if (!element.current) return;
    return createGuestAppPreviewFrameController({
      element: element.current,
      nonce,
      shareId: props.shareId,
      contentOrigin: props.contentOrigin,
      broker: props.broker,
      request: {
        ...props.request,
        pageId: props.view.page.id,
        expectedPageRevision: props.view.page.revision,
        ...(props.reference ? { reference: props.reference } : {}),
      },
      transport: props.transport,
      onStatus: setStatus,
    }).dispose;
  }, [identity, props.transport, props.broker, nonce]);
  return (
    <ReadonlyAppItemFrameSurface
      frameRef={element}
      name={`moss-app-preview-${nonce}`}
      title={props.view.page.title}
      audience="guest"
      status={status}
      height={440}
    />
  );
}
