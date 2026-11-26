import { MossbotAvatarPicker } from "./MossbotAvatar";
import { useMossbotCopy } from "./mossbot.copy";
import { useState } from "react";
import type { ModelSelection, ProjectAgentOverview } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { GroupModelRow } from "~/components/chat/group/GroupModelEffortRow";
import { MOSSBOT_DEFAULT_AVATAR_KEY, MOSSBOT_TEMPLATES } from "./mossbot.logic";
import { useMossbotCreation } from "./useMossbotCreation";

export function MossbotCreateDialog(props: {
  open: boolean;
  templateId: string;
  defaultModelSelection: ModelSelection;
  workspacePath: string;
  onClose: () => void;
  onCreated: (overview: ProjectAgentOverview) => void;
}) {
  const { t } = useMossbotCopy();
  const template =
    MOSSBOT_TEMPLATES.find((item) => item.id === props.templateId) ?? MOSSBOT_TEMPLATES[0];
  const [name, setName] = useState<string>(template.id === "personal" ? "Moss" : t(template.name));
  const [instructions, setInstructions] = useState<string>(t(template.instructions));
  const [avatar, setAvatar] = useState(MOSSBOT_DEFAULT_AVATAR_KEY);
  // Templates wear the kid in their own colour; the colour can be changed later in settings.
  const color = template.id === "research" ? "green" : template.id === "projects" ? "amber" : "";
  const [model, setModel] = useState(props.defaultModelSelection);
  const { busy, error, create: createAssistant, abandon } = useMossbotCreation(props.onCreated);

  const close = async () => {
    if ((await abandon(name)) === "closed") props.onClose();
  };

  const create = async () => {
    await createAssistant({ name, instructions, model, avatar, color });
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
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="space-y-2">
            <p className="text-ui font-medium">{t("Choose a familiar face")}</p>
            <MossbotAvatarPicker
              value={avatar}
              color={color}
              onChange={setAvatar}
              disabled={busy}
            />
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
