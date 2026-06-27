#!/usr/bin/env node
/**
 * GigaPhone CLI — the harness-neutral engine entrypoint (ADR-0006).
 *
 * Standalone so any harness, CI, or a human can drive it. The committed boundary config is
 * the source of truth between invocations (ADR-0004); commands re-derive from config + code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { selectBackend } from "./adapters/backend/registry.js";
import { bundledAdapters } from "./adapters/codebase/registry.js";
import { SCAFFOLD_FILENAME, scaffoldSource } from "./adapters/codebase/scaffold.js";
import * as config from "./config/config.js";
import type { Boundary } from "./core/model.js";
import { detect } from "./engine/detect.js";
import { discover } from "./engine/discover.js";
import * as fix from "./engine/fix.js";
import { buildPlan } from "./engine/plan.js";
import * as report from "./engine/report.js";
import { ingestResolution } from "./engine/resolve.js";
import { applyReview } from "./engine/review.js";
import * as verifyEngine from "./engine/verify.js";
import type { VerifyBackend } from "./engine/verify.js";
import type { CodebaseAdapter } from "./interfaces/codebaseAdapter.js";
import { packForPath } from "./packs/registry.js";

const COMMANDS: Array<[string, string]> = [
  ["discover", "scan (optionally --scope) → propose boundary descriptors → write config"],
  ["detect", "run language-pack queries for confirmed anchors → candidate boundaries"],
  ["plan", "emit plan records (+ an unresolved[] list)"],
  ["resolve", "ingest an agent-supplied resolution.json for an unresolved boundary"],
  [
    "review",
    "ingest a harness review.json: reject false positives" +
      " + add missed boundaries → rewrite config",
  ],
  ["fix", "apply codemods via the backend adapter + language pack; emit diffs"],
  ["verify", "backend-adapter verify against the live project"],
  ["onboard", "run discover → fix → verify and print the onboarding report"],
  ["codebase", "scaffold/list codebase adapters (codebase init <name> | codebase list)"],
];

/** Bundled codebase adapters whose detect() claims this repo (sync; OSS adapters auto-activate). */
function activeCodebaseAdapters(repo: string): CodebaseAdapter[] {
  return bundledAdapters().filter((a) => a.detect(repo));
}

interface Args {
  command: string | null;
  version: boolean;
  repo: string;
  backend: string | null;
  scope: string | null;
  module: string;
  apply: boolean;
  positional: string[];
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function helpText(): string {
  const lines = [
    "usage: gigaphone [--version] <command> ...",
    "",
    "Trace-coverage instrumentation for AI agent codebases " +
      "(neutral across harness, language, vendor, codebase).",
    "",
    "commands:",
  ];
  for (const [name, summary] of COMMANDS) lines.push(`  ${name.padEnd(10)} ${summary}`);
  return lines.join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null,
    version: false,
    repo: ".",
    backend: null,
    scope: null,
    module: "app.run_representative",
    apply: false,
    positional: [],
  };
  let i = 0;
  // top-level flags before a command
  while (i < argv.length && argv[i]!.startsWith("-")) {
    const tok = argv[i]!;
    if (tok === "--version") {
      args.version = true;
      i++;
    } else if (tok === "-h" || tok === "--help") {
      args.command = null;
      return args;
    } else {
      break;
    }
  }
  if (i >= argv.length) return args;
  args.command = argv[i]!;
  i++;

  const takeValue = (tok: string): string => {
    const eq = tok.indexOf("=");
    if (eq !== -1) return tok.slice(eq + 1);
    i++;
    return argv[i] ?? "";
  };

  for (; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--repo")) args.repo = takeValue(tok);
    else if (tok.startsWith("--backend")) args.backend = takeValue(tok);
    else if (tok.startsWith("--scope")) args.scope = takeValue(tok);
    else if (tok.startsWith("--module")) args.module = takeValue(tok);
    else if (tok === "--apply") args.apply = true;
    else if (tok.startsWith("-")) throw new Error(`unrecognized argument: ${tok}`);
    else args.positional.push(tok);
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write(`gigaphone ${version()}\n`);
    return 0;
  }
  if (!args.command) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  const handlers: Record<string, (a: Args) => number> = {
    discover: cmdDiscover,
    detect: cmdDetect,
    plan: cmdPlan,
    resolve: cmdResolve,
    review: cmdReview,
    fix: cmdFix,
    verify: cmdVerify,
    onboard: cmdOnboard,
    codebase: cmdCodebase,
  };
  const handler = handlers[args.command];
  if (!handler) {
    process.stderr.write(`gigaphone: unknown command '${args.command}'\n`);
    return 2;
  }
  try {
    return handler(args);
  } catch (exc) {
    // surface the failure loudly (golden principle 8)
    const msg = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`gigaphone ${args.command}: ${msg}\n`);
    return 1;
  }
}

