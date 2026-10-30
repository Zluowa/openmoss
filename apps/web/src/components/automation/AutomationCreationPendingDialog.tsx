import type { AutomationCreateInput } from "@synara/contracts";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

/** A lost creation reply always retries the original settings and request id. */
export function AutomationCreationPendingDialog(props: {
  open: boolean;
  pending: AutomationCreateInput;
  error: string | null;
  busy: boolean;
  retryDisabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => !props.busy && props.onOpenChange(next)}>
      <DialogPopup showCloseButton={false} className="max-w-lg">
        <DialogTitle>{props.pending.name}</DialogTitle>
        <Alert variant={props.error ? "error" : "default"}>
          <AlertTitle>
            {props.busy ? "Creating automation" : "Confirm automation creation"}
          </AlertTitle>
          <AlertDescription>
            {props.error ? `${props.error} ` : ""}The result of this creation is awaiting
            confirmation. Retrying uses the same request and original settings.
          </AlertDescription>
        </Alert>
        <p className="mt-3 whitespace-pre-wrap text-ui text-muted-foreground">
          {props.pending.prompt}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={props.busy} onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={props.busy || props.retryDisabled} onClick={props.onRetry}>
            {props.busy ? "Creating…" : "Retry creation"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
