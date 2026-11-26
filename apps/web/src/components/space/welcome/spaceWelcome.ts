// FILE: spaceWelcome.ts
// Purpose: What a person finds in an empty 资料空间. On the home, a 欢迎 note with things to
//          try. Beside it, 「苔」: a small book about moss in the making — five classical poems
//          on moss, each set beside a photograph made for it, a three-panel 空山返照 that the
//          grid joins back into one picture, the book's notes, colour, specimens, proofs and
//          poster, its exhibition deck and its print budget. Moss is 苔: the samples are the
//          brand's own idea, slow things growing, told in the space's own cards.
// Layer: Space UI (first run)
// Why: An empty space teaches nothing. Seeded once per account on this device, and only when
//      the space holds nothing at all, trash included, so nobody's own things are touched.

import type {
  LibraryImportResult,
  LibraryItem,
  NativeApi,
  Page,
  PageSpace,
  PageSpaceId,
  SpaceId,
  SpaceOutput,
} from "@moss/contracts";
import { deckFromOutline } from "@moss/shared/spaceItems/deckOps";
import type { SheetCell, SheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";

import type { LibraryUploadFile } from "~/lib/libraryUpload";
import type { SpacePageApp } from "~/lib/spacePageApps";

import { createSpaceItem } from "../../spaceTypes/spaceItemTypes";

/** The folder the samples live in: a 资料空间 and the 资料库 folder of the same name. */
export const WELCOME_FOLDER_TITLE = "苔";

interface WelcomeNote {
  readonly title: string;
  readonly content: string;
}

/** Stands on the home beside the folder: the first thing a person reads. */
const WELCOME_NOTE: WelcomeNote = {
  title: "欢迎来到资料空间",
  content: [
    "资料空间是你和智能体共用的地方。笔记、图片、幻灯片、表格放在一起，彼此照应，谁都找得到。",
    "",
    "旁边的「苔」是一本正在做的小书，随手翻一翻。",
    "",
    "### 先试试这几件事",
    "- [x] 打开资料空间",
    "- [ ] 按 ⌘K，输入「苔」，看诗和图一起出来",
    "- [ ] 打开一张图，在右边给它加个标签",
    "- [ ] 右上角切到「画布」，把这本书摊开在墙上",
    "- [ ] 在对话里说：「读一读《苔》，帮我把展览提案补完整」",
    "",
    "### 几个小规则",
    "- 在笔记里写 #标签，它会出现在左边的「标签」里",
    "- 资料库里和资料空间同名的文件夹，会合在一起显示",
    "- 用不着这些示例了？把「苔」和这一页移到回收站就好",
    "",
    "#入门",
  ].join("\n"),
};

/** A poem as a note: one couplet per line, then who wrote it. */
const poem = (title: string, couplets: readonly string[], by: string): WelcomeNote => ({
  title,
  content: [...couplets, `—— ${by}`].join("\n\n"),
});

const NOTES = {
  book: {
    title: "苔：一本关于慢的小书",
    content: [
      "### 为什么是苔",
      "苔不开我们以为的那种花。它长在白日照不到的地方，一年只长几毫米，却能把一整块石头慢慢变成绿色。",
      "做这本书，是想把注意力放回那些很小、很慢、但一直在生长的东西上。",
      "",
      "### 五章，五首诗",
      "- 光 · 返景入深林，复照青苔上",
      "- 阶 · 苔痕上阶绿，草色入帘青",
      "- 花 · 苔花如米小，也学牡丹开",
      "- 衣 · 坐看苍苔色，欲上人衣来",
      "- 门 · 应怜屐齿印苍苔",
      "",
      "### 设计上的几个决定",
      "- 每章一张大图、一首诗，不加说明",
      "- 正文只用一种字体、两种字重",
      "- 颜色只取苔的五种绿，其余留白",
      "- 用略带纤维的米白纸，让绿色显得湿润",
      "",
      "### 接下来",
      "- [x] 选定五首诗",
      "- [x] 拍完五章的照片",
      "- [ ] 打一份样张，看纸和绿色",
      "- [ ] 把展览提案带去书店聊一聊",
      "",
      "#苔 #书籍设计",
    ].join("\n"),
  },
  light: poem("鹿柴", ["空山不见人，但闻人语响。", "返景入深林，复照青苔上。"], "唐 · 王维"),
  steps: poem(
    "陋室铭（节选）",
    [
      "山不在高，有仙则名。",
      "水不在深，有龙则灵。",
      "斯是陋室，惟吾德馨。",
      "苔痕上阶绿，草色入帘青。",
    ],
    "唐 · 刘禹锡",
  ),
  bloom: poem("苔", ["白日不到处，青春恰自来。", "苔花如米小，也学牡丹开。"], "清 · 袁枚"),
  eaves: poem("书事", ["轻阴阁小雨，深院昼慵开。", "坐看苍苔色，欲上人衣来。"], "唐 · 王维"),
  gate: poem(
    "游园不值",
    ["应怜屐齿印苍苔，小扣柴扉久不开。", "春色满园关不住，一枝红杏出墙来。"],
    "宋 · 叶绍翁",
  ),
} as const satisfies Record<string, WelcomeNote>;

/** The book's exhibition proposal, in the 青瓷 theme: real content, not a template. */
const DECK = deckFromOutline({
  title: "苔",
  subtitle: "一场关于慢慢生长的小展览",
  theme: "celadon",
  slides: [
    {
      title: "为什么是苔",
      body: "苔长在白日照不到的地方，一年只长几毫米，却能把一整块石头慢慢变成绿色。这场展览想请人停下来，看一看很小、很慢、却一直在生长的东西。",
    },
    { quote: "苔花如米小，也学牡丹开。", attribution: "清 · 袁枚《苔》" },
    {
      title: "五章",
      bullets: [
        "光 · 返景入深林，复照青苔上",
        "阶 · 苔痕上阶绿，草色入帘青",
        "花 · 苔花如米小，也学牡丹开",
        "衣 · 坐看苍苔色，欲上人衣来",
        "门 · 应怜屐齿印苍苔",
      ],
    },
    {
      title: "展览与书",
      leftTitle: "展览",
      left: "- 五张大图，五首诗\n- 一面五种绿的颜色墙\n- 只用自然光",
      rightTitle: "书",
      right: "- 64 页，骑马钉\n- 米白纤维纸，专色绿\n- 首印 500 册",
    },
    {
      title: "日程",
      table: [
        ["时间", "事项"],
        ["十二月", "打样，定纸和绿色"],
        ["一月", "付印，布展"],
        ["二月", "开幕，展四周"],
      ],
    },
  ],
  closing: "慢慢来",
});

function sheetCells(
  rows: readonly (readonly (string | number | null)[])[],
  formats: Readonly<Record<number, string>>,
): SheetCell[] {
  const cells: SheetCell[] = [];
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value === null) return;
      const formula = typeof value === "string" && value.startsWith("=");
      const format = r > 0 ? formats[c] : undefined;
      // The header and the 合计 row are bold; numbers keep their format.
      const bold = r === 0 || r === rows.length - 1;
      cells.push({
        r,
        c,
        v: formula ? null : value,
        ...(formula ? { f: value } : {}),
        ...(bold || format
          ? { s: { ...(bold ? { bold } : {}), ...(format ? { format } : {}) } }
          : {}),
      } as SheetCell);
    }),
  );
  return cells;
}

