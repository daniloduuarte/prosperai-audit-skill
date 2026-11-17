import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { projectRefFromUrl, RLS_QUERIES } from "../templates/audit/scans/rls";
import {
  analyzeRls,
  isAlwaysTrue,
  isSensitiveColumn,
  ruleDefinerFunctionsExecutableByAnon,
  ruleOpenPolicyOnSensitiveTable,
  ruleTablesWithoutRls,
  ruleTenantColumnNotUsed,
  type RlsSnapshot,
} from "../templates/audit/scans/rls-rules";

const snap = JSON.parse(readFileSync(new URL("./fixtures/rls-snapshot.json", import.meta.url), "utf-8")) as RlsSnapshot;

test("tabela sem RLS vira crítico; tabelas com RLS não", () => {
  const f = ruleTablesWithoutRls(snap);
  assert.deepEqual(f.map((x) => x.where), ["public.notas_soltas"]);
  assert.equal(f[0].severity, "critico");
});

test("using (true) para anon em tabela sensível vira alto", () => {
  const f = ruleOpenPolicyOnSensitiveTable(snap);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "alto");
  assert.match(f[0].where, /clientes.*leitura publica.*email, phone/);
});

test("using (true) sem coluna sensível, só para authenticated, ou em INSERT não alerta", () => {
  const where = ruleOpenPolicyOnSensitiveTable(snap).map((x) => x.where).join(" ");
  assert.doesNotMatch(where, /catalogo/); // keyboard_layout não é sensível
  assert.doesNotMatch(where, /contatos_publicos/); // authenticated e INSERT
});

test("roles vazio conta como public", () => {
  const s: RlsSnapshot = {
    tables: [{ name: "t", rls: true }],
    columns: [{ table: "t", column: "cpf" }],
    policies: [{ table: "t", name: "p", cmd: "ALL", roles: [], qual: "(true)", withCheck: null }],
    definerFunctions: [],
  };
  assert.equal(ruleOpenPolicyOnSensitiveTable(s).length, 1);
});

test("tabela com coluna de tenant sem policy que a use vira médio", () => {
  const f = ruleTenantColumnNotUsed(snap, "organization_id");
  assert.deepEqual(f.map((x) => x.where.split(" ")[0]), ["public.pedidos"]);
  assert.equal(f[0].severity, "medio");
});

test("policy que cita a coluna (em maiúsculas), tabela sem policy e coluna de outro nome não alertam", () => {
  const tables = ruleTenantColumnNotUsed(snap, "organization_id").map((x) => x.where).join(" ");
  assert.doesNotMatch(tables, /faturas|logs_internos|clientes/);
  assert.equal(ruleTenantColumnNotUsed(snap, "tenant_id").length, 0);
});

test("função SECURITY DEFINER executável por anon vira médio; lista vazia não alerta", () => {
  const f = ruleDefinerFunctionsExecutableByAnon(snap);
  assert.equal(f.length, 1);
  assert.match(f[0].where, /buscar_cliente_por_email\(p_email text\)/);
  assert.equal(ruleDefinerFunctionsExecutableByAnon({ ...snap, definerFunctions: [] }).length, 0);
});

test("analyzeRls junta as 4 regras", () => {
  assert.equal(analyzeRls(snap, "organization_id").length, 4);
});

test("detecção de coluna sensível e de using true", () => {
  for (const c of ["email", "user_email", "cpf", "access_token", "senha_hash", "phone", "client_secret", "api_key", "stripe_key"]) {
    assert.ok(isSensitiveColumn(c), c);
  }
  for (const c of ["id", "nome", "keyboard_layout", "monkey", "tokenizer_version", "created_at"]) {
    assert.ok(!isSensitiveColumn(c), c);
  }
  assert.ok(isAlwaysTrue("true") && isAlwaysTrue(" (TRUE) ") && !isAlwaysTrue("(active = true)") && !isAlwaysTrue(null));
});

test("consultas do scan são só SELECT, sem ponto e vírgula", () => {
  for (const sql of Object.values(RLS_QUERIES)) {
    assert.match(sql, /^\s*select\s/i);
    assert.ok(!sql.includes(";"));
    assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  }
});

test("project ref sai da URL do Supabase; URL estranha não", () => {
  assert.equal(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co"), "abcdefghijklmnopqrst");
  assert.equal(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co/"), "abcdefghijklmnopqrst");
  assert.equal(projectRefFromUrl("https://evil.com/?x=.supabase.co"), null);
  assert.equal(projectRefFromUrl(undefined), null);
});
