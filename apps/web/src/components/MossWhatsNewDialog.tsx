// FILE: MossWhatsNewDialog.tsx
// Purpose: Calm post-update release-notes dialog opened only when the user clicks the
//          top-right "What's new" header button. Mirrors Claude Desktop's WhatsNewModal:
//          releases newest first up to the running version, date + monospace version badge,
//          and grouped New / Improved / Fixed sections.
// Layer: Root overlay dialog

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTranslation } from "~/localization";
import type { MossRelease, MossReleaseGroupKind } from "~/whatsNew/mossReleases";
import { useMossWhatsNew } from "~/whatsNew/useMossWhatsNew";

const GROUP_ORDER: readonly MossReleaseGroupKind[] = ["feat", "improvement", "fix"];

const GROUP_LABEL_KEY: Record<
  MossReleaseGroupKind,
  "whatsNew.group.feat" | "whatsNew.group.improvement" | "whatsNew.group.fix"
> = {
  feat: "whatsNew.group.feat",
  improvement: "whatsNew.group.improvement",
  fix: "whatsNew.group.fix",
};

export interface MossWhatsNewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly releases: readonly MossRelease[];
}

export function MossWhatsNewDialog({ open, onOpenChange, releases }: MossWhatsNewDialogProps) {
  const { locale, t } = useTranslation();
  const zh = locale === "zh-CN";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-h-[min(720px,85vh)] max-w-lg gap-0 p-0"
        data-testid="moss-whats-new-dialog"
      >
        <DialogHeader className="border-b border-[color:var(--color-border)] !pb-3">
          <DialogTitle>{t("whatsNew.dialog.title")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="!pt-4">
          {releases.length === 0 ? (
            <p className="py-8 text-center text-ui text-muted-foreground">
              {t("whatsNew.dialog.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {releases.map((release) => (
                <MossWhatsNewReleaseSection key={release.version} release={release} zh={zh} />
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MossWhatsNewReleaseSection({
  release,
  zh,
}: {
  readonly release: MossRelease;
  readonly zh: boolean;
}) {
  const { t } = useTranslation();
  const groups = release.groups;

  return (
    <section
      className="flex flex-col gap-3 border-b border-[color:var(--color-border)] pb-5 last:border-0 last:pb-0"
      data-whats-new-release={release.version}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui font-medium text-foreground">
          {zh ? release.date.zh : release.date.en}
        </h3>
        <span className="rounded-control bg-secondary px-1.5 py-0.5 font-mono text-ui-xs text-muted-foreground tabular-nums">
          {release.version}
        </span>
      </div>
      {groups && groups.length > 0 ? (
        <div className="flex flex-col gap-3">
          {GROUP_ORDER.map((kind) => {
            const matching = groups.find((group) => group.kind === kind);
            const items = matching ? (zh ? matching.zh : matching.en) : [];
            if (items.length === 0) return null;
            return (
              <div key={kind} className="flex flex-col gap-1.5">
                <h4 className="text-ui-xs font-medium tracking-wide text-muted-foreground">
                  {t(GROUP_LABEL_KEY[kind])}
                </h4>
                <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-ui text-muted-foreground">
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-ui text-muted-foreground">
          {(zh ? release.notes.zh : release.notes.en).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MossWhatsNewDialogHost({
  currentVersion,
  releases: releasesOverride,
}: {
  readonly currentVersion?: string;
  readonly releases?: readonly MossRelease[];
}) {
  const { isDialogOpen, onDialogOpenChange, releases } = useMossWhatsNew({
    ...(currentVersion !== undefined ? { currentVersion } : {}),
    ...(releasesOverride !== undefined ? { releases: releasesOverride } : {}),
  });

  return (
    <MossWhatsNewDialog open={isDialogOpen} onOpenChange={onDialogOpenChange} releases={releases} />
  );
}
