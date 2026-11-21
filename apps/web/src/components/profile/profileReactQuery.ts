// FILE: profileReactQuery.ts
// Purpose: React Query options, mutations, and RPC helpers for Moss's `#759` profile
//          contract (`profile.get`, `profile.update`, `profile.checkHandle`,
//          `profile.uploadAvatar`). Keeps all contract method calls in one place.
// Layer: Web data access (profile feature)

import type {
  MossProfileCheckHandleResult,
  MossProfileState,
  MossProfileUpdateInput,
  MossProfileUploadAvatarInput,
} from "@moss/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { normalizeProfileHandleDraft, validateProfileHandleLocal } from "./profileValidation";

export const profileQueryKeys = {
  state: () => ["server", "mossProfile", "state"] as const,
};

export const profileMutationKeys = {
  update: () => ["server", "mutation", "mossProfile", "update"] as const,
  uploadAvatar: () => ["server", "mutation", "mossProfile", "uploadAvatar"] as const,
};

export function serverMossProfileQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: profileQueryKeys.state(),
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async (): Promise<MossProfileState> => {
      const api = ensureNativeApi();
      return api.profile.get();
    },
  });
}

export function serverMossProfileUpdateMutationOptions(options: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: profileMutationKeys.update(),
    mutationFn: async (input: MossProfileUpdateInput): Promise<MossProfileState> => {
      const api = ensureNativeApi();
      return api.profile.update(input);
    },
    onSuccess: (nextState) => {
      options.queryClient.setQueryData(profileQueryKeys.state(), nextState);
    },
  });
}

export function serverMossProfileUploadAvatarMutationOptions(options: {
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: profileMutationKeys.uploadAvatar(),
    mutationFn: async (input: MossProfileUploadAvatarInput): Promise<MossProfileState> => {
      const api = ensureNativeApi();
      return api.profile.uploadAvatar(input);
    },
    onSuccess: (nextState) => {
      options.queryClient.setQueryData(profileQueryKeys.state(), nextState);
    },
  });
}

export async function checkMossProfileHandleAvailability(
  rawHandle: string,
): Promise<MossProfileCheckHandleResult> {
  const handle = normalizeProfileHandleDraft(rawHandle);
  const localInvalid = validateProfileHandleLocal(handle);
  if (localInvalid) {
    return { handle, status: localInvalid };
  }
  const api = readNativeApi();
  if (!api) {
    return { handle, status: "unverified" };
  }
  return api.profile.checkHandle({ handle });
}
