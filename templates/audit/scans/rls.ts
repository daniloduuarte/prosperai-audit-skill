import type { AuditConfig } from "../config";
import { fetchWithTimeout, isRecord, readJson } from "../http";
import { safeError } from "../redact";
import { env, skipped, type ScanOutcome } from "../types";
import { parseMigrations, readMigrationFiles } from "./migracoes";
import { analyzeRls, type RlsSnapshot } from "./rls-rules";

/** Lê o catálogo do Postgres pela Management API do Supabase. Só SELECT
 * fixo, escrito aqui: nenhum valor da configuração entra no SQL. Não usa
 * SUPABASE_SERVICE_ROLE_KEY. */

export const RLS_QUERIES = {
  tables: `select c.relname as name, c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
order by c.relname`,
  columns: `select table_name as "table", column_name as "column"
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position`,
  policies: `select tablename as "table", policyname as name, cmd, roles::text[] as roles, qual, with_check as "withCheck"
from pg_policies
where schemaname = 'public'
order by tablename, policyname`,
  definerFunctions: `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and has_function_privilege('anon', p.oid, 'EXECUTE')
order by p.proname`,
} as const;

export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.trim().match(/^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i);
  return match ? match[1].toLowerCase() : null;
}

async function query(ref: string, token: string, sql: string): Promise<Record<string, unknown>[]> {
  if (!/^\s*select\s/i.test(sql) || sql.includes(";")) throw new Error("Consulta não permitida.");
  const res = await fetchWithTimeout(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const data = await readJson(res);
  if (!res.ok || !Array.isArray(data)) {
    const detail = isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
    throw new Error(`Management API respondeu ${res.status}: ${detail}`);
  }
  return data.filter(isRecord);
}

function toRoles(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.replace(/[{}]/g, "").split(",").map((r) => r.trim()).filter(Boolean);
  return [];
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function fetchRlsSnapshot(ref: string, token: string): Promise<RlsSnapshot> {
  const [tables, columns, policies, fns] = await Promise.all([
    query(ref, token, RLS_QUERIES.tables),
    query(ref, token, RLS_QUERIES.columns),
    query(ref, token, RLS_QUERIES.policies),
    query(ref, token, RLS_QUERIES.definerFunctions),
  ]);
  return {
    tables: tables.map((r) => ({ name: str(r.name), rls: r.rls === true || r.rls === "t" || r.rls === "true" })),
    columns: columns.map((r) => ({ table: str(r.table), column: str(r.column) })),
    policies: policies.map((r) => ({
      table: str(r.table),
      name: str(r.name),
      cmd: str(r.cmd),
      roles: toRoles(r.roles),
      qual: strOrNull(r.qual),
      withCheck: strOrNull(r.withCheck),
    })),
    definerFunctions: fns.map((r) => ({ name: str(r.name), args: str(r.args) })),
  };
}

/** Sem token: lê só os arquivos de supabase/migrations (aproximação). */
export function scanOffline(config: AuditConfig, why: string, cwd = process.cwd()): ScanOutcome {
  const files = readMigrationFiles(cwd);
  if (!files) return skipped(why);
  const snapshot = parseMigrations(files);
  return {
    status: "ok",
    summary: [
      `MODO OFFLINE: lido só de supabase/migrations (${files.length} arquivo(s)); não vê mudanças feitas direto no painel. Para ler o banco real, configure SUPABASE_ACCESS_TOKEN`,
      `${snapshot.tables.length} tabelas e ${snapshot.policies.length} policies reconstruídas`,
      `Coluna de tenant verificada: ${config.tenantColumn}`,
    ],
    findings: analyzeRls(snapshot, config.tenantColumn),
  };
}

export async function scanRls(config: AuditConfig): Promise<ScanOutcome> {
  const token = env("SUPABASE_ACCESS_TOKEN");
  const url = env("NEXT_PUBLIC_SUPABASE_URL") ?? env("SUPABASE_URL");
  const ref = env("SUPABASE_PROJECT_REF") ?? projectRefFromUrl(url);
  if (!token) return scanOffline(config, "SUPABASE_ACCESS_TOKEN não configurado (token pessoal do Supabase para a Management API).");
  if (!ref) {
    return skipped(
      "Não deu para descobrir o project ref: configure NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co) ou SUPABASE_PROJECT_REF.",
    );
  }
  try {
    const snapshot = await fetchRlsSnapshot(ref, token);
    const findings = analyzeRls(snapshot, config.tenantColumn);
    return {
      status: "ok",
      summary: [
        `${snapshot.tables.length} tabelas e ${snapshot.policies.length} policies lidas no schema public`,
        `${snapshot.definerFunctions.length} função(ões) SECURITY DEFINER executáveis por anon`,
        `Coluna de tenant verificada: ${config.tenantColumn}`,
      ],
      findings,
    };
  } catch (error) {
    return { status: "erro", reason: safeError(error), summary: [], findings: [] };
  }
}
