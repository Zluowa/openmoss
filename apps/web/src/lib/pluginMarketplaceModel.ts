// FILE: pluginMarketplaceModel.ts
// Purpose: Normalize the add-plugin-marketplace form into the native mutation shape.
// Layer: Web domain model
// Exports: form/input types and normalizePluginMarketplaceForm

export interface PluginMarketplaceFormValue {
  readonly source: string;
  readonly refName: string;
  readonly sparsePaths: string;
}

export interface PluginMarketplaceAddParams {
  readonly source: string;
  readonly refName: string | null;
  readonly sparsePaths: readonly string[] | null;
}

export type PluginMarketplaceFormResult =
  | { readonly ok: false; readonly field: "source" }
  | { readonly ok: true; readonly value: PluginMarketplaceAddParams };

export function normalizePluginMarketplaceForm(
  form: PluginMarketplaceFormValue,
): PluginMarketplaceFormResult {
  const source = form.source.trim();
  if (source.length === 0) return { ok: false, field: "source" };

  const refName = form.refName.trim();
  const sparsePaths = form.sparsePaths
    .split(/[\n,]+/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  return {
    ok: true,
    value: {
      source,
      refName: refName.length > 0 ? refName : null,
      sparsePaths: sparsePaths.length > 0 ? sparsePaths : null,
    },
  };
}
