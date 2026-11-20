/** What a hand-off keeps about the repair, besides the report itself. */
export interface DevsHandoffDetails {
  /** The repair's local commit, in the retained job directory. */
  commit?: string;
  jobDir?: string;
  /** The verification run, when one started. */
  runUrl?: string;
}

/**
 * A repair that could not be verified, as opposed to one that failed: the mirror does not
 * publish what it changed, or its checks could not run. The worker keeps the report for a
 * maintainer before it closes the job, instead of letting it fail silently.
 */
export class DevsHandoffError extends Error {
  override readonly name = "DevsHandoffError";
  constructor(
    message: string,
    readonly details: DevsHandoffDetails = {},
  ) {
    super(message);
  }
}
