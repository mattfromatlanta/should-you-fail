# Should You Fail - Campaign Context

## Project Overview

This repository contains all materials for the Dungeons & Dragons campaign **Should You Fail**, authored and run by **Matt From Atlanta**.

## Campaign Summary

Should You Fail is an epic D&D campaign centered around an existential threat from the Estarans, ancient beings who once inflicted catastrophic destruction on the mortal realms. The story follows a party of heroes as they uncover the truth about this ancient conflict and must unite dragons, mortals, and Fey to prevent the return of the Estarans and their doomsday plan.

Key campaign elements:
- The Allied Cities governed by the Counsel of Citizens
- Gallifax, an ancient and powerful dragon ally
- Milicent, a powerful figure raising an army in the Shadowfell
- Cetyri, a lost dragon who is key to the final plan
- The Gold Dragon Singularity, a weapon to defeat the Estarans. Cetyri's destiny?
- Travel between worlds and planes (Material, Shadowfell, Feywild)

## Source of Truth: The Graph

**The graph is the authoritative source of truth for all campaign information.**

All campaign data lives in `graph/nodes/` as individual YAML files. The graph is served by an MCP server (`mcp/`) and is the primary interface for reading and writing campaign content.

- `graph/_schema.yaml` — full node schema and field documentation
- `graph/_index.yaml` — index of all nodes by type
- `graph/nodes/` — individual YAML files for every NPC, location, chapter, event, artifact, faction, concept, and encounter

When assisting with this campaign, **read from and write to the graph nodes**. Do not treat `.md` files as authoritative — they are either archived originals or working drafts.

## The Archive

All original `.md` source files (chapters, NPCs, planning docs, world notes) have been moved to the `archive/` folder. These files are **read-only historical reference** — do not modify them. Reference archive content only when explicitly asked by the user.

Archive structure mirrors the original layout:
- `archive/chapters/` — original chapter write-ups
- `archive/npcs/` — original NPC documents
- `archive/planning/` — original planning notes
- `archive/world/` — original world-building documents

## Project Goals

### 1. Document Organization & Preservation
The graph captures all established campaign information. The graph nodes are the canonical record going forward — new sessions, NPCs, locations, and events should be added as graph nodes.

### 2. Monster Data Tool
Build a browser plugin to capture monster data from D&D Beyond pages. This tool will:
- Extract monster statistics and abilities from D&D Beyond
- Design a storage schema for monster data
- Enable creation of encounter sheets
- For private use only

### 3. AI-Assisted Encounter Format
Establish a standard format for writing encounters that an AI agent can support. This will enable:
- Consistent encounter documentation
- AI assistance in encounter creation and management
- Easier session preparation

### 4. Writing Tool Integration
Work out seamless integration with iA Writer or Ulysses to enable:
- Smooth writing workflow for campaign content
- AI assistance while writing in preferred tools
- Efficient session note-taking and encounter creation

### 5. Campaign Development
Build outlines and encounters for the remaining campaign arc, including:
- Detailed encounter descriptions
- NPC development
- Plot progression and story beats
- World-building details

## Repository Structure

```
graph/           ← SOURCE OF TRUTH
  _schema.yaml
  _index.yaml
  nodes/

archive/         ← READ-ONLY HISTORICAL REFERENCE
  chapters/
  npcs/
  planning/
  world/

mcp/             ← MCP server for graph access
instructions.txt ← DM working notes
```

## Notes for AI Assistance

When assisting with this campaign:
- **Consult graph nodes first** — they are the source of truth
- Maintain consistency with established lore and characters
- Follow D&D 5th Edition 2024 rules unless otherwise specified
- Preserve the epic scope and stakes of the story
- Support the DM's narrative style and pacing
- Only reference `archive/` content when the user explicitly requests it
