// FILE: sshWorkspacePolicy.ts
// Purpose: Keep remote credentials in main-process request headers, outside renderer URLs and logs.
// Layer: SSH workspace security policy
// Exports: sshWorkspaceTransport, sshWorkspaceHeaders
export function sshWorkspaceTransport(wsUrl: string): {
  readonly url: string;
  readonly token: string;
} {
  const url = new URL(wsUrl);
  const token = url.searchParams.get("token");
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !token ||
    !/^[a-f0-9]{64}$/u.test(token)
  )
    throw new Error("invalid-remote-workspace");
  url.searchParams.delete("token");
  return { url: url.toString(), token };
}
export function sshWorkspaceHeaders(
  origin: string,
  token: string,
  requestUrl: string,
  headers: Record<string, string>,
): Record<string, string> {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return headers;
  }
  if (request.protocol === "ws:") request.protocol = "http:";
  if (request.protocol === "wss:") request.protocol = "https:";
  if (request.origin !== origin) return headers;
  return {
    ...Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
    ),
    Authorization: `Bearer ${token}`,
  };
}
