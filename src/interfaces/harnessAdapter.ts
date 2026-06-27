/**
 * HarnessAdapter interface — the *harness* axis (DESIGN §6, ADR-0002).
 *
 * The entire harness-specific surface; everything else — the SKILL.md body, language packs,
 * codemods, specs, plan records — is shared. The divergent bits are the manifest and hooks.
 * Keep hooks to plain shell commands (Codex runs command hooks only) and generate every
 * manifest from one source.
 *
 * Ships `claude_code` + `codex` under `adapters/harness/`.
 */

export abstract class HarnessAdapter {
  abstract readonly id: string; // "claude-code" | "codex" | ...

  /** Produce the install artifact for this harness (plugin manifest / marketplace entry). */
  abstract package(): unknown;

  /** Harness-specific SKILL.md frontmatter. The body is shared across harnesses. */
  abstract skillFrontmatter(): Record<string, unknown>;

  /** Wire the shared MCP verifier into this harness (null — no MCP server is shipped). */
  abstract registerMcp(): unknown;

  /** Render a post-edit / verify hook in this harness's format (plain shell command). */
  abstract hook(event: string, command: string): unknown;

  /**
   * Invoke the harness's own model to fulfil the discovery/resolution protocols. The engine
   * itself never calls a model (ADR-0006) — concrete adapters throw to signal this.
   */
  abstract drive(task: unknown): unknown;

  /** Surface proposed edits via the harness's approval/diff UX. */
  abstract presentDiff(diff: unknown): unknown;
}
