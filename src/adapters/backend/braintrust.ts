/**
 * Native Braintrust backend adapter (DESIGN §9).
 *
 * Braintrust is in the contextvars-native family, so it reuses the OTel adapter's fix
 * routing, expectations, and span-file `verify` (DESIGN §9: "reuse most fix logic within a
 * family"). Only the vendor-divergent surface is overridden: SDK detection, config, the init
 * snippet, and the runtime shim the fixes import (`gigaphone.runtime.braintrust`).
 */

import { OtelAdapter, pyRepr, scanForAny } from "./otel/adapter.js";

/** Python repr() of a string: single-quoted with backslash/quote escaping. */

export class BraintrustAdapter extends OtelAdapter {
  override readonly id = "braintrust";
  // Identical placement + call sites as the OTel family; only the imported shim (per
  // language) and the backend id differ. The whole primitiveFor / verify surface is
  // inherited from OtelAdapter, which reads this.shimPackages + this.id.
  override shimPackages: Record<string, string> = {
    python: "gigaphone.runtime.braintrust",
    typescript: "@gigaphone/braintrust",
  };

  override detectPresence(repo: string): boolean {
    return scanForAny(repo, [".py"], (t) => t.includes("braintrust"));
  }

  override configSchema(): Record<string, string> {
    return { project: "Braintrust project name", api_key: "BRAINTRUST_API_KEY" };
  }

  override initSnippet(config: Record<string, string>): string {
    const project = config.project ?? "${BRAINTRUST_PROJECT}";
    return `import braintrust\nbraintrust.init_logger(project=${pyRepr(project)})\n`;
  }
}
