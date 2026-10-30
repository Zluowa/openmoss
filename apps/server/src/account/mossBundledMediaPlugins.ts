// Moss-owned portable media workflows. Model access, prices, and provider keys
// are decided by the authenticated gateway, never by a downloaded skill.
export const MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME = "moss-imagegen";

export const MOSS_BUNDLED_MEDIA_PLUGINS = [
  {
    name: MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME,
    title: "Moss Images",
    kind: "image",
    models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
    defaultInstalled: true,
  },
  {
    name: "moss-nano-banana",
    title: "Nano Banana Pro",
    kind: "image",
    models: ["nano-banana-pro"],
  },
  {
    name: "moss-nano-banana-2",
    title: "Nano Banana 2",
    kind: "image",
    models: ["gemini-flash-image"],
  },
  {
    name: "moss-grok-image",
    title: "Grok Imagine",
    kind: "image",
    models: ["grok-imagine-image-2.0"],
  },
  { name: "moss-wan-image", title: "万相图像", kind: "image", models: ["wan2.7-image-pro"] },
  { name: "moss-seedream", title: "即梦图像", kind: "image", models: ["seedream-5-0"] },
  { name: "moss-kling", title: "可灵 O3", kind: "video", models: ["kling-v3-omni"] },
  {
    name: "moss-wan-video",
    title: "万相视频",
    kind: "video",
    models: ["wan3.0-video", "wan3.0-video-prime"],
  },
  {
    name: "moss-happyhorse",
    title: "HappyHorse",
    kind: "video",
    models: ["happyhorse", "happyhorse-video-edit"],
  },
  {
    name: "moss-seedance",
    title: "即梦视频",
    kind: "video",
    models: ["doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.5"],
  },
  {
    name: "moss-minimax-h3",
    title: "MiniMax H3",
    kind: "video",
    models: ["MiniMax-H3", "MiniMax-H3-Max"],
  },
] as const;

export type MossBundledMediaPlugin = (typeof MOSS_BUNDLED_MEDIA_PLUGINS)[number];

export function buildMossBundledMediaSkill(plugin: MossBundledMediaPlugin): string {
  return `---
name: ${plugin.name}
description: ${plugin.kind === "image" ? "Generate or edit images" : "Generate videos from text or supported references"} with ${plugin.title} through the signed-in Moss account.
---

# ${plugin.title}

Use this workflow for ${plugin.kind} requests. Catalog model identifiers: ${plugin.models.join(", ")}; confirm availability with moss_media_list.
Use ${plugin.models[0]} unless the user selects another listed model. Keep the user's subject, composition, style, aspect ratio and reference intent intact.

## Execute

1. Call \`moss_media_list\` to verify that the installed model is available. The generation endpoint checks account balance before any provider submission.
2. Submit through \`moss_media_generate\` using the modelId, prompt, a new idempotencyKey for this user request, and any referenceImages, aspectRatio, resolution or duration.
3. Keep the returned job ID. Call \`moss_media_get\` with \`{ jobId }\` for that same job until it completes. Poll no more often than every 15 seconds.
4. ${plugin.kind === "image" ? "For edits, first verify supportsReferences. Include the original HTTPS image URL in referenceImages or pass local image paths inside the caller workspace in referencePaths. Describe what changes and what is preserved. Do not invent public URLs or paste file contents into the conversation." : "Check the catalog's reference capabilities first. Wan 3, Seedance 2.5, H3/H3 Max support first/last frames or multimodal references; these modes cannot mix. HappyHorse supports one first frame or image references; editing uses happyhorse-video-edit plus sourceVideoUrl/sourceVideoDuration and no duration. For referenceVideos/referenceAudios also supply their matching duration arrays. Respect each model's limits; never drop supplied media or silently turn an edit into text-to-video. Local referencePaths are read only inside the current workspace and need no user-pasted base64. Missing configured input prices block admission before supplier submission."}

The tools are injected by the Moss host through its authenticated agent gateway. If they are absent, explain that this session's media tools are unavailable. Never ask for supplier keys or extract credentials from local files or environment variables.
Never resubmit after a timeout, disconnect, HTTP 5xx, or ambiguous acceptance: that can create a second paid task. Use the existing job ID to reconcile. Only a new user-requested generation gets a new idempotencyKey.

## Account and results

The host binds every media tool call to the active Moss account. Supplier API keys are never required. If authentication, pricing, balance, or model availability is missing, report the gateway error and ask the user to resolve it in Moss. Installing this skill does not guarantee that an unconfigured provider is available.
Only report costs and billing status returned by the server. Text, images, videos and paid Skills share the paid package's supplier-cost allowance. Do not ask the user to buy a second allowance, invent a points conversion, or estimate a refund.
Return the generated image/video URLs and actual task status. Reuse successful outputs as references for follow-up edits. These tools share task history and billing with the Images workspace.
`;
}
