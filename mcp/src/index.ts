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

type Audience = "player-available" | "dm-only";

interface GraphNode {
  id: string;
  type: string;
  name: string;
  audience?: Audience;
  tags?: string[];
  status?: string;
  summary?: string;
  // v2 fields
  player_content?: string;
  dm_content?: string;
  public_links?: Relationship[];
  dm_links?: Relationship[];
  // v1 legacy fields (still read until apply_audience rewrites)
  content?: string;
  relationships?: Relationship[];
  sources?: string[];
}

type NodeIndex = Record<string, string[]>;

const NODE_TYPES = ["pc", "npc", "location", "chapter", "event", "artifact", "faction", "concept", "encounter"] as const;
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
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    audience: node.audience ?? "",
    status: node.status ?? "",
    summary: node.summary ?? "",
    tags: node.tags ?? [],
    public_link_count: node.public_links?.length ?? 0,
    dm_link_count: node.dm_links?.length ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────
// v2 schema helpers — audience proposal, validation, apply
// ─────────────────────────────────────────────────────────────

const AUDIENCE_REVIEW_PATH = path.join(GAME_BOOK_DIR, "_audience-review.yaml");

// Tag and content signals that strongly suggest dm-only.
const DM_TAG_SIGNALS = new Set([
  "planning",
  "todo",
  "dm-notes",
  "internal",
  "draft",
  "lore-gap",
]);
const DM_CONTENT_REGEXES = [/\bDM[\s:]*NOTE\b/i, /\bTBD\b/, /\bTODO\b/, /\bOUTSTANDING\b/];

