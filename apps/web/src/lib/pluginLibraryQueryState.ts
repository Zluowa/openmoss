export type PluginLibraryQueryState = "loading" | "error" | "empty" | "ready";

export function resolvePluginLibraryQueryState(input: {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly itemCount: number;
}): PluginLibraryQueryState {
  if (input.itemCount > 0) return "ready";
  if (input.isLoading) return "loading";
  if (input.error !== null && input.error !== undefined) return "error";
  return "empty";
}

export function pluginLibraryErrorMessage(error: unknown): string | null {
  let message: string | null = null;
  if (error instanceof Error) {
    message = error.message.trim();
  }

  if (message === null && typeof error === "string") {
    message = error.trim();
  }

  if (message === null && error && typeof error === "object" && "message" in error) {
    const structuredMessage = Reflect.get(error, "message");
    if (typeof structuredMessage === "string") {
      message = structuredMessage.trim();
    }
  }

  if (!message) return null;

  const exposesProviderInternals =
    /provider adapter request failed|\bplugin\/list\b|chatgpt authentication required|remote plugin catalog/i.test(
      message,
    );
  return exposesProviderInternals ? null : message;
}
