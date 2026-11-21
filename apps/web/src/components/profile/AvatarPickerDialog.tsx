// FILE: AvatarPickerDialog.tsx
// Purpose: Modal picker for Moss's 20 original Notion-style cute minimal SVG preset
//          avatars, custom image upload with circular crop + zoom (≤ 1 MB), and
//          initials fallback. Wired to `#759` `profile.update` and `profile.uploadAvatar`.
// Layer: Web profile feature

import type { MossProfileAvatar, MossProfileUploadAvatarInput } from "@moss/contracts";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { PillTabs } from "~/components/ui/pill-tabs";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  AvatarImageError,
  prepareAvatarUploadFromSource,
  readAvatarPreviewUrl,
} from "./avatarImage";
import {
  DEFAULT_PROFILE_AVATAR_PRESET_ID,
  getProfileAvatarPresetLabel,
  PROFILE_AVATAR_PRESETS,
  resolveProfileAvatarPresetSrc,
  resolveProfileAvatarSrc,
  type ProfileAvatarPresetCategory,
} from "./profileAvatarPresets";
import { getProfileCopy } from "./profileCopy";
import { ProfileAvatar } from "./ProfileAvatar";
import { classifyProfileError } from "./profileValidation";
import { PROFILE_AVATAR_COLORS } from "./useProfileAvatarColor";

type PickerTab = "presets" | "upload" | "initials";
type CategoryFilter = "all" | ProfileAvatarPresetCategory;

export interface AvatarPickerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly currentAvatar: MossProfileAvatar;
  readonly initials: string;
  readonly avatarColor: string;
  readonly onSelectPreset: (presetId: string) => Promise<void>;
  readonly onSelectInitials: (accentColor: string) => Promise<void>;
  readonly onUploadAvatar: (input: MossProfileUploadAvatarInput) => Promise<void>;
}

export function AvatarPickerDialog(props: AvatarPickerDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup showCloseButton={false} className="sm:max-w-[540px]">
        <AvatarPickerDialogBody {...props} />
      </DialogPopup>
    </Dialog>
  );
}

