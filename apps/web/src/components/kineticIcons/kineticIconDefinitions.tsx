// FILE: kineticIconDefinitions.tsx
// Purpose: Pure 24x24 outline definitions and morph geometry specs for the 20 Moss Kinetic Icons (v25).
// Layer: Web UI kinetic icon registry
// Exports: MOSS_KINETIC_ICON_IDS, MossKineticIconId, KineticFrameGroup, KineticPathSpec, KineticIconSpec, KINETIC_ICON_SPECS, renderKineticIconBody

import type { ReactElement } from "react";

export const MOSS_KINETIC_ICON_IDS = [
  "reading",
  "book",
  "terminal",
  "search",
  "editing",
  "thinking",
  "mossbot",
  "skills",
  "plugins",
  "branch",
  "pull-request",
  "browser",
  "automations",
  "library",
  "images",
  "cloud-sync",
  "computer",
  "deep-research",
  "vision-scan",
  "navigate",
] as const;

export type MossKineticIconId = (typeof MOSS_KINETIC_ICON_IDS)[number];

export type KineticFrameGroup = "rect" | "square" | "circle" | "git" | "free";

export interface KineticPathSpec {
  readonly d: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
}

export interface KineticIconSpec {
  readonly id: MossKineticIconId;
  readonly frameGroup: KineticFrameGroup;
  readonly gitAnchorX?: number;
  readonly framePaths: readonly KineticPathSpec[];
  readonly innerPaths: readonly KineticPathSpec[];
}

