// FILE: PluginMarketplaceDialog.tsx
// Purpose: Add-plugin-marketplace dialog and settled mutation UI.
// Layer: Web component
// Exports: PluginMarketplaceDialog and its exact mutation result shape

import { useEffect, useState } from "react";
import type { ProviderAddMarketplaceResult } from "@synara/contracts";

import {
  normalizePluginMarketplaceForm,
  type PluginMarketplaceAddParams,
  type PluginMarketplaceFormValue,
} from "~/lib/pluginMarketplaceModel";
import { useTranslation } from "~/localization";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export interface PluginMarketplaceDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdd: (input: PluginMarketplaceAddParams) => Promise<ProviderAddMarketplaceResult>;
}

const EMPTY_FORM: PluginMarketplaceFormValue = {
  source: "",
  refName: "",
  sparsePaths: "",
};

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}

export function PluginMarketplaceDialog({
  open,
  onOpenChange,
  onAdd,
}: PluginMarketplaceDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PluginMarketplaceFormValue>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setSubmitting(false);
    setError(null);
  }, [open]);

  const normalized = normalizePluginMarketplaceForm(form);
  const close = () => {
    if (!submitting) onOpenChange(false);
  };
  const submit = async () => {
    if (!normalized.ok || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(normalized.value);
      setForm(EMPTY_FORM);
      onOpenChange(false);
    } catch (reason) {
      setError(mutationErrorMessage(reason, t("plugins.marketplace.failed")));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}>
      <DialogPopup surface="solid" className="max-w-xl" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle data-testid="plugin-marketplace-title">
            {t("plugins.marketplace.title")}
          </DialogTitle>
          <DialogDescription>
            {t("plugins.marketplace.subtitle")}{" "}
            <a
              href="https://developers.openai.com/codex/plugins/build"
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground underline underline-offset-2"
            >
              {t("plugins.marketplace.learnMore")}
            </a>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <label className="flex flex-col gap-1.5 text-ui-lg text-muted-foreground">
            <span>{t("plugins.marketplace.sourceLabel")}</span>
            <Input
              autoFocus
              nativeInput
              required
              aria-required="true"
              data-testid="plugin-marketplace-source"
              value={form.source}
              placeholder={t("plugins.marketplace.sourcePlaceholder")}
              disabled={submitting}
              onChange={(event) =>
                setForm((current) => ({ ...current, source: event.target.value }))
              }
            />
          </label>
          <label className="flex flex-col gap-1.5 text-ui-lg text-muted-foreground">
            <span>{t("plugins.marketplace.refLabel")}</span>
            <Input
              nativeInput
              data-testid="plugin-marketplace-ref"
              value={form.refName}
              placeholder={t("plugins.marketplace.refPlaceholder")}
              disabled={submitting}
              onChange={(event) =>
                setForm((current) => ({ ...current, refName: event.target.value }))
              }
            />
          </label>
          <label className="flex flex-col gap-1.5 text-ui-lg text-muted-foreground">
            <span>{t("plugins.marketplace.sparsePathsLabel")}</span>
            <Textarea
              data-testid="plugin-marketplace-sparse-paths"
              value={form.sparsePaths}
              placeholder={t("plugins.marketplace.sparsePathsPlaceholder")}
              disabled={submitting}
              onChange={(event) =>
                setForm((current) => ({ ...current, sparsePaths: event.target.value }))
              }
            />
          </label>
          {error ? (
            <p role="alert" className="text-ui-lg text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={close}>
            {t("plugins.action.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="plugin-marketplace-submit"
            disabled={!normalized.ok || submitting}
            aria-busy={submitting || undefined}
            onClick={() => void submit()}
          >
            {t("plugins.action.addMarketplace")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
