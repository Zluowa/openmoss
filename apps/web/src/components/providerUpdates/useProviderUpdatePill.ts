// FILE: useProviderUpdatePill.ts
// Purpose: The status pill's lifecycle, adapted from T3 Code's SidebarProviderUpdatePill (MIT):
//          swaps views through an exit transition and dismisses success on a timer.
// Layer: Web shell navigation hook.

import type { ServerProviderStatus } from "@synara/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import {
  getProviderUpdatePillView,
  type ProviderUpdateI18n,
  type ProviderUpdatePillView,
  type ProviderUpdateRunProgress,
} from "./providerUpdateRail.logic";

// Matches the pill's `duration-180` class.
const PILL_EXIT_MS = 180;

function latestCheckedAt(providers: ReadonlyArray<ServerProviderStatus>): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

export function useProviderUpdatePill(input: {
  readonly providers: ReadonlyArray<ServerProviderStatus>;
  readonly run: ProviderUpdateRunProgress | null;
  readonly i18n: ProviderUpdateI18n;
}) {
  const { providers, run, i18n } = input;
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [renderedView, setRenderedView] = useState<ProviderUpdatePillView | null>(null);
  const [pendingView, setPendingView] = useState<ProviderUpdatePillView | null>(null);
  const [exitingKey, setExitingKey] = useState<string | null>(null);
  const [dismissAfterExitKey, setDismissAfterExitKey] = useState<string | null>(null);
  // Results that finished before this window opened are old news.
  const [visibleAfterIso, setVisibleAfterIso] = useState<string | undefined>();
  const effectiveVisibleAfterIso = visibleAfterIso ?? latestCheckedAt(providers);
  const view = getProviderUpdatePillView(providers, i18n, {
    ...(effectiveVisibleAfterIso !== undefined
      ? { visibleAfterIso: effectiveVisibleAfterIso }
      : {}),
    dismissedKeys,
    run,
  });

  if (visibleAfterIso === undefined && effectiveVisibleAfterIso !== undefined) {
    setVisibleAfterIso(effectiveVisibleAfterIso);
  }

  const startExit = (
    key: string,
    nextView: ProviderUpdatePillView | null,
    dismissKey?: string,
  ): void => {
    if (exitingKey === key) return;
    setPendingView(nextView);
    setExitingKey(key);
    setDismissAfterExitKey(dismissKey ?? null);
  };

  if (exitingKey === null) {
    if (!renderedView) {
      if (view) setRenderedView(view);
    } else if (!view) {
      startExit(renderedView.key, null);
    } else if (view.key !== renderedView.key) {
      startExit(renderedView.key, view);
    } else if (view !== renderedView && view.title !== renderedView.title) {
      // Same phase, new wording: "1/3" became "2/3". No exit transition for that.
      setRenderedView(view);
    }
  }

  const displayedView = renderedView ?? view;
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;

  const exitAfterVisible = useEffectEvent((key: string) => startExit(key, null, key));
  const finishExit = useEffectEvent(() => {
    if (dismissAfterExitKey !== null) {
      setDismissedKeys((previous) => new Set(previous).add(dismissAfterExitKey));
    }
    setRenderedView(pendingView);
    setPendingView(null);
    setExitingKey(null);
    setDismissAfterExitKey(null);
  });

  useEffect(() => {
    if (exitingKey === null) return;
    // A cancelled or skipped CSS transition must not keep a hidden pill mounted.
    const timeoutId = window.setTimeout(finishExit, PILL_EXIT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [exitingKey]);

  useEffect(() => {
    if (!dismissAfterVisibleMs || !viewKey || exitingKey === viewKey) return;
    const timeoutId = window.setTimeout(() => exitAfterVisible(viewKey), dismissAfterVisibleMs);
    return () => window.clearTimeout(timeoutId);
  }, [dismissAfterVisibleMs, exitingKey, viewKey]);

  return {
    view: displayedView,
    /** What is true now; `view` can still be finishing its exit from an earlier state. */
    liveTone: view?.tone ?? null,
    exiting: displayedView !== null && exitingKey === displayedView.key,
    dismiss: () => {
      if (displayedView) startExit(displayedView.key, null, displayedView.key);
    },
  };
}
