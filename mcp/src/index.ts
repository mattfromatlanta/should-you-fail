import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_BOOK_DIR = path.resolve(__dirname, "../../game-book");
const NODES_DIR = path.join(GAME_BOOK_DIR, "nodes");
const INDEX_PATH = path.join(GAME_BOOK_DIR, "_index.yaml");
const SCHEMA_PATH = path.join(GAME_BOOK_DIR, "_schema.yaml");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface Relationship {
  target: string;
  rel: string;
  notes?: string;
}

interface GraphNode {
  id: string;
  type: string;
  name: string;
  tags?: string[];
  status?: string;
  summary?: string;
  content?: string;
  relationships?: Relationship[];
  sources?: string[];
}

type NodeIndex = Record<string, string[]>;

const NODE_TYPES = ["npc", "location", "chapter", "event", "artifact", "faction", "concept", "encounter"] as const;
type NodeType = typeof NODE_TYPES[number];

// ─────────────────────────────────────────────────────────────
// Game book helpers
// ─────────────────────────────────────────────────────────────

function loadNode(id: string): GraphNode | null {
  const filePath = path.join(NODES_DIR, `${id}.yaml`);
  if (!fs.existsSync(filePath)) return null;
  return yaml.load(fs.readFileSync(filePath, "utf8")) as GraphNode;
}

function loadAllNodes(): GraphNode[] {
  if (!fs.existsSync(NODES_DIR)) return [];
  return fs
    .readdirSync(NODES_DIR)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((f) => {
      try {
        return yaml.load(fs.readFileSync(path.join(NODES_DIR, f), "utf8")) as GraphNode;
      } catch {
        return null;
      }
    })
    .filter((n): n is GraphNode => n !== null);
}

function loadIndex(): NodeIndex {
  if (!fs.existsSync(INDEX_PATH)) return {};
  return (yaml.load(fs.readFileSync(INDEX_PATH, "utf8")) as NodeIndex) ?? {};
}

