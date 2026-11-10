// FILE: LaunchServerList.tsx
// Purpose: A project's servers as the desktop panel lists them: name, port and a ▷ that
//   starts the server and opens it once it answers (■ stops a running one), five rows then
//   "See all", and a line saying where the list is kept. Two skins: the new tab's page,
//   and rows inside a menu (the Environment card, the browser's servers button).
// Layer: BrowserPanel UI

import type { ServerLocalServerProcess } from "@moss/contracts";
import { localServerOpenUrl, localServerPrimaryLabel } from "@moss/shared/localServers";
import { useState, type MouseEvent, type ReactNode } from "react";

import { LoaderCircleIcon, PlayOutlineIcon, ServerIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { StatusDot } from "../ui/status-chip";
import { MenuGroup, MenuGroupLabel, MenuItem } from "../ui/menu";
import {
  LAUNCH_SERVER_LIST_COLLAPSED_COUNT,
  launchServerRowStartable,
  launchServerRowStoppable,
  type LaunchServerRow,
} from "./launchServers.logic";
import type { ProjectLaunchServers } from "./useProjectLaunchServers";

/** The footer line: how to use the list, and where it is kept. */
export function useLaunchServerFooter(servers: ProjectLaunchServers): {
  readonly lead: string;
  readonly fileLine: string;
} {
  const { t, format } = useTranslation();
  const file = servers.editFile;
  return {
    lead: t("browser.servers.footerLead"),
    // Until the file is read the source is unknown; say nothing rather than guess.
    fileLine: !servers.loaded
      ? ""
      : servers.source === "packageScripts"
        ? format("browser.servers.footerScripts", { file })
        : servers.source === "none"
          ? format("browser.servers.footerNone", { file })
          : format("browser.servers.footerEdit", { file }),
  };
}

function RowStatus({ state }: { state: LaunchServerRow["state"] }) {
  const { t } = useTranslation();
  if (state === "starting") {
    return (
      <LoaderCircleIcon
        aria-label={t("browser.servers.starting")}
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
      />
    );
  }
  if (state === "running") {
    return (
      <StatusDot
        aria-label={t("browser.servers.running")}
        className="size-2 bg-success shadow-[0_0_0_2.5px_color-mix(in_srgb,var(--success)_18%,transparent)]"
      />
    );
  }
  return null;
}

function rowActionLabel(
  row: LaunchServerRow,
  format: ReturnType<typeof useTranslation>["format"],
): string {
  if (launchServerRowStartable(row)) return format("browser.servers.start", { name: row.name });
  if (row.state === "idle") return format("browser.servers.open", { name: row.name });
  if (launchServerRowStoppable(row)) return format("browser.servers.stop", { name: row.name });
  return format("browser.servers.open", { name: row.name });
}

function RowActionGlyph({ row }: { row: LaunchServerRow }) {
  if (row.state === "starting" && !row.run) {
    return <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />;
  }
  if (row.state !== "idle" && launchServerRowStoppable(row)) {
    return <StopIcon aria-hidden className="size-3.5" />;
  }
  return <PlayOutlineIcon aria-hidden className="size-4" />;
}

/** What the row's own button does: start an idle one, stop a running one. */
function runRowAction(
  row: LaunchServerRow,
  servers: Pick<ProjectLaunchServers, "openOrStart" | "stop">,
) {
  if (row.state !== "idle" && launchServerRowStoppable(row)) {
    servers.stop(row);
    return;
  }
  servers.openOrStart(row);
}

function rowButtonEnabled(row: LaunchServerRow): boolean {
  if (row.state === "starting") return launchServerRowStoppable(row);
  if (row.state === "running") return launchServerRowStoppable(row) || row.url !== null;
  return launchServerRowStartable(row) || row.url !== null;
}

/**
 * The new tab's list: a card of rows in the middle of the page and, at the foot, the
 * line that says where the list is kept.
 */
export function LaunchServersPage(props: {
  readonly servers: ProjectLaunchServers;
  /** Opens the launch file in the file panel (shown as a link when it exists). */
  readonly onEditFile?: ((absolutePath: string) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const { servers } = props;
  const [expanded, setExpanded] = useState(false);
  const footer = useLaunchServerFooter(servers);
  const visibleRows = expanded
    ? servers.rows
    : servers.rows.slice(0, LAUNCH_SERVER_LIST_COLLAPSED_COUNT);
  const hiddenCount = servers.rows.length - visibleRows.length;
  const editFilePath = servers.editFilePath;

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-[var(--color-background-surface)] text-foreground"
      data-browser-servers-home=""
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
        {servers.rows.length > 0 ? (
          <div className="flex w-full max-w-[36rem] flex-col items-center gap-3">
            <div
              className="w-full overflow-hidden rounded-xl border border-border bg-[var(--color-background-surface)]"
              role="list"
              aria-label={t("browser.servers.title")}
            >
              {visibleRows.map((row) => (
                <div
                  key={row.key}
                  role="listitem"
                  data-launch-server={row.name}
                  data-launch-server-state={row.state}
                  className="group flex h-[38px] items-center gap-3 border-border/70 border-b pr-1.5 pl-3 last:border-b-0 hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left outline-none focus-visible:underline"
                    title={
                      row.state === "running"
                        ? format("browser.servers.open", { name: row.name })
                        : rowActionLabel(row, format)
                    }
                    disabled={
                      row.state === "starting" || (!row.url && !launchServerRowStartable(row))
                    }
                    onClick={() => servers.openOrStart(row)}
                  >
                    <ServerIcon
                      aria-hidden
                      className="size-4 shrink-0 text-[var(--color-text-foreground-secondary)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-ui" data-translation-skip="true">
                      {row.name}
                    </span>
                    <RowStatus state={row.state} />
                    {row.port !== null ? (
                      <span className="shrink-0 text-ui-sm tabular-nums text-[var(--color-text-foreground-secondary)]">
                        :{row.port}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={rowActionLabel(row, format)}
                    title={rowActionLabel(row, format)}
                    disabled={!rowButtonEnabled(row)}
                    data-launch-server-action=""
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)] disabled:opacity-50"
                    onClick={() => runRowAction(row, servers)}
                  >
                    <RowActionGlyph row={row} />
                  </button>
                </div>
              ))}
            </div>
            {hiddenCount > 0 || expanded ? (
              <button
                type="button"
                className="rounded-md px-2 py-0.5 text-ui-sm text-[var(--color-text-foreground-secondary)] hover:text-foreground"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? t("browser.servers.showFewer") : t("browser.servers.seeAll")}
              </button>
            ) : null}
          </div>
        ) : servers.loading ? (
          <LoaderCircleIcon
            aria-label={t("environment.localServers.scanning")}
            className="size-5 animate-spin text-muted-foreground/60"
          />
        ) : null}
      </div>
      <p
        className="shrink-0 px-6 pb-5 text-center text-ui-sm leading-snug text-[var(--color-text-foreground-secondary)]"
        data-browser-servers-footer=""
      >
        {footer.lead}
        <br />
        {editFilePath && props.onEditFile ? (
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => props.onEditFile?.(editFilePath)}
          >
            {footer.fileLine}
          </button>
        ) : (
          footer.fileLine
        )}
        {servers.problems.length > 0 ? (
          <span className="block pt-1 text-warning" title={servers.problems.join("\n")}>
            {t("browser.servers.problems")}
          </span>
        ) : null}
      </p>
    </div>
  );
}

