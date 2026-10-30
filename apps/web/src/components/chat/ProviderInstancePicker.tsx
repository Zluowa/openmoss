// FILE: ProviderInstancePicker.tsx
// Purpose: Keeps provider-account selection separate from model selection in the composer.
// Layer: Chat composer presentation
// Depends on: provider-instance settings, live provider status, and shared picker primitives.

import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { memo, useCallback, useMemo, useState } from "react";

import { SettingsIcon, UserIcon } from "~/lib/icons";
import {
  MISSING_PROVIDER_INSTANCE_LABEL,
  resolveProviderInstanceLabel,
} from "~/lib/providerInstancePresentation";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { compareProvidersByOrder, DEFAULT_PROVIDER_ORDER } from "../../providerOrdering";
import {
  isMossManagedSourceInstanceId,
  isMossProtectedSourceInstanceId,
} from "./providerAccountSources";
import {
  defaultProviderInstance,
  findProviderStatusForInstance,
  resolveLiveProviderAvailability,
  type ProviderModelPickerInstance,
} from "./ProviderModelPicker";

function isCoreAccountProvider(
  provider: ProviderKind | string,
): provider is "codex" | "claudeAgent" {
  return provider === "codex" || provider === "claudeAgent";
}

function sourceSortOrder(instance: ProviderModelPickerInstance): number {
  if (isMossManagedSourceInstanceId(instance.instanceId)) return 0;
  if (instance.instanceId === instance.provider) return 1;
  if (instance.isDefault) return 2;
  return 3;
}

function isUsableAccountSource(
  instance: ProviderModelPickerInstance,
  providers: ReadonlyArray<ServerProviderStatus> | undefined,
): boolean {
  if (!instance.enabled) return false;
  const status = findProviderStatusForInstance({
    providers,
    provider: instance.provider,
    instanceId: instance.instanceId,
  });
  if (status?.available !== true || status.enabled === false) return false;
  return (
    isMossProtectedSourceInstanceId(instance.instanceId) || status.authStatus === "authenticated"
  );
}

/**
 * Converts provider inventory into usable Agent/account routes. Managed routes
 * stay identity-bearing per Agent (Codex and Claude) so the UI can switch the
 * executor separately from the account used to run it.
 */
export function resolveComposerProviderSources(input: {
  readonly provider: ProviderKind;
  readonly providerInstances: ReadonlyArray<ProviderModelPickerInstance>;
  readonly providers?: ReadonlyArray<ServerProviderStatus>;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly providerOrder?: ReadonlyArray<ProviderKind>;
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly selectionLocked?: boolean;
}): ProviderModelPickerInstance[] {
  const providerInstances = [...input.providerInstances];
  for (const status of input.providers ?? []) {
    const provider = status.provider;
    if (
      !isCoreAccountProvider(provider) ||
      (status.instanceId ?? provider) !== provider ||
      providerInstances.some((instance) => instance.instanceId === provider)
    ) {
      continue;
    }
    // Auto-detected personal CLIs need no saved instance. Only their own default
    // status can supply that route; managed/custom accounts keep their identities.
    providerInstances.push(defaultProviderInstance(provider));
  }
  const availableInstances = providerInstances.filter(
    (instance) =>
      (instance.provider === input.provider ||
        !input.hiddenProviders?.includes(instance.provider)) &&
      (isUsableAccountSource(instance, input.providers) ||
        (input.selectionLocked === true &&
          instance.instanceId === input.selectedProviderInstanceId)),
  );

  return availableInstances.toSorted((left, right) => {
    return (
      compareProvidersByOrder(
        input.providerOrder ?? DEFAULT_PROVIDER_ORDER,
        left.provider,
        right.provider,
      ) || sourceSortOrder(left) - sourceSortOrder(right)
    );
  });
}

