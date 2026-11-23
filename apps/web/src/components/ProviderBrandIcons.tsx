import type { ComponentType } from "react";
import {
  SiAlibabacloud,
  SiAnthropic,
  SiBaidu,
  SiBytedance,
  SiCloudflare,
  SiDatabricks,
  SiGithub,
  SiGoogle,
  SiHuawei,
  SiHuggingface,
  SiMeta,
  SiMistralai,
  SiNvidia,
  SiOllama,
  SiPerplexity,
  SiReplicate,
  SiSnowflake,
  SiVercel,
  SiX,
  SiXiaomi,
} from "react-icons/si";
import type { ProviderKind } from "@moss/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DevinIcon,
  Gemini,
  GrokIcon,
  KimiIcon,
  MinimaxIcon,
  OmpIcon,
  OpenAI,
  PiIcon,
  ZcodeIcon,
} from "~/components/Icons";
import { MossLogoMark } from "~/components/MossLogoMark";
import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";
import type { ProviderBrandIconId } from "~/theme/providerBrandTheme";

type IconComponentProps = { readonly className?: string | undefined };

function DeepSeekSvg({ className }: IconComponentProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.4 11.7c-.3-.7-1.1-.8-1.9-.6-.8.2-1.4.6-2 1-.9-2.8-3.6-4.7-7-4.7-4.3 0-7.5 2.8-7.5 6.4 0 3.4 3 5.8 7.3 5.8 3.6 0 6.5-1.8 7.9-4.5.9.2 2 .1 2.7-.5.5-.5.8-2.2.5-2.9Zm-8-6.4c.5-.6 1.2-1.1 2-1.2.3 0 .4.2.3.4-.3.8-.9 1.5-1.7 1.8-.4.1-.7-.2-.7-.6 0-.1 0-.3.1-.4ZM9 11.8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
      />
    </svg>
  );
}

function OpenCodeBrandSvg({ className }: IconComponentProps) {
  return <ProviderIcon provider="opencode" className={className} />;
}

function OpenRouterSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="5.5" cy="12" r="2" />
      <circle cx="18.5" cy="6.5" r="2" />
      <circle cx="18.5" cy="17.5" r="2" />
      <path d="M7.4 11.2 16.6 7.3M7.4 12.8l9.2 3.9" />
    </svg>
  );
}

function SiliconFlowSvg({ className }: IconComponentProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 3.2 4.8 7.3v9.4L12 20.8l7.2-4.1V7.3L12 3.2Zm0 2.3 4.8 2.8v2.2L12 13.2 7.2 10.5V8.3L12 5.5Zm-4.8 7.7 4.8 2.7 4.8-2.7v2L12 18l-4.8-2.8v-2Z" />
    </svg>
  );
}

function TencentHunyuanSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <ellipse cx="10.2" cy="12" rx="6.2" ry="3.8" transform="rotate(-24 10.2 12)" />
      <ellipse cx="13.8" cy="12" rx="6.2" ry="3.8" transform="rotate(24 13.8 12)" />
    </svg>
  );
}

function StepFunSvg({ className }: IconComponentProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M4.5 15.2H9v-4.4h4.4V6.4h6.1V9h-3.6v4.4h-4.4v4.4H4.5v-2.6Z" />
    </svg>
  );
}

function GroqSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M18.6 10.5A7 7 0 1 0 19 12h-5.8" />
    </svg>
  );
}

function TogetherSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      aria-hidden="true"
      className={className}
    >
      <circle cx="9.6" cy="12" r="4.8" />
      <circle cx="14.4" cy="12" r="4.8" />
    </svg>
  );
}

function FireworksSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3.8v4.1M12 16.1v4.1M3.8 12h4.1M16.1 12h4.1M6.2 6.2l2.9 2.9M14.9 14.9l2.9 2.9M17.8 6.2l-2.9 2.9M9.1 14.9l-2.9 2.9" />
    </svg>
  );
}

function AzureSvg({ className }: IconComponentProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M10.4 4.8 4.4 18.4h4l2.1-5 4.7 5h4.4L13 4.8h-2.6Zm.5 5 2.1 5H9l1.9-5Z" />
    </svg>
  );
}

function BedrockSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3.5 4.8 7.7v8.6L12 20.5l7.2-4.2V7.7L12 3.5Z" />
      <path d="M4.8 7.7 12 11.9l7.2-4.2M12 11.9v8.6" />
    </svg>
  );
}

function LmStudioSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="4.2" y="4.8" width="15.6" height="14.4" rx="2.5" />
      <path d="m8.2 9.4 2.8 2.6-2.8 2.6M12.5 14.6h3.3" />
    </svg>
  );
}

function VllmSvg({ className }: IconComponentProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M4.6 5.2h3L12 15.8 16.4 5.2h3L13.3 18.8h-2.6L4.6 5.2Z" />
    </svg>
  );
}

function ModelScopeSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="7.2" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 4.8v2.2M12 17v2.2M4.8 12H7M17 12h2.2" />
    </svg>
  );
}

function ServerCloudSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M7 17.8h10a3.6 3.6 0 0 0 .6-7.15A5.2 5.2 0 0 0 7.5 9a3.8 3.8 0 0 0-.5 8.8Z" />
    </svg>
  );
}

function ServerNodeSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="4.5" y="5" width="15" height="5.5" rx="1.5" />
      <rect x="4.5" y="13.5" width="15" height="5.5" rx="1.5" />
      <path d="M8 7.75h.01M8 16.25h.01M11.5 7.75h4.5M11.5 16.25h4.5" />
    </svg>
  );
}

function ServerGlobeSvg({ className }: IconComponentProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M4.2 12h15.6M12 4a11.8 11.8 0 0 1 0 16M12 4a11.8 11.8 0 0 0 0 16" />
    </svg>
  );
}

const BRAND_ICON_COMPONENTS: Record<string, ComponentType<IconComponentProps>> = {
  moss: MossLogoMark,
  openai: OpenAI,
  codex: OpenAI,
  anthropic: SiAnthropic,
  claude: ClaudeAI,
  claudeAgent: ClaudeAI,
  gemini: Gemini,
  google: SiGoogle,
  antigravity: AntigravityIcon,
  deepseek: DeepSeekSvg,
  qwen: SiAlibabacloud,
  alibaba: SiAlibabacloud,
  kimi: KimiIcon,
  zhipu: ZcodeIcon,
  zcode: ZcodeIcon,
  minimax: MinimaxIcon,
  bytedance: SiBytedance,
  baidu: SiBaidu,
  huawei: SiHuawei,
  tencent: TencentHunyuanSvg,
  stepfun: StepFunSvg,
  xiaomi: SiXiaomi,
  openrouter: OpenRouterSvg,
  siliconflow: SiliconFlowSvg,
  groq: GroqSvg,
  together: TogetherSvg,
  fireworks: FireworksSvg,
  mistral: SiMistralai,
  perplexity: SiPerplexity,
  xai: SiX,
  grok: GrokIcon,
  devin: DevinIcon,
  cursor: CursorIcon,
  opencode: OpenCodeBrandSvg,
  pi: PiIcon,
  omp: OmpIcon,
  nvidia: SiNvidia,
  meta: SiMeta,
  github: SiGithub,
  cloudflare: SiCloudflare,
  vercel: SiVercel,
  ollama: SiOllama,
  lmstudio: LmStudioSvg,
  vllm: VllmSvg,
  huggingface: SiHuggingface,
  modelscope: ModelScopeSvg,
  azure: AzureSvg,
  bedrock: BedrockSvg,
  replicate: SiReplicate,
  databricks: SiDatabricks,
  snowflake: SiSnowflake,
  "server-cloud": ServerCloudSvg,
  "server-node": ServerNodeSvg,
  "server-globe": ServerGlobeSvg,
};

export interface BrandIconCatalogEntry {
  readonly iconId: ProviderBrandIconId;
  readonly label: string;
  readonly category: "brand" | "gateway" | "server";
}

