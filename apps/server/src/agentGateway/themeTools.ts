// FILE: themeTools.ts
// Purpose: `moss_theme_read` and `moss_theme_set`: an agent reads how to restyle Moss, then
//          publishes a theme (colors and CSS) that this computer's Moss windows switch to.
// Layer: Agent gateway tool catalog
// Origin: Re-implements the theme toolkit of T3 Code (https://github.com/pingdotgg/t3code, MIT)
//   at 1d1489d0b8 (PR #35247, #36656, #37259) on Moss's gateway and theme packs. The theme is
//   stored in server settings (settings.json) and each client applies it to its own theme
//   store; there is no theme file service. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";

import {
  MossPublishedTheme,
  MossThemeAppearance,
  MossThemePackSpec,
  THEME_CSS_MAX_LENGTH,
  type OrchestrationThreadShell,
} from "@moss/contracts";
import {
  MOSS_THEME_GUIDE,
  MOSS_THEME_PRESETS,
  isMossThemePreset,
  themeCssLoadsRemoteFiles,
} from "@moss/shared/themeCss";
import { Effect, Schema, SchemaIssue } from "effect";

import type { ServerSettingsShape } from "../serverSettings.ts";
import { gatewayIsoNow } from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
  WRITE_TOOL_ANNOTATIONS,
} from "./toolRuntime.ts";

export interface AgentGatewayThemeToolsInput {
  readonly settings: Pick<ServerSettingsShape, "getSettings" | "updateSettings">;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<Pick<OrchestrationThreadShell, "runtimeMode">, unknown, never>;
}

const PACK_FIELDS = [
  "preset",
  "accent",
  "surface",
  "ink",
  "sidebar",
  "contrast",
  "opaqueWindows",
  "uiFont",
  "codeFont",
  "diffAdded",
  "diffRemoved",
  "skill",
  "css",
] as const;

// Field meanings are in the guide `moss_theme_read` returns, and the handler checks every field,
// so the listing names them once instead of repeating a schema for each pack.
const PACK_INPUT_SCHEMA = {
  type: "object",
  description: `One pack: ${PACK_FIELDS.join(", ")}. See moss_theme_read.`,
} as const;

export const MOSS_THEME_READ_DESCRIPTION =
  "Read how to restyle Moss itself: presets, theme fields, stable CSS selectors and limits. Call before `moss_theme_set`.";

export const MOSS_THEME_SET_DESCRIPTION =
  "Restyle Moss itself, only when the user asks. Sets the light and/or dark pack (`css` goes to both) and switches this computer's Moss desktop app and this server's web app to it, not remote desktops. `appearance`: light, dark or system. `reset` alone restores Moss's default look. Full-access caller thread only.";

const PACK_NAMES = ["light", "dark"] as const;

const decodePackSpec = Schema.decodeUnknownEffect(MossThemePackSpec);
const decodeAppearance = Schema.decodeUnknownEffect(MossThemeAppearance);
const decodePublishedTheme = Schema.decodeUnknownEffect(MossPublishedTheme);

const inputError = (message: string) => Effect.fail(new ToolInputError(message));

function schemaError(field: string) {
  return (cause: { readonly issue: SchemaIssue.Issue }) =>
    new ToolInputError(`${field}: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`);
}

