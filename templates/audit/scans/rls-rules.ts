import type { Finding } from "../types";

/** Regras puras do scan de RLS: recebem o que foi lido do catálogo do
 * Postgres e devolvem achados. Sem rede, sem banco: testável com fixtures. */

export type TableRow = { name: string; rls: boolean };
export type ColumnRow = { table: string; column: string };
export type PolicyRow = {
  table: string;
  name: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  withCheck: string | null;
};
export type DefinerFunctionRow = { name: string; args: string };

export type RlsSnapshot = {
  tables: TableRow[];
  columns: ColumnRow[];
  policies: PolicyRow[];
  definerFunctions: DefinerFunctionRow[];
};

const SENSITIVE_PART =
  /(^|_)(e?mails?|cpf|cnpj|tokens?|senhas?|passwords?|passwd|phones?|telefones?|celular|secrets?|keys?|apikey)(_|$)/i;
const SENSITIVE_ANYWHERE = /email|password|senha|cpf|cnpj/i;

export function isSensitiveColumn(column: string): boolean {
  return SENSITIVE_PART.test(column) || SENSITIVE_ANYWHERE.test(column);
}

/** "true", "(true)", " TRUE " contam como liberado para todo mundo. */
export function isAlwaysTrue(clause: string | null): boolean {
  if (clause === null) return false;
  let c = clause.trim().toLowerCase();
  while (c.startsWith("(") && c.endsWith(")")) c = c.slice(1, -1).trim();
  return c === "true";
}

function appliesToAnonymous(roles: string[]): boolean {
  return roles.length === 0 || roles.some((r) => r === "public" || r === "anon");
}

function mentionsColumn(clause: string | null, column: string): boolean {
  if (!clause) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${column}([^A-Za-z0-9_]|$)`, "i").test(clause);
}

export function ruleTablesWithoutRls(s: RlsSnapshot): Finding[] {
  return s.tables
    .filter((t) => !t.rls)
    .map((t) => ({
      severity: "critico" as const,
      title: "Tabela sem RLS no schema public",
      where: `public.${t.name}`,
      why: "Sem RLS, qualquer role com acesso à tabela (inclusive anon, pela API REST do Supabase) lê e altera todas as linhas.",
      fix: `alter table public.${t.name} enable row level security; e depois crie policies explícitas para quem pode ler e gravar.`,
    }));
}

export function ruleOpenPolicyOnSensitiveTable(s: RlsSnapshot): Finding[] {
  const out: Finding[] = [];
  for (const p of s.policies) {
    const cmd = p.cmd.toUpperCase();
    if (cmd !== "SELECT" && cmd !== "ALL") continue;
    if (!isAlwaysTrue(p.qual) || !appliesToAnonymous(p.roles)) continue;
    const sensitive = s.columns.filter((c) => c.table === p.table && isSensitiveColumn(c.column)).map((c) => c.column);
    if (sensitive.length === 0) continue;
    out.push({
      severity: "alto",
      title: "Leitura pública (using true) em tabela com colunas sensíveis",
      where: `public.${p.table}, policy "${p.name}" (colunas: ${sensitive.join(", ")})`,
      why: "RLS filtra linhas, não colunas: uma policy using (true) para anon/public expõe TODAS as colunas da tabela, inclusive as sensíveis, para qualquer visitante.",
      fix: "Mova as colunas sensíveis para outra tabela com policy restrita, ou troque a policy por uma condição real (dono, membro, tenant). Revogar coluna com GRANT não resolve se a tabela inteira tem select.",
    });
  }
  return out;
}

export function ruleTenantColumnNotUsed(s: RlsSnapshot, tenantColumn: string): Finding[] {
  const out: Finding[] = [];
  const rlsOn = new Set(s.tables.filter((t) => t.rls).map((t) => t.name));
  const withTenant = new Set(
    s.columns.filter((c) => c.column.toLowerCase() === tenantColumn.toLowerCase()).map((c) => c.table),
  );
  for (const table of withTenant) {
    if (!rlsOn.has(table)) continue; // já coberto pela regra de tabela sem RLS
    const policies = s.policies.filter((p) => p.table === table);
    if (policies.length === 0) continue; // RLS sem policy = ninguém acessa: seguro
    const used = policies.some((p) => mentionsColumn(p.qual, tenantColumn) || mentionsColumn(p.withCheck, tenantColumn));
    if (used) continue;
    out.push({
      severity: "medio",
      title: `Tabela com ${tenantColumn} mas nenhuma policy usa essa coluna`,
      where: `public.${table} (${policies.length} policy(s): ${policies.map((p) => p.name).join(", ")})`,
      why: "Se nenhuma policy compara a coluna de tenant, um usuário logado de uma empresa pode enxergar linhas de outra. Pode ser intencional (ex.: acesso só pelo próprio usuário), por isso é para revisar.",
      fix: `Confirme se a policy isola por tenant. Se não, use algo como using (${tenantColumn} in (select ... onde o usuário é membro)).`,
    });
  }
  return out;
}

export function ruleDefinerFunctionsExecutableByAnon(s: RlsSnapshot): Finding[] {
  return s.definerFunctions.map((f) => ({
    severity: "medio" as const,
    title: "Função SECURITY DEFINER executável por anon",
    where: `public.${f.name}(${f.args})`,
    why: "SECURITY DEFINER roda com os privilégios do dono e ignora o RLS. Se anon pode executar, qualquer visitante chama a função pela API (/rest/v1/rpc).",
    fix: `Se não for pública de propósito: revoke execute on function public.${f.name}(${f.args}) from anon, public; e valide auth.uid() e o tenant dentro da função.`,
  }));
}

export function analyzeRls(s: RlsSnapshot, tenantColumn: string): Finding[] {
  return [
    ...ruleTablesWithoutRls(s),
    ...ruleOpenPolicyOnSensitiveTable(s),
    ...ruleTenantColumnNotUsed(s, tenantColumn),
    ...ruleDefinerFunctionsExecutableByAnon(s),
  ];
}
