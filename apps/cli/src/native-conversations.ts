import { realpath } from "node:fs/promises";
import {
  checkCodexConversation,
  listCodexConversations,
  readCodexConversation,
} from "@veyraoss/codex";
import { loadProjectBindings, openProject, ProjectError, ProjectRegistry } from "@veyraoss/project";
import type { NativeConversation, ProjectId } from "@veyraoss/protocol";
import { detectCodex } from "./native-installation.js";
import { initializeNativeProject } from "./project-init.js";

async function options() {
  const executable = await detectCodex(process.env);
  if (!executable) throw new Error("Native Codex was not found. Run ve setup once.");
  return { executable, env: process.env };
}
export const nativeConversations = {
  async list(query: { cursor?: string; search?: string }) {
    return listCodexConversations(await options(), query);
  },
  async select(selected: NativeConversation, registryRoot: string) {
    const actual = await readCodexConversation(await options(), selected.id);
    const root = await realpath(actual.root);
    if (root !== (await realpath(selected.root)) || actual.title !== selected.title)
      throw new Error("The selected Codex task changed. Select it again.");
    // Explicit UI selection authorizes initialization of this exact folder, never an ancestor.
    try {
      const existing = await openProject(root);
      if (existing.root !== root)
        throw new Error(
          "The Codex task directory is inside another Veyra Project. Select its root task.",
        );
      const binding = (await loadProjectBindings(existing))?.roles.executor;
      if (binding && (binding.provider !== "codex" || binding.mode !== "native"))
        throw new Error("This Project uses another executor. Change its binding locally first.");
    } catch (error) {
      if (!(error instanceof ProjectError) || error.code !== "project_missing") throw error;
    }
    const { project } = await initializeNativeProject(root, { registryRoot });
    return { project, conversation: { ...actual, root } };
  },
  async check(selected: NativeConversation, projectId: ProjectId, registryRoot: string) {
    const entry = await new ProjectRegistry({ root: registryRoot }).get(projectId);
    if (entry?.status !== "available" || entry.project.root !== (await realpath(selected.root)))
      throw new Error("The selected Codex task does not belong to this available Project.");
    await checkCodexConversation(await options(), selected);
    return { ready: true, conversation: selected };
  },
};
