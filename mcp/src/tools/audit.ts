import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { AUDIENCE_REVIEW_PATH, GAME_BOOK_DIR } from "../paths.js";
import { loadAllNodes, loadNode, saveNode } from "../io.js";
import { validateNode } from "../validation.js";
import type { ValidationError } from "../validation.js";
import { proposeForNode, readReviewFile } from "../audience.js";
import type { ReviewFile } from "../audience.js";
import { NODE_TYPES } from "../types.js";
import type { GraphNode, Relationship } from "../types.js";

export function registerAuditTools(server: McpServer): void {
  server.tool(
    "validate_schema",
    "Validate every game book node against the v2 schema (audience field, player_content/dm_content split, public_links/dm_links split, no legacy fields, link integrity). Returns a structured list of errors per node.",
    {},
    async () => {
      const nodes = loadAllNodes();
      const map = new Map(nodes.map((n) => [n.id, n]));
      const errors: ValidationError[] = [];
      for (const n of nodes) errors.push(...validateNode(n, map));

      const byNode: Record<string, ValidationError[]> = {};
      for (const e of errors) {
        if (!byNode[e.id]) byNode[e.id] = [];
        byNode[e.id].push(e);
      }

      const result = {
        total_nodes: nodes.length,
        nodes_with_errors: Object.keys(byNode).length,
        total_errors: errors.length,
        errors_by_node: byNode,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "propose_audience",
    "Audit every game book node and propose an audience value (player-available | dm-only). Writes game-book/_audience-review.yaml for human review. Does NOT modify any node files.",
    {
      type: z.enum(NODE_TYPES).optional().describe("Optional: limit the audit to a single node type"),
    },
    async ({ type }) => {
      let nodes = loadAllNodes();
      if (type) nodes = nodes.filter((n) => n.type === type);

      const proposals = nodes.map(proposeForNode);
      proposals.sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return a.id.localeCompare(b.id);
      });

      const byConfidence = { high: 0, medium: 0, low: 0 };
      for (const p of proposals) byConfidence[p.confidence]++;

      const file: ReviewFile = {
        version: 1,
        generated: new Date().toISOString().slice(0, 10),
        instructions: [
          "Review proposed_audience for each node. Edit the value in place to override.",
          "Then run the apply_audience MCP tool. apply_audience reads this file and",
          "rewrites every node to v2 schema (dm_content + audience + link split).",
          "First pass leaves player_content empty for every player-available node.",
          "Confidence: high = trust default; medium = quick scan; low = read the node before approving.",
        ].join("\n"),
        total_nodes: proposals.length,
        by_confidence: byConfidence,
        proposals,
      };

      fs.writeFileSync(AUDIENCE_REVIEW_PATH, yaml.dump(file, { lineWidth: 120, quotingType: '"' }), "utf8");

      return {
        content: [
          {
            type: "text",
            text: `Wrote ${proposals.length} proposals to ${path.relative(GAME_BOOK_DIR, AUDIENCE_REVIEW_PATH)}.\nConfidence: high=${byConfidence.high}, medium=${byConfidence.medium}, low=${byConfidence.low}`,
          },
        ],
      };
    }
  );

  server.tool(
    "apply_audience",
    "Read the approved game-book/_audience-review.yaml and rewrite every listed node to v2 schema: set audience, rename content -> dm_content, move all legacy relationships into dm_links (player-available nodes get an empty player_content placeholder; promotion to public_links happens manually later). Stops on the first error and reports which nodes were modified.",
    {
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, report what would change without writing files."),
    },
    async ({ dry_run }) => {
      const review = readReviewFile();
      if (!review) {
        return {
          content: [
            {
              type: "text",
              text: `No review file found at ${path.relative(GAME_BOOK_DIR, AUDIENCE_REVIEW_PATH)}. Run propose_audience first.`,
            },
          ],
          isError: true,
        };
      }

      const modified: string[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const p of review.proposals) {
        const node = loadNode(p.id);
        if (!node) {
          return {
            content: [
              {
                type: "text",
                text: `STOP: node not found: ${p.id} (after modifying ${modified.length} nodes)\nModified so far:\n${modified.join("\n")}`,
              },
            ],
            isError: true,
          };
        }

        const audience = p.proposed_audience;
        if (audience !== "player-available" && audience !== "dm-only") {
          return {
            content: [
              {
                type: "text",
                text: `STOP: invalid proposed_audience '${audience}' for ${p.id} (after modifying ${modified.length} nodes)`,
              },
            ],
            isError: true,
          };
        }

        // Skip if already in v2 form for this audience (idempotent re-run).
        const alreadyV2 =
          node.audience === audience &&
          node.content === undefined &&
          node.relationships === undefined;
        if (alreadyV2) {
          skipped.push({ id: p.id, reason: "already v2" });
          continue;
        }

        // Build the new v2 node object preserving field order.
        const next: GraphNode = {
          id: node.id,
          type: node.type,
          name: node.name,
          audience,
        };
        if (node.tags?.length) next.tags = node.tags;
        if (node.status) next.status = node.status;
        if (node.summary !== undefined) next.summary = node.summary;

        if (audience === "player-available") {
          // Preserve any existing player_content; otherwise leave empty for first pass.
          next.player_content = node.player_content ?? "";
        }

        // dm_content absorbs legacy content + any existing dm_content.
        const dmBlobParts: string[] = [];
        if (node.dm_content) dmBlobParts.push(node.dm_content.trim());
        if (node.content && node.content !== node.dm_content) dmBlobParts.push(node.content.trim());
        if (dmBlobParts.length > 0) next.dm_content = dmBlobParts.join("\n\n") + "\n";

        // All legacy relationships migrate to dm_links by default.
        // Preserve any pre-existing v2 link lists.
        const mergedDm: Relationship[] = [];
        const seen = new Set<string>();
        const pushRel = (r: Relationship) => {
          const key = `${r.target}|${r.rel}`;
          if (seen.has(key)) return;
          seen.add(key);
          const out: Relationship = { target: r.target, rel: r.rel };
          if (r.notes) out.notes = r.notes;
          mergedDm.push(out);
        };
        for (const r of node.dm_links ?? []) pushRel(r);
        for (const r of node.relationships ?? []) pushRel(r);
        if (node.public_links?.length) next.public_links = node.public_links;
        if (mergedDm.length) next.dm_links = mergedDm;

        if (!dry_run) {
          saveNode(next);
        }
        modified.push(p.id);
      }

      const summary = [
        `${dry_run ? "[DRY RUN] " : ""}Modified ${modified.length} node(s).`,
        `Skipped (already v2): ${skipped.length}`,
        "",
        "Next steps:",
        "  1. Run validate_schema to confirm clean.",
        "  2. For each player-available node, write its player_content when ready.",
        "  3. Promote dm_links → public_links as appropriate.",
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    }
  );
}
