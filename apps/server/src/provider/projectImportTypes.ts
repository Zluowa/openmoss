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
  /** Model the conversation used, for agents whose model catalogs exist only at runtime. */
  readonly model?: string;
}

export interface NativeProjectImportCatalog {
  readonly sourceHome: string;
  readonly projects: ReadonlyArray<NativeImportProject>;
  readonly sessions: ReadonlyArray<NativeImportSession>;
}
