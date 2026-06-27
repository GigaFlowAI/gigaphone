/**
 * Harness adapters (the harness axis, DESIGN §6).
 *
 * The entire harness-specific surface; everything else is shared. Both v1 harness manifests
 * are generated from ONE source (`manifest.ts`) so they never drift (harness-engineering:
 * generate both manifests from one source).
 */

export { ClaudeCodeAdapter } from "./claudeCode.js";
export { CodexAdapter } from "./codex.js";
export {
  NAME,
  VERSION,
  DESCRIPTION,
  PLUGIN,
  type Plugin,
  type ClaudeCodeRender,
  type CodexRender,
  resolveVersion,
  renderClaudeCode,
  renderCodex,
} from "./manifest.js";
export {
  renderedArtifacts,
  checkArtifacts,
  checkCommitted,
  write,
} from "./packaging.js";
export { harnessById, allHarnesses } from "./registry.js";
