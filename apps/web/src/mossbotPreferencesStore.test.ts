import { beforeEach, describe, expect, it } from "vitest";
import { assistantNotificationsMuted, useMossbotPreferencesStore } from "./mossbotPreferencesStore";

beforeEach(() =>
  useMossbotPreferencesStore.setState({
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
  }),
);

describe("assistant presentation preferences", () => {
  it("organizes assistants and rooms together without changing their lifecycle preferences", () => {
    const store = useMossbotPreferencesStore.getState();
    store.setMain("a");
    store.setMuted("a", true);
    const folder = store.createFolder("领导", "assistant:a");
    store.moveConversation("room:team", folder);
    store.setFolderCollapsed(folder, true);
    store.renameFolder(folder, "工作");
    expect(useMossbotPreferencesStore.getState()).toMatchObject({
      folders: [{ id: folder, name: "工作" }],
      folderByConversation: { "assistant:a": folder, "room:team": folder },
      collapsedFolderIds: [folder],
      mainProjectId: "a",
      mutedProjectIds: ["a"],
    });
    store.removeFolder(folder);
    expect(useMossbotPreferencesStore.getState()).toMatchObject({
      folders: [],
      folderByConversation: {},
      collapsedFolderIds: [],
      mainProjectId: "a",
      mutedProjectIds: ["a"],
    });
  });

  it("keeps stable group identities while reordering and rejects stale assignment targets", () => {
    const store = useMossbotPreferencesStore.getState();
    const first = store.createFolder("First");
    const second = store.createFolder("Second", "room:team");
    store.moveFolder(second, -1);
    expect(useMossbotPreferencesStore.getState().folders.map((f) => f.id)).toEqual([second, first]);
    store.moveFolder(second, -1);
    store.moveConversation("room:team", "deleted-group");
    expect(useMossbotPreferencesStore.getState().folderByConversation["room:team"]).toBe(second);
    store.moveConversation("room:team", null);
    expect(useMossbotPreferencesStore.getState().folderByConversation).toEqual({});
    expect(store.createFolder(" first ")).toBe(first);
    store.renameFolder(second, "First");
    expect(useMossbotPreferencesStore.getState().folders.find((f) => f.id === second)?.name).toBe(
      "Second",
    );
  });

  it("keeps room unread, pin and hidden state independent of membership and clearing unread records a visit", () => {
    const store = useMossbotPreferencesStore.getState();
    store.setRoomUnread("room-a", true);
    store.setRoomHidden("room-a", true);
    store.toggleRoomPinned("room-a");
    store.visitRoom("room-a");
    expect(useMossbotPreferencesStore.getState()).toMatchObject({
      unreadRoomIds: [],
      hiddenRoomIds: ["room-a"],
      pinnedRoomIds: ["room-a"],
    });
    expect(
      Number.isFinite(
        Date.parse(useMossbotPreferencesStore.getState().lastVisitedRoomAt["room-a"]!),
      ),
    ).toBe(true);
    store.toggleRoomPinned("room-a");
    store.setRoomHidden("room-a", false);
    expect(useMossbotPreferencesStore.getState()).toMatchObject({
      hiddenRoomIds: [],
      pinnedRoomIds: [],
    });
  });
  it("keeps hiding, manual unread and muting independent and reversible", () => {
    const store = useMossbotPreferencesStore.getState();
    store.setMain("a");
    store.setHidden("a", true);
    store.setHidden("a", true);
    store.setUnread("a", true);
    store.setMuted("b", true);
    expect(useMossbotPreferencesStore.getState()).toMatchObject({
      mainProjectId: "a",
      hiddenProjectIds: ["a"],
      unreadProjectIds: ["a"],
      mutedProjectIds: ["b"],
    });
    store.setHidden("a", false);
    store.setUnread("a", false);
    store.setMuted("b", false);
    expect(useMossbotPreferencesStore.getState()).toMatchObject({
      mainProjectId: "a",
      hiddenProjectIds: [],
      unreadProjectIds: [],
      mutedProjectIds: [],
    });
  });

  it("mutes linked-project workers of the selected assistant without muting unrelated chats", () => {
    const assistants = [
      { projectId: "a", coordinatorThreadId: "dm-a", memberThreadIds: ["worker-in-other-project"] },
      { projectId: "b", coordinatorThreadId: "dm-b" },
    ];
    const input = { mutedProjectIds: ["a"], assistants };
    expect(assistantNotificationsMuted({ ...input, threadId: "dm-a", projectId: "a" })).toBe(true);
    expect(
      assistantNotificationsMuted({
        ...input,
        threadId: "worker-in-other-project",
        projectId: "other-project",
      }),
    ).toBe(true);
    expect(
      assistantNotificationsMuted({
        ...input,
        threadId: "ordinary-chat",
        projectId: "other-project",
      }),
    ).toBe(false);
    expect(assistantNotificationsMuted({ ...input, threadId: "dm-b", projectId: "b" })).toBe(false);
    expect(assistantNotificationsMuted({ ...input, threadId: "dm-a", mutedProjectIds: [] })).toBe(
      false,
    );
  });
});
