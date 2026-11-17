import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_CONFIG } from "../templates/audit/config";
import { RLS_QUERIES, scanRls } from "../templates/audit/scans/rls";

/** Scan de RLS de ponta a ponta com a Management API simulada (fetch
 * trocado). Nenhuma credencial real, nenhuma chamada de rede. */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_PROJECT_REF;
});

const ANSWERS: Record<string, unknown[]> = {
  [RLS_QUERIES.tables]: [{ name: "perfis", rls: true }, { name: "rascunhos", rls: false }],
  [RLS_QUERIES.columns]: [{ table: "perfis", column: "email" }],
  [RLS_QUERIES.policies]: [{ table: "perfis", name: "aberto", cmd: "SELECT", roles: "{anon}", qual: "true", withCheck: null }],
  [RLS_QUERIES.definerFunctions]: [],
};

test("scanRls lê o catálogo, normaliza roles em texto e aplica as regras", async () => {
  process.env.SUPABASE_ACCESS_TOKEN = "token-de-teste-falso";
  process.env.SUPABASE_PROJECT_REF = "projetoficticio0001";
  const calls: { url: string; body: { query: string; read_only: boolean } }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; read_only: boolean };
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify(ANSWERS[body.query] ?? []), { status: 200 });
  }) as typeof fetch;

  const r = await scanRls(DEFAULT_CONFIG);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.findings.map((f) => f.severity).sort(), ["alto", "critico"]);
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.url, "https://api.supabase.com/v1/projects/projetoficticio0001/database/query");
    assert.equal(c.body.read_only, true);
  }
});

test("scanRls com token inválido vira erro explicado, sem vazar o token", async () => {
  process.env.SUPABASE_ACCESS_TOKEN = "sbp_0123456789abcdef0123456789";
  process.env.SUPABASE_PROJECT_REF = "projetoficticio0001";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Unauthorized sbp_0123456789abcdef0123456789" }), { status: 401 })) as typeof fetch;
  const r = await scanRls(DEFAULT_CONFIG);
  assert.equal(r.status, "erro");
  assert.match(r.reason ?? "", /401/);
  assert.ok(!(r.reason ?? "").includes("sbp_0123"), r.reason);
});

test("scanRls sem token é pulado com motivo", async () => {
  const r = await scanRls(DEFAULT_CONFIG);
  assert.equal(r.status, "pulado");
  assert.match(r.reason ?? "", /SUPABASE_ACCESS_TOKEN/);
});
