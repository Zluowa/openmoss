// FILE: sshConfigHosts.ts
// Purpose: Discover SSH aliases without executing config commands or exposing proxy arguments.
// Layer: Desktop SSH configuration inventory
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, resolve } from "node:path";
import type { SshConfigHost } from "@moss/contracts";

type Rule = { patterns: string[]; values: Map<string, string> };
const aliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

function words(line: string): string[] {
  const result: string[] = [];
  let word = "",
    quote = "";
  for (let i = 0; i < line.length; i++) {
    const character = line[i]!;
    if (character === "\\" && /[\s#'"\\]/u.test(line[i + 1] ?? "")) {
      word += line[++i];
    } else if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "#") break;
    else if (/\s/u.test(character)) {
      if (word) {
        result.push(word);
        word = "";
      }
    } else word += character;
  }
  if (quote) return [];
  if (word) result.push(word);
  return result;
}
function matches(pattern: string, alias: string): boolean {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
    "iu",
  ).test(alias);
}
function ruleMatches(patterns: string[], alias: string): boolean {
  return (
    !patterns.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1), alias)) &&
    patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern, alias))
  );
}

/** Read metadata only. Match/exec is never evaluated during discovery. Native
 * OpenSSH remains authoritative when the user explicitly connects an alias. */
export async function listSshConfigHosts(
  configFile = join(homedir(), ".ssh", "config"),
  sshDirectory = join(homedir(), ".ssh"),
): Promise<SshConfigHost[]> {
  const home = homedir();
  const aliases = new Map<string, string>();
  const rules: Rule[] = [];
  const visited = new Set<string>();
  const activeIncludes = new Set<string>();
  let current: Rule | undefined;
  let totalBytes = 0;
  const expandPath = (value: string) =>
    value.replace(/^~(?=$|[/\\])/u, home).replaceAll("%d", home);
  async function includePaths(pattern: string, directory: string): Promise<string[]> {
    const expanded = expandPath(pattern);
    const absolute = isAbsolute(expanded) ? expanded : resolve(directory, expanded);
    const { root } = parse(absolute);
    let candidates = [root];
    for (const segment of absolute.slice(root.length).split(/[/\\]/u).filter(Boolean)) {
      const next: string[] = [];
      for (const parent of candidates) {
        if (!/[*?]/u.test(segment)) next.push(join(parent, segment));
        else {
          try {
            for (const entry of await readdir(parent))
              if (matches(segment, entry)) next.push(join(parent, entry));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      candidates = next.sort();
      if (candidates.length > 128) throw new Error("ssh-config-limit");
    }
    return candidates;
  }
  async function visit(file: string): Promise<void> {
    let canonical: string;
    try {
      canonical = await realpath(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (activeIncludes.has(canonical)) return;
    visited.add(canonical);
    activeIncludes.add(canonical);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      activeIncludes.delete(canonical);
      return;
    }
    totalBytes += metadata.size;
    if (visited.size > 64 || metadata.size > 256 * 1024 || totalBytes > 2 * 1024 * 1024)
      throw new Error("ssh-config-limit");
    const text = await readFile(canonical, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const tokens = words(line);
      if (!tokens.length) continue;
      const keyValue = tokens.shift()!.split(/=(.*)/su);
      const key = keyValue[0]!.toLowerCase();
      if (keyValue[1]) tokens.unshift(keyValue[1]);
      if (tokens[0] === "=") tokens.shift();
      if (!tokens.length) continue;
      if (key === "host") {
        current = { patterns: tokens, values: new Map() };
        rules.push(current);
        for (const alias of tokens)
          if (aliasPattern.test(alias) && !aliases.has(alias.toLowerCase()))
            aliases.set(alias.toLowerCase(), alias);
        if (aliases.size > 1000) throw new Error("ssh-config-limit");
      } else if (key === "match") {
        // Conditional sections can execute arbitrary commands. Do not execute
        // or pretend to resolve them as part of opening an Add connection UI.
        current =
          tokens.length === 1 && tokens[0]!.toLowerCase() === "all"
            ? { patterns: ["*"], values: new Map() }
            : undefined;
        if (current) rules.push(current);
      } else if (key === "include") {
        // OpenSSH anchors every relative user Include at ~/.ssh, including
        // nested files. It does not use the current included file's directory.
        for (const pattern of tokens)
          for (const path of await includePaths(pattern, sshDirectory)) await visit(path);
      } else if (
        ["hostname", "user", "port", "identityfile", "proxycommand", "proxyjump"].includes(key)
      ) {
        if (!current && rules.length === 0) {
          current = { patterns: ["*"], values: new Map() };
          rules.push(current);
        }
        if (current && !current.values.has(key)) current.values.set(key, tokens.join(" "));
      }
    }
    activeIncludes.delete(canonical);
  }
  await visit(configFile);
  const result: SshConfigHost[] = [];
  for (const alias of aliases.values()) {
    const values = new Map<string, string>();
    for (const rule of rules)
      if (ruleMatches(rule.patterns, alias))
        for (const [key, value] of rule.values) if (!values.has(key)) values.set(key, value);
    const host = (values.get("hostname") ?? alias).replaceAll("%h", alias).replaceAll("%n", alias);
    const user = values.get("user");
    const port = Number(values.get("port") ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || /[\s\0]/u.test(host)) continue;
    const identity = values.get("identityfile");
    result.push({
      alias,
      host,
      port,
      ...(user ? { user } : {}),
      ...(identity
        ? {
            identityFile: normalize(
              expandPath(identity)
                .replaceAll("%h", host)
                .replaceAll("%n", alias)
                .replaceAll("%r", user ?? "%r"),
            ),
          }
        : {}),
      usesProxy: [values.get("proxyjump"), values.get("proxycommand")].some(
        (value) => value !== undefined && value.toLowerCase() !== "none",
      ),
    });
  }
  return result;
}
