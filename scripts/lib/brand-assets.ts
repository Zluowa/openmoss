export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "apps/desktop/resources/icon.png",
  productionMacLegacyIconPng: "apps/desktop/resources/icon.png",
  productionLinuxIconPng: "apps/desktop/resources/icon.png",
  productionWindowsIconIco: "apps/desktop/resources/icon.ico",
  productionWebFaviconIco: "apps/web/public/favicon.ico",
  productionWebFavicon16Png: "apps/web/public/favicon-16x16.png",
  productionWebFavicon32Png: "apps/web/public/favicon-32x32.png",
  productionWebAppleTouchIconPng: "apps/web/public/apple-touch-icon.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export const BETA_ASSET_PATHS = {
  betaMacIconPng: "assets/beta/beta-macos-1024.png",
  // Icon Composer source for the beta macOS 26 bundle icon: same layered
  // treatment as production so beta gets Liquid Glass on the dock.
  betaMacIconComposer: "assets/beta/Moss.icon",
  betaMacLegacyIconPng: "assets/beta/beta-macos-legacy-1024.png",
  // One artwork serves both appearances: the dark dock slot reuses the rounded legacy file.
  betaMacLegacyDarkIconPng: "assets/beta/beta-macos-legacy-1024.png",
  betaLinuxIconPng: "assets/beta/beta-universal-1024.png",
  betaWindowsIconIco: "assets/beta/beta-windows.ico",
  betaWebFaviconIco: "assets/beta/beta-web-favicon.ico",
  betaWebFavicon16Png: "assets/beta/beta-web-favicon-16x16.png",
  betaWebFavicon32Png: "assets/beta/beta-web-favicon-32x32.png",
  betaWebAppleTouchIconPng: "assets/beta/beta-web-apple-touch-180.png",
} as const;

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export const DEVELOPMENT_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

export const PUBLISH_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];
