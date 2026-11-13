/**
 * Keyboard shortcuts that act on the whole desktop session rather than on the
 * window an agent targets: locking the screen, logging out, sleeping, shutting
 * down, killing the display server or switching virtual terminals.
 *
 * An agent never needs one of these to finish a task, and a single lock chord
 * ends the task outright: the desktop pauses, the person has to come back and
 * unlock, and everything the agent observed is stale. So the agent tool layer
 * refuses them before dispatch. Human input from the Moss pane is not routed
 * through this check: a person may lock their own machine.
 *
 * The blocklist is per platform on purpose. The same spelling means different
 * things: on macOS "meta+l" is Command-L (focus the address bar), on Linux and
 * Windows it is Super-L (lock the screen).
 *
 * @module computerSessionHotkeys
 */

export type ComputerSessionHotkeyPlatform = "macos" | "linux" | "windows";

/** Spellings folded onto one canonical name, on every platform. */
const COMMON_ALIASES: Readonly<Record<string, string>> = {
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  ctrl_l: "ctrl",
  ctrl_r: "ctrl",
  option: "alt",
  opt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  shift_l: "shift",
  shift_r: "shift",
  del: "delete",
  escape: "esc",
  back_space: "backspace",
  xf86poweroff: "power",
  xf86eject: "eject",
  xf86sleep: "sleep",
  xf86suspend: "sleep",
  suspend: "sleep",
  hibernate: "sleep",
  xf86logoff: "logoff",
};

/**
 * The platform's command-family modifier. macOS calls it Command and the agent
 * dialect spells it "meta"; Linux and Windows call it Super / the Windows key.
 */
const COMMAND_FAMILY = new Set([
  "cmd",
  "command",
  "meta",
  "meta_l",
  "meta_r",
  "super",
  "super_l",
  "super_r",
  "win",
  "windows",
  "⌘",
]);

function canonicalKey(key: string, platform: ComputerSessionHotkeyPlatform): string {
  const lowered = key.trim().toLowerCase();
  if (COMMAND_FAMILY.has(lowered)) return platform === "macos" ? "cmd" : "super";
  return COMMON_ALIASES[lowered] ?? lowered;
}

/**
 * One canonical form per chord. Entries may themselves be "+"-joined, case and
 * alias spellings collapse, order is irrelevant, and a repeated modifier is the
 * same key held once.
 */
function canonicalChord(
  keys: readonly string[],
  platform: ComputerSessionHotkeyPlatform,
): readonly string[] {
  const canonical = new Set(
    keys
      .flatMap((key) => key.split("+"))
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) => canonicalKey(key, platform)),
  );
  return [...canonical].toSorted();
}

function chordId(keys: readonly string[]): string {
  return [...keys].toSorted().join("+");
}

type SessionChordTable = ReadonlyMap<string, string>;

function table(entries: ReadonlyArray<readonly [readonly string[], string]>): SessionChordTable {
  return new Map(entries.map(([keys, action]) => [chordId(keys), action]));
}

/** Keys that act on the session when pressed alone, on every platform. */
const BARE_SESSION_KEYS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["power"], "power off or sleep the computer"],
  [["sleep"], "put the computer to sleep"],
  [["logoff"], "log out"],
];

const LINUX_VT_SWITCHES: ReadonlyArray<readonly [readonly string[], string]> = Array.from(
  { length: 12 },
  (_, index) => [["ctrl", "alt", `f${index + 1}`], "switch virtual terminal"] as const,
);

const SESSION_CHORDS: Readonly<Record<ComputerSessionHotkeyPlatform, SessionChordTable>> = {
  macos: table([
    ...BARE_SESSION_KEYS,
    [["cmd", "ctrl", "q"], "lock the screen"],
    [["cmd", "shift", "q"], "log out"],
    [["alt", "cmd", "shift", "q"], "log out"],
    [["eject"], "show the shut down dialog"],
    [["alt", "cmd", "eject"], "put the computer to sleep"],
    [["alt", "cmd", "power"], "put the computer to sleep"],
    [["ctrl", "shift", "eject"], "put the display to sleep"],
    [["ctrl", "shift", "power"], "put the display to sleep"],
    [["cmd", "ctrl", "eject"], "restart the computer"],
    [["cmd", "ctrl", "power"], "restart the computer"],
    [["alt", "cmd", "ctrl", "eject"], "shut down the computer"],
    [["alt", "cmd", "ctrl", "power"], "shut down the computer"],
    [["ctrl", "eject"], "show the shut down dialog"],
    [["ctrl", "power"], "show the shut down dialog"],
  ]),
  linux: table([
    ...BARE_SESSION_KEYS,
    [["super", "l"], "lock the screen"],
    [["alt", "ctrl", "l"], "lock the screen"],
    [["alt", "ctrl", "delete"], "open the log out dialog"],
    [["alt", "backspace", "ctrl"], "kill the display server"],
    ...LINUX_VT_SWITCHES,
  ]),
  windows: table([
    ...BARE_SESSION_KEYS,
    [["super", "l"], "lock the screen"],
    [["alt", "ctrl", "delete"], "open the secure attention screen"],
    [["alt", "ctrl", "end"], "open the secure attention screen"],
  ]),
};

export interface ComputerSessionHotkeyMatch {
  /** The canonical "+"-joined chord, sorted, e.g. "cmd+ctrl+q". */
  readonly chord: string;
  /** What the chord would do, phrased to follow "would". */
  readonly action: string;
}

/**
 * The session-level shortcut these keys form on `platform`, or `undefined`
 * when they are an ordinary key or chord.
 *
 * `keys` is a single key (`["power"]`), a chord split into its parts
 * (`["ctrl", "cmd", "q"]`) or a "+"-joined chord in one entry (`["ctrl+cmd+q"]`).
 */
export function computerSessionHotkey(
  keys: readonly string[],
  platform: ComputerSessionHotkeyPlatform,
): ComputerSessionHotkeyMatch | undefined {
  const canonical = canonicalChord(keys, platform);
  if (canonical.length === 0) return undefined;
  const id = chordId(canonical);
  const action = SESSION_CHORDS[platform].get(id);
  return action === undefined ? undefined : { chord: id, action };
}
