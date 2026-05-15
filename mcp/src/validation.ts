import type { GraphNode } from "./types.js";

export interface ValidationError {
  id: string;
  field: string;
  message: string;
}

// Fast pre-save guard for the most common authoring mistake: cramming a body
// of prose into `summary`. Returns an error string if the summary is malformed,
// or null if it looks like a one-sentence tooltip.
export function checkSummaryShape(summary: string | undefined): string | null {
  if (summary === undefined) return null;
  if (/\n\s*\n/.test(summary)) {
    return "summary contains a paragraph break — it must be one sentence (≤ ~25 words). Move the body into player_content (party-known) or dm_content (DM-only).";
  }
  if (summary.length > 400) {
    return `summary is ${summary.length} chars — it must be one sentence (≤ ~400 chars). Move the body into player_content (party-known) or dm_content (DM-only).`;
  }
  return null;
}

export function validateNode(node: GraphNode, allNodes: Map<string, GraphNode>): ValidationError[] {
  const errors: ValidationError[] = [];
  const here = (field: string, message: string) => errors.push({ id: node.id, field, message });

  if (!node.audience) {
    here("audience", "missing required v2 field");
    return errors; // most other checks depend on audience
  }
  if (node.audience !== "player-available" && node.audience !== "dm-only") {
    here("audience", `invalid value '${node.audience}'; must be player-available or dm-only`);
  }

  if (node.content !== undefined) {
    here("content", "legacy v1 field present — should be renamed to dm_content");
  }
  if (node.relationships !== undefined) {
    here("relationships", "legacy v1 field present — should be split into public_links + dm_links");
  }

  // Summary shape: must be one sentence, never a body of prose.
  if (node.summary !== undefined) {
    if (/\n\s*\n/.test(node.summary)) {
      here("summary", "summary contains a paragraph break — must be one sentence, not a body");
    } else if (node.summary.length > 400) {
      here(
        "summary",
        `summary is ${node.summary.length} chars — must be one sentence (≤ ~400 chars). Move the body into player_content or dm_content.`
      );
    }
  }

  if (node.audience === "dm-only") {
    if (node.player_content !== undefined && node.player_content !== "") {
      here("player_content", "dm-only nodes must not have player_content");
    }
    if (node.public_links !== undefined && node.public_links.length > 0) {
      here("public_links", "dm-only nodes must not have public_links");
    }
  }

  for (const link of node.public_links ?? []) {
    const target = allNodes.get(link.target);
    if (!target) {
      here("public_links", `target '${link.target}' does not exist`);
    } else if (target.audience === "dm-only") {
      here(
        "public_links",
        `target '${link.target}' is dm-only — public_link targets must be player-available`
      );
    }
  }

  for (const link of node.dm_links ?? []) {
    if (!allNodes.has(link.target)) {
      here("dm_links", `target '${link.target}' does not exist`);
    }
  }

  return errors;
}