function saveNode(node: GraphNode): void {
  const filePath = path.join(NODES_DIR, `${node.id}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(node, { lineWidth: 120, quotingType: '"' }), "utf8");
}

function saveIndex(index: NodeIndex): void {
  fs.writeFileSync(INDEX_PATH, yaml.dump(index, { lineWidth: 120 }), "utf8");
}

function nodeHeader(node: GraphNode) {
  return { id: node.id, type: node.type, name: node.name, summary: node.summary ?? "", status: node.status ?? "" };
}

// ─────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "syf-campaign-mcp",
  version: "0.1.0",
});

// ── get_node ─────────────────────────────────────────────────

server.tool(
  "get_node",
  "Get a single game book node by its ID (e.g. 'npc-gallifax', 'location-aris')",
  { id: z.string().describe("Node ID in <type>-<slug> format") },
  async ({ id }) => {
    const node = loadNode(id);
    if (!node) {
      return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
  }
);

// ── list_nodes ───────────────────────────────────────────────

server.tool(
  "list_nodes",
  "List all game book nodes, optionally filtered by type. Returns lightweight headers (id, name, summary, status).",
  {
    type: z
      .enum(NODE_TYPES)
      .optional()
      .describe("Filter by node type. Omit for all types."),
  },
  async ({ type }) => {
    const nodes = loadAllNodes();
    const filtered = type ? nodes.filter((n) => n.type === type) : nodes;
    const headers = filtered.map(nodeHeader);
    return { content: [{ type: "text", text: JSON.stringify(headers, null, 2) }] };
  }
);

// ── search_nodes ─────────────────────────────────────────────

server.tool(
  "search_nodes",
  "Search game book nodes by text query, type, tag, or status. Returns matching node headers.",
  {
    query: z.string().optional().describe("Text to match against name, summary, and content (case-insensitive)"),
    type: z.enum(NODE_TYPES).optional().describe("Filter by node type"),
    tag: z.string().optional().describe("Must be present in the node's tags array"),
    status: z.string().optional().describe("Filter by status value"),
  },
  async ({ query, type, tag, status }) => {
    let nodes = loadAllNodes();

    if (type) nodes = nodes.filter((n) => n.type === type);
    if (status) nodes = nodes.filter((n) => n.status === status);
    if (tag) nodes = nodes.filter((n) => n.tags?.includes(tag));

    if (query) {
      const q = query.toLowerCase();
      // Score by match location: name > summary > content
      const scored = nodes
        .map((n) => {
          let score = 0;
          if (n.name.toLowerCase().includes(q)) score += 10;
          if (n.summary?.toLowerCase().includes(q)) score += 5;
          if (n.content?.toLowerCase().includes(q)) score += 1;
          return { node: n, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      nodes = scored.map(({ node }) => node);
    }

    return { content: [{ type: "text", text: JSON.stringify(nodes.map(nodeHeader), null, 2) }] };
  }
);

// ── get_relationships ────────────────────────────────────────

server.tool(
  "get_relationships",
  "Get all nodes directly related to a given node (1-hop traversal). Optionally filter by relationship verb.",
  {
    id: z.string().describe("Source node ID"),
    rel: z.string().optional().describe("Relationship verb to filter by (e.g. 'ally', 'founded', 'serves')"),
  },
  async ({ id, rel }) => {
    const source = loadNode(id);
    if (!source) {
      return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
    }

    const rels = source.relationships ?? [];
    const filtered = rel ? rels.filter((r) => r.rel === rel) : rels;

    const resolved = filtered.map((r) => {
      const target = loadNode(r.target);
      return {
        rel: r.rel,
        notes: r.notes,
        node: target ? nodeHeader(target) : { id: r.target, error: "not found" },
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ source: nodeHeader(source), relationships: resolved }, null, 2),
        },
      ],
    };
  }
);

// ── get_context_bundle ───────────────────────────────────────

server.tool(
  "get_context_bundle",
  "Get a rich writing context bundle for a chapter or encounter. Returns the primary node plus all related NPCs, locations, factions, artifacts, and events resolved from its relationship graph.",
  {
    id: z.string().describe("Chapter or encounter node ID (e.g. 'chapter-7-aris-the-fracturing-capital')"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(2)
      .optional()
      .default(1)
      .describe("Traversal depth. 1 = direct relationships only. 2 = also follow NPC/location relationships."),
  },
  async ({ id, depth }) => {
    const primary = loadNode(id);
    if (!primary) {
      return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
    }

    const visited = new Set<string>([id]);
    const bucket: Record<string, GraphNode[]> = {
      npc: [], location: [], faction: [], artifact: [], event: [], chapter: [], concept: [], encounter: [],
    };

    function harvest(node: GraphNode) {
      for (const r of node.relationships ?? []) {
        if (visited.has(r.target)) continue;
        visited.add(r.target);
        const related = loadNode(r.target);
        if (!related) continue;
        bucket[related.type]?.push(related);
        if (depth === 2 && (related.type === "npc" || related.type === "location")) {
          harvest(related);
        }
      }
    }

    harvest(primary);

    const result: Record<string, unknown> = { primary };
    for (const [type, nodes] of Object.entries(bucket)) {
      if (nodes.length > 0) result[`${type}s`] = nodes;
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── get_schema ───────────────────────────────────────────────

server.tool(
  "get_schema",
  "Get the game book node schema: types, status values, and valid relationship verbs.",
  {},
  async () => {
    const raw = fs.readFileSync(SCHEMA_PATH, "utf8");
    return { content: [{ type: "text", text: raw }] };
  }
);

// ── create_node ──────────────────────────────────────────────

server.tool(
  "create_node",
  "Create a new game book node. Writes the node file and registers it in the index.",
  {
    id: z.string().describe("Node ID in <type>-<slug> format (e.g. 'npc-new-character')"),
    type: z.enum(NODE_TYPES).describe("Node type"),
    name: z.string().describe("Human-readable name"),
    summary: z.string().describe("One-sentence description"),
    status: z.string().optional().describe("Status value appropriate for the node type"),
    tags: z.array(z.string()).optional().describe("Tag list"),
    content: z.string().optional().describe("Extended prose detail"),
    relationships: z
      .array(
        z.object({
          target: z.string(),
          rel: z.string(),
          notes: z.string().optional(),
        })
      )
      .optional()
      .describe("Relationships to other nodes"),
    sources: z.array(z.string()).optional().describe("Source file paths (relative to repo root)"),
  },
  async ({ id, type, name, summary, status, tags, content, relationships, sources }) => {
    // Validate ID convention
    if (!id.startsWith(`${type}-`)) {
      return {
        content: [{ type: "text", text: `ID '${id}' must start with '${type}-'` }],
        isError: true,
      };
    }

    if (loadNode(id)) {
      return { content: [{ type: "text", text: `Node already exists: ${id}` }], isError: true };
    }

    const node: GraphNode = { id, type, name, summary };
    if (status) node.status = status;
    if (tags?.length) node.tags = tags;
    if (content) node.content = content;
    if (relationships?.length) node.relationships = relationships;
    if (sources?.length) node.sources = sources;

    saveNode(node);

    // Register in index
    const index = loadIndex();
    const section = `${type}s`;
    if (!index[section]) index[section] = [];
    if (!index[section].includes(id)) {
      index[section].push(id);
      saveIndex(index);
    }

    return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
  }
);

// ── update_node ──────────────────────────────────────────────

server.tool(
  "update_node",
  "Update fields on an existing node. Merges provided fields — does not overwrite omitted fields. Relationships are appended unless replace_relationships is true.",
  {
    id: z.string().describe("Node ID to update"),
    name: z.string().optional(),
    summary: z.string().optional(),
    status: z.string().optional(),
    tags: z.array(z.string()).optional(),
    content: z.string().optional(),
    relationships: z
      .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
      .optional()
      .describe("Relationships to merge in (or replace if replace_relationships is true)"),
    replace_relationships: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, replace the entire relationships array instead of appending"),
    sources: z.array(z.string()).optional(),
  },
  async ({ id, name, summary, status, tags, content, relationships, replace_relationships, sources }) => {
    const node = loadNode(id);
    if (!node) {
      return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
    }

    if (name !== undefined) node.name = name;
    if (summary !== undefined) node.summary = summary;
    if (status !== undefined) node.status = status;
    if (tags !== undefined) node.tags = tags;
    if (content !== undefined) node.content = content;
    if (sources !== undefined) node.sources = sources;

    if (relationships !== undefined) {
      if (replace_relationships) {
        node.relationships = relationships;
      } else {
        const existing = node.relationships ?? [];
        // Append only rels not already present (matched by target+rel)
        for (const newRel of relationships) {
          const dupe = existing.some((e) => e.target === newRel.target && e.rel === newRel.rel);
          if (!dupe) existing.push(newRel);
        }
        node.relationships = existing;
      }
    }

    saveNode(node);
    return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
  }
);

// ── add_relationship ─────────────────────────────────────────

server.tool(
  "add_relationship",
  "Add a single relationship to an existing node. Safe convenience wrapper around update_node.",
  {
    from: z.string().describe("Source node ID"),
    target: z.string().describe("Target node ID"),
    rel: z.string().describe("Relationship verb (e.g. 'ally', 'founded', 'serves')"),
    notes: z.string().optional().describe("Optional clarifying note"),
  },
  async ({ from, target, rel, notes }) => {
    const node = loadNode(from);
    if (!node) {
      return { content: [{ type: "text", text: `Node not found: ${from}` }], isError: true };
    }

    const existing = node.relationships ?? [];
    const dupe = existing.some((e) => e.target === target && e.rel === rel);
    if (dupe) {
      return { content: [{ type: "text", text: `Relationship already exists: ${from} -[${rel}]-> ${target}` }] };
    }

    const newRel: Relationship = { target, rel };
    if (notes) newRel.notes = notes;
    existing.push(newRel);
    node.relationships = existing;

    saveNode(node);
    return { content: [{ type: "text", text: `Added: ${from} -[${rel}]-> ${target}` }] };
  }
);

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
