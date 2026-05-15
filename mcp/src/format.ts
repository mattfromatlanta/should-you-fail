import { z } from "zod";

import { nodeHeader } from "./io.js";
import type { GraphNode, Relationship } from "./types.js";

// Tools that have a `format` parameter accept this. Default is markdown so the
// approval pane in Claude Desktop renders prose instead of an escaped JSON blob.
// Agents that need structured output should pass format="json".
export const FormatParam = z
  .enum(["markdown", "json"])
  .optional()
  .default("markdown")
  .describe(
    "Output format. 'markdown' (default) renders headed sections with prose paragraphs — readable in clients that render markdown. 'json' returns the structured object as a raw JSON string for programmatic use."
  );

export type Format = "markdown" | "json";

function joinLines(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join("\n");
}

function renderLinkList(links: Relationship[] | undefined): string | null {
  if (!links?.length) return null;
  return links
    .map((l) => {
      const base = `- \`${l.target}\` — ${l.rel}`;
      return l.notes ? `${base}\n  - ${l.notes}` : base;
    })
    .join("\n");
}

export function formatNode(node: GraphNode): string {
  const meta: string[] = [`**Type:** ${node.type}`];
  if (node.audience) meta.push(`**Audience:** ${node.audience}`);
  if (node.status) meta.push(`**Status:** ${node.status}`);
  if (node.tags?.length) meta.push(`**Tags:** ${node.tags.join(", ")}`);

  const sections: (string | null)[] = [
    `# ${node.name}  \n\`${node.id}\``,
    meta.join("  \n"),
    node.summary ? `**Summary:** ${node.summary}` : null,
    node.player_content !== undefined && node.player_content !== ""
      ? `## Player content\n\n${node.player_content.trim()}`
      : null,
    node.dm_content
      ? `## DM content\n\n${node.dm_content.trim()}`
      : null,
    // Legacy v1 fields, kept for nodes that have not yet been migrated.
    node.content
      ? `## Content (legacy v1)\n\n${node.content.trim()}`
      : null,
    renderLinkList(node.public_links)
      ? `## Public links\n\n${renderLinkList(node.public_links)}`
      : null,
    renderLinkList(node.dm_links)
      ? `## DM links\n\n${renderLinkList(node.dm_links)}`
      : null,
    renderLinkList(node.relationships)
      ? `## Relationships (legacy v1)\n\n${renderLinkList(node.relationships)}`
      : null,
  ];

  return joinLines(sections.map((s, i) => (s ? (i === 0 ? s : `\n${s}`) : null)));
}

export function formatHeader(node: GraphNode): string {
  const h = nodeHeader(node);
  const meta = [h.type, h.audience, h.status].filter(Boolean).join(" · ");
  const tags = h.tags.length ? ` _[${h.tags.join(", ")}]_` : "";
  const summary = h.summary ? `\n  ${h.summary}` : "";
  return `- **${h.name}** \`${h.id}\` — ${meta}${tags}${summary}`;
}

export function formatHeaderList(nodes: GraphNode[], title?: string): string {
  if (!nodes.length) return title ? `## ${title}\n\n_(none)_` : "_(none)_";
  const head = title ? `## ${title} (${nodes.length})\n\n` : "";
  return head + nodes.map(formatHeader).join("\n");
}

// Render a tool response in the requested format. Falls back to JSON for the
// markdown path when no node-shaped data is supplied.
export function renderText(format: Format, markdown: string, jsonValue: unknown): string {
  if (format === "json") return JSON.stringify(jsonValue, null, 2);
  return markdown;
}