export const PROVIDER_BRAND_ICON_CATALOG: ReadonlyArray<BrandIconCatalogEntry> = [
  { iconId: "deepseek", label: "DeepSeek", category: "brand" },
  { iconId: "openai", label: "OpenAI", category: "brand" },
  { iconId: "anthropic", label: "Anthropic", category: "brand" },
  { iconId: "claude", label: "Claude", category: "brand" },
  { iconId: "gemini", label: "Gemini", category: "brand" },
  { iconId: "google", label: "Google", category: "brand" },
  { iconId: "qwen", label: "Qwen / Alibaba", category: "brand" },
  { iconId: "zhipu", label: "Zhipu GLM", category: "brand" },
  { iconId: "kimi", label: "Kimi", category: "brand" },
  { iconId: "minimax", label: "MiniMax", category: "brand" },
  { iconId: "bytedance", label: "ByteDance / Ark", category: "brand" },
  { iconId: "baidu", label: "Baidu Qianfan", category: "brand" },
  { iconId: "tencent", label: "Tencent Hunyuan", category: "brand" },
  { iconId: "huawei", label: "Huawei Cloud", category: "brand" },
  { iconId: "stepfun", label: "StepFun", category: "brand" },
  { iconId: "xiaomi", label: "Xiaomi MiMo", category: "brand" },
  { iconId: "xai", label: "xAI / Grok", category: "brand" },
  { iconId: "mistral", label: "Mistral AI", category: "brand" },
  { iconId: "nvidia", label: "NVIDIA NIM", category: "brand" },
  { iconId: "meta", label: "Meta Llama", category: "brand" },
  { iconId: "perplexity", label: "Perplexity", category: "brand" },
  { iconId: "openrouter", label: "OpenRouter", category: "gateway" },
  { iconId: "siliconflow", label: "SiliconFlow", category: "gateway" },
  { iconId: "cloudflare", label: "Cloudflare", category: "gateway" },
  { iconId: "groq", label: "Groq", category: "gateway" },
  { iconId: "together", label: "Together AI", category: "gateway" },
  { iconId: "fireworks", label: "Fireworks AI", category: "gateway" },
  { iconId: "huggingface", label: "Hugging Face", category: "gateway" },
  { iconId: "modelscope", label: "ModelScope", category: "gateway" },
  { iconId: "github", label: "GitHub Models", category: "gateway" },
  { iconId: "vercel", label: "Vercel Gateway", category: "gateway" },
  { iconId: "replicate", label: "Replicate", category: "gateway" },
  { iconId: "databricks", label: "Databricks", category: "gateway" },
  { iconId: "snowflake", label: "Snowflake", category: "gateway" },
  { iconId: "ollama", label: "Ollama", category: "server" },
  { iconId: "lmstudio", label: "LM Studio", category: "server" },
  { iconId: "vllm", label: "vLLM", category: "server" },
  { iconId: "azure", label: "Azure OpenAI", category: "server" },
  { iconId: "bedrock", label: "AWS Bedrock", category: "server" },
  { iconId: "server-cloud", label: "Cloud Server", category: "server" },
  { iconId: "server-node", label: "Local Node", category: "server" },
  { iconId: "server-globe", label: "Custom Endpoint", category: "server" },
];

export function ProviderBrandIcon({
  iconId,
  className,
}: {
  readonly iconId: string;
  readonly className?: string | undefined;
}) {
  const Icon = BRAND_ICON_COMPONENTS[iconId] ?? ServerCloudSvg;
  return <Icon className={cn("size-4 shrink-0 opacity-100", className)} />;
}

export function ProviderBrandTile({
  iconId,
  cliProvider,
  variant = "tile",
  size = "md",
  active = false,
  className,
}: {
  readonly iconId: string;
  readonly cliProvider?: ProviderKind | undefined;
  readonly variant?: "bare" | "tile" | undefined;
  readonly size?: "sm" | "md" | "lg" | undefined;
  readonly active?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  if (variant === "bare") {
    const bareSizeClass = size === "sm" ? "size-4" : size === "lg" ? "size-6" : "size-4.5";
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center text-foreground",
          bareSizeClass,
          className,
        )}
        data-brand-icon-id={iconId}
      >
        {cliProvider ? (
          <ProviderIcon provider={cliProvider} className={cn(bareSizeClass, "opacity-100")} />
        ) : (
          <ProviderBrandIcon iconId={iconId} className={bareSizeClass} />
        )}
      </span>
    );
  }

  const sizeClass =
    size === "sm"
      ? "size-7 rounded-control"
      : size === "lg"
        ? "size-10 rounded-card"
        : "size-9 rounded-control";
  const glyphClass = size === "sm" ? "size-4" : size === "lg" ? "size-5" : "size-4.5";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border/65 bg-foreground/[0.04] text-foreground transition-colors",
        active && "border-border bg-foreground/[0.06]",
        sizeClass,
        className,
      )}
      data-brand-icon-id={iconId}
    >
      {cliProvider ? (
        <ProviderIcon provider={cliProvider} className={cn(glyphClass, "opacity-100")} />
      ) : (
        <ProviderBrandIcon iconId={iconId} className={glyphClass} />
      )}
    </span>
  );
}
