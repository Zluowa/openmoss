// FILE: ProfilePage.tsx
// Purpose: Dedicated full-page ChatGPT-style Moss Profile screen opened directly by
//          clicking the user's avatar. Includes `← 返回 Moss` back navigation, direct
//          shortcuts to Settings → 账号 and Settings, and hosts SettingsDialog so
//          opening Settings from Profile works in place without leaving `/profile`.
// Layer: Web profile feature (top-level route screen)

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { MossBackToAppButton, useMossOpaqueSurface } from "~/components/auth/MossAuthShell";
import {
  ProfileContent,
  ProfileSkeleton,
  useProfileAccountContext,
} from "~/components/settings/ProfileSettingsPanel";
import { SettingsDialog } from "~/components/settings/SettingsDialog";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import { CirclePersonIcon, SettingsIcon } from "~/lib/icons";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn, isMacNavigatorPlatform, isMacPlatform } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { openSettings as openSettingsDialog } from "~/settingsDialogStore";
import { getProfileCopy } from "./profileCopy";
import { useMossProfileMutations, useMossProfileState } from "./useMossProfile";

export function ProfilePage() {
  useMossOpaqueSurface();
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);
  const navigate = useNavigate();
  const [shareOpen, setShareOpen] = useState(false);

  const coreQuery = useQuery(serverProfileStatsQueryOptions());
  const tokenQuery = useQuery(serverProfileTokenStatsQueryOptions());
  const accountContext = useProfileAccountContext();
  const profileQuery = useMossProfileState();
  const { updateMutation, uploadAvatarMutation, checkHandle } = useMossProfileMutations();

  // Keep ⌘, / Ctrl+, working while viewing `/profile`.
  useEffect(() => {
    const macPlatform = typeof navigator !== "undefined" && isMacPlatform(navigator.platform ?? "");
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = macPlatform ? event.metaKey : event.ctrlKey;
      if (
        !modifier ||
        event.altKey ||
        event.shiftKey ||
        event.key !== "," ||
        event.defaultPrevented
      ) {
        return;
      }
      event.preventDefault();
      openSettingsDialog();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main
      className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground"
      data-testid="moss-profile-page"
    >
      <header
        className={cn(
          "drag-region relative z-10 flex h-11 shrink-0 items-center justify-between border-b border-border/55 bg-background pr-36 pl-2",
          isElectron && isMacNavigatorPlatform() && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
        )}
      >
        <div className="no-drag flex items-center">
          <MossBackToAppButton data-testid="moss-profile-back">
            {copy.backToMoss}
          </MossBackToAppButton>
        </div>
        <div className="no-drag flex items-center gap-1">
          {coreQuery.data ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShareOpen(true)}
              data-testid="moss-profile-share"
            >
              <CentralIcon name="share-os" className="size-4" />
              {copy.share}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openSettingsDialog({ section: "account" })}
            data-testid="moss-profile-open-account"
          >
            <CirclePersonIcon className="size-4" />
            {copy.openAccountSettings}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openSettingsDialog()}
            data-testid="moss-profile-open-settings"
          >
            <SettingsIcon className="size-4" />
            {copy.openSettings}
          </Button>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8 sm:py-10"
        data-testid="moss-profile-scroll"
      >
        <div className="mx-auto w-full max-w-3xl min-w-0">
          {coreQuery.isPending ? (
            <ProfileSkeleton />
          ) : coreQuery.isError || !coreQuery.data ? (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <p className="text-ui leading-snug text-muted-foreground">{copy.loadStatsError}</p>
              <Button variant="outline" size="sm" onClick={() => void coreQuery.refetch()}>
                {copy.tryAgain}
              </Button>
            </div>
          ) : (
            <ProfileContent
              account={accountContext.state}
              planName={accountContext.planName}
              accountSummary={accountContext.accountSummary}
              profileState={profileQuery.profileState}
              presentation="page"
              shareOpen={shareOpen}
              onShareOpenChange={setShareOpen}
              onSignIn={() => void navigate({ to: "/login" })}
              onOpenAccountSettings={() => openSettingsDialog({ section: "account" })}
              onRetryProfileSync={() => void profileQuery.refetch()}
              onUpdateProfile={async (input) => {
                await updateMutation.mutateAsync(input);
              }}
              onUploadAvatar={async (input) => {
                await uploadAvatarMutation.mutateAsync(input);
              }}
              onCheckHandle={checkHandle}
              stats={coreQuery.data}
              tokenStats={tokenQuery.data ?? null}
              tokensPending={tokenQuery.isPending}
            />
          )}
        </div>
      </div>

      <SettingsDialog />
    </main>
  );
}
