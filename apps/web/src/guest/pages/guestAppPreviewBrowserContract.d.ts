/** Browser-only callbacks serialized by Playwright. Both test projects typecheck this boundary. */
export interface GuestAppPreviewBrowser {
  observeMessages(): void;
  sendInvalidBrokerMessages(): void;
  retainedData(): string;
  messages(): Array<{ origin: string; data: { kind?: string } }>;
  navigateByLink(origin: string): void;
  headerLuminance(): number;
  fitsViewport(): boolean;
}
