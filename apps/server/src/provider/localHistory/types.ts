// FILE: types.ts
// Purpose: Contract every agent's local-history reader implements for project import.
// Layer: Provider local-history parsing
// Exports: LocalHistoryPathInput, LocalHistoryMessage, LocalHistoryReader

import type { NativeProjectImportCatalog } from "../projectImportTypes";

export interface LocalHistoryPathInput {
  /** The user's home directory; agents keep their default stores below it. */
  readonly homeDir: string;
  /** Environment the agent itself would read its store overrides from. */
  readonly env: NodeJS.ProcessEnv;
}

export interface LocalHistoryMessage {
  /** Stable within the source conversation. */
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt?: string | undefined;
}

/**
 * Reads one agent's conversations straight from its local files. Readers never start the
 * agent, never write to its store, and only surface user-visible user/assistant text.
 */
export interface LocalHistoryReader {
  /** Where the agent keeps its history; part of each imported conversation's identity. */
  readonly sourceHome: (input: LocalHistoryPathInput) => string;
  /** Metadata only: ids, titles, working folders, and dates. */
  readonly discover: (input: LocalHistoryPathInput) => Promise<NativeProjectImportCatalog>;
  readonly readMessages: (
    input: LocalHistoryPathInput & { readonly sessionId: string },
  ) => Promise<ReadonlyArray<LocalHistoryMessage>>;
}
