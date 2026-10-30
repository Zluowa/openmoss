// FILE: PluginResourceDetailDialog.tsx
// Purpose: Codex-parity detail modal for a plugin, skill, or MCP server. Header
//          carries the enable toggle + close; the scrollable body shows the
//          resource's structured metadata; the footer offers Uninstall and
//          "Try in chat". Reuses the shared Dialog/Switch/Button primitives.
// Layer: Web component
// Exports: PluginResourceDetailDialog, ResourceDetail

import type {
  ProviderMcpServerDescriptor,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import { lazy, Suspense, useEffect, useState, type ReactNode, type RefObject } from "react";

import { Button } from "./ui/button";
import { Dialog, DialogFooter, DialogPopup, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { Switch } from "./ui/switch";
import { Badge } from "./ui/badge";
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from "./ui/menu";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  mcpTransportLabel,
  originLabel,
  resolvePluginPrimaryAction,
} from "~/lib/pluginLibraryModel";
import { resolvePluginArtworkUrl } from "~/lib/localImageUrls";
import { MCP_FALLBACK_ICON, resolveResourceIcon, SKILL_FALLBACK_ICON } from "~/lib/resourceIcon";
import {
  ArrowRightIcon,
  BuildingsIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GlobeIcon,
  LinkIcon,
  MessageCircleIcon,
  PluginIcon,
  PlusIcon,
  SettingsIcon,
  Trash2,
} from "~/lib/icons";
import { useTranslation } from "~/localization";
import { PluginLibraryDetailIconBox } from "./PluginLibraryPrimitives";
import { localizeAntigravityRuntimeMessage } from "~/lib/antigravityRuntimeMessages";
import { toastManager } from "./ui/toast";
import { Skeleton } from "./ui/skeleton";
import { ensureNativeApi } from "~/nativeApi";
import { skillFilePath, skillMarkdownBody } from "~/lib/skillContent";

const SkillMarkdown = lazy(() => import("./ChatMarkdown"));

type SkillContentLoader = (skill: ProviderSkillDescriptor) => Promise<{ contents: string }>;

function useSkillInstructions(
  skill: ProviderSkillDescriptor | null,
  open: boolean,
  load: SkillContentLoader | undefined,
) {
  const key = skill ? `${skill.name}\0${skill.path}` : null;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    contents: string | null;
    loading: boolean;
    failed: boolean;
  }>({ key: null, contents: null, loading: false, failed: false });
  useEffect(() => {
    if (!open || !skill || !load) return;
    let active = true;
    setState({ key, contents: null, loading: true, failed: false });
    void Promise.resolve()
      .then(() => load(skill))
      .then(
        ({ contents }) => {
          if (active) setState({ key, contents, loading: false, failed: false });
        },
        () => {
          if (active) setState({ key, contents: null, loading: false, failed: true });
        },
      );
    return () => {
      active = false;
    };
  }, [key, load, open, revision, skill]);
  const current = state.key === key ? state : null;
  return {
    contents: open ? (current?.contents ?? null) : null,
    loading: Boolean(open && load && (current?.loading ?? true)),
    failed: Boolean(open && (!load || current?.failed)),
    retry: () => setRevision((value) => value + 1),
  };
}

export type ResourceDetail =
  | {
      readonly kind: "plugin";
      readonly plugin: ProviderPluginDescriptor;
      readonly marketplaceName: string;
      readonly marketplacePath: string | null;
      readonly remoteMarketplaceName: string | null;
    }
  | { readonly kind: "skill"; readonly skill: ProviderSkillDescriptor }
  | { readonly kind: "mcp"; readonly server: ProviderMcpServerDescriptor };

function detailTitle(detail: ResourceDetail): string {
  switch (detail.kind) {
    case "plugin":
      return detail.plugin.interface?.displayName ?? detail.plugin.name;
    case "skill":
      return detail.skill.interface?.displayName ?? detail.skill.name;
    case "mcp":
      return detail.server.name;
  }
}

function detailTag(detail: ResourceDetail, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (detail.kind) {
    case "plugin":
      return t("plugins.detail.tag.plugin");
    case "skill":
      return t("plugins.detail.tag.skill");
    case "mcp":
      return mcpTransportLabel(detail.server.transport);
  }
}

function detailSubtitle(detail: ResourceDetail): string | undefined {
  switch (detail.kind) {
    case "plugin":
      return (
        detail.plugin.interface?.shortDescription ??
        detail.plugin.interface?.longDescription ??
        undefined
      );
    case "skill":
      return detail.skill.interface?.shortDescription ?? detail.skill.description;
    case "mcp":
      return detail.server.command ?? detail.server.url;
  }
}

function detailEnabled(detail: ResourceDetail): boolean {
  switch (detail.kind) {
    case "plugin":
      return detail.plugin.enabled;
    case "skill":
      return detail.skill.enabled;
    case "mcp":
      return detail.server.enabled;
  }
}

function detailIcon(detail: ResourceDetail) {
  switch (detail.kind) {
    case "plugin":
      return resolveResourceIcon(
        detail.plugin.interface?.displayName ?? detail.plugin.name,
        detail.plugin.interface?.shortDescription ?? detail.plugin.interface?.longDescription,
        PluginIcon,
      );
    case "skill":
      return resolveResourceIcon(
        detail.skill.interface?.displayName ?? detail.skill.name,
        detail.skill.interface?.shortDescription ?? detail.skill.description,
        SKILL_FALLBACK_ICON,
      );
    case "mcp":
      return resolveResourceIcon(
        detail.server.name,
        detail.server.description ?? detail.server.command ?? detail.server.url,
        MCP_FALLBACK_ICON,
      );
  }
}