function AvatarPickerDialogBody({
  onOpenChange,
  currentAvatar,
  initials,
  avatarColor,
  onSelectPreset,
  onSelectInitials,
  onUploadAvatar,
}: Omit<AvatarPickerDialogProps, "open">) {
  const { locale } = useTranslation();
  const copy = getProfileCopy(locale);

  const initialTab: PickerTab = currentAvatar.kind === "upload" ? "upload" : "presets";
  const [tab, setTab] = useState<PickerTab>(initialTab);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    currentAvatar.kind === "preset" ? currentAvatar.id : DEFAULT_PROFILE_AVATAR_PRESET_ID,
  );
  const [selectedColor, setSelectedColor] = useState<string>(avatarColor);
  const [uploadSourceUrl, setUploadSourceUrl] = useState<string | null>(
    currentAvatar.kind === "upload" ? currentAvatar.url : null,
  );
  const [hasNewUploadFile, setHasNewUploadFile] = useState(false);
  const [zoom, setZoom] = useState<number>(1);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const visiblePresets =
    category === "all"
      ? PROFILE_AVATAR_PRESETS
      : PROFILE_AVATAR_PRESETS.filter((preset) => preset.category === category);

  const previewSrc =
    tab === "presets"
      ? resolveProfileAvatarPresetSrc(selectedPresetId)
      : tab === "upload"
        ? uploadSourceUrl
        : null;

  const currentAvatarSrc = resolveProfileAvatarSrc(currentAvatar);
  const canSave =
    !saving &&
    !processing &&
    (tab === "presets" ||
      tab === "initials" ||
      (tab === "upload" && hasNewUploadFile && uploadSourceUrl !== null));

  const handleFileChange = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setError(null);
    setProcessing(true);
    try {
      const sourceUrl = await readAvatarPreviewUrl(file);
      setUploadSourceUrl(sourceUrl);
      setHasNewUploadFile(true);
      setZoom(1);
    } catch (cause) {
      setError(cause instanceof AvatarImageError ? cause.message : copy.errors.avatarInvalid);
    } finally {
      setProcessing(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (tab === "presets") {
        await onSelectPreset(selectedPresetId);
      } else if (tab === "initials") {
        await onSelectInitials(selectedColor);
      } else if (tab === "upload" && uploadSourceUrl && hasNewUploadFile) {
        const prepared = await prepareAvatarUploadFromSource(uploadSourceUrl, { zoom });
        await onUploadAvatar({
          mimeType: prepared.mimeType,
          dataBase64: prepared.dataBase64,
        });
      }
      onOpenChange(false);
    } catch (cause) {
      if (cause instanceof AvatarImageError) {
        setError(cause.message);
      } else {
        setError(copy.errors[classifyProfileError(cause)]);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5"
      data-testid="avatar-picker-dialog"
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-ui-lg font-medium">{copy.avatarPicker.title}</DialogTitle>
        <p className="text-ui-sm text-muted-foreground">{copy.avatarPicker.description}</p>
      </div>

      {/* Live preview + mode switcher */}
      <div className="flex flex-col items-center gap-3.5">
        <div className="relative flex size-20 items-center justify-center overflow-hidden rounded-full border border-border/80 bg-card">
          {tab === "upload" && uploadSourceUrl ? (
            <img
              src={uploadSourceUrl}
              alt=""
              draggable={false}
              className="size-full object-cover transition-transform duration-150 motion-reduce:transition-none"
              style={{ transform: `scale(${zoom})` }}
            />
          ) : (
            <ProfileAvatar
              initials={initials}
              color={selectedColor}
              image={previewSrc ?? (tab === "upload" ? currentAvatarSrc : null)}
              className="size-full"
              textClassName="text-2xl"
            />
          )}
        </div>

        <PillTabs
          ariaLabel={copy.avatarPicker.title}
          selected={tab}
          onSelect={(next) => {
            setTab(next);
            setError(null);
          }}
          tabs={[
            { id: "presets", label: copy.avatarPicker.tabPresets },
            { id: "upload", label: copy.avatarPicker.tabUpload },
            { id: "initials", label: copy.avatarPicker.tabInitials },
          ]}
        />
      </div>

      {/* Presets grid */}
      {tab === "presets" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {(["all", "moss", "people", "friends"] as const).map((filter) => {
              const active = category === filter;
              const label =
                filter === "all"
                  ? copy.avatarPicker.categoryAll
                  : copy.avatarPicker.categories[filter];
              return (
                <Button
                  key={filter}
                  type="button"
                  size="xs"
                  shape="capsule"
                  variant={active ? "secondary" : "ghost"}
                  aria-pressed={active}
                  onClick={() => setCategory(filter)}
                >
                  {label}
                </Button>
              );
            })}
          </div>

          <div className="max-h-96 overflow-y-auto p-1">
            <div
              className="grid grid-cols-4 gap-2 sm:grid-cols-5"
              role="radiogroup"
              aria-label={copy.avatarPicker.tabPresets}
              data-testid="avatar-preset-grid"
            >
              {visiblePresets.map((preset) => {
                const selected = selectedPresetId === preset.id;
                const label = getProfileAvatarPresetLabel(preset, locale);
                return (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="ghost"
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    title={label}
                    data-avatar-preset={preset.id}
                    data-testid={`avatar-preset-${preset.id}`}
                    onClick={() => setSelectedPresetId(preset.id)}
                    className={cn(
                      "flex h-auto min-h-0 w-full flex-col items-center justify-center gap-1.5 rounded-card px-1.5 py-2 font-normal",
                      selected
                        ? "bg-[color-mix(in_srgb,var(--info)_10%,transparent)] ring-2 ring-[var(--info)]"
                        : "hover:bg-[color-mix(in_srgb,var(--color-text-foreground)_4%,transparent)]",
                    )}
                  >
                    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60">
                      <img
                        src={preset.src}
                        alt=""
                        draggable={false}
                        className="size-full object-cover"
                      />
                    </span>
                    <span className="block max-w-full truncate text-center text-ui-xs leading-tight text-muted-foreground">
                      {label}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {/* Custom image upload + circular crop */}
      {tab === "upload" ? (
        <div className="flex flex-col items-center gap-3.5 rounded-card border border-dashed border-border p-5 text-center">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid="avatar-upload-input"
            onChange={(event) => {
              void handleFileChange(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <div className="space-y-1">
            <p className="text-ui text-foreground">{copy.avatarPicker.uploadPrompt}</p>
            <p className="text-ui-sm text-muted-foreground">{copy.avatarPicker.uploadHint}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={processing || saving}
            onClick={() => fileInputRef.current?.click()}
          >
            <CentralIcon name="add-image" className="size-4" />
            {processing
              ? copy.avatarPicker.processing
              : hasNewUploadFile
                ? copy.avatarPicker.replaceImage
                : copy.avatarPicker.chooseImage}
          </Button>
          {hasNewUploadFile && uploadSourceUrl ? (
            <label className="flex w-full max-w-xs items-center gap-3 pt-1 text-ui-sm text-muted-foreground">
              <span className="shrink-0">{copy.avatarPicker.zoomLabel}</span>
              <input
                type="range"
                min={1}
                max={2.5}
                step={0.05}
                value={zoom}
                aria-label={copy.avatarPicker.zoomLabel}
                onChange={(event) => setZoom(Number(event.target.value))}
                className="h-1.5 flex-1 accent-[var(--info)]"
              />
              <span className="w-10 shrink-0 text-right tabular-nums">{`${zoom.toFixed(1)}×`}</span>
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Initials fallback */}
      {tab === "initials" ? (
        <div className="flex flex-col items-center gap-3.5 rounded-card border border-border/70 p-5 text-center">
          <p className="text-ui-sm text-muted-foreground">{copy.avatarPicker.initialsHint}</p>
          <div
            className="flex flex-wrap items-center justify-center gap-2.5"
            role="radiogroup"
            aria-label={copy.avatarPicker.accentColorLabel}
          >
            {PROFILE_AVATAR_COLORS.map((color) => {
              const selected = selectedColor === color;
              return (
                <Button
                  key={color}
                  type="button"
                  variant="ghost"
                  shape="capsule"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${copy.avatarPicker.accentColorLabel} ${color}`}
                  onClick={() => setSelectedColor(color)}
                  className={cn(
                    "size-7 min-h-0 p-0",
                    selected && "ring-2 ring-[var(--info)] ring-offset-2 ring-offset-popover",
                  )}
                  style={{ backgroundColor: color }}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-center text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <DialogClose render={<Button type="button" variant="ghost" size="default" />}>
          {copy.cancel}
        </DialogClose>
        <Button
          type="button"
          variant="default"
          size="default"
          disabled={!canSave}
          onClick={() => void handleSave()}
          data-testid="avatar-picker-save"
        >
          {saving
            ? tab === "upload"
              ? copy.avatarPicker.uploading
              : copy.saving
            : copy.avatarPicker.saveAvatar}
        </Button>
      </div>
    </div>
  );
}
