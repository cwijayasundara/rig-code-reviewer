// CWE normalisation + CWE-1003 category rollup, so two finders that agree on
// the weakness agree on the category (and therefore dedupe together).
// Data: data/cwe-categories.json, generated from the MITRE CWE catalog by
// scripts/tools/build-cwe.ts (CWE Terms of Use: see NOTICE.md).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Catalog {
  cwe_version: string;
  categories: Record<string, { name: string; title: string }>;
  category_of: Record<string, number | null>;
}

let catalog: Catalog | null = null;
function load(): Catalog {
  if (!catalog) {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "cwe-categories.json");
    catalog = JSON.parse(readFileSync(p, "utf8")) as Catalog;
  }
  return catalog;
}

/** "CWE-89: SQL Injection" | "cwe89" | "89" -> "CWE-89"; anything else -> undefined. */
export function normaliseCwe(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const m = String(raw).match(/(?:CWE[-_ ]?)?(\d{1,5})/i);
  return m ? `CWE-${Number(m[1])}` : undefined;
}

export interface CweCategory { id: string; name: string }

/** Category of a CWE in the CWE-1003 view, or "Uncategorized". */
export function categoryOf(cwe: string | undefined): CweCategory {
  const c = load();
  const n = cwe ? cwe.replace(/^CWE-/, "") : "";
  if (!n) return { id: "uncategorized", name: "Uncategorized" };
  if (c.categories[n]) return { id: `CWE-${n}`, name: c.categories[n]!.name };
  const parent = c.category_of[n];
  if (parent !== undefined && parent !== null && c.categories[String(parent)]) {
    return { id: `CWE-${parent}`, name: c.categories[String(parent)]!.name };
  }
  return { id: "uncategorized", name: "Uncategorized" };
}

export function cweKnown(cwe: string | undefined): boolean {
  if (!cwe) return false;
  const c = load();
  const n = cwe.replace(/^CWE-/, "");
  return n in c.categories || n in c.category_of;
}

export function cweVersion(): string { return load().cwe_version; }
