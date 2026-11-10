// Global browser-suite reset for the Settings dialog.
//
// Settings is a modal whose open state lives in a module-level store
// (`settingsDialogStore`), not in the URL, so it outlives a test's unmount.
// A case that opens Settings and fails (or simply never closes it) would leave
// the modal's viewport over every later case in the same file and block their
// clicks. Start each case with it closed.
import { beforeEach } from "vitest";

import { closeSettings } from "../settingsDialogStore";

beforeEach(() => {
  closeSettings();
});
