// Tool implementations for the TypeScript onboarding e2e. Both are *untraced* consumption
// boundaries registered in a TOOLS map — GigaPhone discovers them and wraps each body in a
// span so the tool output lands nested under the agent trace.

type ExecResult = { stdout: string; stderr: string; exitCode: number };
type SearchResult = { hits: string[]; count: number };

export function runCode(code: string): ExecResult {
  const stdout = `ran(${code})`;
  return { stdout, stderr: "", exitCode: 0 };
}

export function webSearch(query: string): SearchResult {
  const hits = [`result for ${query}`, `also: ${query}`];
  return { hits, count: hits.length };
}

export const TOOLS: Record<string, Function> = {
  run_code: runCode,
  web_search: webSearch,
};
