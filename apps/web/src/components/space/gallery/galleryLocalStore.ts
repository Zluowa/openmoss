// FILE: galleryLocalStore.ts
// Purpose: What the 资料空间 remembers on this device: tags and descriptions on pictures, saved
//          合集, and where cards were moved on the canvas.
// Layer: Web client state (zustand, persisted to localStorage)
// Why: Pages and 资料库 rows have no tag field yet. Until the stores grow one, tags a person
//      adds live here; a note's own #标签 are read from its text and need no storage.

import { create } from "zustand";

import { normalizeTag, type GalleryCollection } from "./galleryModel";

const STORAGE_KEY = "moss:space-gallery:v1";

interface Persisted {
  readonly tags: Readonly<Record<string, readonly string[]>>;
  readonly descriptions: Readonly<Record<string, string>>;
  readonly collections: readonly GalleryCollection[];
  /** Canvas position overrides: container key → item key → top-left corner. */
  readonly positions: Readonly<Record<string, Readonly<Record<string, { x: number; y: number }>>>>;
}

export interface GalleryLocalState extends Persisted {
  readonly addTag: (itemKey: string, tag: string) => void;
  readonly removeTag: (itemKey: string, tag: string) => void;
  readonly setDescription: (itemKey: string, text: string) => void;
  readonly saveCollection: (title: string, tags: readonly string[]) => GalleryCollection;
  readonly removeCollection: (id: string) => void;
  readonly moveOnCanvas: (container: string, itemKey: string, x: number, y: number) => void;
  readonly resetCanvas: (container: string) => void;
  /** Test and fixture seeding; replaces everything. */
  readonly replaceAll: (next: Partial<Persisted>) => void;
}

const EMPTY: Persisted = { tags: {}, descriptions: {}, collections: [], positions: {} };

function read(): Persisted {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      tags: parsed.tags ?? {},
      descriptions: parsed.descriptions ?? {},
      collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      positions: parsed.positions ?? {},
    };
  } catch {
    return EMPTY;
  }
}

function write(state: Persisted): void {
  try {
    const { tags, descriptions, collections, positions } = state;
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ tags, descriptions, collections, positions }),
    );
  } catch {
    // Private windows and full storage keep working for this visit only.
  }
}

export const useGalleryLocalStore = create<GalleryLocalState>((set, get) => {
  const update = (patch: Partial<Persisted>) => {
    set(patch);
    write(get());
  };
  return {
    ...read(),
    addTag: (itemKey, tag) => {
      const clean = normalizeTag(tag);
      if (!clean) return;
      const current = get().tags[itemKey] ?? [];
      if (current.includes(clean)) return;
      update({ tags: { ...get().tags, [itemKey]: [...current, clean] } });
    },
    removeTag: (itemKey, tag) => {
      const current = get().tags[itemKey] ?? [];
      update({ tags: { ...get().tags, [itemKey]: current.filter((entry) => entry !== tag) } });
    },
    setDescription: (itemKey, text) =>
      update({ descriptions: { ...get().descriptions, [itemKey]: text } }),
    saveCollection: (title, tags) => {
      const collection: GalleryCollection = {
        id: `collection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        title: title.trim() || tags.map((tag) => `#${tag}`).join(" "),
        tags: tags.map(normalizeTag),
      };
      update({ collections: [...get().collections, collection] });
      return collection;
    },
    removeCollection: (id) =>
      update({ collections: get().collections.filter((entry) => entry.id !== id) }),
    moveOnCanvas: (container, itemKey, x, y) =>
      update({
        positions: {
          ...get().positions,
          [container]: { ...get().positions[container], [itemKey]: { x, y } },
        },
      }),
    resetCanvas: (container) => {
      const { [container]: _removed, ...rest } = get().positions;
      update({ positions: rest });
    },
    replaceAll: (next) => update({ ...EMPTY, ...next }),
  };
});