/** The book's print budget: quantities and unit prices, with the sums as formulas. */
const BUDGET = {
  version: 1,
  sheets: [
    {
      id: "sheet1",
      name: "印制预算",
      cells: sheetCells(
        [
          ["项目", "数量", "单价", "小计"],
          ["米白纤维纸 · 64 页", 500, 6.8, "=B2*C2"],
          ["四色印刷 + 专色绿", 500, 9.5, "=B3*C3"],
          ["骑马钉装订", 500, 1.2, "=B4*C4"],
          ["样张打样", 3, 180, "=B5*C5"],
          ["展墙喷绘", 5, 260, "=B6*C6"],
          ["合计", null, null, "=SUM(D2:D6)"],
        ],
        { 2: "0.00", 3: "#,##0.00" },
      ),
      columnWidths: { "0": 180, "1": 80, "2": 90, "3": 110 },
      frozenRows: 1,
    },
  ],
} as unknown as SheetWorkbook;

const TYPED = {
  deck: { kind: "slides", title: "展览提案", data: JSON.stringify(DECK) },
  budget: { kind: "sheet", title: "印制预算", data: JSON.stringify(BUDGET) },
} as const;

interface WelcomePicture {
  readonly name: string;
  readonly tags: readonly string[];
}

/** At `/images/space-welcome/<id>.webp`; prompts in docs/design/space-welcome-image-provenance.json. */
const PICTURES = {
  "light-1": { name: "空山返照 · 一", tags: ["苔", "光"] },
  "light-2": { name: "空山返照 · 二", tags: ["苔", "光"] },
  "light-3": { name: "空山返照 · 三", tags: ["苔", "光"] },
  steps: { name: "苔痕上阶", tags: ["苔", "阶"] },
  bloom: { name: "苔花如米", tags: ["苔", "花"] },
  eaves: { name: "雨后檐下", tags: ["苔", "雨"] },
  gate: { name: "柴扉与红杏", tags: ["苔", "门"] },
  greens: { name: "苔的五种绿", tags: ["配色", "书籍设计"] },
  specimens: { name: "九种苔", tags: ["苔", "标本"] },
  spread: { name: "书的样张", tags: ["书籍设计"] },
  poster: { name: "展览海报", tags: ["书籍设计", "海报"] },
  table: { name: "工作台", tags: ["书籍设计"] },
} as const satisfies Record<string, WelcomePicture>;

