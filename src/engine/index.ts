/** Engine entrypoints (DESIGN §5, §8, §11, §12) — harness-neutral orchestration. */

export * as project from "./project.js";
export * as discover from "./discover.js";
export * as detect from "./detect.js";
export * as plan from "./plan.js";
export * as resolve from "./resolve.js";
export * as fix from "./fix.js";
export * as verify from "./verify.js";
export * as review from "./review.js";
export * as report from "./report.js";

export { discover as discoverBoundaries } from "./discover.js";
export { detect as detectBoundaries } from "./detect.js";
export { buildPlan, Plan, type Unresolved } from "./plan.js";
export { ingestResolution, type Resolution, type ResolutionItem } from "./resolve.js";
export {
  applyFixes,
  applyHunks,
  planFixes,
  FixResult,
} from "./fix.js";
export { verify as verifyBoundaries, verifyTree, type VerifyBackend } from "./verify.js";
export { applyReview, type Review, type ReviewAdd, type ReviewSummary } from "./review.js";
export {
  render,
  renderReportMd,
  renderArchitectureMd,
  writeDocs,
} from "./report.js";
export { scan, read, type SourceFile } from "./project.js";
