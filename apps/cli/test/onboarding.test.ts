import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { mkdir, realpath, readFile, writeFile, symlink } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { ProjectRegistry, loadProjectBindings } from "@veyraoss/project";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { initializeNativeProject } from "../src/project-init.js";
import {
  setupNative,
  readInstallation,
  privateWrite,
  BROWSER_ORIGIN,
} from "../src/native-installation.js";
import { NativeService, ensureCoordinator } from "../src/native-service.js";
import { frame, serveNative, MAX_NATIVE_BYTES } from "../src/native-framing.js";
import { runCli } from "../src/application.js";
import { DaemonClient, startDaemon, daemonStatus, stopDaemon } from "@veyraoss/daemon";

const fakeRunner = vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  stdout: "codex-cli 1.2.3\nLogged in using ChatGPT",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
}));
async function install(root: string) {
  return setupNative({
    registryRoot: join(root, "registry"),
    manifestDirs: [join(root, "chrome/NativeMessagingHosts")],
    entry: import.meta.filename,
    runProcess: fakeRunner,
    env: { PATH: "" },
  });
}
describe("one-time local onboarding", () => {
  it("requires native installation identity for task discovery and grants only the explicitly selected Project", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const installed = await install(path);
      const registryRoot = join(path, "registry");
      const { project } = await initializeNativeProject(path, { registryRoot, env: { PATH: "" } });
      const conversation = { id: randomUUID(), title: "已有 Codex 对话", root: project.root };
      const discovery = {
        list: vi.fn(async () => ({ conversations: [conversation], cursor: null })),
        select: vi.fn(async () => ({ project, conversation })),
        check: vi.fn(async () => ({ ready: true, conversation })),
      };
      const connect = vi.fn();
      const service = new NativeService(
        installed.statePath,
        BROWSER_ORIGIN,
        connect,
        undefined,
        discovery,
      );
      const call = (method: string, params?: unknown) =>
        service.handle({
          version: 1,
          id: randomUUID(),
          installationId: installed.installationId,
          method,
          ...(params === undefined ? {} : { params }),
        });
      expect(await call("codex.conversations.list", {})).toMatchObject({ ok: false });
      expect(discovery.list).not.toHaveBeenCalled();
      await call("hello");
      expect(await call("codex.conversations.list", { search: "已有" })).toMatchObject({
        ok: true,
        data: { conversations: [conversation] },
      });
      expect(await call("codex.conversations.list", { history: true })).toMatchObject({
        ok: false,
      });
      expect(
        await call("codex.conversations.select", { ...conversation, command: "evil" }),
      ).toMatchObject({ ok: false });
      expect(discovery.select).not.toHaveBeenCalled();
      expect(
        await call("codex.conversations.check", { projectId: project.id, conversation }),
      ).toMatchObject({ ok: false });
      expect(await call("codex.conversations.select", conversation)).toMatchObject({ ok: true });
      expect((await readInstallation(installed.statePath)).grants).toEqual({
        [project.id]: {
          root: project.root,
          expiresAt: expect.any(Number),
          nativeConversationIds: [conversation.id],
        },
      });
      expect(
        await call("codex.conversations.check", { projectId: project.id, conversation }),
      ).toMatchObject({ ok: true });
      expect(
        await call("codex.conversations.check", { projectId: randomUUID(), conversation }),
      ).toMatchObject({ ok: false });
      expect(
        await call("codex.conversations.check", {
          projectId: project.id,
          conversation: { ...conversation, root: "/other" },
        }),
      ).toMatchObject({ ok: false });
      expect(discovery.check).toHaveBeenCalledTimes(1);
      expect(
        await call("codex.conversations.check", {
          projectId: project.id,
          conversation: { ...conversation, id: randomUUID() },
        }),
      ).toMatchObject({ ok: false });
      expect(discovery.check).toHaveBeenCalledTimes(1);
      expect(connect).not.toHaveBeenCalled();
    });
  });
  it("initializes/registers/binds native Codex idempotently and discovers trusted verification names", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({
          scripts: { test: "node --test", build: "tsc" },
          packageManager: "pnpm@10.15.1",
        }),
      );
      const options = { registryRoot: join(path, "registry"), env: { PATH: "" } };
      const first = await initializeNativeProject(path, options);
      expect(first.checks).toEqual(["test", "build"]);
      expect(await new ProjectRegistry({ root: options.registryRoot }).list()).toHaveLength(1);
      expect((await loadProjectBindings(first.project))?.roles.executor).toMatchObject({
        provider: "codex",
        mode: "native",
      });
      const config = await readFile(join(path, "veyra.yaml"), "utf8");
      expect(config).not.toMatch(/openai|apiKey|planner|reviewer/);
      const second = await initializeNativeProject(path, options);
      expect(second.project.id).toBe(first.project.id);
      expect(second.bound).toBe(false);
      expect(await readFile(join(path, "veyra.yaml"), "utf8")).toBe(config);
      expect((await readFile(join(path, ".gitignore"), "utf8")).split(".veyra/runs/")).toHaveLength(
        2,
      );
    });
  });
  it("default public init preserves existing configuration and never executes scripts", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(join(path, "veyra.yaml"), "# user configuration preserved verbatim\n");
      const runProcess = vi.fn();
      const output: string[] = [];
      expect(
        await runCli(["init", "--registry", join(path, "registry"), "--json"], {
          cwd: path,
          runProcess,
          stdout: (text) => output.push(text),
        }),
      ).toBe(0);
      expect(await readFile(join(path, "veyra.yaml"), "utf8")).toBe(
        "# user configuration preserved verbatim\n",
      );
      expect(JSON.parse(output.join("")).project.root).toBe(await realpath(path));
      expect(runProcess).not.toHaveBeenCalled();
    });
  });
  it("reopens a nested Project without creating config or evidence beside its source", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const options = { registryRoot: join(path, "registry"), env: { PATH: "" } };
      const first = await initializeNativeProject(path, options);
      const config = await readFile(join(path, "veyra.yaml"), "utf8");
      const nested = join(path, "src", "feature");
      await mkdir(nested, { recursive: true });
      const reopened = await initializeNativeProject(nested, options);
      expect(reopened.project).toEqual(first.project);
      expect(await readFile(join(path, "veyra.yaml"), "utf8")).toBe(config);
      for (const name of ["veyra.yaml", ".gitignore", ".veyra/workflow.yaml"])
        await expect(readFile(join(nested, name))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await new ProjectRegistry({ root: options.registryRoot }).list()).toHaveLength(1);
    });
  });
  it("registers only the official extension origin, preserves identity and rotates grants on revoke", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await install(path);
      expect(result.extension).toBe("awaiting-extension");
      const manifestPath = result.manifests[0];
      assert.ok(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.allowed_origins).toEqual([`${BROWSER_ORIGIN}/`]);
      expect(manifest.type).toBe("stdio");
      expect(await readFile(manifest.path, "utf8")).toContain("exec '");
      const again = await install(path);
      expect(again.installationId).toBe(result.installationId);
      const revoked = await setupNative({
        registryRoot: join(path, "registry"),
        manifestDirs: [join(path, "chrome/NativeMessagingHosts")],
        entry: import.meta.filename,
        runProcess: fakeRunner,
        revoke: true,
      });
      expect(revoked.installationId).not.toBe(result.installationId);
      expect((await readInstallation(result.statePath)).grants).toEqual({});
    });
  });
  it("starts one detached coordinator lazily across concurrent native connections", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const installed = await install(path);
      const registryRoot = join(path, "registry");
      try {
        expect(await daemonStatus({ registryRoot })).toEqual({ status: "stopped" });
        const [one, two] = await Promise.all([
          ensureCoordinator(installed.statePath),
          ensureCoordinator(installed.statePath),
        ]);
        const first = await one.call("health", undefined);
        const second = await two.call("health", undefined);
        expect(first.id).toBe(second.id);
        expect(first.owner.pid).not.toBe(process.pid);
      } finally {
        await stopDaemon({ registryRoot });
      }
      expect(await daemonStatus({ registryRoot })).toEqual({ status: "stopped" });
    });
  });
  it("does not overwrite a foreign manifest, linked file or foreign launcher", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const installed = await install(path);
      const manifest = installed.manifests[0];
      assert.ok(manifest);
      await writeFile(manifest, JSON.stringify({ name: "other", path: "/unrelated" }), {
        mode: 0o600,
      });
      await expect(install(path)).rejects.toThrow("overwrite");
      expect(JSON.parse(await readFile(manifest, "utf8")).name).toBe("other");
      const target = join(path, "user.txt");
      await writeFile(target, "untouched");
      const link = join(path, "link");
      await symlink(target, link);
      await expect(privateWrite(link, "bad")).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("untouched");
    });
  });
  it("scopes native actions to explicit Project grants and refuses origin, schema, expiry and identity changes", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const installed = await install(path);
      const project = (
        await initializeNativeProject(path, {
          registryRoot: join(path, "registry"),
          env: { PATH: "" },
        })
      ).project;
      const daemon = await startDaemon({ registryRoot: join(path, "registry") });
      try {
        const connect = vi.fn(
          async () => new DaemonClient({ registryRoot: join(path, "registry") }),
        );
        expect(
          () =>
            new NativeService(
              installed.statePath,
              "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              connect,
            ),
        ).toThrow("origin");
        const service = new NativeService(
          installed.statePath,
          BROWSER_ORIGIN,
          connect,
          async () => ({ ready: true, message: "fixture", checks: [] }),
        );
        const call = (method: string, params?: unknown) =>
          service.handle({
            version: 1,
            id: randomUUID(),
            installationId: installed.installationId,
            method,
            ...(params === undefined ? {} : { params }),
          });
        expect(await call("projects.list")).toMatchObject({ ok: false });
        expect(await call("hello")).toMatchObject({ ok: true });
        expect((await readInstallation(installed.statePath)).extensionSeenAt).toBeGreaterThan(0);
        expect(await call("projects.list")).toMatchObject({
          ok: true,
          data: [{ project: { id: project.id } }],
        });
        expect(
          await call("results.get", { projectId: project.id, runId: randomUUID() }),
        ).toMatchObject({ ok: false });
        expect(await call("stop")).toMatchObject({ ok: false });
        expect(await call("projects.register", { path: "/unrelated" })).toMatchObject({
          ok: false,
        });
        expect(
          await call("projects.authorize", { projectId: project.id, root: "/evil" }),
        ).toMatchObject({ ok: false });
        expect(await call("projects.authorize", { projectId: project.id })).toMatchObject({
          ok: true,
        });
        expect(await call("projects.get", { projectId: project.id })).toMatchObject({
          ok: true,
          data: { readiness: { ready: true } },
        });
        const state = await readInstallation(installed.statePath);
        const grant = state.grants[project.id];
        assert.ok(grant);
        grant.expiresAt = 0;
        await privateWrite(installed.statePath, JSON.stringify(state));
        expect(await call("projects.get", { projectId: project.id })).toMatchObject({ ok: false });
        grant.expiresAt = Date.now() + 100000;
        grant.root = "/different";
        await privateWrite(installed.statePath, JSON.stringify(state));
        expect(await call("projects.get", { projectId: project.id })).toMatchObject({ ok: false });
        state.id = randomUUID();
        await privateWrite(installed.statePath, JSON.stringify(state));
        expect(await call("projects.list")).toMatchObject({ ok: false });
      } finally {
        await daemon.stop();
      }
    });
  });
});
describe("native messaging framing", () => {
  it("handles split UTF-8 headers/bodies and multiple frames without corrupting stdout", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(chunk));
    const handler = vi.fn(async (value) => value);
    const done = serveNative(input, output, handler);
    const data = Buffer.concat([frame({ text: "中文 + English" }), frame({ number: 2 })]);
    input.write(data.subarray(0, 2));
    input.write(data.subarray(2, 9));
    input.end(data.subarray(9));
    await done;
    expect(handler).toHaveBeenCalledTimes(2);
    expect(Buffer.concat(chunks)).toEqual(data);
  });
  it("rejects oversize, truncated and invalid JSON frames before invoking a handler", async () => {
    expect(() => frame({ text: "x".repeat(MAX_NATIVE_BYTES) })).toThrow();
    for (const bytes of [
      Buffer.from([0, 0, 0, 0]),
      frame({ x: 1 }).subarray(0, 5),
      Buffer.from([1, 0, 0, 0, 123]),
    ]) {
      const input = new PassThrough();
      const handler = vi.fn();
      const done = serveNative(input, new PassThrough(), handler);
      input.end(bytes);
      await expect(done).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    }
  });
});
