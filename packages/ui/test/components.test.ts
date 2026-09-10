import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ErrorState,
  IconButton,
  PathText,
  RunStatus,
  Stepper,
  VerificationStatus,
} from "../src/index.js";

describe("shared semantic presentation", () => {
  it("never interpolates engineering data as HTML", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, {}, "<img src=x onerror=alert(1)>"),
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain('role="alert"');
  });
  it("gives icon controls meaningful accessible names", () => {
    expect(
      renderToStaticMarkup(createElement(IconButton, { icon: "pause", label: "Pause automation" })),
    ).toContain('aria-label="Pause automation"');
  });
  it("distinguishes missing evidence from passing verification", () => {
    expect(
      renderToStaticMarkup(createElement(VerificationStatus, { status: "not_run" })),
    ).toContain("Not run");
    expect(renderToStaticMarkup(createElement(RunStatus, { status: "unknown" }))).not.toContain(
      "Completed",
    );
  });
  it("labels workflow states independently of color", () => {
    const html = renderToStaticMarkup(
      createElement(Stepper, {
        steps: [
          { id: "plan", label: "Plan", state: "passed" },
          { id: "execute", label: "Execute", state: "running", detail: "Codex" },
          { id: "review", label: "Review", state: "pending" },
        ],
      }),
    );
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Pending");
    expect(html).toContain("Passed");
  });
  it("keeps the full path accessible while shortening the home prefix", () => {
    const html = renderToStaticMarkup(
      createElement(PathText, { path: "/Users/developer/Projects/veyra" }),
    );
    expect(html).toContain('title="/Users/developer/Projects/veyra"');
    expect(html).toContain("~/Projects/veyra");
  });
});

import { I18nProvider, LocaleStore } from "../src/index.js";
function renderToStaticMarkup(node: ReactNode) {
  return renderMarkup(
    createElement(I18nProvider, { store: new LocaleStore(undefined, "en") }, node),
  );
}
