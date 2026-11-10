import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { moveFolder } from "~/lib/openmausFolderOrder";

export interface MossbotConversationFolder {
  id: string;
  name: string;
}
export type MossbotConversationKey = `assistant:${string}` | `room:${string}`;
export const UNGROUPED_CONVERSATIONS = "ungrouped";

interface MossbotPreferences {
  mainProjectId: string | null;
  hiddenProjectIds: string[];
  unreadProjectIds: string[];
  mutedProjectIds: string[];
  folders: MossbotConversationFolder[];
  folderByConversation: Record<string, string>;
  collapsedFolderIds: string[];
  hiddenRoomIds: string[];
  unreadRoomIds: string[];
  pinnedRoomIds: string[];
  lastVisitedRoomAt: Record<string, string>;
  setMain: (id: string) => void;
  setHidden: (id: string, hidden: boolean) => void;
  setUnread: (id: string, unread: boolean) => void;
  setMuted: (id: string, muted: boolean) => void;
  createFolder: (name: string, conversation?: MossbotConversationKey) => string;
  renameFolder: (id: string, name: string) => void;
  removeFolder: (id: string) => void;
  moveFolder: (id: string, direction: -1 | 1) => void;
  moveConversation: (key: MossbotConversationKey, folderId: string | null) => void;
  setFolderCollapsed: (id: string, collapsed: boolean) => void;
  setRoomHidden: (id: string, hidden: boolean) => void;
  setRoomUnread: (id: string, unread: boolean) => void;
  toggleRoomPinned: (id: string) => void;
  visitRoom: (id: string) => void;
}

function membership(ids: readonly string[], id: string, included: boolean): string[] {
  return included ? [...new Set([...ids, id])] : ids.filter((value) => value !== id);
}

