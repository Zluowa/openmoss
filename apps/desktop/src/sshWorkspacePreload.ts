// FILE: sshWorkspacePreload.ts
// Purpose: Give a remote workspace only its transport URL and its kind, never local desktop controls.
// Layer: Sandboxed remote workspace preload
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
contextBridge.exposeInMainWorld("mossRemoteWorkspace", {
  getWsUrl: () => ipcRenderer.sendSync(DESKTOP_IPC_CHANNELS.ssh.workspaceUrl),
  getKind: () => ipcRenderer.sendSync(DESKTOP_IPC_CHANNELS.ssh.workspaceKind),
});
