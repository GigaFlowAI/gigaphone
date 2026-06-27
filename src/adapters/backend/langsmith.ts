/**
 * Native LangSmith backend adapter (DESIGN §9).
 *
 * LangSmith is in the contextvars-native family, so it reuses the OTel adapter's fix routing,
 * expectations, and span-file `verify` (DESIGN §9: "reuse most fix logic within a family").
 * Only the vendor-divergent surface is overridden: SDK detection, config, the init snippet,
 * and the runtime shim the fixes import (`gigaphone.runtime.langsmith`).
 */

import { OtelAdapter, scanForAny } from "./otel/adapter.js";

export class LangSmithAdapter extends OtelAdapter {
  override readonly id = "langsmith";
  // Identical placement + call sites as the OTel family; only the imported shim (per
  // language) and the backend id differ. The whole primitiveFor / verify surface is
  // inherited from OtelAdapter, which reads this.shimPackages + this.id.
  override shimPackages: Record<string, string> = {
    python: "gigaphone.runtime.langsmith",
    typescript: "@gigaphone/langsmith",
  };

  override detectPresence(repo: string): boolean {
    return scanForAny(repo, [".py"], (t) => t.includes("langsmith"));
  }

  override configSchema(): Record<string, string> {
    return { project: "LANGCHAIN_PROJECT", api_key: "LANGCHAIN_API_KEY" };
  }

  override initSnippet(_config: Record<string, string>): string {
    return (
      "import langsmith  # tracing is enabled via LANGCHAIN_TRACING_V2=true\n" +
      "_ls_client = langsmith.Client()\n"
    );
  }
}
