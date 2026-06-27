/**
 * Backend-adapter registry + selection (DESIGN §9).
 *
 * Selection: native SDK present → that adapter; else the generic OTel default tier.
 */

import type { BackendAdapter } from "../../interfaces/backendAdapter.js";
import { BraintrustAdapter } from "./braintrust.js";
import { LangSmithAdapter } from "./langsmith.js";
import { LogfireAdapter } from "./logfire.js";
import { OtelAdapter } from "./otel/adapter.js";
import { PhoenixAdapter } from "./phoenix.js";

const _BACKENDS: Record<string, BackendAdapter> = {
  otel: new OtelAdapter(),
  braintrust: new BraintrustAdapter(),
  langsmith: new LangSmithAdapter(),
  logfire: new LogfireAdapter(),
  phoenix: new PhoenixAdapter(),
};

export function backendById(id: string): BackendAdapter | undefined {
  return _BACKENDS[id];
}

export function selectBackend(repo: string, preferred?: string): BackendAdapter {
  if (preferred && preferred in _BACKENDS) return _BACKENDS[preferred]!;
  // Native SDK present → that adapter; else the generic OTel tier (DESIGN §9).
  for (const native of ["braintrust", "langsmith", "logfire", "phoenix"]) {
    if (_BACKENDS[native]!.detectPresence(repo)) return _BACKENDS[native]!;
  }
  return _BACKENDS.otel!;
}
