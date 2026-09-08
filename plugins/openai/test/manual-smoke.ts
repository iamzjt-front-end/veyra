import { OpenAIAdapter } from "../src/index.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const model = args[0];
if (!process.env.OPENAI_API_KEY || args.length !== 1 || !model) {
  console.error("Set OPENAI_API_KEY and run: pnpm --filter @veyraoss/openai smoke -- <model>");
  process.exitCode = 2;
} else {
  const adapter = new OpenAIAdapter({ model });
  const goal = 'Correct the supplied sentence "Hello wrld." to "Hello world."';
  const planned = await adapter.run({
    runId: "openai-smoke",
    stepId: "plan",
    role: "planner",
    goal,
  });
  if (planned.status !== "success") {
    console.error(`Planner smoke failed: ${planned.summary}`);
    process.exitCode = 1;
  } else {
    const reviewed = await adapter.run({
      runId: "openai-smoke",
      stepId: "review",
      role: "reviewer",
      goal,
      context: { plan: planned.data ?? {}, proposedSentence: "Hello world." },
    });
    if (reviewed.status !== "success" || reviewed.outcome !== "pass") {
      console.error(`Reviewer smoke failed: ${reviewed.summary}`);
      process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify(
          {
            planner: planned.status,
            reviewer: reviewed.status,
            outcome: reviewed.outcome,
            plannerUsage: planned.usage,
            reviewerUsage: reviewed.usage,
          },
          null,
          2,
        ),
      );
    }
  }
}
