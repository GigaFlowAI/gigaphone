/**
 * Thin YAML seam (mirrors the Python `_yaml` module boundary).
 *
 * The Python engine vendored a zero-dependency YAML reader to keep the bare-`python3` plugin
 * dependency-free. The Node engine runs on a real runtime, so it uses the `yaml` package
 * behind this seam — the rest of the code depends only on `load` / `dump`.
 */

import { parse, stringify } from "yaml";

export function load(text: string): Record<string, unknown> {
  return (parse(text) as Record<string, unknown>) ?? {};
}

export function dump(doc: unknown): string {
  // Flow style for leaf mappings keeps the committed config compact and diff-friendly,
  // matching the original `{ key: value }` leaf rendering.
  return stringify(doc, { flowCollectionPadding: true, lineWidth: 0 });
}
