import { isMossEnterpriseApiKey } from "@synara/shared/mossRealmCatalog";

/** Returns the field error for a pasted key, or null when it can be submitted. */
export function validateMossEnterpriseKeyInput(value: string): string | null {
  const key = value.trim();
  if (key.length === 0) return "请输入企业 API Key。";
  if (/[\r\n]/u.test(value) || value.includes("\u0000")) return "企业 API Key 只能是一行。";
  if (!isMossEnterpriseApiKey(key)) return "请输入以 moss_sk_ 开头的完整企业 API Key。";
  return null;
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  invalid_key: "请输入以 moss_sk_ 开头的完整企业 API Key。",
  key_rejected: "这个企业 API Key 无效或已被吊销，请联系你的管理员。",
  no_entitlement: "这个企业 API Key 当前没有可用的模型额度，请联系你的管理员。",
  gateway_unavailable: "暂时无法连接 Moss 模型服务，请检查网络后重试。",
  not_configured: "这个版本的 Moss 没有配置企业模型服务，请更新 Moss。",
  not_signed_in: "请先登录企业 API Key。",
  persistence_failed: "无法在本机安全保存企业 API Key，请重试。",
};

export function mossEnterpriseKeyErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return (code && ERROR_COPY[code]) ?? "暂时无法使用企业 API Key 登录，请重试。";
}
