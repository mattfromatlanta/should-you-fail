# Should You Fail — Campaign MCP Dev Plan

## Overview

A TypeScript MCP server that gives Claude (or any MCP client) structured, graph-aware access to the Should You Fail campaign knowledge base. The server reads and writes **only** from `game-book/` — no other campaign documents are touched.

Pattern follows `~/Repos/audio_dev_mcp`: single `src/index.ts`, TypeScript, `@modelcontextprotocol/sdk`, `js-yaml`, `zod`.

---

## Location

Place the MCP **inside the campaign repo** at:

```
should-you-fail/
  mcp/
    src/
      index.ts
    package.json
    tsconfig.json
    dist/          (built output, gitignored)
```

The server resolves `game-book/` relative to the repo root at runtime using `path.resolve(__dirname, "../../game-book")`.

---

## Data Access Rules

- **Read from:** `game-book/nodes/*.yaml`, `game-book/_index.yaml`, `game-book/_schema.yaml`
- **Write to:** `game-book/nodes/*.yaml`, `game-book/_index.yaml` (new node registration)
- **Never touch:** `chapters/`, `npcs/`, `instructions.txt`, or any other `.md`/`.txt` source files

---

## Tools

### Read Tools

#### `get_node`
Get a single node by its ID.

**Input:** `{ id: string }`
**Returns:** Full YAML node parsed to JSON, or error if not found.

---

#### `list_nodes`
List all nodes, optionally filtered by type.

**Input:** `{ type?: "npc" | "location" | "chapter" | "event" | "artifact" | "faction" | "concept" | "encounter" }`
**Returns:** Array of `{ id, name, summary, status }` objects — lightweight, no full content. Sourced from `_index.yaml` plus a quick read of each node's header fields.

---

#### `search_nodes`
Full-text and structured search across all nodes.

**Input:**
```ts
{
  query?: string,        // matched against name, summary, content (case-insensitive)
  type?: NodeType,
  tag?: string,          // must be in node's tags array
  status?: string,
}
```
**Returns:** Array of matching `{ id, name, type, summary }` objects, ranked by relevance (name match > tag match > content match).

---

#### `get_relationships`
Get all nodes directly related to a given node (1-hop traversal).

**Input:** `{ id: string, rel?: string }` — optionally filter by relationship verb (e.g. `"ally"`, `"founded"`)
**Returns:** The source node plus an array of resolved target nodes (full content), each annotated with `rel` and `notes`.

---

#### `get_context_bundle`
The power tool for writing sessions. Given a chapter or encounter ID, returns a rich bundle of all related content — the primary node plus all related NPCs, locations, factions, artifacts, and events, resolved transitively up to configurable depth (default: 1 hop).

**Input:** `{ id: string, depth?: 1 | 2 }`
**Returns:**
```json
{
  "primary": { ...full node... },
  "npcs": [...],
  "locations": [...],
  "factions": [...],
  "artifacts": [...],
  "events": [...],
  "encounters": [...]
}
```

This is the main tool for "tell me everything relevant to encounter X before I write it."

---

#### `get_schema`
Return the node schema and valid relationship types, so an agent knows how to create valid nodes.

**Input:** `{}`
**Returns:** Contents of `_schema.yaml` as JSON.

---

### Write Tools

#### `create_node`
Create a new node file in `game-book/nodes/` and register it in `_index.yaml`.

**Input:** Full node object (all schema fields). Validated against schema before write.
**Behavior:**
- Validates `id` follows `<type>-<slug>` convention
- Checks for ID collision
- Writes `game-book/nodes/<id>.yaml`
- Appends entry to appropriate section of `_index.yaml`
- Returns the written node

---

#### `update_node`
Update fields on an existing node. Merges provided fields; does not overwrite fields not included.

**Input:** `{ id: string, ...partial node fields }`
**Behavior:**
- Reads existing node
- Deep-merges provided fields (relationships are appended, not replaced, unless `replace_relationships: true` is passed)
- Writes updated YAML back to `game-book/nodes/<id>.yaml`
- Returns the updated node

---

#### `add_relationship`
Convenience tool — add a single relationship to an existing node without rewriting the whole node.

**Input:** `{ from: string, target: string, rel: string, notes?: string }`
**Behavior:** Reads `from` node, appends relationship, writes back. Also adds the inverse pointer to `target` if the relationship type has a natural inverse (optional, configurable).

---

## Project Structure

```
mcp/
  src/
    index.ts        # MCP server, all tools registered here
  package.json
  tsconfig.json
  .gitignore        # ignores dist/ and node_modules/
```

No separate config file needed — all data lives in `game-book/`.

---

## Dependencies

Mirrors `audio_dev_mcp`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "js-yaml": "^4.1.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

---

## Claude Desktop Registration

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "syf-campaign": {
      "command": "node",
      "args": ["/Users/matthewfishel/Repos/should-you-fail/mcp/dist/index.js"]
    }
  }
}
```

---

## Build & Dev Scripts

```json
"scripts": {
  "build": "tsc",
  "dev": "tsc --watch",
  "start": "node dist/index.js"
}
```

---

## Implementation Order

1. **Scaffold** — `package.json`, `tsconfig.json`, `.gitignore`, empty `src/index.ts`
2. **Graph helpers** — `loadNode(id)`, `loadAllNodes()`, `loadIndex()`, `saveNode(node)`, `saveIndex(index)` — pure utility functions
3. **Read tools** — `get_node`, `list_nodes`, `search_nodes`, `get_relationships`, `get_schema`
4. **Bundle tool** — `get_context_bundle` (depends on read tools working)
5. **Write tools** — `create_node`, `update_node`, `add_relationship`
6. **Register & test** — wire up Claude Desktop, run a few queries against the game book

---

## Notes

- All YAML is loaded fresh on each tool call (no caching) — keeps data consistent during active editing sessions
- `get_context_bundle` is the highest-value tool for the DM writing use case
- Write tools are scoped conservatively: `update_node` merges rather than replaces to prevent accidental data loss
- The `sources` field on nodes is preserved but the MCP never reads those source files
