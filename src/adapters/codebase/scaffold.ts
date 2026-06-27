/**
 * CodebaseAdapter scaffold — generates the stub a customer (or OSS author) fills in with
 * knowledge of their codebase (ADR-0010). `gigaphone codebase init <name>` writes
 * `gigaphone.codebase.ts` at the repo root; the engine loads its default export and unions
 * its `discover()` into Phase A. `detect` is the only required method.
 */

/** A safe PascalCase class name from an arbitrary adapter id. */
function className(name: string): string {
  const camel = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : "",
  );
  const base = (camel.charAt(0).toUpperCase() + camel.slice(1)) || "Custom";
  return `${base}Adapter`;
}

/** The default filename the engine looks for at the repo root. */
export const SCAFFOLD_FILENAME = "gigaphone.codebase.ts";

/** Render the stub adapter source for `name`. */
export function scaffoldSource(name: string): string {
  const cls = className(name);
  return `/**
 * GigaPhone codebase adapter for "${name}".
 *
 * You know this codebase; GigaPhone doesn't. Fill in the methods below so the auditor anchors
 * the right boundaries (the WHERE) and preserves your intentional redactions. The pipeline
 * (language pack + backend adapter) does the actual instrumenting + verification — you only
 * declare recognition knowledge here, never instrumentation code.
 *
 * \`detect\` is required; everything else is optional and defaults to empty.
 */

import { CodebaseAdapter, type RedactionRule } from "gigaphone/interfaces";
import { Boundary, BoundaryKind, Descriptor } from "gigaphone";

export default class ${cls} extends CodebaseAdapter {
  readonly id = ${JSON.stringify(name)};

  /** Return true only when \`repo\` is the ${name} codebase (signature files, package markers). */
  detect(repo: string): boolean {
    // e.g. existsSync(join(repo, "${name}.config.yaml")) — or scan for a package marker.
    // TODO: implement. Returning false leaves this codebase to generic discovery.
    void repo;
    return false;
  }

  /** Optional: dirs where your gateway / agent loop / tool dispatch live (narrows discovery). */
  override scope(): string[] {
    // e.g. ["src/llm", "src/agent"]
    return [];
  }

  /**
   * Optional: recognize bespoke boundaries that generic dotted-call matching misses — e.g. a
   * factory-built agent dispatch or a registry the matcher can't follow statically.
   */
  override discover(path: string, source: string): Descriptor[] {
    void path;
    void source;
    // Example shape (delete if unused):
    //   if (path.endsWith("dispatch.ts") && source.includes("buildAgent(")) {
    //     return [new Descriptor({
    //       id: "${name}-dispatch",
    //       kind: BoundaryKind.AGENT_CALL,
    //       matchCall: "dispatch.runAgent",
    //       emitName: "${name}.subagent",
    //       outputPaths: ["final_message"],
    //     })];
    //   }
    void BoundaryKind;
    void Descriptor;
    return [];
  }

  /**
   * Optional: fields you intentionally scrub (credentials/PII). The auditor PRESERVES these —
   * a content-capture fix will never un-redact them.
   */
  override redactionModel(): RedactionRule[] {
    // e.g. [{ field: "headers.authorization", reason: "credentials" }]
    return [];
  }

  /** Optional: where data crosses your process boundary (sandbox child→host; class-F reasoning). */
  override processBoundaries(): Boundary[] {
    void Boundary;
    return [];
  }
}
`;
}
