// FILE: ModelPickerEmptyCatalog.tsx
// Purpose: What the model picker says when an agent that runs has listed no models, or its
//          list could not be read: one plain sentence and a retry, never a bare "no models".
// Layer: Web chat composer.

import type { ProviderInstanceId, ProviderKind } from "@moss/contracts";
import { useState } from "react";

import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { useTranslation } from "../../localization";
import { RefreshCwIcon } from "~/lib/icons";
import { Button } from "../ui/button";

export function ModelPickerEmptyCatalog(props: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  agentLabel: string;
  /** The read failed (the detail stays in the tooltip); otherwise the agent listed nothing. */
  failure?: string | undefined;
  onRefresh?: ProviderModelCatalog["refreshModels"] | undefined;
}) {
  const { t, format } = useTranslation();
  const [pending, setPending] = useState(false);
  const { provider, instanceId, onRefresh } = props;
  const retry = async () => {
    if (!onRefresh || pending) return;
    setPending(true);
    try {
      await onRefresh(provider, instanceId, "now");
    } catch {
      // The query keeps the failure; this panel re-renders with it.
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="flex flex-col items-start gap-2 px-2 py-3 text-ui leading-relaxed text-muted-foreground"
      data-model-picker-empty={props.failure ? "failed" : "empty"}
    >
      <span role="status" {...(props.failure ? { title: props.failure } : {})}>
        {pending
          ? t("chat.modelPicker.checking")
          : props.failure
            ? t("chat.modelPicker.discoveryFailed")
            : format("chat.modelPicker.emptyCatalog", { provider: props.agentLabel })}
      </span>
      {onRefresh ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => void retry()}
        >
          <RefreshCwIcon
            aria-hidden="true"
            className={pending ? "size-3 motion-safe:animate-spin" : "size-3"}
          />
          {t("chat.modelPicker.retry")}
        </Button>
      ) : null}
    </div>
  );
}