function primaryAction(
  detail: ResourceDetail,
  input: { canTryInChat: boolean; canInstall: boolean; canEnable: boolean },
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (detail.kind === "plugin") {
    if (detail.plugin.availability === "DISABLED_BY_ADMIN") {
      return {
        icon: PlusIcon,
        label: t("plugins.action.disabledByAdmin"),
        disabled: true,
        action: "install" as const,
      };
    }
    const action = resolvePluginPrimaryAction(detail.plugin, input);
    return {
      icon: action.action === "install" ? PlusIcon : MessageCircleIcon,
      label:
        action.action === "install"
          ? t("plugins.action.installPlugin")
          : action.action === "enable"
            ? t("plugins.action.enableInCodex")
            : t("plugins.action.tryInChat"),
      disabled: action.disabled,
      action: action.action,
    };
  }
  return {
    icon: MessageCircleIcon,
    label: t("plugins.action.tryInChat"),
    disabled: !input.canTryInChat,
    action: "try" as const,
  };
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-[30px] grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 py-[5px] text-ui-lg leading-5">
      <dt className="flex min-w-0 items-center gap-2 break-words text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center break-words text-foreground">{children}</dd>
    </div>
  );
}

function InformationLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      aria-label={label}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="relative inline-flex size-6 items-center justify-center rounded-md text-foreground outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
    >
      <GlobeIcon aria-hidden="true" className="size-4" />
    </a>
  );
}

function MetaBody({ detail }: { detail: ResourceDetail }) {
  const { t } = useTranslation();
  const rows: Array<{ label: string; value: ReactNode }> = [];

  if (detail.kind === "plugin") {
    const p = detail.plugin;
    const capabilities = p.interface?.capabilities?.join(", ");
    const version = p.localVersion ?? p.version;
    if (capabilities)
      rows.push({
        label: t("plugins.detail.label.capabilities"),
        value: capabilities,
      });
    if (p.interface?.developerName)
      rows.push({
        label: t("plugins.detail.label.developer"),
        value: p.interface.developerName,
      });
    if (p.interface?.category)
      rows.push({
        label: t("plugins.detail.label.category"),
        value: p.interface.category,
      });
    if (version)
      rows.push({
        label: t("plugins.detail.label.version"),
        value: version,
      });
    rows.push({
      label: t("plugins.detail.label.website"),
      value: p.interface?.websiteUrl ? (
        <InformationLink href={p.interface.websiteUrl} label={t("plugins.detail.label.website")} />
      ) : (
        t("plugins.detail.unavailable")
      ),
    });
    if (p.interface?.privacyPolicyUrl)
      rows.push({
        label: t("plugins.detail.label.privacy"),
        value: (
          <InformationLink
            href={p.interface.privacyPolicyUrl}
            label={t("plugins.detail.label.privacy")}
          />
        ),
      });
    if (p.interface?.termsOfServiceUrl)
      rows.push({
        label: t("plugins.detail.label.terms"),
        value: (
          <InformationLink
            href={p.interface.termsOfServiceUrl}
            label={t("plugins.detail.label.terms")}
          />
        ),
      });
  } else if (detail.kind === "skill") {
    const s = detail.skill;
    rows.push({
      label: t("plugins.detail.label.source"),
      value: originLabel(s.scope),
    });
    if (s.description)
      rows.push({
        label: t("plugins.detail.label.description"),
        value: s.description,
      });
    rows.push({
      label: t("plugins.detail.label.path"),
      value: <code className="text-ui-xs">{s.path}</code>,
    });
  } else {
    const m = detail.server;
    rows.push({
      label: t("plugins.detail.label.origin"),
      value: originLabel(m.origin),
    });
    rows.push({
      label: t("plugins.detail.label.transport"),
      value: mcpTransportLabel(m.transport),
    });
    if (m.command)
      rows.push({
        label: t("plugins.detail.label.command"),
        value: <code className="text-ui-xs">{m.command}</code>,
      });
    if (m.args && m.args.length > 0) {
      rows.push({
        label: t("plugins.detail.label.args"),
        value: <code className="text-ui-xs">{m.args.join(" ")}</code>,
      });
    }
    if (m.url)
      rows.push({
        label: t("plugins.detail.label.url"),
        value: <code className="text-ui-xs">{m.url}</code>,
      });
    if (m.envKeys && m.envKeys.length > 0) {
      rows.push({
        label: t("plugins.detail.label.env"),
        value: m.envKeys.join(", "),
      });
    }
    if (m.path)
      rows.push({
        label: t("plugins.detail.label.config"),
        value: <code className="text-ui-xs">{m.path}</code>,
      });
  }

  return (
    <dl>
      {rows.map((row) => (
        <MetaRow key={row.label} label={row.label}>
          {row.value}
        </MetaRow>
      ))}
    </dl>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-2 pb-2 text-foreground">
        <h2 className="flex min-h-7 items-center text-lg font-medium leading-6">{title}</h2>
      </div>
      <div className="flex flex-col gap-1 px-2">{children}</div>
    </section>
  );
}

