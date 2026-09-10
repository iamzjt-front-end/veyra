import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseDiff, codeTokens } from "../src/diff.js";
import { DiffView } from "../src/diff-view.js";
import { RunDetail } from "../src/run-detail.js";
import { controlFixture } from "../dev/fixtures.js";
const diff = `diff --git a/src/code.ts b/src/code.ts
--- a/src/code.ts
+++ b/src/code.ts
@@ -3,3 +3,4 @@
 const a = 1;
-return a;
+return a + 1;
+// safe
 `;
it("counts actual additions/deletions, preserves line numbers and keeps file navigation bounded", () => {
  const file = parseDiff(diff).files[0];
  expect(file).toMatchObject({ path: "src/code.ts", added: 2, removed: 1 });
  expect(file?.lines.find((line) => line.kind === "delete")).toMatchObject({
    before: 4,
    text: "return a;",
  });
  expect(file?.lines.find((line) => line.kind === "add")).toMatchObject({ after: 4 });
});
it("bounds UTF-8 patches, line lengths, file counts and rendered code", () => {
  const parsed = parseDiff(diff + "+中文".repeat(50000));
  expect(parsed.truncated).toBe(true);
  expect(parsed.files[0]?.lines.every((line) => line.text.length <= 2048)).toBe(true);
  const many = parseDiff(
    Array.from({ length: 200 }, (_, i) => diff.replaceAll("src/code.ts", `file-${i}.ts`)).join(
      "\n",
    ),
  );
  expect(many.files.length).toBeLessThanOrEqual(128);
  const markup = renderToStaticMarkup(
    createElement(DiffView, { patch: diff + "\n+line\n".repeat(1500), onSelect: () => {} }),
  );
  expect((markup.match(/class="v-diff-line /g) ?? []).length).toBeLessThanOrEqual(160);
});
it("supports binary files and quoted paths without following traversal paths", () => {
  expect(
    parseDiff('diff --git "a/my file.ts" "b/my file.ts"\nBinary files differ').files[0],
  ).toMatchObject({ path: "my file.ts", binary: true });
  expect(
    parseDiff("diff --git a/../../outside b/../../outside\n+++ b/../../outside").files[0]?.path,
  ).toBe("File path unavailable");
});
it("escapes hostile code as text and lexical highlighting does not change it", () => {
  const source = "const html = '<img src=x onerror=alert(1)>'; // comment";
  expect(
    codeTokens(source)
      .map((token) => token.text)
      .join(""),
  ).toBe(source);
  const markup = renderToStaticMarkup(
    createElement(DiffView, { patch: `${diff}\n+${source}`, onSelect: () => {} }),
  );
  expect(markup).toContain("&lt;img");
  expect(markup).not.toContain("<img");
});
it("never invents approval or test counts and does not attach evidence from a different event", () => {
  const fixture = controlFixture("run");
  const evidence = structuredClone(fixture.evidence);
  evidence.verificationEvidence = [
    {
      eventId: "other-event",
      stepId: "test",
      success: true,
      results: [
        {
          success: true,
          exitCode: 0,
          command: "WRONG_EVENT",
          stdout: "100 tests passed",
          stderr: "",
        },
      ],
    },
  ];
  const markup = renderToStaticMarkup(
    createElement(RunDetail, {
      evidence,
      projectRoot: fixture.project.project.root,
      cancel: () => {},
    }),
  );
  expect(markup).toContain("Waiting for ChatGPT");
  expect(markup).toContain("pre-existing edits");
  expect(markup).not.toMatch(/Approved|100 tests passed|WRONG_EVENT/);
});
it("shows recorded review verdicts and links only matching diff-file evidence", () => {
  const fixture = controlFixture("failed");
  const evidence = structuredClone(fixture.evidence);
  const result = evidence.result;
  if (!result) throw new Error("Missing fixture");
  evidence.review = {
    version: 1,
    kind: "review",
    id: result.id,
    projectId: result.projectId,
    runId: result.runId,
    resultId: result.id,
    verdict: "fail",
    summary: "Check session expiry",
    nextAction: "repair",
    provenance: { ...result.provenance, role: "reviewer", actor: "ChatGPT" },
    evidence: [
      {
        path: `${fixture.project.project.root}/src/api/session.ts`,
        source: "agent",
        runId: result.runId,
        stepId: "review",
        eventId: "review-1",
        sequence: 1,
      },
    ],
  };
  const markup = renderToStaticMarkup(
    createElement(RunDetail, {
      evidence,
      projectRoot: fixture.project.project.root,
      cancel: () => {},
    }),
  );
  expect(markup).toContain("Needs changes");
  expect(markup).toContain("Check session expiry");
  evidence.review.resultId = "another-result";
  expect(
    renderToStaticMarkup(
      createElement(RunDetail, {
        evidence,
        projectRoot: fixture.project.project.root,
        cancel: () => {},
      }),
    ),
  ).toContain("Waiting for ChatGPT");
});

import { I18nProvider, LocaleStore } from "@veyraoss/ui";
function renderToStaticMarkup(node: ReactNode) {
  return renderMarkup(
    createElement(I18nProvider, { store: new LocaleStore(undefined, "en") }, node),
  );
}
