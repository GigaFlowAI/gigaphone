/**
 * Claude Code harness adapter (DESIGN §6).
 *
 * Only the harness-specific surface lives here: packaging (plugin manifest + marketplace),
 * skill frontmatter, MCP wiring, event hooks, and diff presentation. The SKILL.md *body*,
 * MCP server, packs, and codemods are all shared. `drive` is intentionally not the engine's
 * job — the live harness fulfils the discovery/resolution protocols (ADR-0006).
 */

import { HarnessAdapter } from "../../interfaces/harnessAdapter.js";
import { PLUGIN, type ClaudeCodeRender, renderClaudeCode } from "./manifest.js";

export class ClaudeCodeAdapter extends HarnessAdapter {
  readonly id = "claude-code";

  package(): ClaudeCodeRender {
    return renderClaudeCode();
  }

  skillFrontmatter(): Record<string, unknown> {
    // Claude Code reads name + description; the body is the shared SKILL.md.
    return { name: PLUGIN.name, description: PLUGIN.description };
  }

  registerMcp(): null {
    // The plugin ships no MCP server — the skill drives the engine via the CLI.
    return null;
  }

  hook(_event: string, command: string): unknown {
    // hooks/hooks.json shape — the map is wrapped under a top-level "hooks" key.
    return {
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command }] },
        ],
      },
    };
  }

  drive(_task: unknown): never {
    throw new Error(
      "The engine never calls a model. The live Claude Code harness drives its own " +
        "model to fulfil the discovery/resolution protocols (see SKILL.md, ADR-0006).",
    );
  }

  presentDiff(diff: unknown): string {
    // Claude Code renders unified diffs natively in its approval UX.
    return String(diff);
  }
}
