# Golden principles

Opinionated, mechanical rules that keep this codebase legible and consistent for every
future agent run. These are *constraints*, not suggestions — boosting trust in
agent-generated code means **constraining** the solution space, not expanding it. Where
a rule can be enforced by a tool, the tool wins over judgment.

## Architecture

1. **Nothing axis-specific in the core.** A harness, language, or vendor detail belongs
   behind its interface (`src/gigaphone/interfaces/`); a codebase detail belongs in
   `gigaphone.boundaries.yaml`. If it names Claude/Codex/Python/Braintrust/a customer
   gateway and sits in the core, it is misplaced. (ADR-0002)
2. **Dependency direction is one-way.** `core → interfaces`. Packs and adapters depend on
   interfaces, never the reverse; the core never imports a concrete pack or adapter by name.
3. **No model calls in the engine.** Reasoning is the harness's job via the JSON protocols.
   (ADR-0006)
4. **Config is authoritative, code is generic.** Don't hardcode a customer's gateway shape;
   discover it into committed config. (ADR-0004)

## Fixes & correctness

5. **No fix without a red fixture.** Every fixable failure mode ships with a *breaking*
   fixture that reproduces the pre-fix loss, so the fix is demonstrable. A fix with no
   failing case to prove it is not done.
6. **No coverage without verification.** A tool counts as covered only after a backend
   `verify()` confirms the span is nested and complete. (ADR-0005)
7. **Edits are idempotent and reviewable.** Codemods never double-wrap (upgrade in place),
   use tree-sitter byte ranges so inserts don't reformat the file, and surface as diffs.
8. **Fail loud on "couldn't resolve."** Never silently skip a boundary. Unresolved →
   resolution protocol or an explicit report. False negatives are the dangerous failure.

## Hygiene

9. **Deterministic tools over LLM judgment**, pushed to the fastest layer that can catch
   the problem: editor/Ruff (ms) → pre-commit (s) → CI (min) → human review.
10. **Don't edit linter/config to silence errors.** Fix the code. `pyproject.toml`'s
    `[tool.ruff]` and test configs are protected.
11. **`AGENTS.md` is a pointer, not a manual.** Routing + commands + prohibitions only;
    everything else lives in code, tests, or ADRs. Keep it under ~50 lines.
12. **Reverse a decision with a new ADR**, never by quietly editing an old one. (ADR-0001)
