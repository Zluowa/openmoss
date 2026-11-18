// FILE: selfReportArgument.ts
// Purpose: The preload argument that tells the main window's preload to expose the self-report
//          bridge. Its own module so the sandboxed preload imports no Node code with it.
// Layer: Desktop IPC contract

export const SELF_REPORT_PRELOAD_ARGUMENT = "--moss-self-report";
