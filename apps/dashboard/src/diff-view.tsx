import { useMemo, useState } from "react";
import { Button, Icon, PathText, CopyButton, EmptyState } from "@veyraoss/ui";
import { codeTokens, parseDiff, type DiffFile, type DiffLine } from "./diff.js";
function CodeLine({ line }: { line: DiffLine }) {
  return (
    <div className={`v-diff-line v-diff-${line.kind}`}>
      <span className="v-diff-number" aria-hidden="true">
        {line.before}
      </span>
      <span className="v-diff-number" aria-hidden="true">
        {line.after}
      </span>
      <span
        className="v-diff-sign"
        role="img"
        aria-label={line.kind === "add" ? "added" : line.kind === "delete" ? "removed" : "context"}
      >
        {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}
      </span>
      <code>
        {line.kind === "header"
          ? line.text
          : codeTokens(line.text).map((token) => (
              <span key={token.offset} className={`v-code-${token.kind}`}>
                {token.text}
              </span>
            ))}
      </code>
    </div>
  );
}
function FilePatch({ file }: { file: DiffFile }) {
  const [limit, setLimit] = useState(160),
    [context, setContext] = useState(false);
  const nodes = [];
  for (let i = 0; i < Math.min(limit, file.lines.length); i++) {
    const line = file.lines[i];
    if (!line) continue;
    if (!context && line.kind === "context") {
      let end = i;
      while (file.lines[end]?.kind === "context") end++;
      if (end - i > 3) {
        nodes.push(
          <button
            key={`context-${i}`}
            type="button"
            className="v-diff-expand"
            onClick={() => setContext(true)}
          >
            <Icon name="down" />
            Show {end - i} unchanged lines
          </button>,
        );
        i = end - 1;
        continue;
      }
    }
    nodes.push(
      <CodeLine key={`${line.kind}:${line.before}:${line.after}:${line.text}`} line={line} />,
    );
  }
  return (
    <>
      {file.binary ? (
        <div className="v-diff-binary">Binary file changed. Its contents are not rendered.</div>
      ) : (
        <section
          className="v-diff-code"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded scroll region must support keyboard scrolling.
          tabIndex={0}
          aria-label={`Unified diff for ${file.path}`}
        >
          {nodes.length ? (
            nodes
          ) : (
            <p className="v-diff-binary">File metadata changed; no textual hunk was captured.</p>
          )}
        </section>
      )}
      {file.lines.length > limit && (
        <Button
          variant="ghost"
          onClick={() => setLimit(Math.min(limit + 160, 640))}
          disabled={limit >= 640}
        >
          {limit >= 640 ? "Preview limited to 640 lines" : "Show more changed lines"}
        </Button>
      )}
      {file.truncated && (
        <p className="v-caption v-diff-notice">
          This file preview is truncated. Inspect the complete diff locally.
        </p>
      )}
      {context && (
        <Button variant="ghost" onClick={() => setContext(false)}>
          Collapse unchanged lines
        </Button>
      )}
    </>
  );
}
export function DiffView({
  patch,
  selected,
  onSelect,
  upstreamTruncated,
}: {
  patch: string;
  selected?: string;
  onSelect: (path: string) => void;
  upstreamTruncated?: boolean;
}) {
  const parsed = useMemo(() => parseDiff(patch), [patch]);
  const file = parsed.files.find((file) => file.path === selected) ?? parsed.files[0];
  if (!file)
    return (
      <EmptyState icon="file" title="No patch available">
        Changed-file references and verification evidence remain available below.
      </EmptyState>
    );
  const added = parsed.files.reduce((count, item) => count + item.added, 0),
    removed = parsed.files.reduce((count, item) => count + item.removed, 0);
  return (
    <div className="v-diff">
      <div className="v-diff-toolbar">
        <span>
          Unified diff <span className="v-caption">· {parsed.files.length} files</span>
        </span>
        <div className="v-line-counts">
          <span className="v-add-count">+{added}</span>
          <span className="v-delete-count">−{removed}</span>
        </div>
      </div>
      <div className="v-diff-layout">
        <nav className="v-diff-files" aria-label="Changed files">
          {parsed.files.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={item === file ? "true" : undefined}
              onClick={() => onSelect(item.path)}
            >
              <Icon name="file" />
              <span>{item.path}</span>
              <span className="v-line-counts">
                <span className="v-add-count">+{item.added}</span>
                <span className="v-delete-count">−{item.removed}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="v-diff-main">
          <div className="v-diff-file-heading">
            <PathText path={file.path} />
            <CopyButton text={file.path} label="Copy file path" />
          </div>
          <FilePatch key={file.path} file={file} />
        </div>
      </div>
      {(parsed.truncated || upstreamTruncated) && (
        <p className="v-caption v-diff-notice">
          Bounded preview. Counts describe only the visible patch; the full local diff may contain
          more changes.
        </p>
      )}
    </div>
  );
}
