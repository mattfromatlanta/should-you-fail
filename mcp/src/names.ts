import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { NAME_RULES_DIR } from "./paths.js";

interface EndingGroup {
  weight: number;
  values: string[];
}

export interface NameRules {
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

export function loadNameRules(category: string): NameRules | null {
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

export function generateOneName(rules: NameRules): string | null {
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
