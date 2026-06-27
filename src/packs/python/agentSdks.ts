/**
 * Agent-SDK catalog — seed family B (DESIGN §8.4). Port of `agent_sdks.py`.
 *
 * Finite, enumerable signatures for frameworks that dispatch a whole sub-agent. Data, not
 * heuristics: tools can be any function and so are never seeded, but agent SDKs are a closed
 * set. The sub-agent itself is a black box by ownership — we recognize the *dispatch*, never
 * its internals.
 */

export interface AgentSdk {
  id: string;
  framework: string;
  /** dotted-suffix call signatures, e.g. "Runner.run", ".invoke" */
  calls: readonly string[];
  /** constructed symbols that signal an agent, e.g. "Agent" */
  constructs: readonly string[];
  /** outbound carriers paired with a construct, e.g. ".post" */
  carriers: readonly string[];
  /** package names for provenance lookups, e.g. "agents", "langgraph" */
  packages: readonly string[];
  inputArg: string | null;
  outputFields: readonly string[];
}

function sdk(
  id: string,
  framework: string,
  opts: {
    calls?: readonly string[];
    constructs?: readonly string[];
    carriers?: readonly string[];
    packages?: readonly string[];
    inputArg?: string | null;
    outputFields?: readonly string[];
  } = {},
): AgentSdk {
  return {
    id,
    framework,
    calls: opts.calls ?? [],
    constructs: opts.constructs ?? [],
    carriers: opts.carriers ?? [],
    packages: opts.packages ?? [],
    inputArg: opts.inputArg ?? null,
    outputFields: opts.outputFields ?? [],
  };
}

export const AGENT_SDKS: readonly AgentSdk[] = [
  sdk("langgraph", "langgraph", {
    calls: [".invoke", ".ainvoke", ".stream"],
    packages: ["langgraph"],
    inputArg: "input",
    outputFields: ["messages"],
  }),
  sdk("openai-agents", "openai-agents", {
    calls: ["Runner.run", "Runner.run_sync"],
    packages: ["agents"],
    outputFields: ["final_output"],
  }),
  sdk("crewai", "crewai", {
    calls: [".kickoff", ".kickoff_async"],
    packages: ["crewai"],
    outputFields: ["raw", "tasks_output"],
  }),
  sdk("llama-index", "llama-index", {
    calls: [".achat", ".run"],
    packages: ["llama_index"],
    outputFields: ["response"],
  }),
  sdk("autogen", "autogen", {
    calls: [".initiate_chat", ".run"],
    packages: ["autogen", "autogen_agentchat"],
    outputFields: ["summary", "chat_history"],
  }),
  // OpenHands: an Agent config is constructed and handed to an outbound HTTP carrier.
  sdk("openhands-sdk", "openhands-sdk", {
    constructs: ["Agent", "StartConversationRequest"],
    packages: ["openhands"],
    carriers: [".post"],
    outputFields: ["events", "final_message"],
  }),
];

/**
 * Return the catalog entry whose `calls` signature matches this call's dotted name.
 *
 * A signature starting with "." matches on the trailing attribute (`graph.invoke` →
 * ".invoke"); otherwise it must be a dotted suffix (`Runner.run`).
 */
export function matchCallSite(dotted: string): AgentSdk | null {
  for (const s of AGENT_SDKS) {
    for (const sig of s.calls) {
      if (sig.startsWith(".")) {
        if (dotted.endsWith(sig) && dotted !== sig.replace(/^\.+/, "")) return s;
      } else if (dotted === sig || dotted.endsWith(`.${sig}`)) {
        return s;
      }
    }
  }
  return null;
}

/** The set of trailing method names from an SDK's call signatures. */
export function methods(s: AgentSdk): Set<string> {
  return new Set(s.calls.map((sig) => sig.split(".").pop() as string));
}

/** The catalog entry matching a package + method combination (provenance-gated). */
export function matchPackageMethod(pkg: string | null, method: string): AgentSdk | null {
  if (!pkg) return null;
  for (const s of AGENT_SDKS) {
    if (s.packages.includes(pkg) && methods(s).has(method)) return s;
  }
  return null;
}

/** The catalog entry matching a construct symbol + package combination (provenance-gated). */
export function matchConstruct(symbol: string, pkg: string | null): AgentSdk | null {
  if (!pkg) return null;
  for (const s of AGENT_SDKS) {
    if (s.constructs.includes(symbol) && s.packages.includes(pkg)) return s;
  }
  return null;
}

/** The set of trailing method names from all carriers in the catalog. */
export function carrierMethods(): Set<string> {
  const out = new Set<string>();
  for (const s of AGENT_SDKS) {
    for (const c of s.carriers) out.add(c.split(".").pop() as string);
  }
  return out;
}

function pyReprTuple(items: readonly string[]): string {
  const inner = items.map((x) => `'${x}'`).join(", ");
  return items.length === 1 ? `(${inner},)` : `(${inner})`;
}

function pyReprStr(s: string): string {
  return `'${s}'`;
}

/**
 * Render a catalog-entry source block an OSS contributor (or the driving harness) can paste
 * into AGENT_SDKS. Mirrors `format_entry` (Python `repr` of the tuples/strings).
 */
export function formatEntry(
  id: string,
  framework: string,
  opts: {
    calls?: readonly string[];
    constructs?: readonly string[];
    carriers?: readonly string[];
    packages?: readonly string[];
    inputArg?: string | null;
    outputFields?: readonly string[];
  } = {},
): string {
  const parts = [`AgentSdk("${id}", "${framework}"`];
  if (opts.calls?.length) parts.push(`calls=${pyReprTuple(opts.calls)}`);
  if (opts.constructs?.length) parts.push(`constructs=${pyReprTuple(opts.constructs)}`);
  if (opts.carriers?.length) parts.push(`carriers=${pyReprTuple(opts.carriers)}`);
  if (opts.packages?.length) parts.push(`packages=${pyReprTuple(opts.packages)}`);
  if (opts.inputArg) parts.push(`input_arg=${pyReprStr(opts.inputArg)}`);
  if (opts.outputFields?.length) parts.push(`output_fields=${pyReprTuple(opts.outputFields)}`);
  return `${parts.join(", ")}),`;
}
