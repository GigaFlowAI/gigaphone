// A tiny agent loop that consumes the tool boundaries. It is NOT itself a boundary (no
// execution sink, not in the TOOLS map) — it just exercises each tool once.

import { runCode, webSearch } from "./tools.ts";

export async function runAgent(task: string): Promise<string> {
  const code = runCode(`solve:${task}`);
  const search = webSearch(task);
  return `${code.stdout} | ${search.count} hits`;
}
