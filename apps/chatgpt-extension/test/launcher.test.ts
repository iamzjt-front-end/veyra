import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LauncherView } from "../src/launcher-view.js";
it("keeps infrastructure and binding controls outside the quick launcher", () => {
  const html = renderToStaticMarkup(
    createElement(LauncherView, {
      state: { status: "Ready", project: "veyra", allowed: true },
      open: () => {},
      diagnostics: () => {},
    }),
  );
  expect(html).toContain("Open Veyra");
  expect(html).toContain("Diagnostics");
  expect(html).not.toMatch(/daemon|localhost|pairing|UUID|Bind conversation|Cancel Run/);
});
it("does not offer panel opening on an unsupported tab", () => {
  const html = renderToStaticMarkup(
    createElement(LauncherView, {
      state: { status: "Ready", allowed: false },
      open: () => {},
      diagnostics: () => {},
    }),
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain("Open chatgpt.com");
});

import { I18nProvider, LocaleStore } from "@veyraoss/ui";
function renderToStaticMarkup(node: ReactNode) {
  return renderMarkup(
    createElement(I18nProvider, { store: new LocaleStore(undefined, "en") }, node),
  );
}
