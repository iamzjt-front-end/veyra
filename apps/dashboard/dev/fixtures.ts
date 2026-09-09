import { panelFixture } from "../../chatgpt-extension/dev/fixtures.js";
import type { WorkspaceViewProps } from "../src/views.js";
import type { DaemonRunSummary } from "@veyraoss/protocol";
export function controlFixture(name = "overview") {
  const panel = panelFixture(name === "failed" ? "failed" : "completed");
  const running = panelFixture("running");
  const first = panel.projects[0];
  if (!first || !panel.evidence.run || !running.evidence.run || !panel.evidence.handoff)
    throw new Error("Missing UI fixture");
  panel.evidence.workspaceDiff = {
    available: true,
    scope: "current_workspace_including_preexisting_changes",
    observedAt: "2026-09-09T10:29:14.000Z",
    untrackedFiles: [],
    patch: `diff --git a/src/auth/apple.ts b/src/auth/apple.ts
index 567a23..aad578 100644
--- a/src/auth/apple.ts
+++ b/src/auth/apple.ts
@@ -1,8 +1,14 @@
 import { getSession } from '../api/session';
${" "}
 export async function signInWithApple() {
-  throw new Error('Not implemented');
+  const response = await apple.signIn();
+  const credential = await verifyCredential(response);
+  if (!credential.userId) {
+    throw new Error('A verified account is required');
+  }
+  return getSession(credential.userId);
 }
${" "}
 export const provider = 'apple';
${" "}
 // The session contract stays unchanged.
+// Credentials remain inside the native provider.
diff --git a/src/auth/wechat.ts b/src/auth/wechat.ts
--- a/src/auth/wechat.ts
+++ b/src/auth/wechat.ts
@@ -1,3 +1,5 @@
 export async function signInWithWeChat() {
-  return null;
+  const code = await wechat.authorize();
+  const account = await verifyWeChatCode(code);
+  return getSession(account.userId);
 }
diff --git a/src/api/session.ts b/src/api/session.ts
--- a/src/api/session.ts
+++ b/src/api/session.ts
@@ -12,3 +12,6 @@
 export function validateSession(session) {
+  if (session.expiresAt < Date.now()) {
+    return { valid: false, reason: 'expired' };
+  }
   return { valid: true };
 }
diff --git a/src/components/Login.vue b/src/components/Login.vue
--- a/src/components/Login.vue
+++ b/src/components/Login.vue
@@ -1,3 +1,5 @@
 <template>
-  <button>Sign in</button>
+  <button @click="signInWithApple">Continue with Apple</button>
+  <button @click="signInWithWeChat">Continue with WeChat</button>
+  <p>Your existing account stays with you.</p>
 </template>
`,
  };
  const runs: DaemonRunSummary[] = [
    {
      ...running.evidence.run,
      runId: "712bdbd3-48e2-45d1-947e-f4f865488610",
      goal: "Refine the session validation",
    },
    { ...panel.evidence.run, goal: panel.evidence.handoff.context.goal },
    {
      ...panel.evidence.run,
      runId: "712bdbd3-48e2-45d1-947e-f4f865488612",
      projectId: panel.projects[1]?.project.id ?? first.project.id,
      goal: "Improve the appointment summary",
      status: "completed",
      createdAt: "2026-09-09T09:03:00.000Z",
      updatedAt: "2026-09-09T09:07:26.000Z",
    },
    {
      ...panel.evidence.run,
      runId: "712bdbd3-48e2-45d1-947e-f4f865488613",
      projectId: panel.projects[2]?.project.id ?? first.project.id,
      goal: "Preserve photo metadata on export",
      status: "failed",
      createdAt: "2026-09-09T08:10:00.000Z",
      updatedAt: "2026-09-09T08:13:09.000Z",
    },
  ];
  return {
    data: { projects: panel.projects, runs, issues: [], hasMore: false },
    project: {
      project: first.project,
      readiness: { ready: true, message: "Native Codex is using its existing login." },
    },
    evidence: panel.evidence,
    route:
      name === "project"
        ? `/projects/${first.project.id}`
        : ["run", "failed"].includes(name)
          ? `/projects/${first.project.id}/runs/${panel.evidence.run.runId}`
          : `/${name}`,
  } satisfies Pick<WorkspaceViewProps, "data" | "route" | "project" | "evidence">;
}
