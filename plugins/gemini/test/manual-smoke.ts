import { GeminiAdapter } from "../src/index.js";
import { visionModels } from "../src/input.js";
import { png } from "./fixtures.js";

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const model = args[0];
  if (
    process.env.VEYRA_LIVE_SMOKE !== "1" ||
    !process.env.GEMINI_API_KEY?.trim() ||
    args.length !== 1 ||
    !model
  ) {
    console.error(
      "Set VEYRA_LIVE_SMOKE=1 and GEMINI_API_KEY, then run: pnpm --filter @veyraoss/gemini smoke -- <model>",
    );
    return 2;
  }
  const adapter = new GeminiAdapter({ model });
  const goal = 'Correct the supplied sentence "Hello wrld." to "Hello world."';
  const plan = await adapter.run({ runId: "gemini-smoke", stepId: "plan", role: "planner", goal });
  if (plan.status !== "success") {
    console.error(`Planner smoke failed: ${plan.summary}`);
    return 1;
  }
  const review = await adapter.run({
    runId: "gemini-smoke",
    stepId: "review",
    role: "reviewer",
    goal,
    context: { plan: plan.data ?? {}, proposedSentence: "Hello world." },
  });
  if (review.status !== "success" || review.outcome !== "pass") {
    console.error(`Reviewer smoke failed: ${review.summary}`);
    return 1;
  }
  let vision: "passed" | "not-enabled-for-model" = "not-enabled-for-model";
  if (visionModels.includes(model.replace(/^models\//, ""))) {
    const visual = await new GeminiAdapter({ model, vision: true }).run({
      runId: "gemini-smoke",
      stepId: "visual-plan",
      role: "planner",
      goal: "Plan a CSS background change to match the supplied pixel image. Include the observed color in your instructions.",
      context: { images: [{ mimeType: "image/png", data: png }] },
    });
    if (
      visual.status !== "success" ||
      typeof visual.data?.instructions !== "string" ||
      !/white|#ffffff|#fff\b/i.test(visual.data.instructions)
    ) {
      console.error(`Image smoke failed: ${visual.summary}`);
      return 1;
    }
    vision = "passed";
  }
  console.log(
    JSON.stringify({
      planner: plan.status,
      reviewer: review.status,
      outcome: review.outcome,
      vision,
      plannerUsage: plan.usage,
      reviewerUsage: review.usage,
    }),
  );
  return 0;
}
process.exitCode = await main();
