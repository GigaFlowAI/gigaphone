/**
 * Native Logfire backend adapter (DESIGN §9).
 *
 * Logfire is in the OTel family: `logfire.configure()` installs a global OTel
 * `TracerProvider`, so the OTel adapter's fix routing, expectations, and span-file `verify`
 * apply unchanged (DESIGN §9: "reuse most fix logic within a family"). Only the
 * vendor-divergent surface is overridden: SDK detection, config, the init snippet, and the
 * runtime shim the fixes import (`gigaphone.runtime.logfire`).
 */

import { OtelAdapter, pyRepr, scanForAny } from "./otel/adapter.js";

/** Python repr() of a string: single-quoted with backslash/quote escaping. */

export class LogfireAdapter extends OtelAdapter {
  override readonly id = "logfire";
  // Identical placement + call sites as the OTel family; only the imported shim (per
  // language) and the backend id differ. The whole primitiveFor / verify surface is
  // inherited from OtelAdapter, which reads this.shimPackages + this.id.
  override shimPackages: Record<string, string> = {
    python: "gigaphone.runtime.logfire",
    typescript: "@gigaphone/logfire",
  };

  override detectPresence(repo: string): boolean {
    return scanForAny(repo, [".py"], (t) => t.includes("logfire"));
  }

  override configSchema(): Record<string, string> {
    return { token: "LOGFIRE_TOKEN", service_name: "logical service name" };
  }

  override initSnippet(config: Record<string, string>): string {
    const service = config.service_name;
    const arg = service ? `service_name=${pyRepr(service)}` : "";
    return `import logfire\nlogfire.configure(${arg})\n`;
  }
}
