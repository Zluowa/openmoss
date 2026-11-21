// FILE: useMossProfile.ts
// Purpose: Shared hook reading the `#759` Moss profile state from the local server
//          (gracefully disabled when no native API transport is present, e.g. in pure
//          unit/component tests) and resolving the avatar URL for the rail, header,
//          Profile page, and ShareCard.
// Layer: Web profile feature

import type { MossProfileState } from "@moss/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { readNativeApi } from "~/nativeApi";
import { resolveProfileAvatarSrc } from "./profileAvatarPresets";
import {
  checkMossProfileHandleAvailability,
  serverMossProfileQueryOptions,
  serverMossProfileUpdateMutationOptions,
  serverMossProfileUploadAvatarMutationOptions,
} from "./profileReactQuery";
import { useProfileAvatarImage } from "./useProfileAvatarImage";

function isMossProfileState(value: unknown): value is MossProfileState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "profile" in (value as Record<string, unknown>) &&
    "scope" in (value as Record<string, unknown>)
  );
}

export function useMossProfileState(options: { enabled?: boolean } = {}) {
  const hasApi = Boolean(readNativeApi());
  const query = useQuery(
    serverMossProfileQueryOptions({ enabled: (options.enabled ?? true) && hasApi }),
  );
  const profileState = hasApi && isMossProfileState(query.data) ? query.data : null;
  return {
    ...query,
    profileState,
    hasApi,
  };
}

export function useMossProfileMutations() {
  const queryClient = useQueryClient();
  const updateMutation = useMutation(serverMossProfileUpdateMutationOptions({ queryClient }));
  const uploadAvatarMutation = useMutation(
    serverMossProfileUploadAvatarMutationOptions({ queryClient }),
  );
  return {
    updateMutation,
    uploadAvatarMutation,
    checkHandle: checkMossProfileHandleAvailability,
  };
}

/**
 * Single source for the person's active avatar image URL across the bottom-left rail,
 * sidebar account badge, Profile hero, and share card. Prefers the `#759` profile
 * contract (`preset` SVG or `upload` URL), falling back to legacy localStorage photo
 * only when the server profile has not loaded yet.
 */
export function useResolvedMossProfileAvatar(): {
  readonly avatarSrc: string | null;
  readonly profileState: MossProfileState | null;
} {
  const { profileState } = useMossProfileState();
  const { image: legacyImage } = useProfileAvatarImage();
  const avatarSrc = profileState
    ? resolveProfileAvatarSrc(profileState.profile.avatar, null)
    : legacyImage;
  return { avatarSrc, profileState };
}
