import type { ConsensusMode } from "./index.js";

/** Technical errors never count as votes or allow a judge to bypass missing reviews. */
export function aggregateReviews(
  mode: ConsensusMode,
  reviews: readonly ("pass" | "fail" | "error")[],
  quorum?: number,
  judge?: "pass" | "fail" | "error",
): "pass" | "fail" {
  if (
    reviews.length < 2 ||
    reviews.length > 32 ||
    reviews.some((vote) => vote !== "pass" && vote !== "fail")
  )
    return "fail";
  if (mode === "judge") return judge === "pass" ? "pass" : "fail";
  const passes = reviews.filter((vote) => vote === "pass").length;
  if (mode === "quorum")
    return quorum !== undefined &&
      Number.isSafeInteger(quorum) &&
      quorum >= 1 &&
      quorum <= reviews.length &&
      passes >= quorum
      ? "pass"
      : "fail";
  return mode === "all-pass" && passes === reviews.length ? "pass" : "fail";
}
