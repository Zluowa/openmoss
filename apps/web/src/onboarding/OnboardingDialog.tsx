// FILE: OnboardingDialog.tsx
// Purpose: First-run welcome tour: intro → feature tour → agents → appearance → project → done.
//          Owns step navigation and the per-run results the final summary reads.
// Layer: Web UI overlay (mounted once from the root route)
//
// Steps share an 800×540 baseline frame that follows the UI scale and is capped
// by the viewport; hero steps (welcome, done) center their scrollable content in it.

import { VISIBLE_PROVIDER_DESCRIPTORS } from "../betaFeatures";
import { useEffect, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_BASE_NAME } from "~/branding";
import { MossLogo } from "~/components/MossLogo";
import { useAnnouncementSheetSlot } from "~/components/announcementSheetSlot";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useTheme } from "~/hooks/useTheme";
import { CheckIcon } from "~/lib/icons";
import { findProviderStatus, resolveAgentReadiness } from "~/lib/providerAvailability";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { useStore } from "~/store";
import { codeThemeLabel } from "~/theme/theme.logic";
import { ONBOARDING_INSET_CLASS_NAME } from "./layout";
import {
  classifyProviderSetup,
  describeOnboardingAgentSummary,
  describeOnboardingDoneSummary,
  isOnboardingSetupStep,
  nextOnboardingStep,
  ONBOARDING_STEPS,
  previousOnboardingStep,
  summarizeProviderSetup,
  type OnboardingStep,
} from "./logic";
import { useOnboardingDialogStore } from "./onboardingDialogStore";
import { OnboardingStepFooter } from "./OnboardingStepFooter";
import { DoneStep } from "./steps/DoneStep";
import { FeatureTourStep } from "./steps/FeatureTourStep";
import type { ProjectImportPrimaryAction } from "~/projectImport/ProjectImportPanel";
import { ProjectStep, type OnboardingProjectResult } from "./steps/ProjectStep";
import { ProvidersStep } from "./steps/ProvidersStep";
import { ThemeStep } from "./steps/ThemeStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { useProviderDetection } from "./useProviderDetection";

const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: `Welcome to ${APP_BASE_NAME}`,
  tour: `What ${APP_BASE_NAME} can do`,
  providers: "Choose your agents",
  theme: "Pick an appearance",
  project: "Add your first project",
  done: "You're all set",
};

const STEP_DESCRIPTIONS: Record<Exclude<OnboardingStep, "done">, string> = {
  welcome: "A local-first workspace for coding agents. Setup takes about a minute.",
  tour: "",
  providers: `Agents on this computer are found automatically. Uncheck any you don't want ${APP_BASE_NAME} to use.`,
  theme: "Applies live behind this window. Change it anytime in Settings → Appearance.",
  project: "Bring in conversations from the agents on this computer.",
};

/** Welcome and Done are hero steps: centered header, no step counter, centered body. */
function isHeroStep(step: OnboardingStep): boolean {
  return step === "welcome" || step === "done";
}

