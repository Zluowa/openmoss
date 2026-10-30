/** One disposable, isolated desktop HTML document. No guest-to-host bridge is exposed. */
export interface HtmlPreviewRegisterInput {
  readonly html: string;
  /** Absolute HTML source path; its directory is the relative-resource boundary. */
  readonly filePath?: string;
}

export interface HtmlPreviewDescriptor {
  readonly id: string;
  readonly partition: string;
  readonly src: string;
}

export interface HtmlPreviewUnregisterInput {
  readonly id: string;
}
