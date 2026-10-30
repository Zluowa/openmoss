// Command-approval footer, laid out like the Codex desktop app's:
// a leading cluster of host-app icons, opposite Deny / Allow once.
import app1 from "../../assets/approval-app-dock/app-1.png";
import app2 from "../../assets/approval-app-dock/app-2.png";
import app3 from "../../assets/approval-app-dock/app-3.png";
import app4 from "../../assets/approval-app-dock/app-4.png";
import app5 from "../../assets/approval-app-dock/app-5.png";

const APPROVAL_APP_DOCK = [
  { src: app1, label: "Browser" },
  { src: app2, label: "Workspace" },
  { src: app3, label: "Terminal" },
  { src: app4, label: "Assistant" },
  { src: app5, label: "Spark" },
] as const;

export function ApprovalAppDock() {
  return (
    <div className="flex min-w-0 items-center gap-2.5" data-approval-app-dock="true">
      {APPROVAL_APP_DOCK.map((app) => (
        <img
          key={app.label}
          src={app.src}
          alt=""
          aria-hidden
          draggable={false}
          className="size-8 shrink-0 object-contain"
        />
      ))}
    </div>
  );
}
