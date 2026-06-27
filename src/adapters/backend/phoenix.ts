/**
 * Native Arize/Phoenix backend adapter (DESIGN §9).
 *
 * Phoenix (OSS) and Arize (cloud) share the OpenInference/OTel surface and are in the OTel
 * family: `phoenix.otel.register()` / `arize.otel.register()` installs a global OTel
 * `TracerProvider` plus the OpenInference exporter, so the OTel adapter's fix routing,
 * expectations, and span-file `verify` apply unchanged (DESIGN §9). The adapter overrides
 * only the vendor-divergent surface: SDK detection, config, the init snippet, and the runtime
 * shim (`gigaphone.runtime.phoenix`).
 */

import { OtelAdapter, scanForAny } from "./otel/adapter.js";

/** Python repr() of a string: single-quoted with backslash/quote escaping. */
function pyRepr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export class PhoenixAdapter extends OtelAdapter {
  override readonly id = "phoenix";
  // Identical placement + call sites as the OTel family; only the imported shim (per
  // language) and the backend id differ. The whole primitiveFor / verify surface is
  // inherited from OtelAdapter, which reads this.shimPackages + this.id.
  override shimPackages: Record<string, string> = {
    python: "gigaphone.runtime.phoenix",
    typescript: "@gigaphone/phoenix",
  };

  override detectPresence(repo: string): boolean {
    return scanForAny(repo, [".py"], (t) => t.includes("phoenix") || t.includes("arize"));
  }

  override configSchema(): Record<string, string> {
    return {
      endpoint: "Phoenix/Arize collector endpoint (OTLP)",
      project: "PHOENIX_PROJECT_NAME (or Arize space/project)",
      api_key: "PHOENIX_API_KEY / ARIZE_API_KEY",
    };
  }

  override initSnippet(config: Record<string, string>): string {
    const project = config.project ?? "${PHOENIX_PROJECT_NAME}";
    return (
      "from phoenix.otel import register\n" +
      `register(project_name=${pyRepr(project)}, auto_instrument=True)\n`
    );
  }
}