export const KINETIC_ICON_SPECS: Readonly<Record<MossKineticIconId, KineticIconSpec>> = {
  reading: {
    id: "reading",
    frameGroup: "rect",
    framePaths: [
      {
        d: "M4.75 4.75C4.75 3.64543 5.64543 2.75 6.75 2.75H14.25L19.25 7.75V19.25C19.25 20.3546 18.3546 21.25 17.25 21.25H6.75C5.64543 21.25 4.75 20.3546 4.75 19.25V4.75Z",
      },
    ],
    innerPaths: [
      { d: "M14.25 2.75V6.25C14.25 7.07843 14.9216 7.75 15.75 7.75H19.25" },
      { d: "M8.25 10.75H15.75" },
      { d: "M8.25 14.25H15.75" },
      { d: "M8.25 17.75H12.25" },
    ],
  },
  book: {
    id: "book",
    frameGroup: "free",
    framePaths: [
      {
        d: "M12 7.75C12 6.09315 13.3431 4.75 15 4.75H20.75C21.5784 4.75 22.25 5.42157 22.25 6.25V17.75C22.25 18.5784 21.5784 19.25 20.75 19.25H15.277C14.5966 19.25 13.9296 19.4142 13.3508 19.7719C12.772 20.1296 12.3043 20.6414 12 21.25",
      },
      {
        d: "M12 7.75C12 6.09315 10.6569 4.75 9 4.75H3.25C2.42157 4.75 1.75 5.42157 1.75 6.25V17.75C1.75 18.5784 2.42157 19.25 3.25 19.25H8.723C9.40341 19.25 10.0704 19.4142 10.6492 19.7719C11.228 20.1296 11.6957 20.6414 12 21.25",
      },
    ],
    innerPaths: [{ d: "M12 7.75V21.25" }],
  },
  terminal: {
    id: "terminal",
    frameGroup: "square",
    framePaths: [
      {
        d: "M5.75 20.25H18.25C19.3546 20.25 20.25 19.3546 20.25 18.25V5.75C20.25 4.64543 19.3546 3.75 18.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V18.25C3.75 19.3546 4.64543 20.25 5.75 20.25Z",
      },
    ],
    innerPaths: [{ d: "M7.25 9.25L10 12L7.25 14.75" }, { d: "M11.75 14.75H16.75" }],
  },
  search: {
    id: "search",
    frameGroup: "free",
    framePaths: [
      {
        d: "M18.25 11C18.25 15.0041 15.0041 18.25 11 18.25C6.99594 18.25 3.75 15.0041 3.75 11C3.75 6.99594 6.99594 3.75 11 3.75C15.0041 3.75 18.25 6.99594 18.25 11Z",
      },
    ],
    innerPaths: [{ d: "M20.25 20.25L16.1265 16.1265" }],
  },
  editing: {
    id: "editing",
    frameGroup: "free",
    framePaths: [{ d: "M3.75 19.25H6.5L16.35 9.4A1.95 1.95 0 0 0 13.6 6.65L3.75 16.5V19.25Z" }],
    innerPaths: [{ d: "M11.8 8.45L14.55 11.2" }, { d: "M3.75 20.25H19.25" }],
  },
  thinking: {
    id: "thinking",
    frameGroup: "free",
    framePaths: [
      {
        d: "M4.45 2.75H9.85A1.25 1.25 0 0 1 11.1 4V9.5A0.7 0.7 0 0 1 9.9 10L3.95 4.05A0.75 0.75 0 0 1 4.45 2.75Z",
      },
      {
        d: "M21.25 4.45V9.85A1.25 1.25 0 0 1 20 11.1H14.5A0.7 0.7 0 0 1 14 9.9L19.95 3.95A0.75 0.75 0 0 1 21.25 4.45Z",
      },
      {
        d: "M19.55 21.25H14.15A1.25 1.25 0 0 1 12.9 20V14.5A0.7 0.7 0 0 1 14.1 14L20.05 19.95A0.75 0.75 0 0 1 19.55 21.25Z",
      },
      {
        d: "M2.75 19.55V14.15A1.25 1.25 0 0 1 4 12.9H9.5A0.7 0.7 0 0 1 10 14.1L4.05 20.05A0.75 0.75 0 0 1 2.75 19.55Z",
      },
    ],
    innerPaths: [],
  },
  mossbot: {
    id: "mossbot",
    frameGroup: "circle",
    framePaths: [
      {
        d: "M20.75 12C20.75 16.8325 16.8325 20.75 12 20.75C7.16751 20.75 3.25 16.8325 3.25 12C3.25 7.16751 7.16751 3.25 12 3.25H17.25C19.183 3.25 20.75 4.817 20.75 6.75V12Z",
      },
    ],
    innerPaths: [{ d: "M10 10.75V13.25" }, { d: "M14 10.75V13.25" }],
  },
  skills: {
    id: "skills",
    frameGroup: "free",
    framePaths: [
      {
        d: "M11.47 4.04Q12 3.75 12.53 4.04L18.72 7.46Q19.25 7.75 19.25 8.35V15.65Q19.25 16.25 18.72 16.54L12.53 19.96Q12 20.25 11.47 19.96L5.28 16.54Q4.75 16.25 4.75 15.65V8.35Q4.75 7.75 5.28 7.46Z",
      },
    ],
    innerPaths: [{ d: "M4.75 7.75L12 11.75L19.25 7.75" }, { d: "M12 11.75V20.25" }],
  },
  plugins: {
    id: "plugins",
    frameGroup: "free",
    framePaths: [
      { d: "M7.25 11.75L5.25 13.75A3.54 3.54 0 0 0 10.25 18.75L12.25 16.75Z" },
      { d: "M16.75 12.25L18.75 10.25A3.54 3.54 0 0 0 13.75 5.25L11.75 7.25Z" },
    ],
    innerPaths: [
      { d: "M3.25 20.75L5.25 18.75" },
      { d: "M20.75 3.25L18.75 5.25" },
      { d: "M8.35 12.85L10.6 10.6" },
      { d: "M11.15 15.65L13.4 13.4" },
    ],
  },
  branch: {
    id: "branch",
    frameGroup: "git",
    gitAnchorX: 6.5,
    framePaths: [
      { d: "M6.5 8.25V15.75" },
      { d: "M8.75 6A2.25 2.25 0 1 1 4.25 6A2.25 2.25 0 1 1 8.75 6Z" },
      { d: "M8.75 18A2.25 2.25 0 1 1 4.25 18A2.25 2.25 0 1 1 8.75 18Z" },
    ],
    innerPaths: [
      { d: "M6.5 14.25C6.5 13 7.4 12 8.5 12H15.5C16.6046 12 17.5 11.1046 17.5 10V8.25" },
      { d: "M19.75 6A2.25 2.25 0 1 1 15.25 6A2.25 2.25 0 1 1 19.75 6Z" },
    ],
  },
  "pull-request": {
    id: "pull-request",
    frameGroup: "git",
    gitAnchorX: 6,
    framePaths: [
      { d: "M6 8.25V15.75" },
      { d: "M8.25 6A2.25 2.25 0 1 1 3.75 6A2.25 2.25 0 1 1 8.25 6Z" },
      { d: "M8.25 18A2.25 2.25 0 1 1 3.75 18A2.25 2.25 0 1 1 8.25 18Z" },
    ],
    innerPaths: [
      { d: "M18 15.75V8C18 6.89543 17.1046 6 16 6H11.75" },
      { d: "M14 3.75L11.75 6L14 8.25" },
      { d: "M20.25 18A2.25 2.25 0 1 1 15.75 18A2.25 2.25 0 1 1 20.25 18Z" },
    ],
  },
  browser: {
    id: "browser",
    frameGroup: "circle",
    framePaths: [
      {
        d: "M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12Z",
      },
    ],
    innerPaths: [
      { d: "M21 12H3" },
      { d: "M12 2.75C16.8 2.75 16.8 21.25 12 21.25" },
      { d: "M12 2.75C7.2 2.75 7.2 21.25 12 21.25" },
    ],
  },
  automations: {
    id: "automations",
    frameGroup: "circle",
    framePaths: [
      {
        d: "M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12Z",
      },
    ],
    innerPaths: [
      { d: "M12 4.6V5.15", strokeWidth: 1.35 },
      { d: "M19.4 12H18.85", strokeWidth: 1.35 },
      { d: "M12 19.4V18.85", strokeWidth: 1.35 },
      { d: "M4.6 12H5.15", strokeWidth: 1.35 },
      { d: "M12 7V12" },
      { d: "M12 12L14.25 13.75" },
    ],
  },
  library: {
    id: "library",
    frameGroup: "rect",
    framePaths: [
      {
        d: "M9.13202 4.25H4.75C3.64543 4.25 2.75 5.14543 2.75 6.25V17.75C2.75 18.8546 3.64543 19.75 4.75 19.75H19.25C20.3546 19.75 21.25 18.8546 21.25 17.75V8.25C21.25 7.14543 20.3546 6.25 19.25 6.25H12.8124C12.2915 6.25 11.7911 6.04674 11.4177 5.68345L10.5267 4.81655C10.1534 4.45326 9.65297 4.25 9.13202 4.25Z",
      },
    ],
    innerPaths: [
      {
        d: "M2.75 13.25V12.25C2.75 11.1454 3.64543 10.25 4.75 10.25H19.25C20.3546 10.25 21.25 11.1454 21.25 12.25V13.25",
      },
    ],
  },
  images: {
    id: "images",
    frameGroup: "square",
    framePaths: [
      {
        d: "M5.75 20.25H18.25C19.3546 20.25 20.25 19.3546 20.25 18.25V5.75C20.25 4.64543 19.3546 3.75 18.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V18.25C3.75 19.3546 4.64543 20.25 5.75 20.25Z",
      },
    ],
    innerPaths: [
      {
        d: "M3.75 14.25L6.84488 12.0821C7.66137 11.5378 8.75215 11.6663 9.41987 12.3853C10.9123 13.9926 12.6426 15.4538 15 15.4538C17.1727 15.4538 18.6125 14.6485 20.25 13.25",
      },
      { d: "M17.25 8.75A2 2 0 1 1 13.25 8.75A2 2 0 1 1 17.25 8.75Z" },
    ],
  },
  "cloud-sync": {
    id: "cloud-sync",
    frameGroup: "free",
    framePaths: [
      {
        d: "M5.5 17.25C3.55 17.25 2.25 15.65 2.25 13.75C2.25 11.75 3.75 10.1 5.75 9.85C6.55 6.85 9.0 4.75 12.0 4.75C15.25 4.75 17.9 7.15 18.25 10.35C20.2 10.65 21.75 12.15 21.75 14C21.75 15.95 20.3 17.25 18.5 17.25",
      },
    ],
    innerPaths: [
      { d: "M9 19.25V12.25" },
      { d: "M7.5 13.75L9 12.25L10.5 13.75" },
      { d: "M15 12.25V19.25" },
      { d: "M13.5 17.75L15 19.25L16.5 17.75" },
    ],
  },
  computer: {
    id: "computer",
    frameGroup: "free",
    framePaths: [
      {
        d: "M7.65 6.4L18.2 10.95Q18.95 11.25 18.2 11.55L13.75 13.45L11.85 18.0Q11.55 18.75 11.25 18.0L7.55 6.7Q7.4 6.3 7.65 6.4Z",
      },
    ],
    innerPaths: [],
  },
  "deep-research": {
    id: "deep-research",
    frameGroup: "free",
    framePaths: [
      { d: "M13.75 14A1.75 1.75 0 1 1 10.25 14A1.75 1.75 0 1 1 13.75 14Z" },
      { d: "M11.1 15.45Q8.9 17.25 7.5 20.25" },
      { d: "M12.9 15.45Q15.1 17.25 16.5 20.25" },
    ],
    innerPaths: [
      { d: "M9.24 9.18L4.6 11.3Q3.95 11.6 4.23 12.3L4.45 12.85Q4.72 13.55 5.42 13.3L10.27 11.73" },
      { d: "M8.78 8.02L14.34 5.77L16.21 10.41L10.65 12.66Z" },
    ],
  },
  "vision-scan": {
    id: "vision-scan",
    frameGroup: "free",
    framePaths: [
      { d: "M8.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V8.25" },
      { d: "M15.75 3.75H18.25C19.3546 3.75 20.25 4.64543 20.25 5.75V8.25" },
      { d: "M20.25 15.75V18.25C20.25 19.3546 19.3546 20.25 18.25 20.25H15.75" },
      { d: "M8.25 20.25H5.75C4.64543 20.25 3.75 19.3546 3.75 18.25V15.75" },
    ],
    innerPaths: [
      { d: "M6.5 16.5L10.25 12.25L13.25 15L15.25 13.25L17.5 16.5" },
      { d: "M16.75 8.75A1.5 1.5 0 1 1 13.75 8.75A1.5 1.5 0 1 1 16.75 8.75Z" },
    ],
  },
  navigate: {
    id: "navigate",
    frameGroup: "free",
    framePaths: [
      {
        d: "M12.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V18.25C3.75 19.3546 4.64543 20.25 5.75 20.25H18.25C19.3546 20.25 20.25 19.3546 20.25 18.25V11.75",
      },
    ],
    innerPaths: [{ d: "M10.75 13.25L19.25 4.75" }, { d: "M13.25 5.25L19.25 4.75L18.75 10.75" }],
  },
};

