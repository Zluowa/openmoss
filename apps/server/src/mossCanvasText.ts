import { Effect } from "effect";
import {
  fetchMossGatewayModelIds,
  normalizeMossGatewayModelCatalog,
} from "./account/mossGatewayModels";
import { MossMediaJobsError, type MossMediaCredential } from "./mossMediaJobsService";

/** Canvas uses the same entitled gateway and actual-cost ledger as Moss chat. */
export async function mossCanvasTextModels(
  credential: MossMediaCredential,
): Promise<ReadonlyArray<string>> {
  const catalog = normalizeMossGatewayModelCatalog(
    await Effect.runPromise(fetchMossGatewayModelIds(credential)),
  );
  if (catalog.status !== "ready") {
    throw new MossMediaJobsError("model_catalog_unavailable", 503);
  }
  return catalog.models;
}

export async function relayMossCanvasText(
  input: Record<string, unknown>,
  credential: MossMediaCredential,
  entitledModels: ReadonlyArray<string>,
): Promise<{ status: number; body: unknown }> {
  const model = input.model;
  const messages = input.messages;
  const operationId = input.operationId;
  if (
    typeof model !== "string" ||
    model.length > 200 ||
    typeof operationId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(operationId) ||
    input.stream !== false ||
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > 128 ||
    messages.some(
      (message) =>
        !message ||
        typeof message !== "object" ||
        !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string",
    ) ||
    !Number.isSafeInteger(input.max_tokens) ||
    Number(input.max_tokens) < 1 ||
    Number(input.max_tokens) > 32768
  )
    throw new MossMediaJobsError("canvas_text_request_invalid", 400);
  if (!entitledModels.includes(model)) {
    throw new MossMediaJobsError("model_not_entitled", 403);
  }
  const target = new URL(credential.gatewayBaseUrl);
  target.pathname = `${target.pathname.replace(/\/+$/u, "").replace(/(?:\/v1)+$/u, "")}/v1/chat/completions`;
  target.search = "";
  target.hash = "";
  // One dispatch only. A timeout is not proof that the supplier did not bill.
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(180000),
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/json",
        "user-agent": "Moss",
        "x-client-request-id": operationId,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: input.max_tokens,
        stream: false,
        ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
        ...(model.toLowerCase().includes("deepseek") ? { thinking: { type: "disabled" } } : {}),
      }),
    });
  } catch {
    throw new MossMediaJobsError("canvas_text_billing_unconfirmed", 503);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Never expose an upstream body, header or credential to the renderer.
    return {
      status: response.status >= 400 && response.status < 600 ? response.status : 502,
      body: {
        error: {
          code: "canvas_text_request_failed",
          message: "文本卡生成未完成，请查看套餐用量。",
        },
      },
    };
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("choices" in payload) ||
    !Array.isArray(payload.choices)
  ) {
    throw new MossMediaJobsError("canvas_text_billing_unconfirmed", 502);
  }
  const data = payload as {
    choices: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: Record<string, unknown>;
  };
  const usage =
    data.usage && typeof data.usage === "object"
      ? Object.fromEntries(
          ["prompt_tokens", "completion_tokens", "total_tokens"].flatMap((key) =>
            Number.isSafeInteger(data.usage?.[key]) && Number(data.usage?.[key]) >= 0
              ? [[key, data.usage?.[key]]]
              : [],
          ),
        )
      : undefined;
  return {
    status: 200,
    body: {
      choices: data.choices.map((choice) => ({
        message: {
          role: "assistant",
          content: typeof choice.message?.content === "string" ? choice.message.content : "",
        },
        finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
      })),
      ...(usage ? { usage } : {}),
    },
  };
}
