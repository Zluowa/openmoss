import * as fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { format } from "oxfmt";
import {
  hasAmbiguousPathSegment,
  isHiddenRepairPath,
  isProtectedRepairPath,
} from "./devsRepairPaths";

const maxBytes = 512_000;
const refused = (name: string, writing: boolean) =>
  writing ? isProtectedRepairPath(name) : isHiddenRepairPath(name);

/**
 * File tools for the public repair agent. Reads and writes resolve inside this checkout, and
 * protected paths are refused. This is not the security boundary: Codex's own patch tool can
 * also write inside the checkout, so the controller re-checks every changed path before Git
 * reads it.
 */
export async function createDevsWorkspaceTools(directory: string) {
  const root = await fs.realpath(directory);
  const inside = (candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  const resolve = async (input: unknown, writing = false) => {
    if (
      typeof input !== "string" ||
      input.includes("\0") ||
      path.isAbsolute(input) ||
      path.win32.isAbsolute(input)
    )
      throw new Error("A workspace-relative path is required.");
    const name = input.replaceAll("\\", "/");
    if (hasAmbiguousPathSegment(name)) throw new Error("Ambiguous workspace path.");
    if (refused(name, writing)) throw new Error("Protected workspace path.");
    const location = path.resolve(root, name);
    if (!inside(location)) throw new Error("Path is outside the repair workspace.");
    let ancestor = location;
    for (;;) {
      try {
        const canonical = await fs.realpath(ancestor);
        if (!inside(canonical)) throw new Error("Symlink target is outside the repair workspace.");
        const relative = path.relative(root, canonical).split(path.sep).join("/");
        // Catches aliases of existing files, such as Windows short names.
        if (refused(relative, writing)) throw new Error("Protected workspace path.");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    if (writing) {
      const stat = await fs.lstat(location).catch(() => undefined);
      if (stat?.isSymbolicLink()) throw new Error("Writing symlinks is not permitted.");
    }
    return location;
  };
  const walk = async (directory: string, limit = 2_000) => {
    const names: string[] = [];
    const visit = async (folder: string) => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (names.length >= limit) return;
        const location = path.join(folder, entry.name);
        const name = path.relative(root, location).split(path.sep).join("/");
        if (
          isHiddenRepairPath(name) ||
          entry.isSymbolicLink() ||
          ["node_modules", ".moss", "dist", ".turbo"].includes(entry.name)
        )
          continue;
        if (entry.isDirectory()) await visit(location);
        else if (entry.isFile()) names.push(name);
      }
    };
    await visit(directory);
    return names;
  };
  return async (name: string, input: Record<string, unknown>) => {
    if (name === "list_files")
      return (await walk(await resolve(input.directory ?? "."))).join("\n");
    if (name === "read_file") {
      const location = await resolve(input.path);
      const stat = await fs.stat(location);
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Select a text file below 512 KB.");
      const start = Number(input.startLine ?? 1),
        count = Number(input.lineCount ?? 300);
      if (
        !Number.isSafeInteger(start) ||
        start < 1 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 500
      )
        throw new Error("Invalid line range.");
      const text = await fs.readFile(location, "utf8");
      if (text.includes("\0")) throw new Error("Binary files are not supported.");
      return text
        .split("\n")
        .slice(start - 1, start - 1 + count)
        .map((line, index) => `${start + index}: ${line}`)
        .join("\n");
    }
    if (name === "write_file") {
      if (typeof input.content !== "string" || Buffer.byteLength(input.content) > maxBytes)
        throw new Error("Text edits are limited to 512 KB.");
      const location = await resolve(input.path, true);
      let content = input.content;
      if (/\.(?:[cm]?[jt]sx?|json|mdx?|ya?ml|css|scss|html)$/i.test(location)) {
        // Use only the controller's pinned formatter and explicit defaults, never job-supplied code/config.
        const formatted = await format(String(input.path), content, { endOfLine: "lf" });
        if (formatted.errors.some((error) => error.severity === "Error"))
          throw new Error("The edit could not be parsed or formatted.");
        content = formatted.code;
      }
      await fs.mkdir(path.dirname(location), { recursive: true });
      const previous = await fs.stat(location).catch(() => undefined);
      // Replace the inode: Bun can hard-link dependencies to a shared host cache.
      const temporary = path.join(path.dirname(location), `.moss-edit-${randomUUID()}`);
      await fs.writeFile(temporary, content, {
        flag: "wx",
        mode: previous ? previous.mode & 0o777 : 0o600,
      });
      try {
        await fs.rename(temporary, location);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return "File saved in the repair workspace.";
    }
    if (name === "search_text") {
      if (typeof input.text !== "string" || !input.text || input.text.length > 500)
        throw new Error("A bounded literal search string is required.");
      const matches: string[] = [];
      let bytes = 0;
      for (const name of await walk(await resolve(input.directory ?? "."))) {
        const location = await resolve(name);
        const stat = await fs.stat(location);
        if (stat.size > maxBytes) continue;
        bytes += stat.size;
        if (bytes > 10_000_000) break;
        const text = await fs.readFile(location, "utf8");
        if (text.includes("\0")) continue;
        for (const [index, line] of text.split("\n").entries())
          if (line.includes(input.text)) {
            matches.push(`${name}:${index + 1}: ${line.slice(0, 500)}`);
            if (matches.length >= 100) return matches.join("\n");
          }
      }
      return matches.join("\n");
    }
    throw new Error("Unknown workspace tool.");
  };
}

if (import.meta.main) {
  const invoke = await createDevsWorkspaceTools(process.argv[2]!);
  const tools = [
    {
      name: "list_files",
      description: "List source files under a workspace-relative directory (bounded).",
      inputSchema: { type: "object", properties: { directory: { type: "string" } } },
    },
    {
      name: "read_file",
      description: "Read a bounded line range from a workspace text file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer" },
          lineCount: { type: "integer" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Create or replace one workspace text file. No shell execution or host paths.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "search_text",
      description: "Search literal text in source files under a workspace-relative directory.",
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string" }, text: { type: "string" } },
        required: ["text"],
      },
    },
  ];
  const lines = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  for await (const line of lines) {
    chain = chain.then(async () => {
      let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        if (line.length > 1_000_000) throw new Error("Message too large");
        message = JSON.parse(line);
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Invalid JSON-RPC message" },
          }) + "\n",
        );
        return;
      }
      if (message.id === undefined) return;
      let result: unknown;
      if (message.method === "initialize")
        result = {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "moss-repair-workspace", version: "1.0.0" },
        };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") {
        try {
          result = {
            content: [
              {
                type: "text",
                text: await invoke(
                  String(message.params?.name),
                  (message.params?.arguments ?? {}) as Record<string, unknown>,
                ),
              },
            ],
          };
        } catch (error) {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Workspace operation failed.",
              },
            ],
          };
        }
      } else if (message.method === "ping") result = {};
      else {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          }) + "\n",
        );
        return;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
    });
  }
  await chain;
}
