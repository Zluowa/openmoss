// FILE: AppToolsDialog.tsx
// Purpose: Codex Desktop parity dialog for inspecting and launching an App's tools.

import type { ProviderAppInfo, ProviderAppTool } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  appToolsSummary,
  buildAppManageUrl,
  groupAppTools,
  isAppToolDisabledByAdmin,
} from "~/lib/appToolsModel";
import { AppsIcon, ChevronRightIcon, EllipsisIcon, LockIcon, MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from "./ui/menu";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function OverflowToolName({ name }: { readonly name: string }) {
  const [overflowing, setOverflowing] = useState(false);
  return (
    <Tooltip open={overflowing}>
      <TooltipTrigger
        render={
          <div
            className="truncate text-ui"
            onPointerEnter={(event) => {
              const node = event.currentTarget;
              setOverflowing(node.scrollWidth > node.clientWidth);
            }}
            onPointerLeave={() => setOverflowing(false)}
          />
        }
      >
        {name}
      </TooltipTrigger>
      <TooltipPopup>{name}</TooltipPopup>
    </Tooltip>
  );
}

function AppToolRow({ tool }: { readonly tool: ProviderAppTool }) {
  const disabledByAdmin = isAppToolDisabledByAdmin(tool);
  return (
    <div
      data-testid="app-tool-row"
      className={cn(
        "grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] gap-x-3 p-2.5",
        disabledByAdmin && "opacity-60",
      )}
    >
      <div className="min-w-0 text-foreground">
        <OverflowToolName name={tool.name} />
        {disabledByAdmin ? (
          <div className="mt-1 flex items-center gap-1 text-ui-xs text-muted-foreground">
            <LockIcon className="size-3 shrink-0" />
            Disabled by admin
          </div>
        ) : null}
      </div>
      <div className="text-ui text-muted-foreground">{tool.description}</div>
    </div>
  );
}

function AppToolSections({ tools }: { readonly tools: ReadonlyArray<ProviderAppTool> }) {
  const sections = useMemo(() => groupAppTools(tools), [tools]);
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  return (
    <div className="flex flex-col">
      {sections.map((section) => {
        const isCollapsed = collapsed[section.title] === true;
        return (
          <section key={section.title} className="border-b border-border/70 last:border-b-0">
            <button
              type="button"
              data-testid="app-tools-section-header"
              className="sticky top-0 z-10 flex w-full items-center justify-between bg-[var(--color-background-elevated-primary-opaque)] p-2.5 text-left text-ui text-foreground"
              aria-expanded={!isCollapsed}
              onClick={() =>
                setCollapsed((current) => ({
                  ...current,
                  [section.title]: !isCollapsed,
                }))
              }
            >
              <span>
                {section.title}
                <span className="ml-2 text-muted-foreground">{section.tools.length}</span>
              </span>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-muted-foreground transition-transform",
                  isCollapsed ? "-rotate-90" : "rotate-90",
                )}
              />
            </button>
            {isCollapsed ? null : (
              <div className="divide-y divide-border/70">
                {section.tools.map((tool) => (
                  <AppToolRow key={tool.name} tool={tool} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export interface AppToolsDialogProps {
  readonly app: ProviderAppInfo | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly loadTools: (app: ProviderAppInfo) => Promise<ReadonlyArray<ProviderAppTool>>;
  readonly onSetAppEnabled: (app: ProviderAppInfo, enabled: boolean) => void;
  readonly onOpenAppUrl: (url: string) => Promise<boolean>;
  readonly onTryNow: (app: ProviderAppInfo) => void;
  readonly updatingAppId?: string | null | undefined;
}

export function AppToolsDialog({
  app,
  open,
  onOpenChange,
  loadTools,
  onSetAppEnabled,
  onOpenAppUrl,
  onTryNow,
  updatingAppId,
}: AppToolsDialogProps) {
  const [tools, setTools] = useState<ReadonlyArray<ProviderAppTool>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !app) return;
    let active = true;
    setTools([]);
    setError(null);
    setLoading(true);
    void loadTools(app)
      .then((nextTools) => {
        if (!active) return;
        setTools(nextTools);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [app, loadTools, open]);

  if (!app) return null;
  const sections = groupAppTools(tools);
  const canTryNow = app.isAccessible && app.isEnabled;
  const manageUrl = buildAppManageUrl(app, false);
  const logo = app.logoUrl ?? app.logoUrlDark;
  const updating = updatingAppId === app.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(720px,calc(100vh-2rem))] max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogHeader className="gap-3 border-b border-border/70 pb-3 pr-12">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 text-muted-foreground">
              {logo ? (
                <img src={logo} alt={app.name} className="size-7 object-contain" />
              ) : (
                <AppsIcon className="size-5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="truncate text-base">{app.name}</DialogTitle>
                {app.isAccessible && !app.isEnabled ? (
                  <Badge variant="outline" className="bg-transparent text-muted-foreground">
                    Disabled
                  </Badge>
                ) : null}
                <span className="text-ui-xs text-muted-foreground">App</span>
              </div>
              <DialogDescription className="mt-0.5">
                {app.description ?? "Tools for this app"}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {app.isAccessible ? (
                <Tooltip>
                  <TooltipTrigger render={<span />}>
                    <Switch
                      checked={app.isEnabled}
                      disabled={updating}
                      aria-label={app.isEnabled ? "Disable app" : "Enable app"}
                      onCheckedChange={(checked) => onSetAppEnabled(app, Boolean(checked))}
                    />
                  </TooltipTrigger>
                  <TooltipPopup>{app.isEnabled ? "Disable app" : "Enable app"}</TooltipPopup>
                </Tooltip>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="More actions">
                      <EllipsisIcon className="size-4" />
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup align="end" className="w-48 min-w-48">
                  <DropdownMenuItem
                    disabled={!manageUrl}
                    onClick={() => {
                      if (manageUrl) void onOpenAppUrl(manageUrl);
                    }}
                  >
                    Manage on ChatGPT
                  </DropdownMenuItem>
                </ComposerPickerMenuPopup>
              </DropdownMenu>
            </div>
          </div>
        </DialogHeader>

        <DialogPanel className="min-h-0 flex-1 px-0 pb-0 pt-0">
          <div className="px-4 py-3 text-ui text-muted-foreground">
            {appToolsSummary(app, sections)}
          </div>
          {loading ? (
            <div className="flex min-h-32 items-center justify-center text-ui text-muted-foreground">
              Loading tools…
            </div>
          ) : error ? (
            <div className="flex min-h-32 items-center justify-center text-ui text-muted-foreground">
              <div>
                <div>Unable to load tools for this app.</div>
                <div>{error}</div>
              </div>
            </div>
          ) : tools.length === 0 ? (
            <div className="flex min-h-32 items-center justify-center text-ui text-muted-foreground">
              No tools available for this app.
            </div>
          ) : (
            <AppToolSections tools={tools} />
          )}
        </DialogPanel>

        <DialogFooter className="border-t border-border/70">
          {canTryNow ? (
            <Button size="sm" onClick={() => onTryNow(app)}>
              <MessageCircleIcon className="size-4" />
              Try now
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    data-testid="app-try-now-tooltip"
                    data-tooltip="Enable and connect this app to try it now"
                  />
                }
              >
                <Button size="sm" disabled>
                  <MessageCircleIcon className="size-4" />
                  Try now
                </Button>
              </TooltipTrigger>
              <TooltipPopup>Enable and connect this app to try it now</TooltipPopup>
            </Tooltip>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