/** Presentation preferences only. Hiding or muting never changes the assistant's lifecycle. */
export const useMossbotPreferencesStore = create<MossbotPreferences>()(
  persist(
    (set, get) => ({
      mainProjectId: null,
      hiddenProjectIds: [],
      unreadProjectIds: [],
      mutedProjectIds: [],
      folders: [],
      folderByConversation: {},
      collapsedFolderIds: [],
      hiddenRoomIds: [],
      unreadRoomIds: [],
      pinnedRoomIds: [],
      lastVisitedRoomAt: {},
      setMain: (mainProjectId) => set({ mainProjectId }),
      setHidden: (id, hidden) =>
        set((state) => ({ hiddenProjectIds: membership(state.hiddenProjectIds, id, hidden) })),
      setUnread: (id, unread) =>
        set((state) => ({ unreadProjectIds: membership(state.unreadProjectIds, id, unread) })),
      setMuted: (id, muted) =>
        set((state) => ({ mutedProjectIds: membership(state.mutedProjectIds, id, muted) })),
      createFolder: (name, conversation) => {
        const trimmed = name.trim().slice(0, 60);
        if (!trimmed) throw new Error("Give the group a name.");
        const existing = get().folders.find(
          (f) => f.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
        );
        const id = existing?.id ?? crypto.randomUUID();
        set((state) => ({
          folders: existing ? state.folders : [...state.folders, { id, name: trimmed }],
          ...(conversation
            ? { folderByConversation: { ...state.folderByConversation, [conversation]: id } }
            : {}),
          collapsedFolderIds: state.collapsedFolderIds.filter((value) => value !== id),
        }));
        return id;
      },
      renameFolder: (id, name) => {
        const trimmed = name.trim().slice(0, 60);
        if (
          !trimmed ||
          get().folders.some(
            (f) => f.id !== id && f.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
          )
        )
          return;
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)),
        }));
      },
      removeFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          folderByConversation: Object.fromEntries(
            Object.entries(state.folderByConversation).filter(([, value]) => value !== id),
          ),
          collapsedFolderIds: state.collapsedFolderIds.filter((value) => value !== id),
        })),
      moveFolder: (id, direction) =>
        set((state) => {
          const order = moveFolder(
            state.folders.map((f) => f.id),
            id,
            direction,
          );
          return { folders: order.map((key) => state.folders.find((f) => f.id === key)!) };
        }),
      moveConversation: (key, folderId) =>
        set((state) => {
          if (folderId !== null && !state.folders.some((f) => f.id === folderId)) return state;
          const next = { ...state.folderByConversation };
          if (folderId === null) delete next[key];
          else next[key] = folderId;
          return { folderByConversation: next };
        }),
      setFolderCollapsed: (id, collapsed) =>
        set((state) => ({
          collapsedFolderIds: membership(state.collapsedFolderIds, id, collapsed),
        })),
      setRoomHidden: (id, hidden) =>
        set((state) => ({ hiddenRoomIds: membership(state.hiddenRoomIds, id, hidden) })),
      setRoomUnread: (id, unread) =>
        set((state) => ({ unreadRoomIds: membership(state.unreadRoomIds, id, unread) })),
      toggleRoomPinned: (id) =>
        set((state) => ({
          pinnedRoomIds: membership(state.pinnedRoomIds, id, !state.pinnedRoomIds.includes(id)),
        })),
      visitRoom: (id) =>
        set((state) => ({
          unreadRoomIds: membership(state.unreadRoomIds, id, false),
          lastVisitedRoomAt: { ...state.lastVisitedRoomAt, [id]: new Date().toISOString() },
        })),
    }),
    {
      name: "moss:assistant-presentation:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: ({
        mainProjectId,
        hiddenProjectIds,
        unreadProjectIds,
        mutedProjectIds,
        folders,
        folderByConversation,
        collapsedFolderIds,
        hiddenRoomIds,
        unreadRoomIds,
        pinnedRoomIds,
        lastVisitedRoomAt,
      }) => ({
        mainProjectId,
        hiddenProjectIds,
        unreadProjectIds,
        mutedProjectIds,
        folders,
        folderByConversation,
        collapsedFolderIds,
        hiddenRoomIds,
        unreadRoomIds,
        pinnedRoomIds,
        lastVisitedRoomAt,
      }),
      merge: (persisted, current) => {
        const value = persisted as Record<string, unknown> | undefined;
        const ids = (key: string) =>
          Array.isArray(value?.[key])
            ? [
                ...new Set(
                  (value[key] as unknown[]).filter((id): id is string => typeof id === "string"),
                ),
              ]
            : [];
        const folders: MossbotConversationFolder[] = [];
        if (Array.isArray(value?.folders))
          for (const item of value.folders) {
            if (
              !item ||
              typeof item !== "object" ||
              typeof item.id !== "string" ||
              typeof item.name !== "string"
            )
              continue;
            const name = item.name.trim().slice(0, 60);
            if (
              !item.id ||
              item.id === UNGROUPED_CONVERSATIONS ||
              !name ||
              folders.some(
                (f) => f.id === item.id || f.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
              )
            )
              continue;
            folders.push({ id: item.id, name });
          }
        const record = (key: string, valid: (key: string, value: string) => boolean) => {
          const source = value?.[key];
          return source && typeof source === "object" && !Array.isArray(source)
            ? (Object.fromEntries(
                Object.entries(source).filter(
                  ([key, item]) => typeof item === "string" && valid(key, item),
                ),
              ) as Record<string, string>)
            : {};
        };
        return {
          ...current,
          mainProjectId: typeof value?.mainProjectId === "string" ? value.mainProjectId : null,
          hiddenProjectIds: ids("hiddenProjectIds"),
          unreadProjectIds: ids("unreadProjectIds"),
          mutedProjectIds: ids("mutedProjectIds"),
          folders,
          folderByConversation: record(
            "folderByConversation",
            (key, id) => /^(assistant|room):.+/.test(key) && folders.some((f) => f.id === id),
          ),
          collapsedFolderIds: ids("collapsedFolderIds").filter(
            (id) => id === UNGROUPED_CONVERSATIONS || folders.some((f) => f.id === id),
          ),
          hiddenRoomIds: ids("hiddenRoomIds"),
          unreadRoomIds: ids("unreadRoomIds"),
          pinnedRoomIds: ids("pinnedRoomIds"),
          lastVisitedRoomAt: record("lastVisitedRoomAt", (_, at) =>
            Number.isFinite(Date.parse(at)),
          ),
        };
      },
    },
  ),
);

export function assistantNotificationsMuted(input: {
  threadId: string;
  projectId?: string | undefined;
  mutedProjectIds: readonly string[];
  assistants: Iterable<{
    projectId: string;
    memberThreadIds?: readonly string[] | undefined;
    coordinatorThreadId: string | null;
  }>;
}): boolean {
  if (input.projectId && input.mutedProjectIds.includes(input.projectId)) return true;
  for (const assistant of input.assistants) {
    if (
      input.mutedProjectIds.includes(assistant.projectId) &&
      (assistant.coordinatorThreadId === input.threadId ||
        assistant.memberThreadIds?.includes(input.threadId))
    )
      return true;
  }
  return false;
}
