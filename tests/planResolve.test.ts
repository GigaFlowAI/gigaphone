/**
 * Plan + resolve unit tests (DESIGN §5, §11). Ported from the plan/resolve assertions in
 * tests/test_agent_call.py: the unresolved wording (incl. "sub-agent" for agent_call), the
 * resolution ingest → Descriptor with agent_call kind, and round-trips.
 */

import { describe, expect, it } from "vitest";
import { BoundaryKind } from "../src/core/boundary.js";
import { Boundary, Descriptor, Range } from "../src/core/model.js";
import { buildPlan } from "../src/engine/plan.js";
import { ingestResolution } from "../src/engine/resolve.js";

describe("buildPlan unresolved wording", () => {
  it("test_unresolved_agent_call_uses_agent_wording", () => {
    const desc = new Descriptor({
      id: "agent-x",
      kind: BoundaryKind.AGENT_CALL,
      matchCall: "svc.dispatch_unknown",
    });
    const plan = buildPlan([desc], []); // nothing localized
    expect(plan.unresolved.length).toBe(1);
    expect(plan.unresolved[0]!.question).toContain("sub-agent");
    expect(plan.unresolved[0]!.question).toContain("agent_call");
    expect(plan.unresolved[0]!.descriptorId).toBe("agent-x");
    expect(plan.unresolved[0]!.matchCall).toBe("svc.dispatch_unknown");
  });

  it("non-agent unresolved asks who consumes the result", () => {
    const desc = new Descriptor({
      id: "tool-x",
      kind: BoundaryKind.TOOL_EXEC,
      matchCall: "svc.run_thing",
    });
    const plan = buildPlan([desc], []);
    expect(plan.unresolved.length).toBe(1);
    const q = plan.unresolved[0]!.question;
    expect(q).toContain("consumes its result");
    expect(q).toContain("(tool_exec)");
    expect(q).not.toContain("sub-agent");
  });
});

describe("buildPlan records", () => {
  it("emits one PlanRecord per localized boundary and surfaces only unmatched descriptors", () => {
    const resolved = new Descriptor({
      id: "tool-run",
      kind: BoundaryKind.TOOL_EXEC,
      matchCall: "app.run_code",
    });
    const missing = new Descriptor({
      id: "tool-missing",
      kind: BoundaryKind.TOOL_EXEC,
      matchCall: "app.gone",
    });
    const boundary = new Boundary({
      descriptorId: "tool-run",
      kind: BoundaryKind.TOOL_EXEC,
      path: "app/exec.py",
      funcName: "run_code",
      call: "app.run_code",
      range: new Range("app/exec.py", 100, 120, 7),
      providerOrFramework: "hand_rolled",
      toolsCovered: ["run_code"],
    });

    const plan = buildPlan([resolved, missing], [boundary]);
    expect(plan.records.length).toBe(1);
    expect(plan.records[0]!.boundary).toBe("app/exec.py:7");
    expect(plan.records[0]!.language).toBe("python");
    expect(plan.records[0]!.kind).toBe(BoundaryKind.TOOL_EXEC);
    // resolved descriptor dropped from unresolved; the unmatched one surfaces
    expect(plan.unresolved.map((u) => u.matchCall)).toEqual(["app.gone"]);
  });
});

describe("ingestResolution", () => {
  it("test_resolution_ingests_agent_call_kind", () => {
    const resolution = {
      resolutions: [
        {
          id: "agent-x",
          boundary_call: "svc.dispatch",
          kind: "agent_call",
          complete_output_fields: ["final_output"],
          emit_name: "svc.subagent.custom",
        },
      ],
    };
    const [descriptors, unresolvable] = ingestResolution(resolution);
    expect(descriptors[0]!.kind).toBe(BoundaryKind.AGENT_CALL);
    expect(unresolvable).toEqual([]);
  });

  it("round-trips boundary_call → Descriptor fields", () => {
    const [descriptors] = ingestResolution({
      resolutions: [
        {
          id: "d1",
          boundary_call: "svc.dispatch",
          kind: "tool_exec",
          complete_output_fields: ["stdout", "stderr"],
          emit_name: "svc.run",
        },
      ],
    });
    const d = descriptors[0]!;
    expect(d.id).toBe("d1");
    expect(d.matchCall).toBe("svc.dispatch");
    expect(d.outputPaths).toEqual(["stdout", "stderr"]);
    expect(d.emitName).toBe("svc.run");
  });

  it("defaults id to the call and kind to tool_exec", () => {
    const [descriptors] = ingestResolution({
      resolutions: [{ boundary_call: "svc.x" }],
    });
    expect(descriptors[0]!.id).toBe("svc.x");
    expect(descriptors[0]!.kind).toBe(BoundaryKind.TOOL_EXEC);
  });

  it("reports unresolvable items without dropping them silently", () => {
    const [descriptors, unresolvable] = ingestResolution({
      resolutions: [
        { id: "u1", unresolvable: true },
        { id: "u2" }, // no boundary_call
        { id: "ok", boundary_call: "svc.y" },
      ],
    });
    expect(descriptors.length).toBe(1);
    expect(unresolvable).toEqual(["u1", "u2"]);
  });
});
