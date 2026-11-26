// FILE: StartupSurfaces.tsx
// Purpose: The surfaces the app root mounts beside every screen at launch. Nothing here opens by
//          itself on sign-in, first launch or an update (WALK-6 H-1): Safari access opens only
//          from its setup button.
// Layer: Root web overlay

import { MossWhatsNewDialogHost } from "./MossWhatsNewDialog";
import { SafariAccessOnboarding } from "./SafariAccessOnboarding";

export function StartupSurfaces() {
  return (
    <>
      <SafariAccessOnboarding />
      <MossWhatsNewDialogHost />
    </>
  );
}
