// Only public connection metadata crosses the desktop bridge. Session secrets stay in main.
export interface RemoteComputerConnection {
  readonly id: string;
  readonly displayName: string;
  readonly origin: string;
  readonly expiresAt: string;
}
export interface RemoteComputerState {
  readonly connection: RemoteComputerConnection;
  readonly status: "disconnected" | "connecting" | "connected" | "needs-pairing" | "failed";
  readonly errorCode?: string;
}
export interface DesktopRemoteComputersBridge {
  list(): Promise<ReadonlyArray<RemoteComputerState>>;
  pair(input: {
    readonly id: string;
    readonly displayName: string;
    readonly origin: string;
    readonly credential: string;
  }): Promise<RemoteComputerState>;
  cancelPairing(id: string): Promise<void>;
  connect(id: string): Promise<RemoteComputerState>;
  disconnect(id: string): Promise<void>;
  remove(id: string): Promise<{ readonly revoked: boolean }>;
}
