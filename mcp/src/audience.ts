import * as fs from "fs";
import * as yaml from "js-yaml";

import { AUDIENCE_REVIEW_PATH } from "./paths.js";
import type { Audience, GraphNode } from "./types.js";

// Tag and content signals that strongly suggest dm-only.
const DM_TAG_SIGNALS = new Set(["planning", "todo", "dm-notes", "internal", "draft", "lore-gap"]);
const DM_CONTENT_REGEXES = [/\bDM[\s:]*NOTE\b/i, /\bTBD\b/, /\bTODO\b/, /\bOUTSTANDING\b/];

export interface AudienceProposal {
  id: string;
  type: string;
  name: string;
  status: string;
  current_audience: string;
  proposed_audience: Audience;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export interface ReviewFile {
  version: number;
  generated: string;
  instructions: string;
  total_nodes: number;
  by_confidence: { high: number; medium: number; low: number };
  proposals: AudienceProposal[];
}

export function proposeForNode(node: GraphNode): AudienceProposal {
  const reasons: string[] = [];
  let proposed: Audience;
  let confidence: "high" | "medium" | "low" = "medium";

  const tags = node.tags ?? [];
  const dmTagHits = tags.filter((t) => DM_TAG_SIGNALS.has(t));
  const contentBlob = (node.content ?? node.dm_content ?? "") + " " + (node.summary ?? "");
  const dmRegexHits = DM_CONTENT_REGEXES.filter((rx) => rx.test(contentBlob));

  // 1. Strong DM signals trump type defaults.
  if (dmTagHits.length > 0 || node.id.endsWith("-todo") || node.id.includes("-lore-gaps")) {
    proposed = "dm-only";
    confidence = "high";
    reasons.push(
      [
        dmTagHits.length ? `dm tags: ${dmTagHits.join(", ")}` : null,
        node.id.endsWith("-todo") ? "node id ends with -todo" : null,
        node.id.includes("-lore-gaps") ? "node id signals lore-gap planning" : null,
      ]
        .filter(Boolean)
        .join("; ")
    );
  } else {
    // 2. Type default.
    switch (node.type) {
      case "encounter":
        if (node.status === "complete") {
          proposed = "player-available";
          confidence = "medium";
          reasons.push("encounter is complete — recap may be wanted player-side");
        } else {
          proposed = "dm-only";
          confidence = "high";
          reasons.push("encounter not yet played; prep is DM-only");
        }
        break;
      case "pc":
        proposed = "player-available";
        confidence = "high";
        reasons.push("pc — always player-available");
        break;
      case "npc":
        proposed = "player-available";
        confidence = "high";
        reasons.push("npc default — most characters have surface info worth sharing");
        if (node.status === "unknown") {
          confidence = "low";
          reasons.push("status=unknown suggests party may not have met them yet — review");
        }
        break;
      case "location":
        if (node.status === "unknown") {
          proposed = "dm-only";
          confidence = "medium";
          reasons.push("location status=unknown — likely undiscovered");
        } else {
          proposed = "player-available";
          confidence = "high";
          reasons.push("location with active/known status");
        }
        break;
      case "concept":
        proposed = "player-available";
        confidence = "low";
        reasons.push("concept default — review whether in-world lore or DM planning");
        break;
      case "chapter":
        proposed = "player-available";
        confidence = "high";
        reasons.push("chapter default — player recap belongs here");
        break;
      case "event":
        proposed = "player-available";
        confidence = "medium";
        reasons.push("event default — historical events are usually public");
        break;
      case "artifact":
        proposed = "player-available";
        confidence = "medium";
        reasons.push("artifact default — review whether the party has encountered it");
        break;
      case "faction":
        proposed = "player-available";
        confidence = "medium";
        reasons.push("faction default — review whether the faction is publicly known");
        break;
      default:
        proposed = "dm-only";
        confidence = "low";
        reasons.push(`unknown type '${node.type}' — defaulting to dm-only`);
    }
  }

  // 3. Content red flags downgrade confidence.
  if (dmRegexHits.length > 0 && proposed === "player-available") {
    confidence = confidence === "high" ? "medium" : "low";
    reasons.push("content contains DM markers (DM NOTE / TBD / TODO) — needs review");
  }

  return {
    id: node.id,
    type: node.type,
    name: node.name,
    status: node.status ?? "",
    current_audience: node.audience ?? "",
    proposed_audience: proposed,
    confidence,
    reasoning: reasons.join(" | "),
  };
}

export function readReviewFile(): ReviewFile | null {
  if (!fs.existsSync(AUDIENCE_REVIEW_PATH)) return null;
  return yaml.load(fs.readFileSync(AUDIENCE_REVIEW_PATH, "utf8")) as ReviewFile;
}
