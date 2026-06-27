/**
 * Codex harness adapter (DESIGN §6).
 *
 * Same shared substrate as Claude Code; the divergent bits are the plugin manifest format
 * (+ `agents/openai.yaml`) and that Codex runs **command hooks only** — which is why the
 * hooks are plain shell commands in the single manifest source.
 */

import { HarnessAdapter } from "../../interfaces/harnessAdapter.js";
import { type CodexRender, PLUGIN, renderCodex } from "./manifest.js";

export class CodexAdapter extends HarnessAdapter {
  readonly id = "codex";

  package(): CodexRender {
    return renderCodex();
  }

  skillFrontmatter(): Record<string, unknown> {
    return { name: PLUGIN.name, description: PLUGIN.description };
  }

  registerMcp(): null {
    // The plugin ships no MCP server — the skill drives the engine via the CLI.
    return null;
  }

  hook(event: string, command: string): unknown {
    // Codex command-only hook.
    return { on: event, run: command };
  }

  drive(_task: unknown): never {
    throw new Error(
      "The engine never calls a model. The live Codex harness drives its own model " +
        "to fulfil the discovery/resolution protocols (see SKILL.md, ADR-0006).",
    );
  }

  presentDiff(diff: unknown): string {
    return String(diff);
  }
}
