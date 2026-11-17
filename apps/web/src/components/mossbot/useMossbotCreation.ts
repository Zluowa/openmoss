// FILE: useMossbotCreation.ts
// Purpose: Creating a Mossbot safely, shared by the create dialog and first-run onboarding. A failed configure keeps
//          the created container and retries the same operation; abandoning setup first checks whether a lost
//          response already created the assistant before removing the empty container.
// Layer: Mossbot UI logic (hook)
// Exports: useMossbotCreation, MossbotCreationDraft
import { useRef, useState } from "react";
import type { ModelSelection, ProjectAgentOverview, ProjectId } from "@moss/contracts";
import { createGroupProject } from "~/lib/groupProjects";
import { readNativeApi } from "~/nativeApi";
import { useProjectAgentSummariesStore } from "~/components/chat/project/useProjectAgentSummaries";
import { buildMossbotConfigureInput } from "./mossbot.logic";
import { useMossbotCopy } from "./mossbot.copy";

export interface MossbotCreationDraft {
  name: string;
  instructions: string;
  model: ModelSelection;
  avatar: string;
  color?: string | undefined;
}

export function useMossbotCreation(onCreated: (overview: ProjectAgentOverview) => void) {
  const { locale, errorText } = useMossbotCopy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  // Keep the created container on a failed configure and retry that same operation.
  const project = useRef<ProjectId | null>(null);
  const createdName = useRef<string | null>(null);
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);

  /** Resolves true when an assistant was created (onCreated has been called). */
  const create = async (draft: MossbotCreationDraft): Promise<boolean> => {
    if (saving.current) return false;
    const api = readNativeApi();
    if (!api) {
      setError("Moss is reconnecting. Try again once connected.");
      return false;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      // Validate before creating any durable object.
      buildMossbotConfigureInput({
        projectId: "validate" as ProjectId,
        requestId: "validate",
        name: draft.name,
        instructions: draft.instructions,
        modelSelection: draft.model,
      });
      if (!project.current) {
        createdName.current = draft.name.trim();
        project.current = await createGroupProject({ title: draft.name.trim() });
      }
      if (!project.current) throw new Error("Moss has not loaded its workspace yet. Please retry.");
      const fingerprint = JSON.stringify(draft);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, requestId: crypto.randomUUID() };
      const overview = await api.projectAgent.configure(
        buildMossbotConfigureInput({
          projectId: project.current,
          requestId: attempt.current.requestId,
          name: draft.name,
          instructions: draft.instructions,
          modelSelection: draft.model,
          userLocale: locale,
          avatar: draft.avatar,
          ...(draft.color ? { color: draft.color } : {}),
        }),
      );
      useProjectAgentSummariesStore.getState().applyOverview(overview);
      onCreated(overview);
      return true;
    } catch (cause) {
      setError(errorText(cause, "Could not create this assistant."));
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  /**
   * Leave setup. "closed": nothing is left behind; "created": a lost response had created the assistant (onCreated
   * was called); "busy" or "failed": stay, the error says why.
   */
  const abandon = async (
    fallbackName: string,
  ): Promise<"closed" | "created" | "busy" | "failed"> => {
    if (saving.current) return "busy";
    if (!project.current) return "closed";
    const api = readNativeApi();
    if (!api) {
      setError("Moss is reconnecting. Please retry before closing setup.");
      return "failed";
    }
    saving.current = true;
    setBusy(true);
    try {
      // A lost configure response may already have created the assistant. Read
      // before cleanup; never delete a possibly completed assistant on timeout.
      const overview = await api.projectAgent.getOverview({ projectId: project.current });
      if (overview.configured) {
        useProjectAgentSummariesStore.getState().applyOverview(overview);
        onCreated(overview);
        return "created";
      }
      await api.projectAgent.deleteGroup({
        requestId: crypto.randomUUID(),
        projectId: project.current,
        confirmName: createdName.current ?? fallbackName.trim(),
        requireEmpty: true,
      });
      project.current = null;
      attempt.current = null;
      return "closed";
    } catch {
      setError("Could not confirm setup state. Retry to recover this assistant safely.");
      return "failed";
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return { busy, error, setError, create, abandon };
}