function cmdCodebase(args: Args): number {
  const sub = args.positional[0];
  if (sub === "init") {
    const name = args.positional[1];
    if (!name) {
      process.stderr.write("usage: gigaphone codebase init <name>\n");
      return 2;
    }
    const dest = join(args.repo, SCAFFOLD_FILENAME);
    if (existsSync(dest)) {
      process.stderr.write(`refusing to overwrite existing ${SCAFFOLD_FILENAME}\n`);
      return 1;
    }
    writeFileSync(dest, scaffoldSource(name), "utf-8");
    process.stdout.write(
      `Wrote ${SCAFFOLD_FILENAME} — fill in detect()/discover() with knowledge of '${name}'.\n`,
    );
    return 0;
  }
  if (sub === "list") {
    const active = new Set(activeCodebaseAdapters(args.repo).map((a) => a.id));
    process.stdout.write("bundled codebase adapters:\n");
    for (const a of bundledAdapters()) {
      process.stdout.write(`  ${a.id}${active.has(a.id) ? "  (detected in this repo)" : ""}\n`);
    }
    process.stdout.write(
      `proprietary: add a default-exported adapter at ${SCAFFOLD_FILENAME} (gigaphone codebase init <name>).\n`,
    );
    return 0;
  }
  process.stderr.write("usage: gigaphone codebase <init|list> ...\n");
  return 2;
}

function cmdDiscover(args: Args): number {
  const descriptors = discover(
    args.repo,
    args.scope ?? undefined,
    activeCodebaseAdapters(args.repo),
  );
  const path = config.save(args.repo, descriptors);
  process.stdout.write(`discovered ${descriptors.length} boundary descriptor(s) → ${path}\n`);
  for (const d of descriptors) {
    process.stdout.write(`  [${d.kind}] ${d.matchCall}  → emit ${d.emitName}\n`);
  }
  return 0;
}

function cmdDetect(args: Args): number {
  const descriptors = config.load(args.repo);
  const boundaries = detect(args.repo, descriptors, args.scope ?? undefined);
  for (const b of boundaries) {
    const modes = b.failureModes.join(",") || "covered";
    process.stdout.write(`  ${b.path}:${b.range.line} ${b.funcName} [${b.kind}] ${modes}\n`);
  }
  return 0;
}