export function renderKineticIconBody(name: MossKineticIconId, clipPrefix: string): ReactElement {
  switch (name) {
    case "reading":
      return (
        <>
          <path d="M4.75 4.75C4.75 3.64543 5.64543 2.75 6.75 2.75H14.25L19.25 7.75V19.25C19.25 20.3546 18.3546 21.25 17.25 21.25H6.75C5.64543 21.25 4.75 20.3546 4.75 19.25V4.75Z" />
          <path
            className="rd-fold"
            d="M14.25 2.75V6.25C14.25 7.07843 14.9216 7.75 15.75 7.75H19.25"
          />
          <path className="rd-base" d="M8.25 10.75H15.75" />
          <path className="rd-base" d="M8.25 14.25H15.75" />
          <path className="rd-base" d="M8.25 17.75H12.25" />
          <path className="rd-sweep rd-l1" d="M8.25 10.75H15.75" />
          <path className="rd-sweep rd-l2" d="M8.25 14.25H15.75" />
          <path className="rd-sweep rd-l3" d="M8.25 17.75H12.25" />
        </>
      );
    case "book":
      return (
        <>
          <g className="book-cradle">
            <path d="M12 7.75C12 6.09315 13.3431 4.75 15 4.75H20.75C21.5784 4.75 22.25 5.42157 22.25 6.25V17.75C22.25 18.5784 21.5784 19.25 20.75 19.25H15.277C14.5966 19.25 13.9296 19.4142 13.3508 19.7719C12.772 20.1296 12.3043 20.6414 12 21.25" />
            <path d="M12 7.75C12 6.09315 10.6569 4.75 9 4.75H3.25C2.42157 4.75 1.75 5.42157 1.75 6.25V17.75C1.75 18.5784 2.42157 19.25 3.25 19.25H8.723C9.40341 19.25 10.0704 19.4142 10.6492 19.7719C11.228 20.1296 11.6957 20.6414 12 21.25" />
            <path d="M12 7.75V21.25" />
          </g>
          <path
            className="book-leaf book-leaf-a"
            d="M 12 7.75 C 12.6 5.8 14.8 5.25 20.75 5.25 L 20.75 18.75 C 14.8 18.75 12.6 19.4 12 21.25"
          />
          <path
            className="book-leaf book-leaf-b"
            d="M 12 7.75 C 12.6 5.8 14.8 5.25 20.75 5.25 L 20.75 18.75 C 14.8 18.75 12.6 19.4 12 21.25"
          />
        </>
      );
    case "terminal": {
      const cid = `${clipPrefix}-term`;
      return (
        <>
          <defs>
            <clipPath id={cid}>
              <rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1.15" />
            </clipPath>
          </defs>
          <path d="M5.75 20.25H18.25C19.3546 20.25 20.25 19.3546 20.25 18.25V5.75C20.25 4.64543 19.3546 3.75 18.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V18.25C3.75 19.3546 4.64543 20.25 5.75 20.25Z" />
          <g clipPath={`url(#${cid})`}>
            <g className="term-prompt-group">
              <path className="term-prompt" d="M7.25 9.25L10 12L7.25 14.75" />
              <path className="term-cursor" d="M11.75 14.75H16.75" />
            </g>
            <g className="term-output-group">
              <path className="term-out-1" d="M7.25 8.75H13.75" />
              <path className="term-out-2" d="M7.25 12H16.75" />
              <path className="term-out-3" d="M7.25 15.25H12.25" />
              <path className="term-out-cursor" d="M14.25 15.25H16.25" />
            </g>
          </g>
        </>
      );
    }
    case "search":
      return (
        <g className="search-rig">
          <path d="M18.25 11C18.25 15.0041 15.0041 18.25 11 18.25C6.99594 18.25 3.75 15.0041 3.75 11C3.75 6.99594 6.99594 3.75 11 3.75C15.0041 3.75 18.25 6.99594 18.25 11Z" />
          <path d="M20.25 20.25L16.1265 16.1265" />
          <path className="search-glint" d="M7.75 9.25C8.35 7.95 9.55 7.15 11 7.15" />
        </g>
      );
    case "editing":
      return (
        <>
          <path className="edit-ink-base" d="M3.75 20.25H19.25" />
          <path className="edit-ink-draw" d="M3.75 20.25H9.75" />
          <g className="edit-pencil">
            <path d="M3.75 19.25H6.5L16.35 9.4A1.95 1.95 0 0 0 13.6 6.65L3.75 16.5V19.25Z" />
            <path d="M11.8 8.45L14.55 11.2" />
          </g>
        </>
      );
    case "thinking":
      return (
        <g className="think-wheel">
          <path
            className="think-b1"
            d="M4.45 2.75H9.85A1.25 1.25 0 0 1 11.1 4V9.5A0.7 0.7 0 0 1 9.9 10L3.95 4.05A0.75 0.75 0 0 1 4.45 2.75Z"
          />
          <path
            className="think-b2"
            d="M21.25 4.45V9.85A1.25 1.25 0 0 1 20 11.1H14.5A0.7 0.7 0 0 1 14 9.9L19.95 3.95A0.75 0.75 0 0 1 21.25 4.45Z"
          />
          <path
            className="think-b3"
            d="M19.55 21.25H14.15A1.25 1.25 0 0 1 12.9 20V14.5A0.7 0.7 0 0 1 14.1 14L20.05 19.95A0.75 0.75 0 0 1 19.55 21.25Z"
          />
          <path
            className="think-b4"
            d="M2.75 19.55V14.15A1.25 1.25 0 0 1 4 12.9H9.5A0.7 0.7 0 0 1 10 14.1L4.05 20.05A0.75 0.75 0 0 1 2.75 19.55Z"
          />
        </g>
      );
    case "mossbot":
      return (
        <g className="bot-head">
          <path d="M20.75 12C20.75 16.8325 16.8325 20.75 12 20.75C7.16751 20.75 3.25 16.8325 3.25 12C3.25 7.16751 7.16751 3.25 12 3.25H17.25C19.183 3.25 20.75 4.817 20.75 6.75V12Z" />
          <g className="bot-eyes-shift">
            <g className="bot-eyes-blink">
              <path d="M10 10.75V13.25" />
              <path d="M14 10.75V13.25" />
            </g>
          </g>
        </g>
      );
    case "skills":
      return (
        <>
          <g className="skills-base">
            <path d="M4.75 7.75V15.65Q4.75 16.25 5.28 16.54L11.47 19.96Q12 20.25 12.53 19.96L18.72 16.54Q19.25 16.25 19.25 15.65V7.75" />
            <path d="M12 11.75V20.25" />
            <path className="skills-seat" d="M4.75 7.75L12 11.75L19.25 7.75" />
          </g>
          <path
            className="skills-cap"
            d="M11.47 4.04Q12 3.75 12.53 4.04L18.72 7.46Q19.25 7.75 18.72 8.04L12.53 11.46Q12 11.75 11.47 11.46L5.28 8.04Q4.75 7.75 5.28 7.46Z"
          />
        </>
      );
    case "plugins":
      return (
        <g className="plugin-rig">
          <g className="plugin-plug">
            <path d="M3.25 20.75L5.25 18.75" />
            <path d="M7.25 11.75L5.25 13.75A3.54 3.54 0 0 0 10.25 18.75L12.25 16.75Z" />
            <path className="plugin-prong" d="M8.35 12.85L10.6 10.6" />
            <path className="plugin-prong" d="M11.15 15.65L13.4 13.4" />
          </g>
          <g className="plugin-socket">
            <path d="M20.75 3.25L18.75 5.25" />
            <path d="M16.75 12.25L18.75 10.25A3.54 3.54 0 0 0 13.75 5.25L11.75 7.25Z" />
          </g>
        </g>
      );
    case "branch":
      return (
        <>
          <path d="M6.5 8.25V15.75" />
          <circle cx="6.5" cy="6" r="2.25" />
          <circle cx="6.5" cy="18" r="2.25" />
          <path
            className="branch-ghost"
            d="M6.5 14.25C6.5 13 7.4 12 8.5 12H15.5C16.6046 12 17.5 11.1046 17.5 10V8.25"
          />
          <path
            className="branch-trace"
            d="M6.5 14.25C6.5 13 7.4 12 8.5 12H15.5C16.6046 12 17.5 11.1046 17.5 10V8.25"
          />
          <circle className="branch-node" cx="17.5" cy="6" r="2.25" />
        </>
      );
    case "pull-request":
      return (
        <>
          <path d="M6 8.25V15.75" />
          <circle className="pr-target-node" cx="6" cy="6" r="2.25" />
          <circle cx="6" cy="18" r="2.25" />
          <circle cx="18" cy="18" r="2.25" />
          <path className="pr-ghost" d="M18 15.75V8C18 6.89543 17.1046 6 16 6H11.75" />
          <path className="pr-trace" d="M18 15.75V8C18 6.89543 17.1046 6 16 6H11.75" />
          <g className="pr-arrow">
            <path d="M12.75 6H11.75" />
            <path d="M14 3.75L11.75 6L14 8.25" />
          </g>
        </>
      );
    case "browser":
      return (
        <>
          <path d="M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12Z" />
          <path d="M21 12H3" />
          <path className="globe-meridian globe-m-a" d="M12 2.75C16.8 2.75 16.8 21.25 12 21.25" />
          <path className="globe-meridian globe-m-b" d="M12 2.75C7.2 2.75 7.2 21.25 12 21.25" />
          <path className="globe-meridian globe-m-c" d="M12 2.75C24.0 2.75 24.0 21.25 12 21.25" />
        </>
      );
    case "automations":
      return (
        <>
          <path d="M21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12Z" />
          <path className="clock-pip clock-pip-12" strokeWidth={1.35} d="M12 4.6V5.15" />
          <path className="clock-pip clock-pip-3" strokeWidth={1.35} d="M19.4 12H18.85" />
          <path className="clock-pip clock-pip-6" strokeWidth={1.35} d="M12 19.4V18.85" />
          <path className="clock-pip clock-pip-9" strokeWidth={1.35} d="M4.6 12H5.15" />
          <path className="clock-minute" d="M12 7V12" />
          <path className="clock-hour" d="M12 12L14.25 13.75" />
        </>
      );
    case "library": {
      const cid = `${clipPrefix}-lib`;
      return (
        <>
          <defs>
            <clipPath id={cid}>
              <rect x="4" y="6.85" width="16" height="4.3" />
            </clipPath>
          </defs>
          <path d="M9.13202 4.25H4.75C3.64543 4.25 2.75 5.14543 2.75 6.25V17.75C2.75 18.8546 3.64543 19.75 4.75 19.75H19.25C20.3546 19.75 21.25 18.8546 21.25 17.75V8.25C21.25 7.14543 20.3546 6.25 19.25 6.25H12.8124C12.2915 6.25 11.7911 6.04674 11.4177 5.68345L10.5267 4.81655C10.1534 4.45326 9.65297 4.25 9.13202 4.25Z" />
          <g clipPath={`url(#${cid})`}>
            <g className="folder-card">
              <path d="M6.75 12.25V9.5A1.25 1.25 0 0 1 8 8.25H16A1.25 1.25 0 0 1 17.25 9.5V12.25" />
              <path className="folder-card-line" strokeWidth={1.35} d="M9.5 10.1H14.5" />
            </g>
          </g>
          <path
            className="folder-front"
            d="M2.75 13.25V12.25C2.75 11.1454 3.64543 10.25 4.75 10.25H19.25C20.3546 10.25 21.25 11.1454 21.25 12.25V13.25"
          />
        </>
      );
    }
    case "images": {
      const cid = `${clipPrefix}-img`;
      return (
        <>
          <defs>
            <clipPath id={cid}>
              <path d="M3.75 3.75H20.25V13.25C18.6125 14.6485 17.1727 15.4538 15 15.4538C12.6426 15.4538 10.9123 13.9926 9.41987 12.3853C8.75215 11.6663 7.66137 11.5378 6.84488 12.0821L3.75 14.25Z" />
            </clipPath>
          </defs>
          <path d="M5.75 20.25H18.25C19.3546 20.25 20.25 19.3546 20.25 18.25V5.75C20.25 4.64543 19.3546 3.75 18.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V18.25C3.75 19.3546 4.64543 20.25 5.75 20.25Z" />
          <g clipPath={`url(#${cid})`}>
            <circle className="img-sun" cx="15.25" cy="8.75" r="2" />
            <path
              className="img-moon"
              d="M15.65 6.45A2.35 2.35 0 1 0 17.25 9.65Q13.5 8.8 15.65 6.45Z"
            />
            <path
              className="img-star"
              strokeWidth={1.35}
              d="M8.5 5.85Q8.5 7.45 10.1 7.45Q8.5 7.45 8.5 9.05Q8.5 7.45 6.9 7.45Q8.5 7.45 8.5 5.85Z"
            />
            <path className="img-star-2" strokeWidth={1.35} d="M11.6 6.2V6.6" />
          </g>
          <path
            className="img-wave"
            d="M3.75 14.25L6.84488 12.0821C7.66137 11.5378 8.75215 11.6663 9.41987 12.3853C10.9123 13.9926 12.6426 15.4538 15 15.4538C17.1727 15.4538 18.6125 14.6485 20.25 13.25"
          />
        </>
      );
    }
    case "cloud-sync": {
      const cid = `${clipPrefix}-cloud`;
      return (
        <>
          <defs>
            <clipPath id={cid}>
              <rect x="6" y="10.8" width="12" height="9.7" />
            </clipPath>
          </defs>
          <path
            className="cloud-shell"
            d="M5.5 17.25C3.55 17.25 2.25 15.65 2.25 13.75C2.25 11.75 3.75 10.1 5.75 9.85C6.55 6.85 9.0 4.75 12.0 4.75C15.25 4.75 17.9 7.15 18.25 10.35C20.2 10.65 21.75 12.15 21.75 14C21.75 15.95 20.3 17.25 18.5 17.25"
          />
          <g clipPath={`url(#${cid})`}>
            <g className="cloud-up">
              <path d="M9 19.25V12.25" />
              <path d="M7.5 13.75L9 12.25L10.5 13.75" />
            </g>
            <g className="cloud-up-echo">
              <path d="M9 19.25V12.25" />
              <path d="M7.5 13.75L9 12.25L10.5 13.75" />
            </g>
            <g className="cloud-down">
              <path d="M15 12.25V19.25" />
              <path d="M13.5 17.75L15 19.25L16.5 17.75" />
            </g>
            <g className="cloud-down-echo">
              <path d="M15 12.25V19.25" />
              <path d="M13.5 17.75L15 19.25L16.5 17.75" />
            </g>
          </g>
        </>
      );
    }
    case "computer":
      return (
        <>
          <circle className="comp-target" strokeWidth={1.35} cx="7.5" cy="6.25" r="1.35" />
          <circle className="comp-ripple" cx="7.5" cy="6.25" r="2.35" />
          <g className="comp-sparks">
            <path d="M5.25 4.0L4.1 2.85" />
            <path d="M9.75 4.0L10.9 2.85" />
            <path d="M5.25 8.5L4.1 9.65" />
            <path d="M9.75 8.5L10.9 9.65" />
          </g>
          <g className="comp-cursor">
            <path d="M7.65 6.4L18.2 10.95Q18.95 11.25 18.2 11.55L13.75 13.45L11.85 18.0Q11.55 18.75 11.25 18.0L7.55 6.7Q7.4 6.3 7.65 6.4Z" />
          </g>
        </>
      );
    case "deep-research":
      return (
        <>
          <path d="M13.75 14A1.75 1.75 0 1 1 10.25 14A1.75 1.75 0 1 1 13.75 14Z" />
          <path d="M11.1 15.45Q8.9 17.25 7.5 20.25" />
          <path d="M12.9 15.45Q15.1 17.25 16.5 20.25" />
          <g className="scope-rig">
            <path d="M11.25 8.5H5.75Q5 8.5 5 9.25V10.5Q5 11.25 5.75 11.25H11.25" />
            <path className="scope-sleeve" d="M11.25 8.85H13.15M11.25 10.9H13.15" />
            <g className="scope-hood">
              <path d="M11.25 7.25H16.5Q17.25 7.25 17.25 8V11.5Q17.25 12.25 16.5 12.25H11.25Z" />
            </g>
          </g>
          <path
            className="scope-star"
            strokeWidth={1.35}
            d="M19 4.25Q19 6 20.75 6Q19 6 19 7.75Q19 6 17.25 6Q19 6 19 4.25Z"
          />
        </>
      );
    case "vision-scan": {
      const cidLand = `${clipPrefix}-scan-land`;
      const cidGrid = `${clipPrefix}-scan-grid`;
      return (
        <>
          <defs>
            <clipPath id={cidLand}>
              <rect className="scan-clip-land" x="4" y="4" width="16" height="16" />
            </clipPath>
            <clipPath id={cidGrid}>
              <rect className="scan-clip-grid" x="20" y="4" width="16" height="16" />
            </clipPath>
          </defs>
          <path className="scan-tl" d="M8.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V8.25" />
          <path
            className="scan-tr"
            d="M15.75 3.75H18.25C19.3546 3.75 20.25 4.64543 20.25 5.75V8.25"
          />
          <path
            className="scan-br"
            d="M20.25 15.75V18.25C20.25 19.3546 19.3546 20.25 18.25 20.25H15.75"
          />
          <path
            className="scan-bl"
            d="M8.25 20.25H5.75C4.64543 20.25 3.75 19.3546 3.75 18.25V15.75"
          />
          <g clipPath={`url(#${cidLand})`}>
            <path d="M6.5 16.5L10.25 12.25L13.25 15L15.25 13.25L17.5 16.5" />
            <circle cx="15.25" cy="8.75" r="1.5" />
          </g>
          <g className="scan-lattice" clipPath={`url(#${cidGrid})`}>
            <rect x="7.48" y="7.48" width="1.35" height="1.35" rx="0.45" />
            <rect x="15.18" y="7.48" width="1.35" height="1.35" rx="0.45" />
            <rect x="11.32" y="11.32" width="1.35" height="1.35" rx="0.45" />
            <rect x="7.48" y="15.18" width="1.35" height="1.35" rx="0.45" />
            <rect x="15.18" y="15.18" width="1.35" height="1.35" rx="0.45" />
            <path strokeWidth={1.35} d="M12 7.9V8.4M7.9 12H8.4M15.6 12H16.1M12 15.6V16.1" />
          </g>
          <path className="scan-bar" d="M20 3.75V20.25" />
        </>
      );
    }
    case "navigate": {
      const cid = `${clipPrefix}-nav`;
      return (
        <>
          <defs>
            <clipPath id={cid}>
              <rect x="7" y="2" width="15" height="15" rx="2" />
            </clipPath>
          </defs>
          <path
            className="nav-frame"
            d="M12.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V18.25C3.75 19.3546 4.64543 20.25 5.75 20.25H18.25C19.3546 20.25 20.25 19.3546 20.25 18.25V11.75"
          />
          <g clipPath={`url(#${cid})`}>
            <g className="nav-dart-main">
              <path d="M10.75 13.25L19.25 4.75" />
              <path d="M13.25 5.25L19.25 4.75L18.75 10.75" />
            </g>
            <g className="nav-dart-relay">
              <path d="M10.75 13.25L19.25 4.75" />
              <path d="M13.25 5.25L19.25 4.75L18.75 10.75" />
            </g>
          </g>
        </>
      );
    }
  }
}
