import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";

import { SCHEMA_PATH } from "../paths.js";
import { loadAllNodes, loadNode, nodeHeader } from "../io.js";
import { FormatParam, formatHeaderList, formatNode, renderText } from "../format.js";
import { NODE_TYPES } from "../types.js";
import type { GraphNode } from "../types.js";

export function registerReadTools(server: McpServer): void {
  server.tool(
    "get_node",
    "Get a single game book node by its ID (e.g. 'npc-gallifax', 'location-aris'). Returns formatted markdown by default; pass format='json' for the raw structured object.",
    {
      id: z.string().describe("Node ID in <type>-<slug> format"),
      format: FormatParam,
    },
    async ({ id, format }) => {
      const node = loadNode(id);
      if (!node) {
        return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
      }
      return { content: [{ type: "text", text: renderText(format, formatNode(node), node) }] };
    }
  );

  server.tool(
    "list_nodes",
    "List all game book nodes, optionally filtered by type. Returns lightweight headers (id, name, summary, status).",
    {
      type: z.enum(NODE_TYPES).optional().describe("Filter by node type. Omit for all types."),
      format: FormatParam,
    },
    async ({ type, format }) => {
      const nodes = loadAllNodes();
      const filtered = type ? nodes.filter((n) => n.type === type) : nodes;
      const title = type ? `${type} nodes` : "All nodes";
      return {
        content: [
          {
            type: "text",
            text: renderText(format, formatHeaderList(filtered, title), filtered.map(nodeHeader)),
          },
        ],
      };
    }
  );

  server.tool(
    "search_nodes",
    "Search game book nodes by text query, type, tag, or status. Returns matching node headers.",
    {
      query: z.string().optional().describe("Text to match against name, summary, and content (case-insensitive)"),
      type: z.enum(NODE_TYPES).optional().describe("Filter by node type"),
      tag: z.string().optional().describe("Must be present in the node's tags array"),
      status: z.string().optional().describe("Filter by status value"),
      format: FormatParam,
    },
    async ({ query, type, tag, status, format }) => {
      let nodes = loadAllNodes();

      if (type) nodes = nodes.filter((n) => n.type === type);
      if (status) nodes = nodes.filter((n) => n.status === status);
      if (tag) nodes = nodes.filter((n) => n.tags?.includes(tag));

      if (query) {
        const q = query.toLowerCase();
        // Score by match location: name > summary > content (any content field)
        const scored = nodes
          .map((n) => {
            let score = 0;
            if (n.name.toLowerCase().includes(q)) score += 10;
            if (n.summary?.toLowerCase().includes(q)) score += 5;
            const contentBlob = (n.dm_content ?? "") + " " + (n.player_content ?? "") + " " + (n.content ?? "");
            if (contentBlob.toLowerCase().includes(q)) score += 1;
            return { node: n, score };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score);
        nodes = scored.map(({ node }) => node);
      }

      return {
        content: [
          {
            type: "text",
            text: renderText(format, formatHeaderList(nodes, "Search results"), nodes.map(nodeHeader)),
          },
        ],
      };
    }
  );

  server.tool(
    "find_same_property",
    "Find nodes by shared property: same type, same status, and/or same tag. Filters combine with AND semantics. Returns headers (use get_node to drill in). Use to explore thematic or structural proximity without graph traversal — e.g. 'all NPCs tagged \"dragon\"', 'all locations with status active', 'all player-available nodes tagged \"naeliste\"'.",
    {
      type: z.enum(NODE_TYPES).optional().describe("Limit to one node type"),
      status: z.string().optional().describe("Match status value exactly"),
      tag: z.string().optional().describe("Tag that must be present on the node"),
      audience: z.enum(["player-available", "dm-only"]).optional().describe("Filter by audience"),
      exclude_id: z.string().optional().describe("Exclude this node from results (useful for 'others like this one')"),
      format: FormatParam,
    },
    async ({ type, status, tag, audience, exclude_id, format }) => {
      if (!type && !status && !tag && !audience) {
        return {
          content: [{ type: "text", text: "Provide at least one filter (type, status, tag, or audience)." }],
          isError: true,
        };
      }

      let nodes = loadAllNodes();
      if (exclude_id) nodes = nodes.filter((n) => n.id !== exclude_id);
      if (type) nodes = nodes.filter((n) => n.type === type);
      if (status) nodes = nodes.filter((n) => n.status === status);
      if (audience) nodes = nodes.filter((n) => n.audience === audience);
      if (tag) nodes = nodes.filter((n) => n.tags?.includes(tag));

      const filterDesc = [
        type ? `type=${type}` : null,
        status ? `status=${status}` : null,
        tag ? `tag=${tag}` : null,
        audience ? `audience=${audience}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const title = `Matches — ${filterDesc}`;

      const headers = nodes.map(nodeHeader);
      return {
        content: [
          {
            type: "text",
            text: renderText(format, formatHeaderList(nodes, title), {
              count: headers.length,
              filters: { type, status, tag, audience, exclude_id },
              results: headers,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_relationships",
    "Get all nodes directly related to a given node (1-hop traversal). Optionally filter by relationship verb.",
    {
      id: z.string().describe("Source node ID"),
      rel: z.string().optional().describe("Relationship verb to filter by (e.g. 'ally', 'founded', 'serves')"),
      format: FormatParam,
    },
    async ({ id, rel, format }) => {
      const source = loadNode(id);
      if (!source) {
        return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
      }

      const rels = [
        ...(source.public_links ?? []),
        ...(source.dm_links ?? []),
        ...(source.relationships ?? []),
      ];
      const filtered = rel ? rels.filter((r) => r.rel === rel) : rels;

      const resolved = filtered.map((r) => {
        const target = loadNode(r.target);
        return {
          rel: r.rel,
          notes: r.notes,
          target,
        };
      });

      const markdown = (() => {
        const lines: string[] = [`# Relationships of ${source.name}  \n\`${source.id}\``];
        if (resolved.length === 0) {
          lines.push("\n_(no matching relationships)_");
        } else {
          for (const r of resolved) {
            if (!r.target) {
              lines.push(`\n- **(missing)** \`${"" /* placeholder */}\` — ${r.rel}`);
              continue;
            }
            const meta = [r.target.type, r.target.audience, r.target.status].filter(Boolean).join(" · ");
            lines.push(
              `\n- **${r.target.name}** \`${r.target.id}\` — ${r.rel}${r.notes ? ` _(${r.notes})_` : ""}\n  ${meta}${
                r.target.summary ? `\n  ${r.target.summary}` : ""
              }`
            );
          }
        }
        return lines.join("\n");
      })();

      const jsonValue = {
        source: nodeHeader(source),
        relationships: resolved.map((r) => ({
          rel: r.rel,
          notes: r.notes,
          node: r.target ? nodeHeader(r.target) : { id: "", error: "not found" },
        })),
      };

      return { content: [{ type: "text", text: renderText(format, markdown, jsonValue) }] };
    }
  );

  server.tool(
    "get_context_bundle",
    "Get a writing context bundle for a chapter or encounter. The primary node is always returned in full. Related nodes are returned as headers by default (mode='headers') — call get_node on any you need to read in full. Set mode='full' to return every related node's complete content (use sparingly; bundles get large).",
    {
      id: z.string().describe("Chapter or encounter node ID (e.g. 'chapter-7-aris-the-fracturing-capital')"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(2)
        .optional()
        .default(1)
        .describe("Traversal depth. 1 = direct relationships only. 2 = also follow PC/NPC/location relationships."),
      mode: z
        .enum(["headers", "full"])
        .optional()
        .default("headers")
        .describe("'headers' (default) returns id/type/name/audience/status/summary/tags/link-counts for related nodes. 'full' returns each related node in its entirety."),
      format: FormatParam,
    },
    async ({ id, depth, mode, format }) => {
      const primary = loadNode(id);
      if (!primary) {
        return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
      }

      const visited = new Set<string>([id]);
      const bucket: Record<string, GraphNode[]> = {
        pc: [], npc: [], location: [], faction: [], artifact: [], event: [], chapter: [], concept: [], encounter: [],
      };

      function harvest(node: GraphNode) {
        const allLinks = [
          ...(node.public_links ?? []),
          ...(node.dm_links ?? []),
          ...(node.relationships ?? []),
        ];
        for (const r of allLinks) {
          if (visited.has(r.target)) continue;
          visited.add(r.target);
          const related = loadNode(r.target);
          if (!related) continue;
          bucket[related.type]?.push(related);
          if (depth === 2 && (related.type === "pc" || related.type === "npc" || related.type === "location")) {
            harvest(related);
          }
        }
      }

      harvest(primary);

      const jsonValue: Record<string, unknown> = { primary, mode };
      for (const [type, nodes] of Object.entries(bucket)) {
        if (nodes.length === 0) continue;
        jsonValue[`${type}s`] = mode === "full" ? nodes : nodes.map(nodeHeader);
      }

      const markdownParts: string[] = [formatNode(primary)];
      for (const [type, nodes] of Object.entries(bucket)) {
        if (nodes.length === 0) continue;
        if (mode === "full") {
          markdownParts.push(`\n# Related ${type}s (${nodes.length})\n\n${nodes.map(formatNode).join("\n\n---\n\n")}`);
        } else {
          markdownParts.push(`\n${formatHeaderList(nodes, `Related ${type}s`)}`);
        }
      }

      return {
        content: [{ type: "text", text: renderText(format, markdownParts.join("\n"), jsonValue) }],
      };
    }
  );

  server.tool(
    "get_schema",
    "Get the game book node schema: types, status values, and valid relationship verbs.",
    {},
    async () => {
      const raw = fs.readFileSync(SCHEMA_PATH, "utf8");
      return { content: [{ type: "text", text: raw }] };
    }
  );
}
