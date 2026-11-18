import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ColumnRow, DefinerFunctionRow, PolicyRow, RlsSnapshot, TableRow } from "./rls-rules";

/** Modo offline do scan de RLS: reconstrói tabelas, colunas, RLS e policies
 * lendo os arquivos de supabase/migrations, sem token e sem rede. É uma
 * aproximação: não vê o que foi mudado direto no painel do Supabase. */

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`;
const TBL = String.raw`(?:(?:"public"|public)\s*\.\s*)?(${IDENT})`;
const CONSTRAINT_START = /^(constraint|primary|foreign|unique|check|like|exclude)\b/i;
const unq = (s: string): string => s.replace(/^"|"$/g, "").toLowerCase();

export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

function dollarBodiesRemoved(sql: string): string {
  return sql.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, "''");
}

/** Conteúdo entre o parêntese que abre em `start` e o que fecha. */
function balanced(s: string, start: number): { inner: string; end: number } | null {
  let depth = 0;
  let quote = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { inner: s.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function clauseAfter(stmt: string, keyword: RegExp): string | null {
  const m = keyword.exec(stmt);
  if (!m) return null;
  const open = stmt.indexOf("(", m.index + m[0].length - 1);
  const b = open >= 0 ? balanced(stmt, open) : null;
  return b ? b.inner.trim() : null;
}

export function parseMigrations(files: string[]): RlsSnapshot {
  const tables = new Map<string, TableRow>();
  const columns = new Map<string, Set<string>>();
  const policies = new Map<string, PolicyRow>();
  const definers = new Map<string, DefinerFunctionRow>();
  const revoked = new Set<string>();

  for (const raw of files) {
    const clean = stripSqlNoise(raw);
    // Funções SECURITY DEFINER: o cabeçalho fica antes do corpo $$...$$
    for (const m of clean.matchAll(new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:(?:"public"|public)\s*\.\s*)?(${IDENT})\s*\(([^)]*)\)([\s\S]*?)(?:\$[A-Za-z_]*\$|\bas\s+')`, "gi"))) {
      const name = unq(m[1]);
      if (/security\s+definer/i.test(m[3])) definers.set(name, { name, args: m[2].trim() });
      else definers.delete(name);
    }
    const sql = dollarBodiesRemoved(clean);
    for (const m of sql.matchAll(new RegExp(String.raw`revoke\s+(?:all|execute)[^;]*?on\s+function\s+(?:(?:"public"|public)\s*\.\s*)?(${IDENT})[^;]*?from\s+([^;]*)`, "gi"))) {
      if (/\b(public|anon)\b/i.test(m[2])) revoked.add(unq(m[1]));
    }
    for (const stmt of sql.split(";")) {
      const s = stmt.trim();
      let m = new RegExp(String.raw`^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${TBL}\s*\(`, "i").exec(s);
      if (m) {
        const name = unq(m[1]);
        const b = balanced(s, s.indexOf("(", m.index + m[0].length - 1));
        tables.set(name, { name, rls: false });
        const cols = new Set<string>();
        for (const part of splitTopLevel(b?.inner ?? "")) {
          const p = part.trim();
          if (!p || CONSTRAINT_START.test(p)) continue;
          const first = new RegExp(`^(${IDENT})`).exec(p);
          if (first) cols.add(unq(first[1]));
        }
        columns.set(name, cols);
        continue;
      }
      m = new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?${TBL}`, "i").exec(s);
      if (m) {
        const name = unq(m[1]);
        tables.delete(name);
        columns.delete(name);
        for (const k of [...policies.keys()]) if (k.startsWith(`${name}\u0000`)) policies.delete(k);
        continue;
      }
      m = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${TBL}\s+([\s\S]*)$`, "i").exec(s);
      if (m) {
        const name = unq(m[1]);
        const rest = m[2];
        const t = tables.get(name);
        if (/\benable\s+row\s+level\s+security\b/i.test(rest) && t) t.rls = true;
        if (/\bdisable\s+row\s+level\s+security\b/i.test(rest) && t) t.rls = false;
        for (const a of rest.matchAll(new RegExp(String.raw`add\s+column\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, "gi"))) columns.get(name)?.add(unq(a[1]));
        for (const a of rest.matchAll(new RegExp(String.raw`drop\s+column\s+(?:if\s+exists\s+)?(${IDENT})`, "gi"))) columns.get(name)?.delete(unq(a[1]));
        continue;
      }
      m = new RegExp(String.raw`^create\s+policy\s+(${IDENT})\s+on\s+${TBL}([\s\S]*)$`, "i").exec(s);
      if (m) {
        const policyName = unq(m[1]);
        const table = unq(m[2]);
        const rest = m[3];
        const cmd = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest)?.[1].toUpperCase() ?? "ALL";
        const toMatch = /\bto\s+([\s\S]*?)(?=\s+(?:using|with\s+check)\b|$)/i.exec(rest);
        const roles = toMatch ? toMatch[1].split(",").map((r) => unq(r.trim())).filter(Boolean) : [];
        const qual = clauseAfter(rest, /\busing\s*\(/i);
        const withCheck = clauseAfter(rest, /\bwith\s+check\s*\(/i);
        policies.set(`${table}\u0000${policyName}`, { table, name: policyName, cmd, roles, qual, withCheck });
        continue;
      }
      m = new RegExp(String.raw`^drop\s+policy\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+${TBL}`, "i").exec(s);
      if (m) policies.delete(`${unq(m[2])}\u0000${unq(m[1])}`);
    }
  }

  const colRows: ColumnRow[] = [];
  for (const [table, set] of columns) for (const column of set) colRows.push({ table, column });
  return {
    tables: [...tables.values()],
    columns: colRows,
    policies: [...policies.values()],
    definerFunctions: [...definers.values()].filter((f) => !revoked.has(f.name)),
  };
}

export function readMigrationFiles(cwd: string): string[] | null {
  const dir = path.join(cwd, "supabase", "migrations");
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".sql")).sort();
  return names.length === 0 ? null : names.map((f) => readFileSync(path.join(dir, f), "utf-8"));
}
