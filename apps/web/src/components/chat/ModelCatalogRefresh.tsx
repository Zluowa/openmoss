// FILE: ModelCatalogRefresh.tsx
// Purpose: Silently check the visible catalog when the picker opens on an account.
// Layer: Chat picker UI
//
// It renders nothing. A failed background check leaves the listed models usable, so the
// picker shows no error line for it (walk 2026-11-24, D-5: 「无法更新模型。 重试」 on open).
// An account that lists nothing says so, with its own retry (ModelPickerEmptyCatalog).

import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import type { ProviderInstanceId, ProviderKind } from "@moss/contracts";
import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";

export function ModelCatalogRefresh(props: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  onRefresh: ProviderModelCatalog["refreshModels"];
}) {
  const { provider, instanceId, onRefresh } = props;
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await onRefresh(provider, instanceId, "if-stale");
    } catch {
      // The listed models stay usable; the query keeps the failure for the empty state.
    } finally {
      inFlight.current = false;
    }
  }, [provider, instanceId, onRefresh]);

  const checkOnMount = useEffectEvent(() => void refresh());
  useEffect(() => {
    checkOnMount();
    return () => {
      inFlight.current = false;
    };
  }, [provider, instanceId]);

  return null;
}