function stopMenuEvent(event: MouseEvent) {
  event.stopPropagation();
}

function MenuServerRow(props: {
  readonly name: string;
  readonly port: number | null;
  readonly status: ReactNode;
  readonly openLabel: string;
  readonly openDisabled: boolean;
  readonly onOpen: () => void;
  readonly action: {
    readonly label: string;
    readonly glyph: ReactNode;
    readonly disabled: boolean;
    readonly destructive: boolean;
    readonly onClick: () => void;
  } | null;
  readonly dataKey: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 pr-1.5">
      <MenuItem
        disabled={props.openDisabled}
        onClick={props.onOpen}
        aria-label={props.openLabel}
        title={props.openLabel}
        data-local-server-open={props.dataKey}
        className="grid h-auto min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 py-1 pl-2 pr-1"
      >
        <span className="flex size-4 items-center justify-center">{props.status}</span>
        <span className="truncate text-ui" data-translation-skip="true">
          {props.name}
        </span>
        {props.port !== null ? (
          <span className="text-ui-sm tabular-nums text-[var(--color-text-foreground-secondary)]">
            :{props.port}
          </span>
        ) : (
          <span />
        )}
      </MenuItem>
      {props.action ? (
        <MenuItem
          closeOnClick={false}
          disabled={props.action.disabled}
          onClick={props.action.onClick}
          onMouseDown={stopMenuEvent}
          aria-label={props.action.label}
          title={props.action.label}
          data-launch-server-action=""
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground/80 transition-colors data-disabled:text-muted-foreground/30",
            props.action.destructive
              ? "hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] hover:text-destructive data-highlighted:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] data-highlighted:text-destructive"
              : "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-foreground",
          )}
        >
          {props.action.glyph}
        </MenuItem>
      ) : (
        <span className="size-6" />
      )}
    </div>
  );
}

