// FILE: generateOpenUIChatReference.ts
// Purpose: Regenerate apps/server/src/agentGateway/openUIChatReference.generated.ts
//          from the live @openuidev/react-ui chat library.
// Run: bun scripts/generateOpenUIChatReference.ts   (from apps/web)

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  buildOpenUIChatExamples,
  buildOpenUIChatReferenceCore,
} from "../src/lib/openUIChatReference";

const OUTPUT_PATH = new URL(
  "../../server/src/agentGateway/openUIChatReference.generated.ts",
  import.meta.url,
);

const reference = buildOpenUIChatReferenceCore();
const examples = buildOpenUIChatExamples();

const moduleText = `// FILE: openUIChatReference.generated.ts
// GENERATED FILE — do not edit by hand.
// Regenerate from apps/web: bun scripts/generateOpenUIChatReference.ts
// Source of truth: @openuidev/react-ui chat library as extended by
// apps/web/src/lib/mossOpenUILibrary.tsx, rendered through
// apps/web/src/lib/openUIChatReference.ts (buildOpenUIChatReferenceCore/Examples).
// Served to agents by the openui_reference gateway tool (openUIReferenceTool.ts):
// the core catalog by default, worked examples via { "section": "examples" }.

export const OPENUI_CHAT_REFERENCE = ${JSON.stringify(reference)};

export const OPENUI_CHAT_REFERENCE_EXAMPLES = ${JSON.stringify(examples)};
`;

writeFileSync(OUTPUT_PATH, moduleText);
// Normalize to repo formatting (oxfmt rewrites the long string literal to its
// canonical form) so `bun fmt:check` stays green after every regeneration.
// oxfmt resolves its config from the repository root, so spawn it there.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputPath = fileURLToPath(OUTPUT_PATH);
const formatterPath = createRequire(import.meta.url).resolve("oxfmt/bin/oxfmt");
execFileSync(process.execPath, [formatterPath, outputPath], { cwd: repoRoot, stdio: "inherit" });
console.log(
  `wrote ${outputPath} (${reference.length} core chars + ${examples.length} example chars)`,
);
