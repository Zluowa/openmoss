// Literal shell words for display classification only. Never evaluates a command.
// Compound commands and expansions keep the generic/raw-command fallback.
export function literalCommandWords(command: string): string[] | null {
  if (command.length > 32_768) return null;
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\" && quote !== "'") {
      const next = command[++index];
      if (next === undefined) return null;
      word += quote === '"' && !'"\\$`'.includes(next) ? `\\${next}` : next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else if (quote === '"' && (char === "$" || char === "`")) return null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/[|&;<>\n\r$`()]/.test(char)) {
      return null;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** CHIP kx/$4n: a known interpreter + a script inside a recognized skill root. */
export function skillScriptCommand(
  command: string,
): { fileName: string; skillName: string } | null {
  const words = literalCommandWords(command);
  const executable = words?.[0]?.replaceAll("\\", "/").split("/").at(-1);
  if (!executable || !["python", "python3", "bash", "sh"].includes(executable)) return null;
  // -c/-m invoke code/modules, not a script; don't mislabel a quoted code string
  // as a filesystem path even if it mentions a skills directory.
  if (words!.slice(1).some((word) => /^-(?:[A-Za-z]*c|m)$/.test(word))) return null;
  const script = words!.slice(1).find((word) => word && !word.startsWith("-"));
  if (!script) return null;
  const parts = script.replaceAll("\\", "/").split("/").filter(Boolean);
  const root = parts.findIndex(
    (part, index) =>
      [".codex", ".agents", ".claude"].includes(part.toLowerCase()) &&
      parts[index + 1]?.toLowerCase() === "skills",
  );
  let skillIndex = -1;
  if (root >= 0) {
    skillIndex = root + 2;
    if ([".system", "_import"].includes(parts[skillIndex]?.toLowerCase() ?? "")) skillIndex++;
  } else {
    const plugins = parts.findIndex((part) => part.toLowerCase() === "plugins");
    if (plugins >= 0) {
      const skills = parts.findIndex(
        (part, index) => index > plugins && part.toLowerCase() === "skills",
      );
      if (skills >= 0) skillIndex = skills + 1;
    }
  }
  const skill = parts[skillIndex];
  const fileName = parts.at(-1);
  if (
    !skill ||
    !fileName ||
    parts[skillIndex + 1]?.toLowerCase() !== "scripts" ||
    parts.length <= skillIndex + 2
  )
    return null;
  const acronyms = new Set([
    "GH",
    "IA",
    "MCP",
    "API",
    "CI",
    "CLI",
    "LLM",
    "PDF",
    "PR",
    "UI",
    "URL",
    "SQL",
    "TW",
    "GPU",
    "CPU",
  ]);
  const skillName = skill
    .replaceAll("_", "-")
    .split("-")
    .filter(Boolean)
    .map((word) =>
      acronyms.has(word.toUpperCase())
        ? word.toUpperCase()
        : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
  return { fileName, skillName };
}