function rowStatusGlyph(row: LaunchServerRow): ReactNode {
  if (row.state === "idle") {
    return (
      <ServerIcon aria-hidden className="size-3.5 text-[var(--color-text-foreground-secondary)]" />
    );
  }
  return <RowStatus state={row.state} />;
}

/**
 * The same list inside a menu: rows open (or start) on click, the trailing button starts
 * or stops, five rows then "See all", servers elsewhere on the computer under their own
 * label, and the footer line.
 */
export function LaunchServerMenuRows(props: {
  readonly servers: ProjectLaunchServers;
  /** Opens an address of a server found elsewhere on the computer. */
  readonly onOpenUrl: (url: string) => void;
  /** Stops a server found elsewhere (when it can be stopped). */
  readonly onStopElsewhere?: ((server: ServerLocalServerProcess) => void) | undefined;
  readonly showElsewhere?: boolean;
  /** The line saying where the list is kept (left out where the menu links the file). */
  readonly showFooter?: boolean;
}) {
  const { t, format } = useTranslation();
  const { servers } = props;
  const [expanded, setExpanded] = useState(false);
  const footer = useLaunchServerFooter(servers);
  const visibleRows = expanded
    ? servers.rows
    : servers.rows.slice(0, LAUNCH_SERVER_LIST_COLLAPSED_COUNT);
  const hiddenCount = servers.rows.length - visibleRows.length;

  return (
    <>
      {visibleRows.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-launch-server-menu="">
          {visibleRows.map((row) => (
            <MenuServerRow
              key={row.key}
              dataKey={row.key}
              name={row.name}
              port={row.port}
              status={rowStatusGlyph(row)}
              openLabel={
                row.state === "running"
                  ? format("browser.servers.open", { name: row.name })
                  : rowActionLabel(row, format)
              }
              openDisabled={
                row.state === "starting" || (!row.url && !launchServerRowStartable(row))
              }
              onOpen={() => servers.openOrStart(row)}
              action={{
                label: rowActionLabel(row, format),
                glyph: <RowActionGlyph row={row} />,
                disabled: !rowButtonEnabled(row),
                destructive: row.state !== "idle" && launchServerRowStoppable(row),
                onClick: () => runRowAction(row, servers),
              }}
            />
          ))}
        </div>
      ) : null}
      {hiddenCount > 0 || expanded ? (
        <MenuItem
          closeOnClick={false}
          className="justify-center py-1 text-ui-sm text-[var(--color-text-foreground-secondary)]"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("browser.servers.showFewer") : t("browser.servers.seeAll")}
        </MenuItem>
      ) : null}
      {props.showElsewhere !== false && servers.elsewhere.length > 0 ? (
        <MenuGroup>
          <MenuGroupLabel className="pt-1.5 pb-0.5 text-ui-xs">
            {t("environment.localServers.elsewhere")}
          </MenuGroupLabel>
          <div className="flex flex-col gap-0.5">
            {servers.elsewhere.map((server) => {
              const url = localServerOpenUrl(server);
              const name = localServerPrimaryLabel(server);
              return (
                <MenuServerRow
                  key={server.id}
                  dataKey={server.id}
                  name={name}
                  port={server.ports[0] ?? null}
                  status={<RowStatus state="running" />}
                  openLabel={format("browser.servers.open", { name })}
                  openDisabled={!url}
                  onOpen={() => {
                    if (url) props.onOpenUrl(url);
                  }}
                  action={
                    props.onStopElsewhere
                      ? {
                          label: format("browser.servers.stop", { name }),
                          glyph: <StopIcon aria-hidden className="size-3.5" />,
                          disabled: !server.isStoppable,
                          destructive: true,
                          onClick: () => props.onStopElsewhere?.(server),
                        }
                      : null
                  }
                />
              );
            })}
          </div>
        </MenuGroup>
      ) : null}
      {props.showFooter !== false && footer.fileLine ? (
        <p
          className="px-2 pt-1.5 pb-1 text-ui-xs leading-snug text-[var(--color-text-foreground-secondary)]"
          data-launch-server-footer=""
        >
          {footer.fileLine}
        </p>
      ) : null}
    </>
  );
}
