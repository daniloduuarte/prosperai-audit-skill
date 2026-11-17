import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUDIT_FILES, defaultConfig, detectProject, renderWorkflow } from "../setup";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SECRET_VARS = /^(SUPABASE_|NEXT_PUBLIC_SUPABASE|KV_|UPSTASH_|VERCEL_|RESEND_|SLACK_|NOTIFY_EMAIL|DEPLOYED_APP_URL|GITHUB_STEP_SUMMARY|AUDIT_)/;
const temps: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-skill-"));
  temps.push(d);
  return d;
}
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_VARS.test(k)));
}

function runTsx(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [TSX_CLI, script, ...args], { cwd, env: cleanEnv(), encoding: "utf-8", timeout: 120_000 });
}

function fakeProject(): string {
  const d = tempDir();
  writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "loja-ficticia", dependencies: { next: "15.0.0", "@supabase/ssr": "0.5.0" } }));
  mkdirSync(path.join(d, "supabase", "migrations"), { recursive: true });
  writeFileSync(
    path.join(d, "supabase", "migrations", "0001_init.sql"),
    "create table pedidos (id uuid primary key, organization_id uuid not null);\ncreate index on pedidos (organization_id);\n",
  );
  return d;
}

test("lista AUDIT_FILES do setup bate com a pasta templates/audit", () => {
  const dir = path.join(ROOT, "templates", "audit");
  const onDisk = [...readdirSync(dir).filter((f) => f.endsWith(".ts")), ...readdirSync(path.join(dir, "scans")).map((f) => `scans/${f}`)];
  assert.deepEqual([...onDisk].sort(), [...AUDIT_FILES].sort());
});

test("workflow gerado: sem service role, actions pinadas por SHA, permissão mínima", () => {
  const all = { rls: true, deps: true, saude: true, forcaBruta: true, logs: true, codigo: true };
  const wf = renderWorkflow(all, true);
  assert.doesNotMatch(wf, /SERVICE_ROLE/i);
  const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 3);
  for (const u of uses) assert.match(u, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, u);
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /timeout-minutes: \d+/);
  assert.match(wf, /node-version: "22"/);
  assert.match(wf, /npx --yes tsx@\d+\.\d+\.\d+ lib\/audit\/run\.ts/);
  assert.match(wf, /persist-credentials: false/);
  const none = renderWorkflow({ rls: false, deps: true, saude: false, forcaBruta: false, logs: false, codigo: true }, false);
  assert.doesNotMatch(none, /SUPABASE_ACCESS_TOKEN|VERCEL_TOKEN|KV_REST/);
  assert.match(none, /npm install/);
  const pub = renderWorkflow(all, true, true);
  assert.doesNotMatch(pub, /upload-artifact/);
  assert.match(pub, /permissions:\n {2}contents: read/);
});

test("detecção no projeto falso: Next + Supabase + organization_id", () => {
  const d = detectProject(fakeProject());
  assert.equal(d.projectName, "loja-ficticia");
  assert.ok(d.hasNext && d.hasSupabase);
  assert.equal(d.tenantColumn, "organization_id");
  assert.equal(defaultConfig(d).scans.rls, true);
});

test("setup --dry-run em pasta vazia não escreve nada", () => {
  const d = tempDir();
  const r = runTsx(path.join(ROOT, "setup.ts"), ["--dry-run"], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nada foi escrito/);
  assert.deepEqual(readdirSync(d), []);
});

test("setup --yes no projeto falso escreve tudo e não sobrescreve arquivo existente", () => {
  const d = fakeProject();
  mkdirSync(path.join(d, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(d, ".github", "workflows", "weekly-audit.yml"), "# meu workflow\n");
  const r = runTsx(path.join(ROOT, "setup.ts"), ["--yes"], d);
  assert.equal(r.status, 0, r.stderr);
  for (const f of AUDIT_FILES) assert.ok(existsSync(path.join(d, "lib", "audit", f)), f);
  assert.ok(existsSync(path.join(d, ".claude", "skills", "auditoria", "SKILL.md")));
  assert.equal(readFileSync(path.join(d, ".github", "workflows", "weekly-audit.yml"), "utf-8"), "# meu workflow\n");
  assert.match(r.stdout, /manter\s+\.github\/workflows\/weekly-audit\.yml/);
  const cfg = JSON.parse(readFileSync(path.join(d, "audit.config.json"), "utf-8")) as { tenantColumn: string };
  assert.equal(cfg.tenantColumn, "organization_id");
  const skill = readFileSync(path.join(d, ".claude", "skills", "auditoria", "SKILL.md"), "utf-8");
  assert.match(skill, /Auditoria de loja-ficticia/);
  assert.match(skill, /NUNCA aplique correção sem pedir/);
});

test("run.ts sem nenhum segredo: exit 0 e todos os scans pulados com motivo", () => {
  const d = tempDir();
  const r = runTsx(path.join(ROOT, "templates", "audit", "run.ts"), [], d);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const md = readFileSync(path.join(d, "audit-report.md"), "utf-8");
  assert.match(md, /cobertura: 0 de 6 scans rodaram/);
  assert.match(md, /Nota: 100\/100/);
  const rows = md.split("\n").filter((l) => /^\| (?!Scan|---)/.test(l));
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.match(row, /\| pulado \| 0 \|/, row);
    assert.ok(row.split("|")[4].trim().length > 10, `sem motivo: ${row}`);
  }
});