function OnboardingFlow(props: {
  onComplete: () => void;
  projectBusy: boolean;
  onProjectBusyChange: (busy: boolean) => void;
}) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [projectResults, setProjectResults] = useState<ReadonlyArray<OnboardingProjectResult>>([]);
  // The import's own primary action, so "Import N conversations" stays in the footer.
  const [importAction, setImportAction] = useState<ProjectImportPrimaryAction | null>(null);
  const { settings } = useAppSettings();
  const statuses = useProviderStatusesForLocalConfig();
  const providerDetection = useProviderDetection();
  const { activeTheme } = useTheme();
  const { locale } = useTranslation();
  const existingProjectCount = useStore((store) => store.projects.length);

  const goBack = () => setStep(previousOnboardingStep(step));
  const goNext = () => setStep(nextOnboardingStep(step));

  // Once the user reaches a setup step the first-run gate must not auto-close the dialog.
  const markEngaged = useOnboardingDialogStore((store) => store.markEngaged);
  useEffect(() => {
    if (isOnboardingSetupStep(step)) markEngaged();
  }, [markEngaged, step]);

  const providerSummary = summarizeProviderSetup(
    VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => {
      const status = findProviderStatus(statuses, descriptor.kind, descriptor.kind);
      return {
        provider: descriptor.kind,
        state: classifyProviderSetup({
          readiness: status ? resolveAgentReadiness(status) : null,
          disabled: settings.disabledProviders.includes(descriptor.kind),
          detecting: providerDetection.detecting,
          detectionFailed: providerDetection.failed,
        }),
      };
    }),
  );
  const doneSummary = describeOnboardingDoneSummary({
    agents: describeOnboardingAgentSummary(providerSummary, locale),
    themeLabel: codeThemeLabel(activeTheme.codeThemeId, locale),
    projectsAdded: projectResults.length,
    existingProjects: existingProjectCount,
    locale,
  });

  const description = step === "done" ? doneSummary : STEP_DESCRIPTIONS[step];
  const stepIndex = ONBOARDING_STEPS.indexOf(step);
  const hero = isHeroStep(step);

  const primaryAction = (() => {
    switch (step) {
      case "welcome":
        return { label: "Get started", onPrimary: goNext };
      case "tour":
        return { label: "Set up", onPrimary: goNext };
      case "providers":
      case "theme":
        return { label: "Continue", onPrimary: goNext };
      case "project":
        if (importAction) {
          return {
            label: importAction.label,
            onPrimary: importAction.run,
            disabled: importAction.disabled,
            secondary: projectResults.length > 0 ? "Continue" : "Skip for now",
          };
        }
        return projectResults.length > 0
          ? { label: "Continue", onPrimary: goNext }
          : { label: "Skip for now", onPrimary: goNext };
      case "done":
        return { label: `Start using ${APP_BASE_NAME}`, onPrimary: props.onComplete };
    }
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col outline-none" tabIndex={-1}>
      <DialogHeader
        className={cn(
          "shrink-0 gap-1.5 pt-8 pb-0",
          ONBOARDING_INSET_CLASS_NAME,
          hero && "items-center text-center",
        )}
      >
        {step === "welcome" ? <MossLogo aria-hidden className="mb-3.5 size-11" /> : null}
        {step === "done" ? (
          <span
            aria-hidden
            className="mb-3.5 flex size-11 items-center justify-center rounded-full bg-success/8 text-success dark:bg-success/16"
          >
            <CheckIcon className="size-5" />
          </span>
        ) : null}
        {hero ? null : (
          <span className="text-ui-sm font-medium tracking-[0.04em] text-muted-foreground/70 uppercase">
            Step {stepIndex + 1} of {ONBOARDING_STEPS.length}
          </span>
        )}
        <DialogTitle className="text-title tracking-[-0.01em]">{STEP_TITLES[step]}</DialogTitle>
        {description ? (
          <DialogDescription className="max-w-[560px] text-ui-lg leading-normal">
            {description}
          </DialogDescription>
        ) : null}
      </DialogHeader>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto pt-6",
          step === "providers" && "overflow-hidden pt-4",
          ONBOARDING_INSET_CLASS_NAME,
          hero && "[justify-content:safe_center] pb-6",
        )}
      >
        {step === "welcome" ? <WelcomeStep /> : null}
        {step === "tour" ? <FeatureTourStep /> : null}
        {step === "providers" ? <ProvidersStep detection={providerDetection} /> : null}
        {step === "theme" ? <ThemeStep /> : null}
        {step === "project" ? (
          <ProjectStep
            results={projectResults}
            onBusyChange={props.onProjectBusyChange}
            onImportActionChange={setImportAction}
            onResult={(result) =>
              setProjectResults((current) =>
                current.some((entry) => entry.projectId === result.projectId)
                  ? current
                  : [...current, result],
              )
            }
          />
        ) : null}
        {step === "done" ? <DoneStep /> : null}
      </div>
      <OnboardingStepFooter
        step={step}
        onBack={goBack}
        onSkip={props.onComplete}
        primaryLabel={primaryAction.label}
        onPrimary={primaryAction.onPrimary}
        primaryDisabled={"disabled" in primaryAction ? primaryAction.disabled : false}
        primaryBusy={step === "project" && props.projectBusy && !importAction}
        navigationLocked={props.projectBusy}
        {...("secondary" in primaryAction && primaryAction.secondary
          ? { secondaryLabel: primaryAction.secondary, onSecondary: goNext }
          : {})}
      />
    </div>
  );
}

export function OnboardingDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  // The first-run gate already decides eligibility. Replays remain available after
  // a startup handoff, but still share the slot with any surface currently showing.
  const { open } = useAnnouncementSheetSlot(props.open, true, false);
  // Project creation cannot be aborted: closing the tour mid-create would report a skip
  // while a project still appears afterwards, so dismissal waits for it to settle.
  const [projectBusy, setProjectBusy] = useState(false);
  const handleOpenChange = (open: boolean) => {
    if (!open && projectBusy) return;
    props.onOpenChange(open);
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        showCloseButton
        className="h-[min(calc(540px*var(--app-ui-scale,1)),100%)] max-h-full max-w-[800px]"
      >
        {/* Remount per open so a replay from Settings starts at the first step. */}
        {open ? (
          <OnboardingFlow
            onComplete={props.onComplete}
            projectBusy={projectBusy}
            onProjectBusyChange={setProjectBusy}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
