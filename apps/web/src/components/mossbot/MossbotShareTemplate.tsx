import type { ProjectAgentSummary } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { readNativeApi } from "~/nativeApi";
import { useMossbotCopy } from "./mossbot.copy";

export function MossbotShareTemplate({
  assistant,
  onClose,
}: {
  assistant: ProjectAgentSummary;
  onClose: () => void;
}) {
  const { t, errorText } = useMossbotCopy();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["mossbot", "template", assistant.projectId],
    staleTime: 0,
    queryFn: async () => {
      const api = readNativeApi()?.projectAgent;
      if (!api) throw new Error(t("Moss is reconnecting. Try again once connected."));
      const document = await api.readDocument({
        projectId: assistant.projectId,
        logicalPath: "instructions.md",
      });
      // Deliberately whitelist: no memory, conversations, provider accounts, or access grants.
      return JSON.stringify(
        {
          version: 1,
          name: assistant.coordinatorName,
          avatar: assistant.coordinatorIcon ?? "mossbot-pebble",
          instructions: document.document.content,
        },
        null,
        2,
      );
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="mossbot-template-dialog">
        <DialogHeader>
          <DialogTitle>{t("Share as template…")}</DialogTitle>
          <DialogDescription>
            {t(
              "Review the name and instructions before sharing. Memory, conversations and account access stay private.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.isPending && (
            <p role="status" className="text-ui">
              {t("Loading…")}
            </p>
          )}
          {query.isError && (
            <p role="alert" className="text-ui text-destructive">
              {errorText(query.error)}
              <Button variant="link" onClick={() => void query.refetch()}>
                {t("Retry")}
              </Button>
            </p>
          )}
          {query.data && (
            <pre
              tabIndex={0}
              className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-foreground/5 p-4 text-ui-sm"
            >
              {query.data}
            </pre>
          )}
          {error && (
            <p role="alert" className="mt-3 text-ui-sm text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={!query.data}
            onClick={() => {
              if (!query.data) return;
              const url = URL.createObjectURL(new Blob([query.data], { type: "application/json" }));
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "moss-assistant-template.json";
              anchor.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            {t("Download template")}
          </Button>
          <Button
            disabled={!query.data}
            onClick={() => {
              if (!query.data) return;
              setError(null);
              if (!navigator.clipboard) {
                setError(t("Could not copy. Download the template instead."));
                return;
              }
              void navigator.clipboard.writeText(query.data).then(
                () => setCopied(true),
                () => setError(t("Could not copy. Download the template instead.")),
              );
            }}
          >
            {t(copied ? "Copied" : "Copy template")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