type Step =
  | { readonly note: keyof typeof NOTES }
  | { readonly typed: keyof typeof TYPED }
  | { readonly picture: keyof typeof PICTURES };

/**
 * How 「苔」 reads, first card first. The three panels of 空山返照 open the first row and the
 * grid joins them into one picture, with 鹿柴 beside them. Then the book's note, and each poem
 * after the photograph made for it, like a spread. The book's colour, specimens, deck, proofs,
 * poster and budget close it. Seeded last-first, since the newest is listed first.
 */
const SEQUENCE: readonly Step[] = [
  { picture: "light-1" },
  { picture: "light-2" },
  { picture: "light-3" },
  { note: "light" },
  { note: "book" },
  { picture: "steps" },
  { note: "steps" },
  { picture: "bloom" },
  { note: "bloom" },
  { picture: "eaves" },
  { note: "eaves" },
  { picture: "gate" },
  { note: "gate" },
  { picture: "greens" },
  { picture: "specimens" },
  { typed: "deck" },
  { picture: "spread" },
  { picture: "poster" },
  { typed: "budget" },
  { picture: "table" },
];

// ---------------------------------------------------------------------------------------------
// When

/** True when the space has never held anything: no pages, spaces, apps, outputs or files. */
export function isBlankSpace(input: {
  readonly pages: readonly Page[];
  readonly spaces: readonly PageSpace[];
  readonly apps: readonly SpacePageApp[];
  readonly outputs: readonly SpaceOutput[];
  readonly library: readonly LibraryItem[];
}): boolean {
  return (
    input.pages.length === 0 &&
    input.spaces.length === 0 &&
    input.apps.length === 0 &&
    input.outputs.length === 0 &&
    input.library.length === 0
  );
}

const offeredKey = (account: string) => `moss:space:welcome:v1:${account}`;

/** Whether this account was already given the samples on this device (kept or not). */
export function welcomeOffered(account: string): boolean {
  try {
    return globalThis.localStorage?.getItem(offeredKey(account)) === "1";
  } catch {
    // Without storage, seed only into a blank space, which is already the rule.
    return false;
  }
}

export function markWelcomeOffered(account: string): void {
  try {
    globalThis.localStorage?.setItem(offeredKey(account), "1");
  } catch {
    // Not remembered; the blank-space rule still stops a second seeding once it has content.
  }
}

// ---------------------------------------------------------------------------------------------
// How

export interface WelcomeDeps {
  readonly api: NativeApi;
  readonly scopeSpaceId: SpaceId | null;
  readonly upload: (files: readonly LibraryUploadFile[]) => Promise<LibraryImportResult>;
  /** Tags for a seeded picture, by its item key (`library:<id>`). */
  readonly onTags: (itemKey: string, tags: readonly string[]) => void;
  /** A picture's bytes; replaced in tests. */
  readonly loadPicture?: (id: string) => Promise<Blob>;
}

