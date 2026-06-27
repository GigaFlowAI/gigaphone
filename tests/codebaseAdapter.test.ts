/**
 * CodebaseAdapter axis (ADR-0010): the scaffold stub, the bundled OpenHands example, the
 * discovery union (authored knowledge takes precedence over generic heuristics), repo-local
 * proprietary loading, and detect-based selection.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectAdapters,
  loadRepoAdapter,
  OpenHandsAdapter,
  SCAFFOLD_FILENAME,
  scaffoldSource,
} from "../src/adapters/codebase/index.js";
import { BoundaryKind } from "../src/core/boundary.js";
import { Descriptor } from "../src/core/model.js";
import { discover } from "../src/engine/discover.js";
import { CodebaseAdapter } from "../src/interfaces/codebaseAdapter.js";

function tmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gigaphone_cb_"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
  return root;
}

describe("CodebaseAdapter scaffold", () => {
  it("generates a fillable stub: extends CodebaseAdapter, required detect, default export", () => {
    const src = scaffoldSource("arcanist");
    expect(SCAFFOLD_FILENAME).toBe("gigaphone.codebase.ts");
    expect(src).toContain("export default class ArcanistAdapter extends CodebaseAdapter");
    expect(src).toContain('readonly id = "arcanist"');
    expect(src).toContain("detect(repo: string): boolean");
    expect(src).toContain('from "gigaphone/interfaces"');
    expect(src).toContain("override discover(");
    expect(src).toContain("override redactionModel(");
  });
});

describe("bundled OpenHands example", () => {
  it("detects a repo that references openhands", () => {
    const yes = tmpRepo({ "svc.py": "from openhands.sdk import Agent\n" });
    const no = tmpRepo({ "svc.py": "import os\n" });
    expect(new OpenHandsAdapter().detect(yes)).toBe(true);
    expect(new OpenHandsAdapter().detect(no)).toBe(false);
  });

  it("recognizes the conversations-POST dispatch as an agent_call", () => {
    const source =
      "from openhands.sdk import Agent\n" +
      "import httpx\n\n" +
      "def start_conversation(task, client):\n" +
      "    req = _build(task)\n" +
      "    return client.post('http://a/api/conversations', json=req)\n";
    const descs = new OpenHandsAdapter().discover("service.py", source);
    expect(descs.length).toBe(1);
    expect(descs[0]!.kind).toBe(BoundaryKind.AGENT_CALL);
    expect(descs[0]!.matchCall).toBe("service.start_conversation");
    expect(descs[0]!.emitName).toBe("service.subagent.openhands");
    expect(descs[0]!.outputPaths).toEqual(["events", "final_message"]);
  });
});

describe("discovery union with codebase adapters", () => {
  class StubAdapter extends CodebaseAdapter {
    readonly id = "stub";
    detect(): boolean {
      return true;
    }
    override discover(path: string, source: string): Descriptor[] {
      if (path.endsWith("svc.ts") && source.includes("MAGIC_DISPATCH")) {
        return [
          new Descriptor({
            id: "stub-dispatch",
            kind: BoundaryKind.AGENT_CALL,
            matchCall: "svc.dispatch",
            emitName: "svc.subagent.stub",
          }),
        ];
      }
      return [];
    }
  }

  it("unions the adapter's bespoke descriptors into Phase A (no python required)", () => {
    const root = tmpRepo({
      "svc.ts": "// MAGIC_DISPATCH\nexport function dispatch(task: string) { return task; }\n",
    });
    const withAdapter = discover(root, undefined, [new StubAdapter()]);
    expect(withAdapter.some((d) => d.matchCall === "svc.dispatch" && d.kind === "agent_call")).toBe(
      true,
    );
    // and without the adapter the bespoke boundary is not discovered
    const without = discover(root);
    expect(without.some((d) => d.matchCall === "svc.dispatch")).toBe(false);
  });
});

describe("registry: detect + repo-local proprietary loading", () => {
  it("detectAdapters returns the bundled openhands adapter for an openhands repo", async () => {
    const root = tmpRepo({ "svc.py": "from openhands.sdk import Agent\n" });
    const adapters = await detectAdapters(root);
    expect(adapters.some((a) => a.id === "openhands")).toBe(true);
  });

  it("loads a repo-local gigaphone.codebase.mjs (proprietary adapter) by convention", async () => {
    const root = mkdtempSync(join(tmpdir(), "gigaphone_local_"));
    // a self-contained proprietary adapter (duck-typed; would extend CodebaseAdapter in practice)
    writeFileSync(
      join(root, "gigaphone.codebase.mjs"),
      "export default class ArcanistAdapter {\n" +
        '  id = "arcanist";\n' +
        "  detect(repo) { return true; }\n" +
        "  scope() { return []; }\n" +
        "  discover() { return []; }\n" +
        "  redactionModel() { return [{ field: 'headers.authorization', reason: 'credentials' }]; }\n" +
        "  processBoundaries() { return []; }\n" +
        "}\n",
    );
    const local = await loadRepoAdapter(root);
    expect(local).not.toBeNull();
    expect(local!.id).toBe("arcanist");
    expect(local!.redactionModel()).toEqual([
      { field: "headers.authorization", reason: "credentials" },
    ]);
    const detected = await detectAdapters(root);
    expect(detected.some((a) => a.id === "arcanist")).toBe(true);
  });
});
