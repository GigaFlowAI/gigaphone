/**
 * `gigaphone detect` — Phase B localization (DESIGN §8.2).
 *
 * Route each confirmed descriptor to the file its `match.call` targets, run the language
 * pack's `analyze` there, and collect the located boundaries with their failure modes.
 */

import type { Boundary, Descriptor } from "../core/model.js";
import { packForPath } from "../packs/registry.js";
import { read, scan } from "./project.js";

export function detect(root: string, descriptors: Descriptor[], scope?: string): Boundary[] {
  const boundaries: Boundary[] = [];
  for (const sf of scan(root, scope)) {
    const pack = packForPath(sf.absPath);
    if (pack === null) continue;
    // the pack does the authoritative per-file module match inside analyze().
    boundaries.push(...pack.analyze(sf.relPath, read(sf), descriptors));
  }
  return boundaries;
}
