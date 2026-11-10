// FILE: SshConnectionEditor.tsx
// Purpose: Shared manual add/edit form; explicit overrides preserve SSH config defaults.
// Layer: Connection settings UI
import type { SshConnection } from "@moss/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { GlobeIcon } from "~/lib/icons";
import { useTranslation, type TranslationKey } from "~/localization";
import { LARGE_DIALOG_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { SettingsSegmentedControl } from "./SettingControls";
import { sshFailureTranslationKey } from "./sshConnectionsSettingsModel";

export function SshConnectionEditor({
  connection,
  onClose,
  onSave,
}: {
  readonly connection: SshConnection | "new" | null;
  readonly onClose: () => void;
  readonly onSave: (value: Omit<SshConnection, "id"> & { readonly id?: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(""),
    [host, setHost] = useState(""),
    [port, setPort] = useState("");
  const [identity, setIdentity] = useState("");
  const [identityMode, setIdentityMode] = useState<"default" | "file">("default");
  const [saving, setSaving] = useState(false),
    [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    const value = connection && connection !== "new" ? connection : null;
    setName(value?.displayName ?? "");
    setHost(value?.host ?? "");
    setPort(String(value?.port ?? ""));
    setIdentity(value?.identityFile ?? "");
    setIdentityMode(value?.identityFile ? "file" : "default");
    setError(null);
    setChoosing(false);
  }, [connection]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!connection || saving) return;
    if (!name.trim()) {
      setError("settings.ssh.error.name");
      return;
    }
    if (!host.trim()) {
      setError("settings.ssh.error.host");
      return;
    }
    if (port && (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      setError("settings.ssh.error.port");
      return;
    }
    if (identityMode === "file" && !identity.trim()) {
      setError("settings.ssh.error.identity");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...(connection === "new"
          ? { enabled: true }
          : { id: connection.id, enabled: connection.enabled ?? false }),
        displayName: name.trim(),
        host: host.trim(),
        ...(port ? { port: Number(port) } : {}),
        ...(identityMode === "file" ? { identityFile: identity.trim() } : {}),
      });
    } catch (cause) {
      setError(sshFailureTranslationKey(cause));
    } finally {
      setSaving(false);
    }
  };
  const choose = async () => {
    const request = generation.current;
    setChoosing(true);
    try {
      const file = await window.desktopBridge?.ssh?.pickIdentityFile();
      if (request === generation.current && file) {
        setIdentity(file);
        setError(null);
      }
    } catch {
      if (request === generation.current) setError("settings.ssh.error.identity");
    } finally {
      if (request === generation.current) setChoosing(false);
    }
  };
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle className={LARGE_DIALOG_TITLE_CLASS_NAME}>
              {t(connection === "new" ? "settings.ssh.add" : "settings.ssh.editTitle")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.ssh.formDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            <label className="flex flex-col gap-2 text-ui font-medium">
              <span>{t("settings.ssh.name")}</span>
              <InputGroup>
                <InputGroupAddon className="w-10 self-stretch border-e border-border ps-0">
                  <GlobeIcon aria-hidden className="size-4 text-primary" />
                </InputGroupAddon>
                <InputGroupInput
                  autoFocus
                  disabled={saving}
                  value={name}
                  maxLength={80}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                />
              </InputGroup>
            </label>
            <label className="flex flex-col gap-2 text-ui font-medium">
              <span>{t("settings.ssh.host")}</span>
              <Input
                disabled={saving}
                value={host}
                onChange={(event) => {
                  setHost(event.target.value);
                  setError(null);
                }}
                placeholder={t("settings.ssh.hostPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-2 text-ui font-medium">
              <span>{t("settings.ssh.port")}</span>
              <Input
                disabled={saving}
                value={port}
                onChange={(event) => {
                  setPort(event.target.value);
                  setError(null);
                }}
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
            <fieldset
              disabled={saving}
              className="min-w-0 border-0 p-0 [&_[role=radiogroup]]:w-full [&_[role=radio]]:flex-1"
            >
              <SettingsSegmentedControl
                value={identityMode}
                onValueChange={setIdentityMode}
                ariaLabel={t("settings.ssh.authentication")}
                options={[
                  { value: "default", label: t("settings.ssh.defaultIdentity") },
                  { value: "file", label: t("settings.ssh.identityFile") },
                ]}
              />
            </fieldset>
            {identityMode === "file" ? (
              <label className="flex flex-col gap-2 text-ui font-medium">
                <span>{t("settings.ssh.identityPath")}</span>
                <div className="flex items-center gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    disabled={saving || choosing}
                    value={identity}
                    onChange={(event) => {
                      setIdentity(event.target.value);
                      setError(null);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving || choosing}
                    onClick={() => void choose()}
                  >
                    {t("settings.ssh.choose")}
                  </Button>
                </div>
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="text-ui text-destructive">
                {t(error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              {t("settings.ssh.cancel")}
            </Button>
            <Button type="submit" className="rounded-full" disabled={saving || choosing}>
              {t(saving ? "settings.ssh.saving" : "settings.ssh.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
