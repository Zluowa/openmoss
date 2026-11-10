import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useCallback, useEffect } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useRunningImportsStore } from "~/lib/runningImportsStore";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { useProjectImportDialogStore } from "./projectImportDialogStore";

export const PROJECT_IMPORT_ANNOUNCEMENT_STORAGE_KEY = "moss:project-import-announcement:v1";
export const ProjectImportAnnouncementSeenSchema = Schema.Array(Schema.String);
export const EMPTY_PROJECT_IMPORT_ANNOUNCEMENT_SEEN: readonly string[] = [];

export function useProjectImportAnnouncement() {
  const installation = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.worktreesDir,
  }).data;
  const [seen, setSeen] = useLocalStorage(
    PROJECT_IMPORT_ANNOUNCEMENT_STORAGE_KEY,
    EMPTY_PROJECT_IMPORT_ANNOUNCEMENT_SEEN,
    ProjectImportAnnouncementSeenSchema,
  );
  const startupSettled = useOnboardingDialogStore((state) => state.startupGateSettled);
  const onboardingOpen = useOnboardingDialogStore((state) => state.isOpen);
  const dialogOpen = useProjectImportDialogStore((state) => state.isOpen);
  // An import running anywhere (the welcome tour's import step, Settings → Import, the import
  // dialog) means the person already uses the feature.
  const importing = useRunningImportsStore((state) => Object.keys(state.importsById).length > 0);
  const markSeen = useCallback(() => {
    if (installation)
      setSeen((current) => (current.includes(installation) ? current : [...current, installation]));
  }, [installation, setSeen]);
  // The welcome tour already presents this feature, and an import that ran makes it moot;
  // don't announce it again afterwards.
  useEffect(() => {
    if ((onboardingOpen || dialogOpen || importing) && installation && !seen.includes(installation))
      markSeen();
  }, [dialogOpen, importing, installation, markSeen, onboardingOpen, seen]);
  return {
    visible: Boolean(
      startupSettled &&
      installation &&
      !seen.includes(installation) &&
      !onboardingOpen &&
      !dialogOpen &&
      !importing,
    ),
    markSeen,
  };
}
