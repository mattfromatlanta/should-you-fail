import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { INDEX_PATH, NODES_DIR } from "./paths.js";
import type { GraphNode, NodeIndex } from "./types.js";

export function loadNode(id: string): GraphNode | null {
  const filePath = path.join(NODES_DIR, `${id}.yaml`);
  if (!fs.existsSync(filePath)) return null;
  return yaml.load(fs.readFileSync(filePath, "utf8")) as GraphNode;
}

export function loadAllNodes(): GraphNode[] {
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

export function loadIndex(): NodeIndex {
  if (!fs.existsSync(INDEX_PATH)) return {};
  return (yaml.load(fs.readFileSync(INDEX_PATH, "utf8")) as NodeIndex) ?? {};
}

export function saveNode(node: GraphNode): void {
  const filePath = path.join(NODES_DIR, `${node.id}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(node, { lineWidth: 120, quotingType: '"' }), "utf8");
}

export function saveIndex(index: NodeIndex): void {
  fs.writeFileSync(INDEX_PATH, yaml.dump(index, { lineWidth: 120 }), "utf8");
}

export function nodeHeader(node: GraphNode) {
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
