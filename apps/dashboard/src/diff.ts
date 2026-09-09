/** Bounded, text-only unified diff model. It never opens referenced paths or evaluates code. */
export interface DiffLine {
  kind: "add" | "delete" | "context" | "header";
  text: string;
  before?: number;
  after?: number;
}
export interface DiffFile {
  id: string;
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  binary: boolean;
  truncated: boolean;
}
export const DIFF_LIMIT = 32768;
const pathValue = (value: string) => {
  let decoded = value;
  if (value.startsWith('"')) {
    try {
      decoded = JSON.parse(value) as string;
    } catch {
      return "";
    }
  }
  const path = decoded.replace(/^[ab]\//, "");
  return path &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !/\p{Cc}/u.test(path)
    ? path
    : "";
};
export function parseDiff(source: string) {
  const bytes = new TextEncoder().encode(source),
    truncated = bytes.length > DIFF_LIMIT;
  const patch = new TextDecoder().decode(bytes.subarray(0, DIFF_LIMIT));
  const rows = patch.split("\n").slice(0, 1600);
  const files: DiffFile[] = [];
  let file: DiffFile | undefined,
    before = 0,
    after = 0,
    inHunk = false;
  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      if (files.length >= 128) break;
      const match = /^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(row);
      file = {
        id: `${files.length}:${row}`,
        path: pathValue(match?.[1] ?? "") || "File path unavailable",
        added: 0,
        removed: 0,
        lines: [],
        binary: false,
        truncated: false,
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (row.startsWith("+++ ") && !inHunk) {
      const path = pathValue(row.slice(4));
      if (path) file.path = path;
      continue;
    }
    if (/^(?:Binary files |GIT binary patch)/.test(row)) {
      file.binary = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "header", text: row.slice(0, 1024) });
      continue;
    }
    if (!inHunk || !/^[ +-]/.test(row)) continue;
    const text = row.slice(1, 2049);
    if (row.length > 2049) file.truncated = true;
    if (row.startsWith("+")) {
      file.added++;
      file.lines.push({ kind: "add", text, after: after++ });
    } else if (row.startsWith("-")) {
      file.removed++;
      file.lines.push({ kind: "delete", text, before: before++ });
    } else file.lines.push({ kind: "context", text, before: before++, after: after++ });
  }
  const bounded = truncated || patch.split("\n").length > 1600 || files.length >= 128;
  if (bounded && files.at(-1)) (files.at(-1) as DiffFile).truncated = true;
  return { files, truncated: bounded };
}
export interface CodeToken {
  offset: number;
  kind: "plain" | "keyword" | "string" | "comment" | "number";
  text: string;
}
/** Small lexical color treatment, not a compiler/highlighter runtime. React escapes every token. */
export function codeTokens(source: string): CodeToken[] {
  const value = source.slice(0, 2048),
    tokens: CodeToken[] = [];
  const pattern =
    /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|\b(const|let|var|function|async|await|return|export|import|from|if|else|throw|new|class|interface|type|true|false|null|undefined|def|with|for|in)\b|\b(\d+(?:\.\d+)?)\b/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (tokens.length > 256) break;
    if (match.index > cursor)
      tokens.push({ offset: cursor, kind: "plain", text: value.slice(cursor, match.index) });
    tokens.push({
      offset: match.index,
      kind: match[1] ? "comment" : match[2] ? "string" : match[3] ? "keyword" : "number",
      text: match[0],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length)
    tokens.push({ offset: cursor, kind: "plain", text: value.slice(cursor) });
  return tokens;
}
