// Representative path GigaPhone runs during `verify` for the TypeScript testclient.
//
// The harness already owns an agent trace (here: a root "agent" span created via the shim,
// exactly as a customer's existing instrumentation would). GigaPhone's job is to make every
// tool boundary land *nested under it + complete* — which is what `verify` checks after the
// fix wraps the tools. Run directly with Node (type-stripping); set GIGAPHONE_SPAN_FILE to
// capture spans as JSONL.

import { gigaphoneTrace } from "@gigaphone/otel";

import { runAgent } from "./agent.ts";

async function main(): Promise<void> {
  const answer = await gigaphoneTrace({ name: "agent", kind: "agent" })(async () =>
    runAgent("ship trace coverage"),
  );
  console.log(answer);
}

main();
