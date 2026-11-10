import { MossbotAvatarPicker } from "./MossbotAvatar";
import { useMossbotCopy } from "./mossbot.copy";
import { useRef, useState } from "react";
import type { ModelSelection, ProjectAgentOverview, ProjectId } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { GroupModelRow } from "~/components/chat/group/GroupModelEffortRow";
import { createGroupProject } from "~/lib/groupProjects";
import { readNativeApi } from "~/nativeApi";
import { useProjectAgentSummariesStore } from "~/components/chat/project/useProjectAgentSummaries";
import { buildMossbotConfigureInput, MOSSBOT_TEMPLATES } from "./mossbot.logic";

export function MossbotCreateDialog(props: {
  open: boolean;
  templateId: string;
  defaultModelSelection: ModelSelection;
  workspacePath: string;
  onClose: () => void;
  onCreated: (overview: ProjectAgentOverview) => void;
}) {
  const { locale, t, errorText } = useMossbotCopy();
  const template =
    MOSSBOT_TEMPLATES.find((item) => item.id === props.templateId) ?? MOSSBOT_TEMPLATES[0];
  const [name, setName] = useState<string>(template.id === "personal" ? "Moss" : t(template.name));
  const [instructions, setInstructions] = useState<string>(t(template.instructions));
  const [avatar, setAvatar] = useState(
    template.id === "research"
      ? "mossbot-sprout"
      : template.id === "projects"
        ? "mossbot-orbit"
        : "mossbot-pebble",
  );
  const [model, setModel] = useState(props.defaultModelSelection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  // Keep the created container on a failed configure and retry that same operation.
  const project = useRef<ProjectId | null>(null);
  const createdName = useRef<string | null>(null);
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);

  const close = async () => {
    if (saving.current) return;
    if (!project.current) {
      props.onClose();
      return;
    }
    const api = readNativeApi();
    if (!api) {
      setError("Moss is reconnecting. Please retry before closing setup.");
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      // A lost configure response may already have created the assistant. Read
      // before cleanup; never delete a possibly completed assistant on timeout.
      const overview = await api.projectAgent.getOverview({ projectId: project.current });
      if (overview.configured) {
        useProjectAgentSummariesStore.getState().applyOverview(overview);
        props.onCreated(overview);
      } else {
        await api.projectAgent.deleteGroup({
          requestId: crypto.randomUUID(),
          projectId: project.current,
          confirmName: createdName.current ?? name.trim(),
          requireEmpty: true,
        });
        props.onClose();
      }
    } catch {
      setError("Could not confirm setup state. Retry to recover this assistant safely.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const create = async () => {
    if (saving.current) return;
    const api = readNativeApi();
    if (!api) {
      setError("Moss is reconnecting. Try again once connected.");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      // Validate before creating any durable object.
      buildMossbotConfigureInput({
        projectId: "validate" as ProjectId,
        requestId: "validate",
        name,
        instructions,
        modelSelection: model,
      });
      if (!project.current) {
        createdName.current = name.trim();
        project.current = await createGroupProject({ title: name.trim() });
      }
      if (!project.current) throw new Error("Moss has not loaded its workspace yet. Please retry.");
      const fingerprint = JSON.stringify({ name, instructions, model, avatar });
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, requestId: crypto.randomUUID() };
      const overview = await api.projectAgent.configure(
        buildMossbotConfigureInput({
          projectId: project.current,
          requestId: attempt.current.requestId,
          name,
          instructions,
          modelSelection: model,
          userLocale: locale,
          avatar,
        }),
      );
      useProjectAgentSummariesStore.getState().applyOverview(overview);
      props.onCreated(overview);
    } catch (cause) {
      setError(errorText(cause, "Could not create this assistant."));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy) void close();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a Mossbot</DialogTitle>
          <DialogDescription className="sr-only">
            Give your assistant a purpose. You can change its model, memory, and skills later.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="space-y-2">
            <p className="text-ui font-medium">{t("Choose a familiar face")}</p>
            <MossbotAvatarPicker value={avatar} onChange={setAvatar} disabled={busy} />
          </div>
          <div className="space-y-2">
            <label htmlFor="mossbot-name" className="text-ui font-medium">
              Name
            </label>
            <Input
              id="mossbot-name"
              autoFocus
              value={name}
              maxLength={160}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="mossbot-personality" className="text-ui font-medium">
              Personality & instructions
            </label>
            <Textarea
              id="mossbot-personality"
              value={instructions}
              rows={4}
              maxLength={16_000}
              disabled={busy}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
          <GroupModelRow
            title="CLI & model"
            description="Use any provider configured in Moss."
            selection={model}
            defaultSelection={props.defaultModelSelection}
            projectCwd={props.workspacePath}
            onChange={(next) => {
              if (!busy) setModel(next);
            }}
          />

          {error && (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => void close()}>
            Cancel
          </Button>
          <Button
            disabled={busy || !name.trim() || !instructions.trim()}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create assistant"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
