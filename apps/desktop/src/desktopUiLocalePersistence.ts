// FILE: desktopUiLocalePersistence.ts
// Purpose: Serializes desktop locale display updates and durable persistence.
// Layer: Desktop main-process helper
// Exports: DesktopUiLocalePersistenceCoordinator

import type { DesktopUiLocale } from "@synara/contracts";

interface DesktopUiLocalePersistenceOptions {
  initialLocale: DesktopUiLocale;
  onDisplayLocaleChange: (locale: DesktopUiLocale) => void;
  persistLocale: (locale: DesktopUiLocale) => Promise<void>;
}

/**
 * Applies display changes synchronously while keeping disk writes in request order.
 *
 * Every request is persisted, including requests for the currently displayed
 * locale. That lets a renderer retry a write that previously failed without
 * rebuilding the application menu when the visible locale did not change.
 */
export class DesktopUiLocalePersistenceCoordinator {
  readonly #onDisplayLocaleChange: (locale: DesktopUiLocale) => void;
  readonly #persistLocale: (locale: DesktopUiLocale) => Promise<void>;
  #displayLocale: DesktopUiLocale;
  #persistenceTail: Promise<void> = Promise.resolve();

  constructor(options: DesktopUiLocalePersistenceOptions) {
    this.#displayLocale = options.initialLocale;
    this.#onDisplayLocaleChange = options.onDisplayLocaleChange;
    this.#persistLocale = options.persistLocale;
  }

  update(locale: DesktopUiLocale): Promise<void> {
    if (this.#displayLocale !== locale) {
      this.#displayLocale = locale;
      this.#onDisplayLocaleChange(locale);
    }

    const persistence = this.#persistenceTail.then(() => this.#persistLocale(locale));
    this.#persistenceTail = persistence.catch(() => undefined);
    return persistence;
  }
}
