// FILE: ExternalImage.tsx
// Purpose: A remote image in a chat message, drawn as the desktop chat draws it: the image
//          is never fetched in the transcript; a 160x128 "Show Image" box stands in its
//          place, and pressing it asks before opening the address in the browser.
// Layer: Chat transcript UI
// Exports: ExternalImage

import { HitArea } from "~/components/ui/hit-area";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useTranslation } from "../../../localization";
import { parseExternalImageSrc } from "./externalImageHosts";

export function ExternalImage(props: { src: string; alt: string }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const parsed = parseExternalImageSrc(props.src);
  if (!parsed) return <span>{props.alt}</span>;
  const href = parsed.url.href;
  return (
    <>
      <HitArea
        type="button"
        data-external-image=""
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setAsking(true);
        }}
        className="inline-grid h-32 w-40 cursor-interaction items-center justify-items-center rounded-card border border-border bg-foreground/[0.035] p-4 align-top font-sans text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("transcript.image.show")}
      </HitArea>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("transcript.image.openTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {parsed.url.host}
              <br />
              {href}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t("transcript.image.cancel")}
            </Button>
            <Button
              onClick={() => {
                setAsking(false);
                window.open(href, "_blank", "noopener,noreferrer");
              }}
            >
              {t("transcript.image.openLink")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
