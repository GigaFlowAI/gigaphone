/** Harness-adapter registry. New harness = register an adapter; everything else is shared. */

import type { HarnessAdapter } from "../../interfaces/harnessAdapter.js";
import { ClaudeCodeAdapter } from "./claudeCode.js";
import { CodexAdapter } from "./codex.js";

const _HARNESSES: Record<string, HarnessAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
};

export function harnessById(harnessId: string): HarnessAdapter | undefined {
  return _HARNESSES[harnessId];
}

export function allHarnesses(): HarnessAdapter[] {
  return Object.values(_HARNESSES);
}
