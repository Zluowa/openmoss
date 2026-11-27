import {
  MOSS_NOVEL_READER_DESCRIPTION,
  MOSS_NOVEL_READER_HTML,
  MOSS_NOVEL_READER_STARTER_ID,
  MOSS_NOVEL_READER_TITLE,
} from "./mossNovelReader";

export interface BuiltInPageAppStarter {
  readonly starterId: string;
  readonly title: string;
  readonly description: string;
  readonly html: string;
}

export const BUILTIN_PAGE_APP_STARTERS: ReadonlyArray<BuiltInPageAppStarter> = [
  {
    starterId: MOSS_NOVEL_READER_STARTER_ID,
    title: MOSS_NOVEL_READER_TITLE,
    description: MOSS_NOVEL_READER_DESCRIPTION,
    html: MOSS_NOVEL_READER_HTML,
  },
];
