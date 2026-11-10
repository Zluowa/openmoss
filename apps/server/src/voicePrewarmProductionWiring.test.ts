import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("voice prewarm production wiring", () => {
  it("uses the settings-backed voice route before calling an adapter", () => {
    const wsSource = readFileSync(new URL("./wsRpc.ts", import.meta.url), "utf8");
    const adapterSource = readFileSync(
      new URL("./provider/Layers/CodexAdapter.ts", import.meta.url),
      "utf8",
    );
    const managerSource = readFileSync(
      new URL("./codexAppServerManager.ts", import.meta.url),
      "utf8",
    );
    const webSource = readFileSync(
      new URL("../../web/src/components/chat/useComposerVoiceController.ts", import.meta.url),
      "utf8",
    );

    const prewarmBlock = wsSource.slice(
      wsSource.indexOf("[WS_METHODS.serverPrewarmVoice]"),
      wsSource.indexOf("[WS_METHODS.serverTranscribeVoice]"),
    );
    expect(prewarmBlock).toContain("resolveAdmittedVoicePrewarmProviderRoute(");
    expect(prewarmBlock).toContain("awaitAccountStartup: runtimeStartup.enqueueRead(Effect.void)");
    expect(prewarmBlock).toContain("getPhoneAuthorityCredential:");
    expect(prewarmBlock).toContain("mossPhoneAccountService.getAuthorityCredential()");
    expect(prewarmBlock).toContain("getCloudAuthorityCredential:");
    expect(prewarmBlock).toContain("mossCloudAccountService.getAuthorityCredential()");
    expect(prewarmBlock).toContain("providerInstanceId: route.providerInstanceId");
    expect(prewarmBlock).toContain("providerOptions: route.providerOptions");
    expect(prewarmBlock).toContain("route.serverResolvedVoiceRouteAuthority");
    expect(prewarmBlock).toContain("serverResolvedVoiceRouteAuthority:");
    const transcriptionBlock = wsSource.slice(
      wsSource.indexOf("[WS_METHODS.serverTranscribeVoice]"),
      wsSource.indexOf("[WS_METHODS.serverGenerateThreadRecap]"),
    );
    // Both transports share one routing composition (Moss account first, then the personal
    // provider, then the localized sign-in guidance).
    expect(transcriptionBlock).toContain("transcribeVoiceRequest({");
    expect(transcriptionBlock).toContain(
      "awaitAccountStartup: runtimeStartup.enqueueRead(Effect.void)",
    );
    expect(transcriptionBlock).toContain("getPhoneAuthorityCredential:");
    expect(transcriptionBlock).toContain("mossPhoneAccountService.getAuthorityCredential()");
    expect(transcriptionBlock).toContain("getCloudAuthorityCredential:");
    expect(transcriptionBlock).toContain("mossCloudAccountService.getAuthorityCredential()");
    expect(transcriptionBlock).toContain("enterpriseKey: mossEnterpriseKeyAccount");
    expect(transcriptionBlock).toContain("getEnabledProviderAdapter(");
    const httpSource = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
    const uploadStart = httpSource.indexOf(
      "if (url.pathname === VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH)",
    );
    const uploadBlock = httpSource.slice(
      uploadStart,
      httpSource.indexOf('return HttpServerResponse.text("Not Found"', uploadStart),
    );
    expect(uploadBlock).toContain("transcribeVoiceRequest({");
    expect(uploadBlock).toContain("code: failure.code");
    expect(uploadBlock).not.toContain("adapter.transcribeVoice(");
    expect(prewarmBlock).toContain("resolveMossVoiceAccountState({");
    const adapterPrewarmBlock = adapterSource.slice(
      adapterSource.indexOf("const prewarmVoice:"),
      adapterSource.indexOf(
        "yield* Effect.acquireRelease",
        adapterSource.indexOf("const prewarmVoice:"),
      ),
    );
    expect(adapterPrewarmBlock).toContain("input.providerOptions?.codex");
    expect(adapterPrewarmBlock).toContain("codexOptions: input.providerOptions.codex");
    expect(adapterPrewarmBlock).toContain("providerInstanceId: input.providerInstanceId");
    expect(adapterPrewarmBlock).toContain("assertServerResolvedVoiceRouteAuthority({");
    expect(adapterPrewarmBlock).toContain("input.serverResolvedVoiceRouteAuthority");
    expect(adapterPrewarmBlock).toContain("serverResolvedVoiceRouteAuthority:");

    const managerPrewarmBlock = managerSource.slice(
      managerSource.indexOf("async prewarmVoice("),
      managerSource.indexOf(
        "getComposerCapabilities()",
        managerSource.indexOf("async prewarmVoice("),
      ),
    );
    expect(managerPrewarmBlock).toContain("resolveReservedMossVoiceRouteIdentity({");
    expect(managerPrewarmBlock).toContain("providerInstanceId: input.providerInstanceId");
    expect(managerPrewarmBlock).not.toContain('accountId === "moss" || accountId === "byok"');
    expect(managerPrewarmBlock).toContain("prewarmChatGptVoiceTranscriptionConnection()");
    expect(managerPrewarmBlock).not.toContain("MOSS_ACCESS_TOKEN");
    expect(managerPrewarmBlock).not.toContain("MOSS_BYOK_API_KEY");
    expect(managerPrewarmBlock).not.toContain("MOSS_APIMART_API_KEY");

    const webPrewarmBlock = webSource.slice(
      webSource.indexOf(".prewarmVoice?.({"),
      webSource.indexOf(".catch(() => undefined)", webSource.indexOf(".prewarmVoice?.({")),
    );
    expect(webPrewarmBlock).toContain("providerInstanceId: voiceProviderInstanceId");
  });
});