function cmdPlan(args: Args): number {
  const descriptors = config.load(args.repo);
  const boundaries = detect(args.repo, descriptors, args.scope ?? undefined);
  const plan = buildPlan(descriptors, boundaries);
  process.stdout.write(
    JSON.stringify(
      {
        records: plan.records.map((r) => r.toDict()),
        unresolved: plan.unresolved.map((u) => ({
          descriptor_id: u.descriptorId,
          match_call: u.matchCall,
          question: u.question,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

function cmdResolve(args: Args): number {
  const resolutionPath = args.positional[0];
  if (!resolutionPath) throw new Error("the following arguments are required: resolution");
  const resolution = JSON.parse(readFileSync(resolutionPath, "utf-8"));
  const [newDescriptors, unresolvable] = ingestResolution(resolution);
  const existing = new Map(config.load(args.repo).map((d) => [d.matchCall, d]));
  for (const d of newDescriptors) existing.set(d.matchCall, d);
  config.save(args.repo, [...existing.values()]);
  process.stdout.write(
    `resolved ${newDescriptors.length} boundary(ies); ${unresolvable.length} still unresolvable\n`,
  );
  for (const uid of unresolvable) process.stderr.write(`  ! unresolvable: ${uid}\n`);
  return 0;
}

function cmdReview(args: Args): number {
  const reviewPath = args.positional[0];
  if (!reviewPath) throw new Error("the following arguments are required: review");
  const review = JSON.parse(readFileSync(reviewPath, "utf-8"));
  const descriptors = config.load(args.repo);
  const [updated, summary] = applyReview(descriptors, review);
  config.save(args.repo, updated);
  process.stdout.write(
    `review applied: -${summary.rejected.length} rejected, ` +
      `+${summary.added.length} added, ${summary.kept} kept → ` +
      `${config.configPath(args.repo)}\n`,
  );
  for (const rid of summary.rejected) process.stdout.write(`  - rejected: ${rid}\n`);
  for (const call of summary.added) process.stdout.write(`  + added: ${call}\n`);
  return 0;
}

function cmdFix(args: Args): number {
  const descriptors = config.load(args.repo);
  const boundaries = detect(args.repo, descriptors, args.scope ?? undefined);
  const backend = selectBackend(args.repo, args.backend ?? undefined);
  if (args.apply) {
    const result = fix.applyFixes(args.repo, boundaries, backend);
    for (const diff of Object.values(result.diffs)) process.stdout.write(diff + "\n");
    const n = Object.keys(result.diffs).length;
    process.stdout.write(
      `applied ${n} file edit(s); ${result.skippedIdempotent} idempotent skip(s)\n`,
    );
  } else {
    const result = fix.planFixes(args.repo, boundaries, backend);
    for (const e of result.edits) process.stdout.write(`  would fix: ${e.description}\n`);
  }
  return 0;
}

// LLM gateway, tool, and sub-agent boundaries are verified — every call in the agent loop.
const VERIFIABLE = new Set(["tool_exec", "agent_call", "llm"]);

/** The language of the boundaries (drives how `verify` launches the representative path). */
function langOf(repo: string, boundaries: Boundary[]): string {
  for (const b of boundaries) {
    const pack = packForPath(join(repo, b.path));
    if (pack !== null) return pack.id;
  }
  return "python";
}

function cmdVerify(args: Args): number {
  const descriptors = config.load(args.repo);
  const boundaries = detect(args.repo, descriptors, undefined);
  const backend = selectBackend(args.repo, args.backend ?? undefined);
  const lang = langOf(args.repo, boundaries);
  const entry = lang !== "python" ? args.module : null;
  const expectations = boundaries
    .filter((b) => VERIFIABLE.has(b.kind))
    .map((b) => backend.expectationFor(b));
  const tree = verifyEngine.verifyTree(
    args.repo,
    expectations,
    backend as unknown as VerifyBackend,
    args.module,
    lang,
    entry,
  );
  for (const v of tree.results) {
    process.stdout.write(
      `  ${v.ok ? "✓" : "✗"} [${v.kind}] ${v.tool}: ` +
        `${v.ok ? "nested + complete" : v.detail}\n`,
    );
  }
  process.stdout.write(`  trace tree: ${tree.singleRoot ? "single root ✓" : "multiple roots ✗"}\n`);
  return tree.ok ? 0 : 1;
}

function cmdOnboardDiscover(args: Args) {
  return discover(args.repo, args.scope ?? undefined, activeCodebaseAdapters(args.repo));
}

function cmdOnboard(args: Args): number {
  const backend = selectBackend(args.repo, args.backend ?? undefined);
  const descriptors = cmdOnboardDiscover(args);
  config.save(args.repo, descriptors);
  const boundaries = detect(args.repo, descriptors, args.scope ?? undefined);
  const plan = buildPlan(descriptors, boundaries);
  const lang = langOf(args.repo, boundaries);
  const entry = lang !== "python" ? args.module : null;
  const expectations = boundaries
    .filter((b) => VERIFIABLE.has(b.kind))
    .map((b) => backend.expectationFor(b));
  const fixResult = fix.applyFixes(args.repo, boundaries, backend);
  const tree = verifyEngine.verifyTree(
    args.repo,
    expectations,
    backend as unknown as VerifyBackend,
    args.module,
    lang,
    entry,
  );
  process.stdout.write(
    report.render({
      harness: "cli",
      language: lang,
      backend: backend.id,
      plan,
      verifyResults: tree.results,
      traceLink: null,
    }) + "\n",
  );
  const paths = report.writeDocs(args.repo, {
    harness: "cli",
    language: lang,
    backend: backend.id,
    descriptors,
    plan,
    fixResult,
    tree,
  });
  const rels = paths.map((p) => relative(args.repo, p));
  process.stdout.write("Wrote " + rels.join(" and ") + "\n");
  return tree.results.length && tree.results.every((r) => r.ok) ? 0 : 1;
}

// run when invoked directly
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
