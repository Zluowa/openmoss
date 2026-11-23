// FILE: providerBrandTheme.ts
// Purpose: Brand accent colors for model providers, gateways, and CLI icon tiles.
// Layer: Theme

export const PROVIDER_BRAND_ACCENT_HEX = {
  moss: "#e85443",
  openai: "#10a37f",
  codex: "#10a37f",
  anthropic: "#d97757",
  claude: "#d97757",
  claudeAgent: "#d97757",
  gemini: "#4285f4",
  google: "#4285f4",
  antigravity: "#4285f4",
  deepseek: "#4d6bfe",
  qwen: "#ff6a00",
  alibaba: "#ff6a00",
  kimi: "#3b82f6",
  zhipu: "#3859ff",
  zcode: "#3859ff",
  minimax: "#e11d48",
  bytedance: "#00b5b8",
  baidu: "#2932e1",
  huawei: "#cf0a2c",
  tencent: "#0052d9",
  stepfun: "#2563eb",
  xiaomi: "#ff6900",
  openrouter: "#6366f1",
  siliconflow: "#7c3aed",
  groq: "#f55036",
  together: "#0ea5e9",
  fireworks: "#f97316",
  mistral: "#fa520f",
  perplexity: "#20808d",
  xai: "#475569",
  grok: "#475569",
  nvidia: "#76b900",
  meta: "#0668e1",
  github: "#334155",
  cloudflare: "#f38020",
  vercel: "#334155",
  ollama: "#4b5563",
  lmstudio: "#4f46e5",
  vllm: "#0284c7",
  huggingface: "#f59e0b",
  modelscope: "#6366f1",
  azure: "#0078d4",
  bedrock: "#ff9900",
  replicate: "#475569",
  databricks: "#ff3621",
  snowflake: "#29b5e8",
  cursor: "#334155",
  opencode: "#475569",
  pi: "#6366f1",
  hermes: "#0f766e",
  omp: "#7c3aed",
  devin: "#0ea5e9",
  "server-cloud": "#475569",
  "server-node": "#0f766e",
  "server-globe": "#2563eb",
} as const satisfies Record<string, string>;

export type ProviderBrandIconId = keyof typeof PROVIDER_BRAND_ACCENT_HEX;

export function resolveProviderBrandAccentHex(iconId: string): string {
  if (Object.hasOwn(PROVIDER_BRAND_ACCENT_HEX, iconId)) {
    return PROVIDER_BRAND_ACCENT_HEX[iconId as ProviderBrandIconId];
  }
  return PROVIDER_BRAND_ACCENT_HEX["server-cloud"];
}