/** Validate the tool input into the theme clients will apply. */
export function buildPublishedTheme(
  args: Record<string, unknown>,
  now: { readonly revision: string; readonly publishedAt: string },
): Effect.Effect<MossPublishedTheme, ToolInputError> {
  return Effect.gen(function* () {
    const known = new Set(["name", "appearance", "reset", "css", "light", "dark"]);
    const unknown = Object.keys(args).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      return yield* inputError(`Unknown field: ${unknown.join(", ")}.`);
    }
    if (args.css !== undefined && typeof args.css !== "string") {
      return yield* inputError("css: expected a string.");
    }
    const sharedCss = typeof args.css === "string" ? args.css : undefined;
    const packs: Partial<Record<(typeof PACK_NAMES)[number], MossThemePackSpec>> = {};
    for (const variant of PACK_NAMES) {
      const raw = args[variant];
      if (raw === undefined && sharedCss === undefined) continue;
      if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
        return yield* inputError(`${variant}: expected an object.`);
      }
      const unknownFields = Object.keys(raw ?? {}).filter(
        (key) => !(PACK_FIELDS as ReadonlyArray<string>).includes(key),
      );
      if (unknownFields.length > 0) {
        return yield* inputError(
          `${variant}: unknown field ${unknownFields.join(", ")}. Fields: ${PACK_FIELDS.join(", ")}.`,
        );
      }
      const spec = yield* decodePackSpec(raw ?? {}).pipe(Effect.mapError(schemaError(variant)));
      if (spec.preset !== undefined && !isMossThemePreset(spec.preset, variant)) {
        const available = MOSS_THEME_PRESETS.filter((preset) => preset.variants.includes(variant))
          .map((preset) => preset.id)
          .join(", ");
        return yield* inputError(
          `${variant}.preset "${spec.preset}" has no ${variant} pack. Available: ${available}.`,
        );
      }
      const css = spec.css ?? sharedCss;
      if (css !== undefined && themeCssLoadsRemoteFiles(css)) {
        return yield* inputError(
          `${variant} CSS loads files. Remove @import, image-set(), and url() that is not data: or #id.`,
        );
      }
      packs[variant] = css === undefined ? spec : { ...spec, css };
    }
    const appearance =
      args.appearance === undefined
        ? undefined
        : yield* decodeAppearance(args.appearance).pipe(Effect.mapError(schemaError("appearance")));
    if (args.reset !== undefined && typeof args.reset !== "boolean") {
      return yield* inputError("reset: expected true or false.");
    }
    const reset = args.reset === true;
    if (
      !reset &&
      appearance === undefined &&
      packs.light === undefined &&
      packs.dark === undefined
    ) {
      return yield* inputError("Give `light`, `dark`, `css`, `appearance`, or `reset`.");
    }
    return yield* decodePublishedTheme({
      revision: now.revision,
      publishedAt: now.publishedAt,
      ...(typeof args.name === "string" && args.name.trim().length > 0
        ? { name: args.name.trim() }
        : {}),
      ...(reset ? { reset: true } : {}),
      ...(appearance === undefined ? {} : { appearance }),
      ...packs,
    }).pipe(Effect.mapError(schemaError("theme")));
  });
}

export function makeAgentGatewayThemeTools({
  settings,
  requireThreadShell,
}: AgentGatewayThemeToolsInput): ReadonlyArray<ToolEntry> {
  const read: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_theme_read",
      description: MOSS_THEME_READ_DESCRIPTION,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Read Moss theme guide", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      settings.getSettings.pipe(
        Effect.map((current) =>
          mcpToolResultJson({
            lastSetByAgent: current.agentTheme,
            note: "The person may have changed the theme in Settings since; you cannot see what is on screen.",
            presets: MOSS_THEME_PRESETS,
            guide: MOSS_THEME_GUIDE,
          }),
        ),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  const set: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "moss_theme_set",
      description: MOSS_THEME_SET_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 48 },
          appearance: { type: "string", enum: ["light", "dark", "system"] },
          reset: { type: "boolean" },
          css: { type: "string", maxLength: THEME_CSS_MAX_LENGTH },
          light: PACK_INPUT_SCHEMA,
          dark: PACK_INPUT_SCHEMA,
        },
        additionalProperties: false,
      },
      annotations: { title: "Restyle Moss", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        yield* context.assertCallerTurnActive();
        // The same bar as other app-wide changes an agent makes: a full-access thread.
        const caller = yield* requireThreadShell(context.callerThreadId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
        );
        if (caller.runtimeMode !== "full-access") {
          return yield* inputError(
            "Changing Moss's appearance needs a full-access thread. Ask the user to switch this thread to full access, or to change the theme in Settings > Appearance.",
          );
        }
        const theme = yield* buildPublishedTheme(args, {
          revision: randomUUID(),
          publishedAt: gatewayIsoNow(),
        });
        // The turn may have ended while this validated.
        yield* context.assertCallerTurnActive();
        yield* settings.updateSettings({ agentTheme: theme });
        return mcpToolResultJson({
          applied: true,
          revision: theme.revision,
          packs: PACK_NAMES.filter((variant) => theme[variant] !== undefined),
          ...(theme.appearance === undefined ? {} : { appearance: theme.appearance }),
          ...(theme.reset === true ? { reset: true } : {}),
          note: "Moss windows on this computer and the web app this server serves switch now. Ask the user how it looks.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [read, set];
}
