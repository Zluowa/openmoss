// The complete Open Moss Canvas renderer delegates account and media authority
// to the running Moss backend. No gateway credentials cross into the renderer.
export interface MossCanvasEndpoint {
  readonly baseUrl: string;
  readonly token: string;
}

const failure = (code: string, status = 503) =>
  Response.json({ success: false, code, error: { code } }, { status });

const managedAccount = async (): Promise<never> => {
  throw Object.assign(new Error("请在 Moss 账号设置中管理当前账号。"), {
    code: "MOSS_CANVAS_HOST_ACCOUNT_MANAGED",
  });
};

export function createMossCanvasTransport(options: {
  readonly endpoint: () => MossCanvasEndpoint;
  readonly fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backend = async (path: string, method = "GET", body?: ArrayBuffer) => {
    const endpoint = options.endpoint();
    const base = new URL(endpoint.baseUrl);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !endpoint.token)
      throw new Error("canvas_host_unavailable");
    const url = new URL(path, base);
    url.searchParams.set("token", endpoint.token);
    // A lost POST response never triggers another submission here. Durable job
    // reconciliation belongs to the existing account-scoped media service.
    return fetchImpl(url, {
      method,
      ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  };
  const read = async (path: string) => {
    const response = await backend(path);
    if (!response.ok) throw new Error("canvas_account_unavailable");
    return response.json();
  };
  return {
    account: {
      getSession: () => read("/api/moss/media/canvas/account"),
      getQuota: () => read("/api/moss/media/canvas/quota"),
      getPublicConfigStatus: () => ({
        configured: true,
        hostedByMoss: true,
        accountDatabase: "moss-database",
      }),
      startPhoneLogin: managedAccount,
      verifyPhoneLogin: managedAccount,
      logout: managedAccount,
    },
    async request(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.protocol !== "hoola-local:" || url.hostname !== "app" || url.username || url.password)
        return failure("canvas_request_origin_invalid", 403);
      const path = url.pathname;
      const job = path.match(/^\/api\/generation\/jobs\/(moss_[A-Za-z0-9_-]{1,128})(\/run)?$/u);
      const project = path.match(
        /^\/api\/generation\/projects\/([A-Za-z0-9_-]{1,256})\/jobs\/open$/u,
      );
      try {
        // Every branch awaits in place: a bare `return backend(...)` would hand the
        // promise back before rejection and bypass this catch.
        if (path === "/api/generation/jobs" && request.method === "POST") {
          const body = await request.arrayBuffer();
          if (body.byteLength > 8 * 1024 * 1024) return failure("request_too_large", 413);
          return await backend("/api/moss/media/jobs", "POST", body);
        }
        if (job && ((!job[2] && request.method === "GET") || (job[2] && request.method === "POST")))
          return await backend(`/api/moss/media/jobs/${job[1]}`);
        if (project && request.method === "GET")
          return await backend(`/api/moss/media/projects/${project[1]}/jobs/open`);
        if (path === "/api/media/catalog" && request.method === "GET")
          return await backend("/api/moss/media/jobs");
        if (
          /^\/api\/moss\/media\/assets\/moss_[A-Za-z0-9_-]{1,128}\/[0-9]{1,2}$/u.test(path) &&
          request.method === "GET"
        )
          return await backend(path);
        return failure("canvas_operation_unavailable", 404);
      } catch {
        // Preserve an ambiguous delivery as an error; never manufacture a job,
        // balance, bill or a successful response to hide an unavailable host.
        return failure("canvas_host_unavailable");
      }
    },
  };
}
