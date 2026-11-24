// FILE: StartupSurfaces.tsx
// Purpose: The surfaces the app root mounts beside every screen at launch. Nothing here opens by
//          itself on sign-in, first launch or an update (WALK-6 H-1): the feature tour opens only
//          from 设置 → 关于 → 重播 and Safari access only from its setup button.
// Layer: Root web overlay

import { FeatureTourDialog } from "./FeatureTourDialog";
import { SafariAccessOnboarding } from "./SafariAccessOnboarding";

export function StartupSurfaces() {
  return (
    <SafariAccessOnboarding>
      <FeatureTourDialog />
    </SafariAccessOnboarding>
  );
}
