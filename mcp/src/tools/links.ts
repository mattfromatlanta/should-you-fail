import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadNode, saveNode } from "../io.js";
import type { Relationship } from "../types.js";

export function registerLinkTools(server: McpServer): void {
  server.tool(
    "add_relationship",
    "Add a single link to an existing node. Writes to dm_links by default; pass public=true for public_links.",
    {
      from: z.string().describe("Source node ID"),
      target: z.string().describe("Target node ID"),
      rel: z.string().describe("Relationship verb (e.g. 'ally', 'founded', 'serves')"),
      notes: z.string().optional().describe("Optional clarifying note"),
      public: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, add to public_links (target must be player-available)"),
    },
    async ({ from, target, rel, notes, public: isPublic }) => {
      const node = loadNode(from);
      if (!node) {
        return { content: [{ type: "text", text: `Node not found: ${from}` }], isError: true };
      }

      if (isPublic) {
        if (node.audience === "dm-only") {
          return {
            content: [{ type: "text", text: "Cannot add public_link to a dm-only node" }],
            isError: true,
          };
        }
        const targetNode = loadNode(target);
        if (targetNode && targetNode.audience === "dm-only") {
          return {
            content: [{ type: "text", text: `public_link target '${target}' is dm-only` }],
            isError: true,
          };
        }
      }

      const listKey: "public_links" | "dm_links" = isPublic ? "public_links" : "dm_links";
      const existing = node[listKey] ?? [];
      const dupe = existing.some((e) => e.target === target && e.rel === rel);
      if (dupe) {
        return { content: [{ type: "text", text: `Relationship already exists in ${listKey}: ${from} -[${rel}]-> ${target}` }] };
      }

      const newRel: Relationship = { target, rel };
      if (notes) newRel.notes = notes;
      existing.push(newRel);
      node[listKey] = existing;

      saveNode(node);
      return { content: [{ type: "text", text: `Added to ${listKey}: ${from} -[${rel}]-> ${target}` }] };
    }
  );

  server.tool(
    "promote_link",
    "Move a relationship between dm_links and public_links on a single node. Set direction='to_public' to promote (dm_links -> public_links) or 'to_dm' to demote (public_links -> dm_links). Identifies the link by (target, rel). When promoting, validates that both the source node and the target node are player-available.",
    {
      id: z.string().describe("Source node id"),
      target: z.string().describe("Target node id of the link to move"),
      rel: z.string().describe("Relationship verb identifying the link"),
      direction: z.enum(["to_public", "to_dm"]).describe("Which way to move the link"),
    },
    async ({ id, target, rel, direction }) => {
      const node = loadNode(id);
      if (!node) {
        return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
      }
      const fromKey: "dm_links" | "public_links" = direction === "to_public" ? "dm_links" : "public_links";
      const toKey: "dm_links" | "public_links" = direction === "to_public" ? "public_links" : "dm_links";

      const source = node[fromKey] ?? [];
      const idx = source.findIndex((r) => r.target === target && r.rel === rel);
      if (idx === -1) {
        return {
          content: [{ type: "text", text: `Link not found in ${fromKey}: ${id} -[${rel}]-> ${target}` }],
          isError: true,
        };
      }

      if (direction === "to_public") {
        if (node.audience === "dm-only") {
          return {
            content: [{ type: "text", text: `Cannot promote: source node ${id} is dm-only` }],
            isError: true,
          };
        }
        const targetNode = loadNode(target);
        if (targetNode && targetNode.audience === "dm-only") {
          return {
            content: [{ type: "text", text: `Cannot promote: target node ${target} is dm-only` }],
            isError: true,
          };
        }
      }

      const link = source[idx];
      source.splice(idx, 1);
      node[fromKey] = source.length ? source : undefined;
      const dest = node[toKey] ?? [];
      if (!dest.some((r) => r.target === link.target && r.rel === link.rel)) {
        dest.push(link);
      }
      node[toKey] = dest;

      saveNode(node);
      return {
        content: [
          {
            type: "text",
            text: `Moved ${fromKey} -> ${toKey}: ${id} -[${rel}]-> ${target}`,
          },
        ],
      };
    }
  );
}