function PluginDefaultPrompts({
  detail,
  onActivate,
}: {
  detail: ResourceDetail;
  onActivate?: ((prompt: string) => void) | undefined;
}) {
  if (detail.kind !== "plugin") return null;
  const prompts = detail.plugin.interface?.defaultPrompt ?? [];
  if (prompts.length === 0) return null;
  return (
    <div className="relative mx-1 overflow-hidden rounded-2xl border border-border/40 bg-muted/30 px-4 py-5">
      <div className="flex flex-col gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="group/prompt max-w-[88%] rounded-2xl bg-background/75 px-3 py-2 text-left text-ui-lg text-foreground shadow-xs transition-colors hover:bg-background disabled:cursor-default"
            disabled={!onActivate}
            onClick={() => onActivate?.(prompt)}
          >
            <span className="line-clamp-3">{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function IncludesBody({
  detail,
  pluginDetail,
  loading,
}: {
  detail: ResourceDetail;
  pluginDetail?: ProviderPluginDetail | undefined;
  loading?: boolean | undefined;
}) {
  const { format, t } = useTranslation();
  if (detail.kind === "plugin") {
    const apps = pluginDetail?.apps ?? [];
    const skills = pluginDetail?.skills ?? [];
    const mcpServers = pluginDetail?.mcpServers ?? [];
    if (loading && !pluginDetail) {
      return (
        <p className="text-ui-lg text-muted-foreground">{t("plugins.detail.loadingIncludes")}</p>
      );
    }
    if (apps.length === 0 && skills.length === 0 && mcpServers.length === 0) {
      return <p className="text-ui-lg text-muted-foreground">{t("plugins.detail.noIncludes")}</p>;
    }
    return (
      <div className="flex flex-col gap-3">
        {apps.length > 0 ? (
          <div className="flex flex-col gap-2">
            {apps.map((app) => (
              <div key={app.id} className="flex items-center justify-between gap-3 text-ui-lg">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{app.name}</p>
                  {app.description ? (
                    <p className="line-clamp-1 text-ui-sm text-muted-foreground">
                      {app.description}
                    </p>
                  ) : null}
                </div>
                <Badge variant="secondary" className="shrink-0 text-ui-2xs font-medium">
                  {t("plugins.detail.app")}
                </Badge>
              </div>
            ))}
          </div>
        ) : null}
        {skills.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <Badge key={skill.path} variant="secondary" className="text-ui-sm font-medium">
                {format("plugins.detail.skillBadge", {
                  name: skill.interface?.displayName ?? skill.name,
                })}
              </Badge>
            ))}
          </div>
        ) : null}
        {mcpServers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {mcpServers.map((server) => (
              <Badge key={server} variant="secondary" className="text-ui-sm font-medium">
                {format("plugins.detail.mcpBadge", { name: server })}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (detail.kind === "skill") {
    return <p className="text-ui-lg text-muted-foreground">{t("plugins.detail.skillHarness")}</p>;
  }
  return <p className="text-ui-lg text-muted-foreground">{t("plugins.detail.mcpHarness")}</p>;
}

type PluginPageSectionKind = "apps" | "skills" | "information";

function PluginPageSection({
  kind,
  title,
  count,
  children,
}: {
  readonly kind: PluginPageSectionKind;
  readonly title: string;
  readonly count?: number | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4" data-plugin-detail-section={kind}>
      <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-2 pr-0.5 pl-2 text-foreground">
        <h2 className="flex min-h-7 items-center gap-1.5 text-[16px] font-semibold leading-6">
          {title}
          {count === undefined ? null : (
            <span className="font-normal text-muted-foreground" data-plugin-detail-count={kind}>
              {count}
            </span>
          )}
        </h2>
      </div>
      <div className="flex flex-col gap-1 px-2">{children}</div>
    </section>
  );
}

function PluginPagePromptShowcase({
  detail,
  artworkCwd,
  onActivate,
}: {
  readonly detail: Extract<ResourceDetail, { readonly kind: "plugin" }>;
  readonly artworkCwd?: string | undefined;
  readonly onActivate?: ((prompt: string) => void) | undefined;
}) {
  // Codex shows up to three stacked suggested-prompt rows inside the gradient
  // showcase card (Helios shot 18).
  const prompts = (detail.plugin.interface?.defaultPrompt ?? []).slice(0, 3);
  if (prompts.length === 0) return null;

  const title = detailTitle(detail);
  const PromptIcon = detailIcon(detail);
  const promptLogoSource =
    detail.plugin.interface?.composerIconUrl ??
    detail.plugin.interface?.composerIcon ??
    detail.plugin.interface?.logoUrl ??
    detail.plugin.interface?.logo ??
    detail.plugin.interface?.logoUrlDark ??
    detail.plugin.interface?.logoDark ??
    undefined;
  const promptLogo = promptLogoSource
    ? resolvePluginArtworkUrl({ src: promptLogoSource, cwd: artworkCwd })
    : undefined;

  return (
    <div
      className="relative mx-2 flex min-h-[122px] justify-center overflow-hidden rounded-panel bg-[#dfe3fb] px-4 py-8 sm:px-8"
      data-testid="plugin-detail-prompt"
      style={{
        backgroundImage:
          "radial-gradient(100% 150% at 4% 50%, rgba(185, 205, 250, 0.96) 0%, rgba(219, 226, 255, 0.28) 62%, transparent 82%), radial-gradient(90% 170% at 62% -28%, rgba(184, 180, 235, 0.72) 0%, transparent 66%), radial-gradient(85% 180% at 100% 72%, rgba(218, 198, 249, 0.88) 0%, transparent 74%), linear-gradient(104deg, #cdd9fa 0%, #d7d7f4 58%, #eee6fb 100%)",
      }}
    >
      <div className="relative flex w-full max-w-[640px] flex-col items-center justify-center gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            aria-label={`${title} ${prompt}`}
            aria-disabled={!onActivate}
            className="max-w-[77%] cursor-pointer rounded-card bg-background/75 py-2 pl-2 pr-1.5 text-left text-ui-lg leading-[21px] text-foreground outline-hidden hover:bg-background focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
            disabled={!onActivate}
            onClick={() => onActivate?.(prompt)}
          >
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 break-words text-pretty">
                <span className="px-0.5 font-medium">
                  <span className="relative mr-[3px] inline-block h-[1lh] w-4 align-bottom">
                    {promptLogo ? (
                      <img
                        src={promptLogo}
                        alt=""
                        draggable={false}
                        className="absolute top-1/2 size-4 -translate-y-1/2 object-contain"
                      />
                    ) : (
                      <PromptIcon className="absolute top-1/2 size-4 -translate-y-1/2" />
                    )}
                  </span>
                  <span className="min-w-0 break-words">{title}</span>
                </span>
                <span className="ml-1 line-clamp-2">{prompt}</span>
              </span>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                <ArrowRightIcon aria-hidden="true" className="size-4" />
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PluginPageAppRow({ app }: { readonly app: ProviderPluginDetail["apps"][number] }) {
  const hasInstallTarget = app.installUrl !== null;
  const AppIcon = resolveResourceIcon(app.name, app.description, PluginIcon);

  return (
    <div
      className={`flex min-h-[54px] w-full min-w-0 flex-col justify-center rounded-card px-2 py-[5px] ${
        hasInstallTarget ? "" : "opacity-60"
      }`}
      data-plugin-app-install-target={hasInstallTarget ? "present" : "missing"}
      data-testid="plugin-detail-app-row"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-transparent"
        >
          <AppIcon className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-ui-lg leading-[21px] text-foreground">{app.name}</span>
            </div>
            {app.description ? (
              <span className="line-clamp-1 text-ui leading-[21.125px] text-muted-foreground">
                {app.description}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function PluginPageSkillRow({
  skill,
  onOpen,
}: {
  readonly skill: ProviderSkillDescriptor;
  readonly onOpen?: (() => void) | undefined;
}) {
  const name = skill.interface?.displayName ?? skill.name;
  const description = skill.description ?? skill.interface?.shortDescription;
  const SkillIcon = resolveResourceIcon(name, description, SKILL_FALLBACK_ICON);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      aria-label={name}
      className="flex min-h-[54px] w-full min-w-0 flex-col justify-center rounded-card px-2 py-[5px] text-left outline-none transition-colors enabled:hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      data-testid="plugin-detail-skill-row"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center">
          <SkillIcon className="size-6 rounded-sm text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="truncate text-ui-lg leading-[21px] text-foreground">{name}</span>
          {description ? (
            <span className="line-clamp-1 text-ui leading-[21.125px] text-muted-foreground">
              {description}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

/**
 * Codex's skill preview from a plugin page: the skill's icon, name and summary,
 * its SKILL.md under a "Skill" heading in a scrolling well, and Close.
 */
function PluginSkillPreviewDialog({
  skill,
  onOpenChange,
  loadSkillContent,
}: {
  readonly skill: ProviderSkillDescriptor | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly loadSkillContent?: SkillContentLoader | undefined;
}) {
  const { t } = useTranslation();
  const open = skill !== null;
  const instructions = useSkillInstructions(skill, open, loadSkillContent);
  if (!skill) return null;
  const name = skill.interface?.displayName ?? skill.name;
  const description = skill.description ?? skill.interface?.shortDescription;
  const SkillIcon = resolveResourceIcon(name, description, SKILL_FALLBACK_ICON);
  const body = instructions.contents === null ? "" : skillMarkdownBody(instructions.contents);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-[600px] gap-0 p-0" data-testid="plugin-skill-preview">
        <div className="flex flex-col gap-3 px-6 pt-6">
          <span className="flex size-10 items-center justify-center rounded-[10px] bg-card ring-1 ring-border/70 ring-inset">
            <SkillIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          </span>
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-[20px] font-semibold leading-7">{name}</DialogTitle>
            {description ? (
              <p
                className="text-[15px] leading-6 text-muted-foreground"
                data-translation-skip="true"
              >
                {description}
              </p>
            ) : null}
          </div>
          <h3 className="pt-1 text-[16px] font-semibold leading-6">
            {t("plugins.section.skills")}
          </h3>
        </div>
        <div className="px-6 pt-3">
          <ScrollArea className="max-h-[min(52vh,460px)] rounded-xl border border-border/70 bg-muted/20">
            <div
              className="min-w-0 px-4 py-3.5 text-ui leading-6"
              data-testid="plugin-skill-preview-body"
            >
              {instructions.loading ? (
                <p role="status" className="text-muted-foreground">
                  {t("plugins.skillContent.loading")}
                </p>
              ) : body.trim() ? (
                <Suspense
                  fallback={
                    <p role="status" className="text-muted-foreground">
                      {t("plugins.skillContent.loading")}
                    </p>
                  }
                >
                  <SkillMarkdown text={body} cwd={undefined} className="text-ui" />
                </Suspense>
              ) : (
                <p className="text-muted-foreground">
                  {description ?? t("plugins.skillContent.empty")}
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
        <div className="flex justify-end px-6 py-5">
          <Button size="sm" className="h-8 rounded-lg px-3" onClick={() => onOpenChange(false)}>
            {t("plugins.action.close")}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export interface PluginResourceDetailDialogProps {
  readonly detail: ResourceDetail | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Toggle the enabled state. When absent the switch is read-only (display). */
  readonly onToggleEnabled?: ((enabled: boolean) => void) | undefined;
  readonly canToggle?: boolean | undefined;
  readonly onTryInChat?: (() => void) | undefined;
  readonly onInstall?: (() => void) | undefined;
  readonly onUninstall?: (() => void) | undefined;
  readonly pluginDetail?: ProviderPluginDetail | undefined;
  readonly pluginDetailLoading?: boolean | undefined;
  /** Reads only a skill that the selected provider has rediscovered and authorized. */
  readonly loadSkillContent?: SkillContentLoader | undefined;
}

export function PluginResourceDetailDialog({
  detail,
  open,
  onOpenChange,
  onToggleEnabled,
  canToggle = false,
  onTryInChat,
  onInstall,
  onUninstall,
  pluginDetail,
  pluginDetailLoading = false,
  loadSkillContent,
}: PluginResourceDetailDialogProps) {
  const { format, locale, t } = useTranslation();
  const skill = detail?.kind === "skill" ? detail.skill : null;
  const instructions = useSkillInstructions(skill, open, loadSkillContent);
  const [pendingSkillAction, setPendingSkillAction] = useState(false);
  if (!detail) return null;

  const effectiveDetail =
    detail.kind === "plugin" && pluginDetail
      ? {
          ...detail,
          plugin: {
            ...pluginDetail.summary,
            installed: detail.plugin.installed,
            enabled: detail.plugin.enabled,
          },
          marketplaceName: pluginDetail.marketplaceName,
          marketplacePath: pluginDetail.marketplacePath,
        }
      : detail;
  const title = detailTitle(effectiveDetail);
  const rawSubtitle = detailSubtitle(effectiveDetail);
  const subtitle = rawSubtitle
    ? localizeAntigravityRuntimeMessage(rawSubtitle, locale)
    : rawSubtitle;
  const enabled = detailEnabled(effectiveDetail);
  const Icon = detailIcon(effectiveDetail);
  const action = primaryAction(
    effectiveDetail,
    {
      canTryInChat: Boolean(onTryInChat),
      canInstall: Boolean(onInstall),
      canEnable: canToggle && Boolean(onToggleEnabled),
    },
    t,
  );

  // Codex skill detail (Helios shot 16): icon + "{name} Skill" + description on
  // the left, enable switch + overflow + close on the right; the body leads with
  // the skill's own description prose; the footer carries Uninstall (left) and
  // Try now (right). Plugin/MCP details keep the generic layout below.
  if (effectiveDetail.kind === "skill") {
    const filePath = skillFilePath(effectiveDetail.skill.path);
    const canRead = instructions.contents !== null && !instructions.loading;
    const runSkillAction = async (action: "open" | "reveal" | "copy") => {
      if (pendingSkillAction || !canRead) return;
      setPendingSkillAction(true);
      try {
        if (action === "copy") {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(instructions.contents ?? "");
          toastManager.add({
            type: "success",
            title: format("plugins.toast.copied", { label: "SKILL.md" }),
          });
        } else if (filePath) {
          const api = ensureNativeApi();
          if (action === "open") await api.shell.openInEditor(filePath, "system-default");
          else await api.shell.showInFolder(filePath);
        }
      } catch {
        toastManager.add({
          type: "error",
          title:
            action === "copy"
              ? t("plugins.toast.copyFailed")
              : t("plugins.skillContent.openFailed"),
        });
      } finally {
        setPendingSkillAction(false);
      }
    };
    const body = instructions.contents === null ? "" : skillMarkdownBody(instructions.contents);
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-[600px] gap-0 p-0" data-testid="skill-detail-dialog">
          {/* Codex skill sheet: the icon tile with the enable switch, "…" and
              close on its row; the name with a muted "Skill" suffix and the
              summary under it; SKILL.md in an inset well; Uninstall and Try now. */}
          <div className="flex items-start justify-between gap-4 px-6 pt-6 pr-14">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-card ring-1 ring-border/70 ring-inset">
              <Icon className="size-5 text-muted-foreground" />
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {canToggle ? (
                <Switch
                  checked={enabled}
                  disabled={!canToggle}
                  onCheckedChange={(checked) => onToggleEnabled?.(Boolean(checked))}
                  aria-label={format("plugins.detail.enableAria", {
                    name: title,
                  })}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("plugins.action.moreActions")}
                    >
                      <EllipsisIcon className="size-4" />
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup align="end" className="w-44 min-w-44">
                  <DropdownMenuItem
                    disabled={!canRead || !filePath || pendingSkillAction}
                    onClick={() => void runSkillAction("open")}
                  >
                    <ExternalLinkIcon className="size-4" />
                    {t("plugins.skillContent.open")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canRead || !filePath || pendingSkillAction}
                    onClick={() => void runSkillAction("reveal")}
                  >
                    <FolderOpenIcon className="size-4" />
                    {t("plugins.skillContent.reveal")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canRead || pendingSkillAction}
                    onClick={() => void runSkillAction("copy")}
                  >
                    <CopyIcon className="size-4" />
                    {t("plugins.skillContent.copy")}
                  </DropdownMenuItem>
                </ComposerPickerMenuPopup>
              </DropdownMenu>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 px-6 pt-3">
            <DialogTitle className="flex min-w-0 items-baseline gap-2 text-[22px] font-semibold leading-8">
              <span className="truncate">{title}</span>
              <span className="shrink-0 font-normal text-muted-foreground">
                {t("plugins.detail.tag.skill")}
              </span>
            </DialogTitle>
            {subtitle ? (
              <p
                className="line-clamp-3 text-[16px] leading-6 text-muted-foreground"
                data-translation-skip="true"
              >
                {subtitle}
              </p>
            ) : null}
          </div>

          <div className="px-6 pt-5">
            <ScrollArea className="max-h-[min(52vh,460px)] rounded-xl border border-border/70 bg-muted/20">
              <div className="flex flex-col gap-5 px-4 py-3.5">
                <div data-testid="skill-detail-body" className="min-w-0 text-ui leading-6">
                  {instructions.loading ? (
                    <p role="status" className="text-muted-foreground">
                      {t("plugins.skillContent.loading")}
                    </p>
                  ) : instructions.failed ? (
                    <div role="alert" className="flex flex-col items-start gap-3">
                      <p className="text-muted-foreground">{t("plugins.skillContent.failed")}</p>
                      {loadSkillContent ? (
                        <Button variant="outline" size="sm" onClick={instructions.retry}>
                          {t("plugins.action.retry")}
                        </Button>
                      ) : null}
                    </div>
                  ) : body.trim() ? (
                    <Suspense
                      fallback={
                        <p role="status" className="text-muted-foreground">
                          {t("plugins.skillContent.loading")}
                        </p>
                      }
                    >
                      <SkillMarkdown text={body} cwd={undefined} className="text-ui" />
                    </Suspense>
                  ) : (
                    <p className="text-muted-foreground">{t("plugins.skillContent.empty")}</p>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>

          <div className="flex items-center justify-between gap-3 px-6 py-5">
            <div>
              {onUninstall ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full bg-destructive/10 px-3.5 text-ui-lg text-destructive sm:h-8 [:hover,[data-pressed]]:bg-destructive/15 [:hover,[data-pressed]]:text-destructive"
                  onClick={onUninstall}
                >
                  {t("plugins.action.uninstall")}
                </Button>
              ) : null}
            </div>
            {onTryInChat ? (
              <Button
                variant="default"
                size="sm"
                className="h-8 gap-1.5 rounded-full px-3.5 text-ui-lg font-medium sm:h-8"
                data-testid="skill-detail-try-now"
                onClick={onTryInChat}
              >
                <span aria-hidden="true">
                  <MessageCircleIcon className="size-4" />
                </span>
                {t("plugins.action.tryInChat")}
              </Button>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl gap-0 p-0">
        <div className="flex items-start gap-4 p-5 pr-12">
          <PluginLibraryDetailIconBox bordered={false}>
            <Icon className="size-8 text-muted-foreground" />
          </PluginLibraryDetailIconBox>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 text-xl font-normal leading-[34px]">
                  <span className="truncate">{title}</span>
                  <Badge
                    variant="secondary"
                    className="shrink-0 text-ui-2xs font-semibold uppercase"
                  >
                    {detailTag(detail, t)}
                  </Badge>
                </DialogTitle>
                {subtitle ? (
                  <p
                    className="line-clamp-2 text-ui text-muted-foreground"
                    data-translation-skip="true"
                  >
                    {subtitle}
                  </p>
                ) : null}
              </div>
              <Button
                variant="default"
                size="sm"
                disabled={action.disabled}
                onClick={
                  action.action === "install"
                    ? onInstall
                    : action.action === "enable"
                      ? () => onToggleEnabled?.(true)
                      : onTryInChat
                }
              >
                <span aria-hidden="true">
                  <action.icon className="size-4" />
                </span>
                {action.label}
              </Button>
            </div>
            {canToggle ? (
              <label className="flex items-center gap-2 text-ui-sm text-muted-foreground">
                <Switch
                  checked={enabled}
                  disabled={!canToggle}
                  onCheckedChange={(checked) => onToggleEnabled?.(Boolean(checked))}
                  aria-label={format("plugins.detail.enableAria", {
                    name: title,
                  })}
                />
                {t("plugins.detail.enabled")}
              </label>
            ) : null}
          </div>
        </div>

        <ScrollArea className="max-h-[min(60vh,560px)] border-y border-border/60">
          <div className="flex flex-col gap-5 px-5 py-5">
            <PluginDefaultPrompts
              detail={effectiveDetail}
              onActivate={onTryInChat ? () => onTryInChat() : undefined}
            />
            <DetailSection title={t("plugins.detail.includes")}>
              <IncludesBody
                detail={effectiveDetail}
                pluginDetail={pluginDetail}
                loading={pluginDetailLoading}
              />
            </DetailSection>
            <DetailSection title={t("plugins.detail.information")}>
              <MetaBody detail={effectiveDetail} />
            </DetailSection>
          </div>
        </ScrollArea>

        {onUninstall ? (
          <DialogFooter className="justify-start">
            <Button variant="destructive-outline" size="sm" onClick={onUninstall}>
              {t("plugins.action.uninstall")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

export interface PluginResourceDetailPageProps {
  readonly detail: ResourceDetail;
  readonly onBack: () => void;
  readonly onToggleEnabled?: ((enabled: boolean) => void) | undefined;
  readonly canToggle?: boolean | undefined;
  readonly onTryInChat?: ((prompt?: string) => void) | undefined;
  readonly onInstall?: (() => void) | undefined;
  readonly onUninstall?: (() => void) | undefined;
  readonly onManage?: (() => void) | undefined;
  readonly pluginDetail?: ProviderPluginDetail | undefined;
  readonly pluginDetailLoading?: boolean | undefined;
  readonly artworkCwd?: string | undefined;
  readonly scrollContainerRef?: RefObject<HTMLDivElement | null> | undefined;
  /** Reads a bundled skill's SKILL.md for the in-page skill preview. */
  readonly loadSkillContent?: SkillContentLoader | undefined;
}

/**
 * Full-page plugin detail surface used by the Plugins directory. The current
 * Codex desktop app navigates to a breadcrumb-backed page instead of opening a
 * centered modal; skill and MCP details may continue to use the compact dialog.
 */
export function PluginResourceDetailPage({
  detail,
  onBack,
  onToggleEnabled,
  canToggle = false,
  onTryInChat,
  onInstall,
  onUninstall,
  onManage,
  pluginDetail,
  pluginDetailLoading = false,
  artworkCwd,
  scrollContainerRef,
  loadSkillContent,
}: PluginResourceDetailPageProps) {
  const { format, locale, t } = useTranslation();
  const [previewSkill, setPreviewSkill] = useState<ProviderSkillDescriptor | null>(null);
  const effectiveDetail =
    detail.kind === "plugin" && pluginDetail
      ? {
          ...detail,
          plugin: {
            ...pluginDetail.summary,
            installed: detail.plugin.installed,
            enabled: detail.plugin.enabled,
          },
          marketplaceName: pluginDetail.marketplaceName,
          marketplacePath: pluginDetail.marketplacePath,
        }
      : detail;
  const title = detailTitle(effectiveDetail);
  const rawSubtitle = detailSubtitle(effectiveDetail);
  const subtitle = rawSubtitle
    ? localizeAntigravityRuntimeMessage(rawSubtitle, locale)
    : rawSubtitle;
  const Icon = detailIcon(effectiveDetail);
  const action = primaryAction(
    effectiveDetail,
    {
      canTryInChat: Boolean(onTryInChat),
      canInstall: Boolean(onInstall),
      canEnable: canToggle && Boolean(onToggleEnabled),
    },
    t,
  );
  const activatePrimary = () => {
    if (action.action === "install") onInstall?.();
    else if (action.action === "enable") onToggleEnabled?.(true);
    else onTryInChat?.();
  };

  const pluginLogoSource =
    effectiveDetail.kind === "plugin"
      ? (effectiveDetail.plugin.interface?.logoUrl ??
        effectiveDetail.plugin.interface?.logo ??
        effectiveDetail.plugin.interface?.logoUrlDark ??
        effectiveDetail.plugin.interface?.logoDark ??
        undefined)
      : undefined;
  const pluginLogo = pluginLogoSource
    ? resolvePluginArtworkUrl({ src: pluginLogoSource, cwd: artworkCwd })
    : undefined;
  const isPendingPluginDetail =
    effectiveDetail.kind === "plugin" && pluginDetailLoading && !pluginDetail;

  const copyDetailLink =
    effectiveDetail.kind === "plugin"
      ? () => {
          const url = `${window.location.origin}/skills/plugins/${encodeURIComponent(effectiveDetail.plugin.id)}`;
          void navigator.clipboard
            .writeText(url)
            .then(() => {
              toastManager.add({
                type: "success",
                title: format("plugins.toast.copied", { label: t("plugins.action.copyLink") }),
              });
            })
            .catch(() => {
              toastManager.add({
                type: "error",
                title: t("plugins.toast.copyFailed"),
              });
            });
        }
      : undefined;

  return (
    <div
      className="flex h-full min-h-0 flex-col text-ui"
      data-testid="plugin-library-route-detail"
      data-plugin-id={effectiveDetail.kind === "plugin" ? effectiveDetail.plugin.id : undefined}
    >
      <div
        className="drag-region flex h-[46px] shrink-0 items-center gap-1 px-2"
        data-testid="plugin-detail-breadcrumb"
      >
        <button
          type="button"
          onClick={onBack}
          className="no-drag flex h-7 items-center rounded-control border border-transparent px-2 text-ui-lg leading-[18px] font-[445] text-muted-foreground transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("plugins.tabs.plugins")}
        </button>
        <ChevronRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground/50" />
        <span
          aria-current="page"
          className="no-drag flex h-7 min-w-0 items-center truncate px-1 text-ui-lg leading-[18px] font-[445] text-foreground"
        >
          {title}
        </span>
      </div>

      <div
        ref={scrollContainerRef}
        data-testid="plugin-detail-scroll"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <main
          data-testid="plugin-detail-content"
          data-plugin-detail-state={isPendingPluginDetail ? "loading" : "settled"}
          className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-10 pt-5"
        >
          <header className="flex flex-col gap-4 px-2" data-testid="plugin-detail-header">
            <div className="flex" data-testid="plugin-detail-artwork">
              <PluginDetailArtwork logo={pluginLogo} title={title} FallbackIcon={Icon} />
            </div>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
                <h1 className="min-w-0 break-words text-[22px] leading-7 font-semibold text-foreground">
                  {title}
                </h1>
                {/* Codex attributes the plugin under its name ("By OpenAI");
                    without a developer the one-line summary stands in. */}
                {effectiveDetail.kind === "plugin" &&
                effectiveDetail.plugin.interface?.developerName ? (
                  <p
                    className="flex min-w-0 items-center gap-1.5 text-ui-lg leading-5 text-muted-foreground"
                    data-testid="plugin-detail-developer"
                  >
                    <BuildingsIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {format("plugins.detail.byDeveloper", {
                        developer: effectiveDetail.plugin.interface.developerName,
                      })}
                    </span>
                  </p>
                ) : subtitle ? (
                  <p
                    className="text-ui-lg leading-5 text-muted-foreground"
                    data-translation-skip="true"
                  >
                    {subtitle}
                  </p>
                ) : null}
              </div>
              <div className="flex max-w-full shrink-0 items-center gap-1.5">
                {effectiveDetail.kind === "plugin" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="sm:size-8"
                          aria-label={t("plugins.action.moreActions")}
                          data-plugin-library-focus-key="detail:more-actions"
                          data-testid="plugin-detail-more-actions"
                        >
                          <EllipsisIcon className="size-4" />
                        </Button>
                      }
                    />
                    <ComposerPickerMenuPopup align="end" className="w-48 min-w-48">
                      {copyDetailLink ? (
                        <DropdownMenuItem
                          onClick={copyDetailLink}
                          data-testid="plugin-detail-copy-link"
                        >
                          <LinkIcon className="size-4" />
                          {t("plugins.action.copyLink")}
                        </DropdownMenuItem>
                      ) : null}
                      {onManage && effectiveDetail.plugin.installed ? (
                        <DropdownMenuItem onClick={onManage}>
                          <SettingsIcon className="size-4" />
                          {t("plugins.action.manage")}
                        </DropdownMenuItem>
                      ) : null}
                      {onUninstall && effectiveDetail.plugin.installed ? (
                        <DropdownMenuItem className="text-destructive" onClick={onUninstall}>
                          <Trash2 className="size-4" />
                          {t("plugins.action.uninstall")}
                        </DropdownMenuItem>
                      ) : null}
                    </ComposerPickerMenuPopup>
                  </DropdownMenu>
                ) : null}
                <Button
                  size="sm"
                  className="h-8 gap-1.5 rounded-lg px-3 text-ui-lg font-medium sm:h-8"
                  data-testid="plugin-detail-primary-action"
                  disabled={action.disabled}
                  onClick={activatePrimary}
                >
                  <span aria-hidden="true">
                    <action.icon className="size-4" />
                  </span>
                  {action.label}
                </Button>
              </div>
            </div>
          </header>

          {isPendingPluginDetail ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-6 px-2"
              data-testid="plugin-detail-loading-skeleton"
            >
              <span className="sr-only">{t("plugins.detail.loadingIncludes")}</span>
              <Skeleton className="h-5 w-40 rounded-md" />
              <Skeleton className="h-4 w-3/4 rounded-md" />
              <Skeleton className="h-[122px] w-full rounded-panel" />
              <Skeleton className="h-4 w-1/3 rounded-md" />
              <Skeleton className="h-24 w-full rounded-panel" />
            </div>
          ) : effectiveDetail.kind === "plugin" ? (
            <>
              <PluginPagePromptShowcase
                detail={effectiveDetail}
                artworkCwd={artworkCwd}
                onActivate={onTryInChat ? (prompt) => onTryInChat(prompt) : undefined}
              />
              {pluginDetail?.description ? (
                <p
                  className="px-2 text-ui-lg leading-[22.75px] text-foreground"
                  data-testid="plugin-detail-description"
                >
                  {pluginDetail.description}
                </p>
              ) : null}
              {pluginDetail && pluginDetail.apps.length > 0 ? (
                <PluginPageSection
                  kind="apps"
                  title={t("plugins.manage.tab.apps")}
                  count={pluginDetail.apps.length}
                >
                  <div className="flex flex-col gap-2">
                    {pluginDetail.apps.map((app) => (
                      <PluginPageAppRow key={app.id} app={app} />
                    ))}
                  </div>
                </PluginPageSection>
              ) : null}
              {pluginDetail && pluginDetail.skills.length > 0 ? (
                <PluginPageSection
                  kind="skills"
                  title={t("plugins.manage.tab.skills")}
                  count={pluginDetail.skills.length}
                >
                  {pluginDetail.skills.map((skill) => (
                    <PluginPageSkillRow
                      key={skill.path}
                      skill={skill}
                      onOpen={() => setPreviewSkill(skill)}
                    />
                  ))}
                </PluginPageSection>
              ) : null}
              <PluginPageSection kind="information" title={t("plugins.detail.information")}>
                <MetaBody detail={effectiveDetail} />
              </PluginPageSection>
              {pluginDetail &&
              (pluginDetail.apps.length > 0 || pluginDetail.mcpServers.length > 0) ? (
                <p
                  role="note"
                  className="px-2 text-ui-sm leading-5 text-muted-foreground"
                  data-testid="plugin-detail-legal-notice"
                >
                  {format("plugins.detail.legalNotice", { name: title })}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <PluginDefaultPrompts
                detail={effectiveDetail}
                onActivate={onTryInChat ? (prompt) => onTryInChat(prompt) : undefined}
              />
              <DetailSection title={t("plugins.detail.includes")}>
                <IncludesBody detail={effectiveDetail} />
              </DetailSection>
              <DetailSection title={t("plugins.detail.information")}>
                <MetaBody detail={effectiveDetail} />
              </DetailSection>
            </>
          )}
        </main>
      </div>
      <PluginSkillPreviewDialog
        skill={previewSkill}
        onOpenChange={(open) => {
          if (!open) setPreviewSkill(null);
        }}
        loadSkillContent={loadSkillContent}
      />
    </div>
  );
}

function PluginDetailArtwork({
  logo,
  title,
  FallbackIcon,
}: {
  logo?: string | undefined;
  title: string;
  FallbackIcon: ReturnType<typeof detailIcon>;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <PluginLibraryDetailIconBox>
      {logo && !failed ? (
        <img
          src={logo}
          alt={title}
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <FallbackIcon className="size-8 text-muted-foreground" />
      )}
    </PluginLibraryDetailIconBox>
  );
}
