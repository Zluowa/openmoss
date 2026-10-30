import { describe, expect, it } from "vitest";

import { assertPatchPostImage, parsePatchFileExpectations } from "./staged-patch-verification.ts";

describe("staged patch verification", () => {
  it("verifies exact hunk post-images at their target lines", () => {
    const [expectation] = parsePatchFileExpectations(`diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -2,3 +2,4 @@
 before
-old
+new
+extra
 after
`);
    expect(expectation).toBeDefined();
    expect(() =>
      assertPatchPostImage(expectation!, ["zero", "before", "new", "extra", "after"].join("\n")),
    ).not.toThrow();
  });

  it("rejects an added line that only appears elsewhere in the file", () => {
    const [expectation] = parsePatchFileExpectations(`diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -2,3 +2,3 @@
 before
-old
+patched
 after
`);
    expect(expectation).toBeDefined();
    expect(() =>
      assertPatchPostImage(expectation!, ["zero", "before", "old", "after", "patched"].join("\n")),
    ).toThrow(/does not match patched post-image/);
  });

  it("verifies every hunk independently", () => {
    const [expectation] = parsePatchFileExpectations(`diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,2 +1,2 @@
-one
+ONE
 two
@@ -4,2 +4,2 @@
 four
-five
+FIVE
`);
    expect(expectation).toBeDefined();
    expect(() =>
      assertPatchPostImage(expectation!, ["ONE", "two", "three", "four", "FIVE"].join("\n")),
    ).not.toThrow();
    expect(() =>
      assertPatchPostImage(expectation!, ["ONE", "two", "three", "four", "five"].join("\n")),
    ).toThrow(/line 4/);
  });

  it("parses created and deleted file boundaries", () => {
    const expectations = parsePatchFileExpectations(`diff --git a/new.js b/new.js
new file mode 100644
--- /dev/null
+++ b/new.js
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.js b/old.js
deleted file mode 100644
--- a/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-old
-file
`);
    expect(expectations).toHaveLength(2);
    expect(expectations[0]).toMatchObject({ sourceFile: null, targetFile: "new.js" });
    expect(expectations[1]).toMatchObject({ sourceFile: "old.js", targetFile: null });
    expect(() => assertPatchPostImage(expectations[0]!, "one\ntwo")).not.toThrow();
    expect(() => assertPatchPostImage(expectations[1]!, "")).toThrow(
      /Deleted patch targets must be verified as absent/,
    );
  });
});
