export interface Relationship {
  target: string;
  rel: string;
  notes?: string;
}

export type Audience = "player-available" | "dm-only";

export interface GraphNode {
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
}

export type NodeIndex = Record<string, string[]>;

export const NODE_TYPES = [
  "pc",
  "npc",
  "location",
  "chapter",
  "event",
  "artifact",
  "faction",
  "concept",
  "encounter",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
