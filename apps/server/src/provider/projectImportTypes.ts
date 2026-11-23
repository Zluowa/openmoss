// Provider-owned discovery metadata. Runtime bindings and import decisions belong to orchestration.
export interface NativeImportProject {
  readonly id: string;
  readonly title: string;
  readonly roots: ReadonlyArray<string>;
}

export interface NativeImportSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  /** An explicit origin project, separate from the conversation's runtime cwd. */
  readonly projectRoot?: string;
  readonly parentSessionId?: string;
  /** Source CLI session/thread ID of the parent conversation when imported hierarchically. */
  readonly parentSourceSessionId?: string | null;
  /** Relationship kind for imported child conversations. */
  readonly hierarchyKind?: "subagent" | "sideSession" | "child" | null;
  readonly subagentNickname?: string;
  readonly subagentRole?: string;
  /** Earlier native IDs for the same conversation. */
  readonly priorSessionIds?: ReadonlyArray<string>;
  /** Model the conversation used, for agents whose model catalogs exist only at runtime. */
  readonly model?: string;
}

export interface NativeProjectImportCatalog {
  readonly sourceHome: string;
  readonly projects: ReadonlyArray<NativeImportProject>;
  readonly sessions: ReadonlyArray<NativeImportSession>;
  readonly skippedSessions?: number;
}