interface AudienceProposal {
  id: string;
  type: string;
  name: string;
  status: string;
  current_audience: string;
  proposed_audience: Audience;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

function proposeForNode(node: GraphNode): AudienceProposal {
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

interface ReviewFile {
  version: number;
  generated: string;
  instructions: string;
  total_nodes: number;
  by_confidence: { high: number; medium: number; low: number };
  proposals: AudienceProposal[];
}

function readReviewFile(): ReviewFile | null {
  if (!fs.existsSync(AUDIENCE_REVIEW_PATH)) return null;
  return yaml.load(fs.readFileSync(AUDIENCE_REVIEW_PATH, "utf8")) as ReviewFile;
}

interface ValidationError {
  id: string;
  field: string;
  message: string;
}

function validateNode(node: GraphNode, allNodes: Map<string, GraphNode>): ValidationError[] {
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

    return { content: [{ type: "text", text: JSON.stringify(nodes.map(nodeHeader), null, 2) }] };
  }
);

// ── find_same_property ───────────────────────────────────────

server.tool(
  "find_same_property",
  "Find nodes by shared property: same type, same status, and/or same tag. Filters combine with AND semantics. Returns headers (use get_node to drill in). Use to explore thematic or structural proximity without graph traversal — e.g. 'all NPCs tagged \"dragon\"', 'all locations with status active', 'all player-available nodes tagged \"naeliste\"'.",
  {
    type: z.enum(NODE_TYPES).optional().describe("Limit to one node type"),
    status: z.string().optional().describe("Match status value exactly"),
    tag: z.string().optional().describe("Tag that must be present on the node"),
    audience: z.enum(["player-available", "dm-only"]).optional().describe("Filter by audience"),
    exclude_id: z.string().optional().describe("Exclude this node from results (useful for 'others like this one')"),
  },
  async ({ type, status, tag, audience, exclude_id }) => {
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

    const headers = nodes.map(nodeHeader);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: headers.length, filters: { type, status, tag, audience, exclude_id }, results: headers }, null, 2),
        },
      ],
    };
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
  },
  async ({ id, depth, mode }) => {
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

    const result: Record<string, unknown> = { primary, mode };
    for (const [type, nodes] of Object.entries(bucket)) {
      if (nodes.length === 0) continue;
      result[`${type}s`] = mode === "full" ? nodes : nodes.map(nodeHeader);
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
  "Create a new game book node (v2 schema). Writes the node file and registers it in the index.",
  {
    id: z.string().describe("Node ID in <type>-<slug> format (e.g. 'npc-new-character')"),
    type: z.enum(NODE_TYPES).describe("Node type"),
    name: z.string().describe("Human-readable name"),
    audience: z
      .enum(["player-available", "dm-only"])
      .describe("player-available (has both player_content + dm_content) or dm-only (dm_content only)"),
    summary: z.string().describe("One-sentence description"),
    status: z.string().optional().describe("Status value appropriate for the node type"),
    tags: z.array(z.string()).optional().describe("Tag list"),
    player_content: z
      .string()
      .optional()
      .describe("Player-facing prose. Only meaningful for player-available nodes; may be empty."),
    dm_content: z.string().optional().describe("DM-facing prose. The primary content field."),
    public_links: z
      .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
      .optional()
      .describe("Relationships visible to players. Targets must be player-available."),
    dm_links: z
      .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
      .optional()
      .describe("DM-only relationships."),
    sources: z.array(z.string()).optional().describe("Source file paths (relative to repo root)"),
  },
  async ({ id, type, name, audience, summary, status, tags, player_content, dm_content, public_links, dm_links, sources }) => {
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

    const node: GraphNode = { id, type, name, audience, summary };
    if (status) node.status = status;
    if (tags?.length) node.tags = tags;
    if (audience === "player-available") node.player_content = player_content ?? "";
    if (dm_content) node.dm_content = dm_content;
    if (public_links?.length) node.public_links = public_links;
    if (dm_links?.length) node.dm_links = dm_links;
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
  "Update fields on an existing v2 node. **Replace semantics**: every field provided replaces the existing value in full, including arrays (tags, public_links, dm_links, sources). Fields you omit are left untouched. Agent contract: call get_node first, modify the values you want to change, then call update_node with the new state. For adding a single relationship without rewriting a whole array, use add_relationship. To move a relationship between dm_links and public_links, use promote_link.",
  {
    id: z.string().describe("Node ID to update"),
    name: z.string().optional(),
    audience: z.enum(["player-available", "dm-only"]).optional(),
    summary: z.string().optional(),
    status: z.string().optional(),
    tags: z.array(z.string()).optional().describe("Replaces the entire tags array"),
    player_content: z.string().optional(),
    dm_content: z.string().optional(),
    public_links: z
      .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
      .optional()
      .describe("Replaces the entire public_links array"),
    dm_links: z
      .array(z.object({ target: z.string(), rel: z.string(), notes: z.string().optional() }))
      .optional()
      .describe("Replaces the entire dm_links array"),
    sources: z.array(z.string()).optional().describe("Replaces the entire sources array"),
  },
  async ({ id, name, audience, summary, status, tags, player_content, dm_content, public_links, dm_links, sources }) => {
    const node = loadNode(id);
    if (!node) {
      return { content: [{ type: "text", text: `Node not found: ${id}` }], isError: true };
    }

    if (name !== undefined) node.name = name;
    if (audience !== undefined) node.audience = audience;
    if (summary !== undefined) node.summary = summary;
    if (status !== undefined) node.status = status;
    if (tags !== undefined) node.tags = tags;
    if (player_content !== undefined) node.player_content = player_content;
    if (dm_content !== undefined) node.dm_content = dm_content;
    if (sources !== undefined) node.sources = sources;
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
    return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
  }
);

// ── add_relationship ─────────────────────────────────────────

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

// ── rename_node ──────────────────────────────────────────────

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

// ── delete_node ──────────────────────────────────────────────

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

// ── promote_link ─────────────────────────────────────────────

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

// ── validate_schema ──────────────────────────────────────────

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

// ── propose_audience ─────────────────────────────────────────

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

// ── apply_audience ───────────────────────────────────────────

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

      if (node.sources?.length) next.sources = node.sources;

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

// ─────────────────────────────────────────────────────────────
// Name Generation
// ─────────────────────────────────────────────────────────────

interface EndingGroup {
  weight: number;
  values: string[];
}

interface NameRules {
  description: string;
  first_parts: string[];
  second_parts: string[];
  second_part_probability: number;
  endings: EndingGroup[];
  approved?: string[];
  forbidden?: string[];
  name_pool?: string[];
  pool_probability?: number;
}

const NAME_RULES_DIR = path.resolve(__dirname, "../name-rules");

function loadNameRules(category: string): NameRules | null {
  const filePath = path.join(NAME_RULES_DIR, `${category}.yaml`);
  if (!fs.existsSync(filePath)) return null;
  return yaml.load(fs.readFileSync(filePath, "utf8")) as NameRules;
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedEndingChoice(rules: NameRules): string {
  const total = rules.endings.reduce((s, g) => s + g.weight, 0);
  let r = Math.random() * total;
  for (const g of rules.endings) {
    r -= g.weight;
    if (r <= 0) return randomItem(g.values);
  }
  return randomItem(rules.endings[rules.endings.length - 1].values);
}

function generateOneName(rules: NameRules): string | null {
  // Occasionally draw directly from the pre-crafted name pool
  if (rules.name_pool?.length && Math.random() < (rules.pool_probability ?? 0)) {
    return randomItem(rules.name_pool);
  }

  const first = randomItem(rules.first_parts);
  let ending = weightedEndingChoice(rules);

  // Prevent phonetic repetition at first→ending seam (e.g. "cor"+"or" = "coror")
  let endingAttempts = 0;
  while (first.slice(-2) === ending.slice(0, 2) && endingAttempts < 5) {
    ending = weightedEndingChoice(rules);
    endingAttempts++;
  }

  let second = "";
  if (Math.random() < rules.second_part_probability) {
    const candidate = randomItem(rules.second_parts);
    // Prevent same-char seam: first→second (e.g. "al"+"l") or second→ending (e.g. "li"+"is")
    const firstSecondSeam = first.charAt(first.length - 1) === candidate.charAt(0);
    const secondEndingSeam = candidate.charAt(candidate.length - 1) === ending.charAt(0);
    if (!firstSecondSeam && !secondEndingSeam) second = candidate;
  } else {
    // No second_part: prevent single-char vowel doubling at first→ending (e.g. "ta"+"ael")
    let attempts = 0;
    while (first.charAt(first.length - 1) === ending.charAt(0) && attempts < 5) {
      ending = weightedEndingChoice(rules);
      attempts++;
    }
  }

  const raw = first + second + ending;
  // Reject forbidden names (real-world collisions, etc.)
  if (rules.forbidden?.map((f) => f.toLowerCase()).includes(raw.toLowerCase())) return null;

  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// ── generate_name ────────────────────────────────────────────

server.tool(
  "generate_name",
  "Generate names for a given category. Available categories: 'estaran', 'mortal'. Rules loaded from mcp/name-rules/{category}.yaml.",
  {
    category: z.string().describe("Name category. Available: 'estaran' (Estaran race names), 'mortal' (mortal/human names). Must match a file in mcp/name-rules/."),
    count: z.number().int().min(1).max(50).optional().describe("Number of names to generate (default 20, max 50)"),
  },
  async ({ category, count = 20 }) => {
    const rules = loadNameRules(category);
    if (!rules) {
      const available = fs.existsSync(NAME_RULES_DIR)
        ? fs.readdirSync(NAME_RULES_DIR).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(".yaml", ""))
        : [];
      return {
        content: [{ type: "text", text: `No rules found for '${category}'. Available: ${available.join(", ") || "none"}` }],
        isError: true,
      };
    }

    const approvedSet = new Set((rules.approved ?? []).map((n) => n.toLowerCase()));
    const names = new Set<string>();
    let attempts = 0;
    while (names.size < count && attempts < count * 20) {
      const name = generateOneName(rules);
      if (name && !approvedSet.has(name.toLowerCase())) names.add(name);
      attempts++;
    }

    const result: Record<string, unknown> = { category, description: rules.description };
    if (rules.approved?.length) result.approved = rules.approved;
    result.new = [...names];

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
