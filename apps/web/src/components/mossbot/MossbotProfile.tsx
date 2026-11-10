import { lazy, Suspense, useState } from "react";
import type { ProjectAgentSummary } from "@moss/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FoldersIcon,
  MonitorIcon,
  PluginIcon,
  ShareIcon,
  EllipsisIcon,
} from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { useAutomations } from "~/routes/-automations.shared";
import { GroupAutomationsSection } from "~/components/chat/project/GroupOverview";
import { collectGroupAutomations } from "~/components/chat/project/groupOverview.logic";
import { useMossbotCopy } from "./mossbot.copy";
import { MossbotAvatar } from "./MossbotAvatar";
import type { GroupSettingsSection } from "~/components/chat/group/groupSettingsDialog.logic";

const GroupSettingsDialog = lazy(() =>
  import("~/components/chat/group/GroupSettingsDialog").then((module) => ({
    default: module.GroupSettingsDialog,
  })),
);
const MossbotShareTemplate = lazy(() =>
  import("./MossbotShareTemplate").then((module) => ({ default: module.MossbotShareTemplate })),
);

export function MossbotProfile({
  assistant,
  onClose,
}: {
  assistant: ProjectAgentSummary;
  onClose: () => void;
}) {
  const { t, errorText } = useMossbotCopy();
  const navigate = useNavigate();
  const [section, setSection] = useState<GroupSettingsSection | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const project = useStore((state) =>
    state.projects.find((item) => item.id === assistant.projectId),
  );
  const muted = useMossbotPreferencesStore((state) =>
    state.mutedProjectIds.includes(assistant.projectId),
  );
  const overview = useQuery({
    queryKey: ["mossbot", "profile", assistant.projectId],
    queryFn: async () => {
      const api = readNativeApi()?.projectAgent;
      if (!api) throw new Error(t("Moss is reconnecting. Try again once connected."));
      return api.getOverview({ projectId: assistant.projectId });
    },
  });
  const automations = useAutomations();
  const definitions = collectGroupAutomations({
    definitions: automations.data.definitions,
    groupProjectId: assistant.projectId,
    memberThreadIds: new Set([
      ...(assistant.memberThreadIds ?? []),
      ...(assistant.coordinatorThreadId ? [assistant.coordinatorThreadId] : []),
    ]),
  }).filter((item) => item.schedule.type !== "project-event" && item.schedule.type !== "manual");
  const activeCount = definitions.filter((item) => item.enabled).length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="mossbot-profile">
        <header className="mossbot-profile-nav">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("Back")}
            onClick={() => (tasksOpen ? setTasksOpen(false) : onClose())}
          >
            <ArrowLeftIcon />
          </Button>
          {tasksOpen && <span className="text-ui font-medium">{t("Scheduled tasks")}</span>}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Share as template…")}
              onClick={() => setSharing(true)}
            >
              <ShareIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Assistant settings")}
              onClick={() => setSection("general")}
            >
              <EllipsisIcon />
            </Button>
          </div>
        </header>
        <div className="mossbot-profile-scroll">
          <div className="mossbot-profile-identity">
            <MossbotAvatar
              icon={assistant.coordinatorIcon}
              color={assistant.coordinatorColor}
              className="mossbot-profile-avatar"
            />
            <DialogTitle className="mt-3 max-w-full break-words text-center text-ui-xl font-medium [overflow-wrap:anywhere]">
              {assistant.coordinatorName ?? "Moss"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("Your assistant’s personality, memory, models, and access.")}
            </DialogDescription>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => setSection("general")}
            >
              {t("Edit")}
            </Button>
          </div>
          {tasksOpen ? (
            <div className="mossbot-profile-card p-3">
              <GroupAutomationsSection
                definitions={definitions}
                automations={automations}
                onOpenAutomation={(automationId) => {
                  onClose();
                  void navigate({ to: "/automations/$automationId", params: { automationId } });
                }}
              />
            </div>
          ) : (
            <>
              <div className="mossbot-profile-card">
                <button
                  type="button"
                  className="mossbot-profile-row"
                  onClick={() => setTasksOpen(true)}
                >
                  <ClockIcon />
                  <span>{t("Scheduled tasks")}</span>
                  <small>
                    {activeCount} {t("enabled")}
                  </small>
                  <ChevronRightIcon />
                </button>
                <button
                  type="button"
                  className="mossbot-profile-row"
                  onClick={() => setSection("memory")}
                >
                  <FoldersIcon />
                  <span>{t("Knowledge library")}</span>
                  <ChevronRightIcon />
                </button>
                <button
                  type="button"
                  className="mossbot-profile-row"
                  onClick={() => setSection("environment")}
                >
                  <MonitorIcon />
                  <span>{t("Computer")}</span>
                  <small>{t("Access settings")}</small>
                  <ChevronRightIcon />
                </button>
                <button
                  type="button"
                  className="mossbot-profile-row"
                  onClick={() => setSection("plugins")}
                >
                  <PluginIcon />
                  <span>{t("Skills & apps")}</span>
                  <ChevronRightIcon />
                </button>
              </div>
              <div className="mossbot-profile-card mt-4">
                <div className="mossbot-profile-row">
                  <label htmlFor={`mossbot-notify-${assistant.projectId}`} className="flex-1">
                    {t("Notifications")}
                  </label>
                  <Switch
                    id={`mossbot-notify-${assistant.projectId}`}
                    aria-label={t("Notifications")}
                    checked={!muted}
                    onCheckedChange={(checked) =>
                      useMossbotPreferencesStore.getState().setMuted(assistant.projectId, !checked)
                    }
                    aria-describedby="mossbot-notification-help"
                  />
                </div>
              </div>
              <p
                id="mossbot-notification-help"
                className="px-3 pt-2 text-ui-sm text-muted-foreground"
              >
                {t("Notify me when this assistant finishes or needs me.")}
              </p>
              <Button
                variant="link"
                size="sm"
                className="mt-1 px-3 text-ui-sm text-muted-foreground"
                onClick={() => {
                  onClose();
                  void navigate({ to: "/settings", search: { section: "notifications" } });
                }}
              >
                {t("Notification settings")}
              </Button>
            </>
          )}
          {overview.isError && (
            <p role="alert" className="mt-4 text-ui-sm text-destructive">
              {errorText(overview.error)}
              <Button variant="link" onClick={() => void overview.refetch()}>
                {t("Retry")}
              </Button>
            </p>
          )}
        </div>
        {section && (
          <Suspense
            fallback={
              <p role="status" className="p-4 text-ui">
                {t("Loading…")}
              </p>
            }
          >
            <GroupSettingsDialog
              open
              mode="edit"
              projectId={assistant.projectId}
              projectName={assistant.coordinatorName ?? "Moss"}
              workspacePath={project?.cwd ?? ""}
              defaultModelSelection={
                overview.data?.config?.coordinatorModelSelection ??
                project?.defaultModelSelection ??
                null
              }
              initialSection={section}
              onOpenChange={(open) => {
                if (!open) {
                  setSection(null);
                  void overview.refetch();
                }
              }}
            />
          </Suspense>
        )}
        {sharing && (
          <Suspense fallback={null}>
            <MossbotShareTemplate assistant={assistant} onClose={() => setSharing(false)} />
          </Suspense>
        )}
      </DialogPopup>
    </Dialog>
  );
}