export interface ProviderInstancePickerProps {
  readonly provider: ProviderKind;
  readonly providerInstances: ReadonlyArray<ProviderModelPickerInstance>;
  readonly providers?: ReadonlyArray<ServerProviderStatus>;
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly selectionLocked?: boolean;
  readonly compact?: boolean;
  readonly hideLabel?: boolean;
  readonly onProviderInstanceChange: (instanceId: ProviderInstanceId) => void;
  readonly onManageAccounts: () => void;
  readonly onSelectionCommitted?: () => void;
}

function pickerSectionLabel(provider: ProviderKind): string {
  return provider === "codex" || provider === "claudeAgent" ? "Accounts" : "Profiles";
}

function manageLabel(provider: ProviderKind): string {
  return provider === "codex" || provider === "claudeAgent"
    ? "Manage accounts…"
    : "Manage profiles…";
}

export const ProviderInstancePicker = memo(function ProviderInstancePicker(
  props: ProviderInstancePickerProps,
) {
  const [open, setOpen] = useState(false);
  const instances = useMemo(
    () => props.providerInstances.filter((instance) => instance.provider === props.provider),
    [props.provider, props.providerInstances],
  );
  const selectedInstance = instances.find(
    (instance) => instance.instanceId === props.selectedProviderInstanceId,
  );
  const selectedLabel = resolveProviderInstanceLabel(instances, props.selectedProviderInstanceId);
  const triggerLabel = `Account: ${selectedLabel}`;

  const handleInstanceChange = useCallback(
    (value: string) => {
      if (!value || props.selectionLocked || value === props.selectedProviderInstanceId) {
        return;
      }
      props.onProviderInstanceChange(value as ProviderInstanceId);
      setOpen(false);
      props.onSelectionCommitted?.();
    },
    [props],
  );

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <PickerTriggerButton
            compact={props.compact ?? false}
            hideLabel={props.hideLabel ?? false}
            icon={<UserIcon aria-hidden="true" className="size-3.5" />}
            label={triggerLabel}
            className="max-w-44"
          />
        }
      >
        <span className="sr-only">{triggerLabel}</span>
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" fixedWidth>
        <div className="px-2.5 pb-1 pt-1 text-ui-xs font-medium text-muted-foreground uppercase tracking-[0.08em]">
          {pickerSectionLabel(props.provider)}
        </div>
        <MenuRadioGroup
          value={props.selectedProviderInstanceId}
          onValueChange={handleInstanceChange}
        >
          {!selectedInstance ? (
            <MenuRadioItem value={props.selectedProviderInstanceId} disabled>
              <span className="truncate">{MISSING_PROVIDER_INSTANCE_LABEL}</span>
              <span className="ms-auto text-ui-xs text-muted-foreground/80 uppercase tracking-[0.08em]">
                Unavailable
              </span>
            </MenuRadioItem>
          ) : null}
          {instances.map((instance) => {
            const availability = instance.enabled
              ? resolveLiveProviderAvailability(
                  findProviderStatusForInstance({
                    providers: props.providers,
                    provider: instance.provider,
                    instanceId: instance.instanceId,
                  }),
                )
              : { disabled: true, label: "Disabled" };
            const lockedSibling =
              props.selectionLocked && instance.instanceId !== props.selectedProviderInstanceId;
            const statusLabel = lockedSibling ? "New thread" : availability.label;
            return (
              <MenuRadioItem
                key={instance.instanceId}
                value={instance.instanceId}
                disabled={availability.disabled || lockedSibling}
              >
                <span className="truncate">{instance.label}</span>
                {statusLabel ? (
                  <span
                    className={cn(
                      "ms-auto text-ui-xs text-muted-foreground/80",
                      statusLabel !== "Checking" && "uppercase tracking-[0.08em]",
                    )}
                  >
                    {statusLabel}
                  </span>
                ) : null}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            setOpen(false);
            props.onManageAccounts();
          }}
        >
          <SettingsIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {manageLabel(props.provider)}
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