/** Puts the samples in place. Each part stands alone: a failed part leaves the others. */
export async function seedWelcomeSpace(deps: WelcomeDeps): Promise<void> {
  const { api, scopeSpaceId } = deps;
  const existingSpaces =
    typeof api.pages.spaces === "function"
      ? await api.pages
          .spaces({ scopeSpaceId })
          .then((result) => result.spaces)
          .catch(() => [] as readonly PageSpace[])
      : [];
  let space = existingSpaces.find(
    (entry) => entry.trashedAt === null && entry.title === WELCOME_FOLDER_TITLE,
  );
  if (!space) {
    const created = await api.pages.mutate({
      op: "create-space",
      requestId: crypto.randomUUID(),
      scopeSpaceId,
      title: WELCOME_FOLDER_TITLE,
    });
    space = created.space;
  }
  if (!space) throw new Error("示例资料没有建好。");
  const spaceId: PageSpaceId = space.id;
  const existingPages =
    typeof api.pages.list === "function"
      ? await api.pages
          .list({ scopeSpaceId, includeTrashed: false })
          .then((result) => result.pages.filter((page) => page.trashedAt === null))
          .catch(() => [] as readonly Page[])
      : [];
  const existingLibrary =
    typeof api.library.list === "function"
      ? await api.library
          .list({ includeTrashed: false })
          .catch(() => ({ items: [] as readonly LibraryItem[], folders: [] as const }))
      : { items: [] as readonly LibraryItem[], folders: [] as const };
  const existingSpaceNotes = new Set(
    existingPages
      .filter(
        (page) =>
          page.spaceId === spaceId &&
          page.id !== space.rootPageId &&
          (page.kind ?? "page") === "page",
      )
      .map((page) => page.title),
  );
  const existingSpaceTyped = new Set(
    existingPages
      .filter((page) => page.spaceId === spaceId && page.kind && page.kind !== "page")
      .map((page) => `${page.kind}:${page.title}`),
  );
  const hasWelcomeNote = existingPages.some(
    (page) => page.spaceId === null && page.title === WELCOME_NOTE.title,
  );
  const loadPicture = deps.loadPicture ?? fetchPicture;
  const failures = new Set<string>();
  let folderId: string | null =
    existingLibrary.folders.find((folder) => folder.title === WELCOME_FOLDER_TITLE)?.id ?? null;
  if (!folderId) {
    try {
      const id = crypto.randomUUID();
      await api.library.createFolder({ id, title: WELCOME_FOLDER_TITLE });
      folderId = id;
    } catch {
      failures.add("图片");
    }
  }
  const existingPictureTitles = new Set(
    folderId
      ? existingLibrary.items
          .filter((item) => item.trashedAt === null && item.folderId === folderId)
          .map((item) => item.title)
      : [],
  );

  for (const step of SEQUENCE.toReversed()) {
    try {
      if ("note" in step) {
        const note = NOTES[step.note];
        if (existingSpaceNotes.has(note.title)) continue;
        await api.pages.mutate({
          op: "create",
          requestId: crypto.randomUUID(),
          scopeSpaceId,
          title: note.title,
          content: note.content,
          spaceId,
          parentPageId: space.rootPageId,
        });
        existingSpaceNotes.add(note.title);
      } else if ("typed" in step) {
        const item = TYPED[step.typed];
        const typedKey = `${item.kind}:${item.title}`;
        if (existingSpaceTyped.has(typedKey)) continue;
        await createSpaceItem(api, {
          scopeSpaceId,
          kind: item.kind,
          title: item.title,
          data: item.data,
          spaceId,
          parentPageId: space.rootPageId,
        });
        existingSpaceTyped.add(typedKey);
      } else if (folderId) {
        const picture = PICTURES[step.picture];
        const fileName = `${picture.name}.webp`;
        if (existingPictureTitles.has(fileName) || existingPictureTitles.has(picture.name))
          continue;
        const result = await deps.upload([
          {
            name: fileName,
            mimeType: "image/webp",
            data: await loadPicture(step.picture),
          },
        ]);
        const ids = result.items.map((item) => item.id);
        if (ids.length) await api.library.move({ ids, folderId });
        for (const id of ids) deps.onTags(`library:${id}`, picture.tags);
        existingPictureTitles.add(fileName);
      }
    } catch {
      failures.add(
        "note" in step
          ? NOTES[step.note].title
          : "typed" in step
            ? TYPED[step.typed].title
            : "图片",
      );
    }
  }

  if (!hasWelcomeNote) {
    // Last, so it is the newest thing on the home.
    try {
      await api.pages.mutate({
        op: "create",
        requestId: crypto.randomUUID(),
        scopeSpaceId,
        title: WELCOME_NOTE.title,
        content: WELCOME_NOTE.content,
        spaceId: null,
        parentPageId: null,
      });
    } catch {
      failures.add(WELCOME_NOTE.title);
    }
  }
  if (failures.size) throw new Error(`示例资料里的${[...failures].join("、")}没有放好。`);
}

export function welcomePictureUrl(
  id: string,
  origin = typeof window !== "undefined" ? window.location?.origin : undefined,
): string {
  const path = `/images/space-welcome/${id}.webp`;
  if (origin && origin !== "null" && /^(https?|moss(?:-canary)?):\/\//u.test(origin)) {
    return new URL(path, origin).toString();
  }
  return path;
}

async function fetchPicture(id: string): Promise<Blob> {
  const response = await fetch(welcomePictureUrl(id));
  if (!response.ok) throw new Error(`${id} ${response.status}`);
  return response.blob();
}
