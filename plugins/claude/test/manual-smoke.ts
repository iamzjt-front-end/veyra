import { ClaudeAdapter } from "../src/index.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const model = args[0];
if (
  process.env.VEYRA_LIVE_SMOKE !== "1" ||
  !process.env.ANTHROPIC_API_KEY?.trim() ||
  args.length !== 1 ||
  !model
) {
  console.error(
    "Set VEYRA_LIVE_SMOKE=1 and ANTHROPIC_API_KEY, then run: pnpm --filter @veyra/claude smoke -- <model>",
  );
  process.exitCode = 2;
} else {
  const adapter = new ClaudeAdapter({ model });
  const goal = 'Correct the supplied sentence "Hello wrld." to "Hello world."';
  const plan = await adapter.run({ runId: "claude-smoke", stepId: "plan", role: "planner", goal });
  if (plan.status !== "success") {
    console.error(`Planner smoke failed: ${plan.summary}`);
    process.exitCode = 1;
  } else {
    const review = await adapter.run({
      runId: "claude-smoke",
      stepId: "review",
      role: "reviewer",
      goal,
      context: { plan: plan.data ?? {}, proposedSentence: "Hello world." },
    });
    if (review.status !== "success" || review.outcome !== "pass") {
      console.error(`Reviewer smoke failed: ${review.summary}`);
      process.exitCode = 1;
    } else
      console.log(
        JSON.stringify({
          planner: plan.status,
          reviewer: review.status,
          outcome: review.outcome,
          plannerUsage: plan.usage,
          reviewerUsage: review.usage,
        }),
      );
  }
}
