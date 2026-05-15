import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { NODES_DIR } from "../paths.js";
import { loadAllNodes, loadIndex, loadNode, saveIndex, saveNode } from "../io.js";
import { checkSummaryShape } from "../validation.js";
import { FormatParam, formatNode, renderText } from "../format.js";
import { NODE_TYPES } from "../types.js";
import type { GraphNode } from "../types.js";

export function registerWriteTools(server: McpServer): void {
  server.tool(
    "create_node",
    "Create a new game book node (v2 schema). Writes the node file and registers it in the index.",
    {
      id: z.string().describe("Node ID in <type>-<slug> format (e.g. 'npc-new-character')"),
      type: z.enum(NODE_TYPES).describe("Node type"),
      name: z.string().describe("Human-readable name"),
      audience: z
        .enum(["player-available", "dm-only"])
        .describe("player-available (has both player_content + dm_content) or dm-only (dm_content only)"),
      summary: z
        .string()
        .describe(
          "ONE sentence (≤ ~25 words). Never a body of prose. For player-available nodes this becomes the tooltip in the player journal export, so it must be player-safe."
        ),
      status: z.string().optional().describe("Status value appropriate for the node type"),
      tags: z.array(z.string()).optional().describe("Tag list"),
      player_content: z
        .string()
        .optional()
        .describe(
          "Player-facing prose, written in DM-as-narrator voice. Carries the ARC SHAPE — identity, personality, motivation, current state, key arc beats. 5–6 paragraphs for major NPCs; fewer for minor. No scene-level read-aloud (scenes live in encounter nodes). Required on player-available nodes (may be empty string during backlog). Forbidden on dm-only nodes."
        ),
      dm_content: z
        .string()
        .optional()
        .describe(
          "On player-available nodes: the DELTA — ONLY what is not already in player_content (hidden motivations, planning notes, secret connections, tactics, run-the-scene instructions). Never restate facts that appear in player_content. Full picture = player_content + dm_content. On dm-only nodes: the entire body of the node lives here."
        ),
      public_links: z
        .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
        .optional()
        .describe("Relationships visible to players. Targets must be player-available."),
      dm_links: z
        .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
        .optional()
        .describe("DM-only relationships."),
      format: FormatParam,
    },
    async ({ id, type, name, audience, summary, status, tags, player_content, dm_content, public_links, dm_links, format }) => {
      // Validate ID convention
      // Encounters use the established 'enc-' shorthand rather than 'encounter-'
      const expectedPrefix = type === "encounter" ? "enc-" : `${type}-`;
      if (!id.startsWith(expectedPrefix)) {
        return {
          content: [{ type: "text", text: `ID '${id}' must start with '${expectedPrefix}'` }],
          isError: true,
        };
      }

      if (loadNode(id)) {
        return { content: [{ type: "text", text: `Node already exists: ${id}` }], isError: true };
      }

      if (audience === "dm-only" && (player_content || public_links?.length)) {
        return {
          content: [{ type: "text", text: "dm-only nodes cannot have player_content or public_links" }],
          isError: true,
        };
      }

      const summaryError = checkSummaryShape(summary);
      if (summaryError) {
        return { content: [{ type: "text", text: summaryError }], isError: true };
      }

      const node: GraphNode = { id, type, name, audience, summary };
      if (status) node.status = status;
      if (tags?.length) node.tags = tags;
      if (audience === "player-available") node.player_content = player_content ?? "";
      if (dm_content) node.dm_content = dm_content;
      if (public_links?.length) node.public_links = public_links;
      if (dm_links?.length) node.dm_links = dm_links;

      saveNode(node);

      // Register in index
      const index = loadIndex();
      const section = `${type}s`;
      if (!index[section]) index[section] = [];
      if (!index[section].includes(id)) {
        index[section].push(id);
        saveIndex(index);
      }

      const header = `_Created \`${node.id}\`._\n\n`;
      return {
        content: [{ type: "text", text: renderText(format, header + formatNode(node), node) }],
      };
    }
  );

  server.tool(
    "update_node",
    "Update fields on an existing v2 node. **Replace semantics**: every field provided replaces the existing value in full, including arrays (tags, public_links, dm_links). Fields you omit are left untouched. **Agent contract:** (1) call get_node first and read the existing player_content/dm_content/summary; (2) for each new fact, decide whether the party currently knows it — if yes it goes in player_content, if no it goes in dm_content; (3) summary is ONE sentence and never a body of prose; (4) on player-available nodes, prose MUST be split between player_content and dm_content — do not bundle everything into one field, and do not duplicate facts across the two; (5) if you are unsure whether a fact is player-known, ask the caller before writing. For adding a single relationship without rewriting a whole array, use add_relationship. To move a relationship between dm_links and public_links, use promote_link. See game-book/_writing-priority.yaml for the writing pattern (arcs in character nodes, scenes in encounter nodes).",
    {
      id: z.string().describe("Node ID to update"),
      name: z.string().optional(),
      audience: z.enum(["player-available", "dm-only"]).optional(),
      summary: z
        .string()
        .optional()
        .describe(
          "ONE sentence (≤ ~25 words). Never a body of prose. For player-available nodes this is the player-journal tooltip and must be player-safe."
        ),
      status: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Replaces the entire tags array"),
      player_content: z
        .string()
        .optional()
        .describe(
          "Player-facing prose in DM-as-narrator voice. Carries the ARC SHAPE — identity, personality, motivation, current state, key arc beats. Roughly 5–6 paragraphs for a major NPC. No scene-level read-aloud (scenes live in encounter nodes). Forbidden on dm-only nodes."
        ),
      dm_content: z
        .string()
        .optional()
        .describe(
          "On player-available nodes: the DELTA — ONLY what is not already in player_content (hidden motivations, planning notes, secret connections, tactics, run-the-scene instructions). Never restate facts that appear in player_content. Full picture = player_content + dm_content. On dm-only nodes: the entire body of the node lives here."
        ),
      public_links: z
        .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
        .optional()
        .describe("Replaces the entire public_links array"),
      dm_links: z
        .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
        .optional()
        .describe("Replaces the entire dm_links array"),
      format: FormatParam,
    },
    async ({ id, name, audience, summary, status, tags, player_content, dm_content, public_links, dm_links, format }) => {
      const node = loadNode(id);
      if (!node) {
        return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
      }

      if (summary !== undefined) {
        const summaryError = checkSummaryShape(summary);
        if (summaryError) {
          return { content: [{ type: "text", text: summaryError }], isError: true };
        }
      }

      if (name !== undefined) node.name = name;
      if (audience !== undefined) node.audience = audience;
      if (summary !== undefined) node.summary = summary;
      if (status !== undefined) node.status = status;
      if (tags !== undefined) node.tags = tags;
      if (player_content !== undefined) node.player_content = player_content;
      if (dm_content !== undefined) node.dm_content = dm_content;
      if (public_links !== undefined) node.public_links = public_links;
      if (dm_links !== undefined) node.dm_links = dm_links;

      if (node.audience === "dm-only") {
        if (node.player_content && node.player_content !== "") {
          return {
            content: [{ type: "text", text: "dm-only nodes must not have non-empty player_content" }],
            isError: true,
          };
        }
        if (node.public_links?.length) {
          return {
            content: [{ type: "text", text: "dm-only nodes must not have public_links" }],
            isError: true,
          };
        }
      }

      saveNode(node);
      const header = `_Updated \`${node.id}\`._\n\n`;
      return {
        content: [{ type: "text", text: renderText(format, header + formatNode(node), node) }],
      };
    }
  );

  server.tool(
    "rename_node",
    "Rename a node's id. Renames its YAML file, updates its index entry, and cascades the new id through every public_links and dm_links target reference in every other node. The type prefix in the new id must match the node's type (or 'enc-' for encounters).",
    {
      old_id: z.string().describe("Current node id"),
      new_id: z.string().describe("New node id in <type>-<slug> format"),
    },
    async ({ old_id, new_id }) => {
      if (old_id === new_id) {
        return { content: [{ type: "text", text: "old_id and new_id are identical" }], isError: true };
      }
      const node = loadNode(old_id);
      if (!node) {
        return { content: [{ type: "text", text: `Node not found: ${old_id}` }], isError: true };
      }
      if (loadNode(new_id)) {
        return { content: [{ type: "text", text: `Target id already exists: ${new_id}` }], isError: true };
      }
      const expectedPrefix = node.type === "encounter" ? "enc-" : `${node.type}-`;
      if (!new_id.startsWith(expectedPrefix)) {
        return {
          content: [{ type: "text", text: `new_id '${new_id}' must start with '${expectedPrefix}' for type '${node.type}'` }],
          isError: true,
        };
      }

      // Rewrite node file under new id
      node.id = new_id;
      const newPath = path.join(NODES_DIR, `${new_id}.yaml`);
      const oldPath = path.join(NODES_DIR, `${old_id}.yaml`);
      fs.writeFileSync(newPath, yaml.dump(node, { lineWidth: 120, quotingType: '"' }), "utf8");
      fs.unlinkSync(oldPath);

      // Cascade references
      const updated: string[] = [];
      const allNodes = loadAllNodes();
      for (const other of allNodes) {
        if (other.id === new_id) continue;
        let dirty = false;
        for (const list of ["public_links", "dm_links"] as const) {
          const arr = other[list];
          if (!arr) continue;
          for (const link of arr) {
            if (link.target === old_id) {
              link.target = new_id;
              dirty = true;
            }
          }
        }
        if (dirty) {
          saveNode(other);
          updated.push(other.id);
        }
      }

      // Update index
      const index = loadIndex();
      const section = `${node.type}s`;
      if (index[section]) {
        index[section] = index[section].map((id) => (id === old_id ? new_id : id));
        saveIndex(index);
      }

      return {
        content: [
          {
            type: "text",
            text: `Renamed ${old_id} -> ${new_id}\nUpdated index section '${section}'\nCascaded references in ${updated.length} node(s):\n${updated.join("\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "delete_node",
    "Delete a node. Refuses with a list of referrers if any other node has a public_link or dm_link targeting this node — the caller must remove those references first (via update_node or rename_node). On success, removes the YAML file and the index entry.",
    {
      id: z.string().describe("Node id to delete"),
    },
    async ({ id }) => {
      const node = loadNode(id);
      if (!node) {
        return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
      }

      // Find referrers
      const referrers: { id: string; list: "public_links" | "dm_links"; rel: string }[] = [];
      for (const other of loadAllNodes()) {
        if (other.id === id) continue;
        for (const list of ["public_links", "dm_links"] as const) {
          for (const link of other[list] ?? []) {
            if (link.target === id) referrers.push({ id: other.id, list, rel: link.rel });
          }
        }
      }
      if (referrers.length > 0) {
        const lines = referrers.map((r) => `  ${r.id} (${r.list}, rel=${r.rel})`);
        return {
          content: [
            {
              type: "text",
              text: `Cannot delete ${id} — ${referrers.length} referrer(s) still link to it. Remove these first:\n${lines.join("\n")}`,
            },
          ],
          isError: true,
        };
      }

      // Remove file and index entry
      fs.unlinkSync(path.join(NODES_DIR, `${id}.yaml`));
      const index = loadIndex();
      const section = `${node.type}s`;
      if (index[section]) {
        index[section] = index[section].filter((entry) => entry !== id);
        saveIndex(index);
      }

      return { content: [{ type: "text", text: `Deleted ${id} (no referrers).` }] };
    }
  );
}
