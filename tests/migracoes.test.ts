import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_CONFIG } from "../templates/audit/config";
import { fixDeps } from "../templates/audit/fix-deps";
import { buildHtml } from "../templates/audit/report";
import { parseMigrations } from "../templates/audit/scans/migracoes";
import { scanOffline } from "../templates/audit/scans/rls";
import { analyzeRls } from "../templates/audit/scans/rls-rules";
import type { ScanResult } from "../templates/audit/types";

const temps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "audit-mig-"));
  temps.push(d);
  return d;
};
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SQL1 = `
-- comentário com create table falsa (id int);
create table public.orgs (id uuid primary key);
alter table public.orgs enable row level security;
create table public.clientes (
  id uuid primary key,
  organization_id uuid references public.orgs(id),
  nome text, email text, cpf text,
  constraint c_unique unique (email)
);
alter table public.clientes enable row level security;
create policy "leitura publica" on public.clientes for select using (true);
create table public.pedidos (id uuid primary key, organization_id uuid, total numeric);
create table public.notas (id uuid primary key, organization_id uuid);
alter table public.notas enable row level security;
create policy "so dono" on public.notas for all to authenticated using (auth.uid() is not null);
create function public.ver_tudo() returns setof public.notas language sql security definer as $$ select * from public.notas; $$;
`;

test("migrations: acha tabela sem RLS, policy using(true) com e-mail/cpf e policy sem tenant", () => {
  const snap = parseMigrations([SQL1]);
  assert.deepEqual(snap.tables.map((t) => t.name).sort(), ["clientes", "notas", "orgs", "pedidos"]);
  assert.ok(snap.columns.some((c) => c.table === "clientes" && c.column === "cpf"));
  assert.ok(!snap.columns.some((c) => c.column === "constraint"));
  const f = analyzeRls(snap, "organization_id");
  const titles = f.map((x) => `${x.severity}:${x.where}`).join("\n");
  assert.match(titles, /critico:public\.pedidos/);
  assert.match(titles, /alto:public\.clientes, policy "leitura publica" \(colunas: email, cpf\)/);
  assert.match(titles, /medio:public\.notas/);
  assert.match(titles, /medio:public\.ver_tudo/);
  assert.ok(!titles.includes("public.orgs"), titles);
});

test("migrations: drop policy, disable/enable RLS, revoke e drop table são respeitados", () => {
  const sql2 = `
drop policy "leitura publica" on public.clientes;
alter table public.pedidos enable row level security;
revoke execute on function public.ver_tudo() from public, anon;
drop table public.notas;`;
  const snap = parseMigrations([SQL1, sql2]);
  assert.deepEqual(analyzeRls(snap, "organization_id"), []);
  assert.equal(snap.tables.some((t) => t.name === "notas"), false);
});

test("migrations: policy com roles authenticated não vira alerta de anon", () => {
  const snap = parseMigrations([
    "create table public.a (id int, email text); alter table public.a enable row level security; create policy p on public.a for select to authenticated using (true);",
  ]);
  assert.deepEqual(analyzeRls(snap, "organization_id"), []);
});

test("scanOffline: sem pasta de migrations é pulado; com pasta roda e avisa que é offline", () => {
  const d = tmp();
  assert.equal(scanOffline(DEFAULT_CONFIG, "sem token", d).status, "pulado");
  mkdirSync(path.join(d, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(d, "supabase", "migrations", "1.sql"), SQL1);
  const r = scanOffline(DEFAULT_CONFIG, "sem token", d);
  assert.equal(r.status, "ok");
  assert.match(r.summary[0], /MODO OFFLINE/);
  assert.ok(r.findings.some((x) => x.severity === "critico"));
});

test("relatório HTML escapa texto e não tem script", () => {
  const results: ScanResult[] = [
    { id: "x", name: "Teste <b>", status: "ok", summary: ["ok"], durationMs: 1, findings: [{ severity: "alto", title: "<script>alert(1)</script>", where: "a&b", why: "w", fix: "f" }] },
  ];
  const html = buildHtml(results, { projectName: "loja", date: new Date(0), warnings: [] });
  assert.ok(!html.includes("<script"), html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /a&amp;b/);
  assert.match(html, /Nota: 90\/100/);
});

test("fix-deps recusa pasta sem git e sem lockfile, sem alterar nada", () => {
  const d = tmp();
  writeFileSync(path.join(d, "package.json"), "{}");
  assert.equal(fixDeps(d).status, "recusado");
  writeFileSync(path.join(d, "package-lock.json"), "{}");
  const before = readFileSync(path.join(d, "package-lock.json"), "utf-8");
  const prev = process.cwd();
  process.chdir(d);
  try {
    // tmp não é repositório git (a pasta temp do sistema não está dentro de um repo)
    assert.equal(fixDeps(d).status, "recusado");
  } finally {
    process.chdir(prev);
  }
  assert.equal(readFileSync(path.join(d, "package-lock.json"), "utf-8"), before);
});
