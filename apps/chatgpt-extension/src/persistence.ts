import { conversationUrl, type Binding } from "./contracts.js";
import type { SessionState } from "./controller.js";
/** Local storage contains routing/one-time delivery intent only; bodies remain in Project state. */
export function durableBindings(state: SessionState): Record<string, Binding> {
  const entries = { ...state.bindings };
  if (state.binding?.installationId) entries[state.binding.conversation] = state.binding;
  if (Object.keys(entries).length > 50)
    throw new Error("已有 50 个会话绑定，请先 Unbind 不再使用的会话。");
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([url, binding]) => conversationUrl(url) === url && binding.installationId)
      .map(([url, b]) => [
        url,
        {
          id: b.id,
          tabId: b.tabId,
          epoch: b.epoch,
          conversation: url,
          projectId: b.projectId,
          projectName: b.projectName,
          projectRoot: b.projectRoot,
          maxRuns: b.maxRuns,
          count: b.count,
          nextRunId: b.nextRunId,
          phase: b.phase,
          runId: b.runId,
          runStatus: b.runStatus,
          agentStatus: b.agentStatus,
          installationId: b.installationId,
          bootstrapped: b.bootstrapped,
          pausedByUser: b.pausedByUser,
          resumePhase: b.resumePhase,
          attached: false,
          message: "绑定已保存。",
          ...(b.lastResult
            ? {
                lastResult: {
                  runId: b.lastResult.runId,
                  status: b.lastResult.status,
                  delivery: b.lastResult.delivery,
                  summary: "结果保存在 Project。",
                },
              }
            : {}),
        },
      ]),
  );
}
