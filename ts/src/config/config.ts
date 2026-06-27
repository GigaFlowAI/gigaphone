/**
 * Boundary-config I/O + drift detection (DESIGN §8, ADR-0004).
 *
 * The committed `gigaphone.boundaries.yaml` is the source of truth for routine runs; the LLM
 * is in the loop only for discovery and change. Drift = a committed anchor no longer resolves
 * to any boundary in the code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Descriptor, type DescriptorYaml } from "../core/model.js";
import * as yaml from "./yaml.js";

export const CONFIG_NAME = "gigaphone.boundaries.yaml";

export function configPath(repo: string): string {
  return join(repo, CONFIG_NAME);
}

export function load(repo: string): Descriptor[] {
  const path = configPath(repo);
  if (!existsSync(path)) return [];
  const data = yaml.load(readFileSync(path, "utf-8"));
  const boundaries = (data.boundaries as DescriptorYaml[] | undefined) ?? [];
  return boundaries.map((o) => Descriptor.fromYamlObj(o));
}

export function save(repo: string, descriptors: Descriptor[]): string {
  const path = configPath(repo);
  const doc = { boundaries: descriptors.map((d) => d.toYamlObj()) };
  const header =
    "# GigaPhone boundary config (DESIGN §8.4) — the fourth axis as data, not code.\n" +
    "# Produced by discovery; consumed deterministically by routine/CI runs.\n";
  writeFileSync(path, header + yaml.dump(doc), "utf-8");
  return path;
}

/** Committed anchors that no longer resolve anywhere in the code (DESIGN §8.5). */
export function detectDrift(descriptors: Descriptor[], resolvedMatchCalls: Set<string>): string[] {
  return descriptors.filter((d) => !resolvedMatchCalls.has(d.matchCall)).map((d) => d.matchCall);
}
