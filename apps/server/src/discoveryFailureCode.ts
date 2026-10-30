/** A closed diagnostic vocabulary. Never return error messages, paths or credentials. */
const transportCodes = new Set([
  "EPERM",
  "EACCES",
  "ENOENT",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
]);

export function discoveryFailureCode(error: unknown): string {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current && !visited.has(current); depth++) {
    visited.add(current);
    if (typeof current !== "object") break;
    try {
      const code = Reflect.get(current, "code");
      if (code === -32601) return "PROTOCOL_METHOD_UNSUPPORTED";
      if (code === -32602) return "PROTOCOL_PARAMETERS_INVALID";
      if (typeof code === "string" && transportCodes.has(code)) return code;
      const message = Reflect.get(current, "message");
      if (typeof message === "string") {
        if (/Codex account runtime generation was revoked/.test(message))
          return "RUNTIME_GENERATION_REVOKED";
        if (/Provider process tree \d+ did not prove exit/.test(message))
          return "PROCESS_EXIT_UNPROVEN";
        if (
          /Windows.*observer.*(?:failed|timed out)|(?:failed|timed out).*Windows.*observer/i.test(
            message,
          )
        )
          return "PROCESS_OBSERVER_FAILED";
        if (/chatgpt authentication required|personal ChatGPT session/i.test(message))
          return "REMOTE_AUTH_REQUIRED";
        if (/executable version probe failed|bundled Codex runtime.*unavailable/i.test(message))
          return "BUNDLED_RUNTIME_UNAVAILABLE";
        if (/Codex must report its runtime home/i.test(message)) return "RUNTIME_HOME_MISSING";
        if (/official Moss plugin.*did not finish installing/i.test(message))
          return "BUNDLED_PLUGIN_BOOTSTRAP_FAILED";
        if (/authentication changed|account changed/i.test(message)) return "ACCOUNT_CHANGED";
        if (/ownership collision|managed home authority/i.test(message))
          return "MANAGED_HOME_AUTHORITY_FAILED";
      }
      current = Reflect.get(current, "cause");
    } catch {
      break;
    }
  }
  return "DISCOVERY_FAILED";
}
