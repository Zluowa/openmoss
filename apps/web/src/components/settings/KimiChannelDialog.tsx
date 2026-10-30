// FILE: KimiChannelDialog.tsx
// Purpose: Keep Kimi Coding Plan setup to one secret field and one flagship model.
// Layer: Settings presentation

import { useEffect, useRef, useState } from "react";

import { normalizeKimiApiKey } from "~/lib/ccSwitchChannels";
import { useTranslation } from "~/localization";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function KimiChannelDialog({
  open,
  connected,
  onOpenChange,
  onSave,
  onDisconnect,
}: {
  readonly open: boolean;
  readonly connected: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (apiKey: string) => Promise<void> | void;
  readonly onDisconnect: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | "disconnect" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setError(null);
      setPendingAction(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const save = async () => {
    if (pendingAction) return;
    let normalized: string;
    try {
      normalized = normalizeKimiApiKey(apiKey);
    } catch {
      setError(t("settings.providers.accounts.kimiInvalidKey"));
      return;
    }
    setError(null);
    setPendingAction("save");
    try {
      await onSave(normalized);
      onOpenChange(false);
    } catch {
      setPendingAction(null);
    }
  };

  const disconnect = async () => {
    if (pendingAction) return;
    setPendingAction("disconnect");
    try {
      await onDisconnect();
      onOpenChange(false);
    } catch {
      setPendingAction(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.providers.accounts.kimiDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.providers.accounts.kimiDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label htmlFor="kimi-coding-plan-api-key" className="text-ui-lg font-medium">
              {t("settings.providers.accounts.kimiKeyLabel")}
            </label>
            <Input
              id="kimi-coding-plan-api-key"
              ref={inputRef}
              type="password"
              size="lg"
              value={apiKey}
              disabled={pendingAction !== null}
              placeholder={t(
                connected
                  ? "settings.providers.accounts.kimiKeySaved"
                  : "settings.providers.accounts.kimiKeyPlaceholder",
              )}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
            {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          {connected ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pendingAction !== null}
              onClick={() => void disconnect()}
            >
              {t("settings.providers.accounts.disconnect")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={apiKey.trim().length === 0 || pendingAction !== null}
            onClick={() => void save()}
          >
            {t("settings.providers.accounts.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
