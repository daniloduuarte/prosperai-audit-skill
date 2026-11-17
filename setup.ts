#!/usr/bin/env tsx
/**
 * Setup da skill de auditoria. Rode na RAIZ do seu projeto:
 *
 *   git clone --depth 1 https://github.com/daniloduuarte/prosperai-audit-skill /tmp/audit-skill
 *   npx tsx /tmp/audit-skill/setup.ts            (interativo)
 *   npx tsx /tmp/audit-skill/setup.ts --yes      (aceita os padrões detectados)
 *   npx tsx /tmp/audit-skill/setup.ts --dry-run  (só mostra o que faria)
 *   --public-repo  repositório público: resumo das Actions só com a nota, sem artefato
 *   --force        sobrescreve arquivos existentes diferentes
 *
 * Escreve: lib/audit/*, audit.config.json, .claude/skills/auditoria/SKILL.md e
 * .github/workflows/weekly-audit.yml. Nunca sobrescreve arquivo diferente sem
 * perguntar (com --yes, mantém o existente; use --force para sobrescrever).
 * Não lê valores de segredo: do .env só confere se o NOME da variável existe.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RAW_BASE = "https://raw.githubusercontent.com/daniloduuarte/prosperai-audit-skill/main/templates/";
export const TSX_VERSION = "4.23.15";
export const ACTIONS = {
  checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0",
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
};
export const AUDIT_FILES = [
  "types.ts", "config.ts", "http.ts", "exec.ts", "redact.ts", "report.ts", "notify.ts", "run.ts",
  "scans/rls.ts", "scans/rls-rules.ts", "scans/deps.ts", "scans/saude.ts",
  "scans/forca-bruta.ts", "scans/logs.ts", "scans/codigo.ts",
];
const TENANT_CANDIDATES = ["organization_id", "tenant_id", "company_id", "org_id", "workspace_id", "account_id", "team_id"];
type ScanId = "rls" | "deps" | "saude" | "forcaBruta" | "logs" | "codigo";
const SCAN_IDS: ScanId[] = ["rls", "deps", "saude", "forcaBruta", "logs", "codigo"];

export type Args = { yes: boolean; dryRun: boolean; force: boolean; publicRepo: boolean };
export type Detected = {
  projectName: string; hasNext: boolean; hasSupabase: boolean; tenantColumn: string | null;
  hasRedis: boolean; hasVercel: boolean; hasLock: boolean; hasTsconfig: boolean;
};
export type SetupConfig = {
  projectName: string; tenantColumn: string; notifyEmail: string; scans: Record<ScanId, boolean>;
  failOnCritical: boolean; publicRepo: boolean; bruteForce: { keyPatterns: string[]; threshold: number; maxKeys: number };
  codigo: { eslint: boolean; build: boolean };
};

export function parseArgs(argv: string[]): Args {
  return { yes: argv.includes("--yes") || argv.includes("-y"), dryRun: argv.includes("--dry-run"), force: argv.includes("--force"), publicRepo: argv.includes("--public-repo") };
}

function envNames(cwd: string): Set<string> {
  const names = new Set<string>();
  for (const f of [".env.local", ".env", ".env.example"]) {
    const p = path.join(cwd, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
      if (m) names.add(m[1]); // só o nome; o valor nunca é lido para nada
    }
  }
  return names;
}

export function detectTenantColumn(cwd: string): string | null {
  const dir = path.join(cwd, "supabase", "migrations");
  if (!existsSync(dir)) return null;
  const counts = new Map<string, number>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync(path.join(dir, f), "utf-8").toLowerCase();
    for (const c of TENANT_CANDIDATES) {
      const n = sql.match(new RegExp(`\\b${c}\\b`, "g"))?.length ?? 0;
      counts.set(c, (counts.get(c) ?? 0) + n);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

export function detectProject(cwd: string): Detected {
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    pkg = {};
  }
  const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, unknown>;
  const names = envNames(cwd);
  return {
    projectName: typeof pkg.name === "string" && pkg.name ? pkg.name : path.basename(cwd),
    hasNext: "next" in deps,
    hasSupabase: "@supabase/supabase-js" in deps || "@supabase/ssr" in deps || existsSync(path.join(cwd, "supabase")),
    tenantColumn: detectTenantColumn(cwd),
    hasRedis: "@upstash/redis" in deps || "@upstash/ratelimit" in deps || names.has("KV_REST_API_URL"),
    hasVercel: existsSync(path.join(cwd, "vercel.json")) || existsSync(path.join(cwd, ".vercel")) || names.has("VERCEL_PROJECT_ID"),
    hasLock: existsSync(path.join(cwd, "package-lock.json")),
    hasTsconfig: existsSync(path.join(cwd, "tsconfig.json")),
  };
}

export function defaultConfig(d: Detected, publicRepo = false): SetupConfig {
  return {
    projectName: d.projectName,
    tenantColumn: d.tenantColumn ?? "organization_id",
    notifyEmail: "",
    scans: { rls: d.hasSupabase, deps: true, saude: true, forcaBruta: d.hasRedis, logs: d.hasVercel, codigo: d.hasTsconfig },
    failOnCritical: true,
    publicRepo,
    bruteForce: { keyPatterns: ["ratelimit:*"], threshold: 10, maxKeys: 500 },
    codigo: { eslint: false, build: false },
  };
}

export function workflowSecrets(scans: Record<ScanId, boolean>): string[] {
  const s: string[] = [];
  if (scans.rls || scans.saude) s.push("NEXT_PUBLIC_SUPABASE_URL");
  if (scans.rls) s.push("SUPABASE_ACCESS_TOKEN");
  if (scans.saude) s.push("DEPLOYED_APP_URL");
  if (scans.forcaBruta) s.push("KV_REST_API_URL", "KV_REST_API_READ_ONLY_TOKEN");
  if (scans.logs) s.push("VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID");
  s.push("RESEND_API_KEY", "RESEND_FROM", "NOTIFY_EMAIL", "SLACK_WEBHOOK_URL");
  return s;
}

export function renderWorkflow(scans: Record<ScanId, boolean>, hasLock: boolean, publicRepo = false, cron = "0 23 * * 0"): string {
  const env = workflowSecrets(scans).map((n) => `          ${n}: \${{ secrets.${n} }}`).join("\n");
  return `# Gerado pelo setup da skill de auditoria. Revise antes de commitar.
name: Auditoria semanal

on:
  schedule:
    - cron: "${cron}" # domingo 23h UTC; o GitHub pode atrasar alguns minutos
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: weekly-audit
  cancel-in-progress: false

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          persist-credentials: false
      - uses: ${ACTIONS.setupNode}
        with:
          node-version: "22"${hasLock ? "\n          cache: npm" : ""}
      - name: Instalar dependências (sem segredos neste passo)
        run: ${hasLock ? "npm ci" : "npm install --no-audit --no-fund"}
      - name: Rodar auditoria
        run: npx --yes tsx@${TSX_VERSION} lib/audit/run.ts
        env:
${env}
${publicRepo ? "      # Repositório público: sem artefato (seria visível a todos). Relatório completo só por e-mail.\n" : `      - name: Guardar relatório
        if: always()
        uses: ${ACTIONS.uploadArtifact}
        with:
          name: audit-report
          path: audit-report.md
          retention-days: 30
          if-no-files-found: ignore
`}`;
}

export function renderSkill(template: string, c: SetupConfig): string {
  return template.replaceAll("{{PROJECT}}", c.projectName).replaceAll("{{TENANT}}", c.tenantColumn);
}

/** Pasta templates/ ao lado deste arquivo (rodando de um clone), ou null. */
export function localTemplatesDir(): string | null {
  try {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");
    return existsSync(path.join(dir, "audit", "run.ts")) ? dir : null;
  } catch {
    return null;
  }
}

export async function loadTemplate(rel: string, localDir: string | null): Promise<string> {
  if (localDir) return readFileSync(path.join(localDir, rel), "utf-8");
  const base = process.env.AUDIT_SKILL_TEMPLATES_URL || RAW_BASE;
  if (!base.startsWith("https://")) throw new Error("AUDIT_SKILL_TEMPLATES_URL precisa ser https://");
  const res = await fetch(base + rel);
  if (!res.ok) throw new Error(`Não consegui baixar ${rel} (HTTP ${res.status}).`);
  return res.text();
}

export type PlannedFile = { path: string; content: string };

export async function planFiles(c: SetupConfig, hasLock: boolean, localDir: string | null): Promise<PlannedFile[]> {
  const files: PlannedFile[] = [];
  for (const rel of AUDIT_FILES) files.push({ path: `lib/audit/${rel}`, content: await loadTemplate(`audit/${rel}`, localDir) });
  files.push({ path: "audit.config.json", content: `${JSON.stringify(c, null, 2)}\n` });
  files.push({ path: ".claude/skills/auditoria/SKILL.md", content: renderSkill(await loadTemplate("skill/SKILL.md", localDir), c) });
  files.push({ path: ".github/workflows/weekly-audit.yml", content: renderWorkflow(c.scans, hasLock, c.publicRepo) });
  return files;
}

function makeAsk(): { ask: (q: string, def: string) => Promise<string>; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  return {
    ask: (q, def) =>
      closed
        ? Promise.resolve(def)
        : new Promise((resolve) => {
            const onClose = (): void => resolve(def);
            rl.once("close", onClose);
            rl.question(`${q} [${def}]: `, (a) => { rl.off("close", onClose); resolve(a.trim() || def); });
          }),
    close: () => rl.close(),
  };
}

const yesNo = (v: boolean): string => (v ? "s" : "n");

async function interactive(c: SetupConfig, ask: (q: string, def: string) => Promise<string>): Promise<SetupConfig> {
  const out = structuredClone(c);
  out.notifyEmail = await ask("E-mail para o relatório (vazio = use o secret NOTIFY_EMAIL; recomendado em repo público)", "");
  out.publicRepo = (await ask("O repositório no GitHub é PÚBLICO? (s/n)", yesNo(out.publicRepo))).toLowerCase().startsWith("s");
  const tenant = await ask("Coluna de tenant", out.tenantColumn);
  if (/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(tenant)) out.tenantColumn = tenant;
  for (const id of SCAN_IDS) out.scans[id] = (await ask(`Ligar scan ${id}? (s/n)`, yesNo(out.scans[id]))).toLowerCase().startsWith("s");
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  console.log("\nSkill de auditoria: setup\n");
  if (!existsSync(path.join(cwd, "package.json"))) console.log("Aviso: sem package.json aqui. Rode na raiz do projeto.\n");
  const d = detectProject(cwd);
  console.log(`Projeto: ${d.projectName}\nNext.js: ${d.hasNext ? "sim" : "não"} | Supabase: ${d.hasSupabase ? "sim" : "não"} | Redis: ${d.hasRedis ? "sim" : "não"} | Vercel: ${d.hasVercel ? "sim" : "não"}`);
  console.log(`Coluna de tenant: ${d.tenantColumn ?? "não detectada (padrão organization_id)"} | package-lock: ${d.hasLock ? "sim" : "não"}\n`);

  const prompt = args.yes || args.dryRun ? null : makeAsk();
  let config = defaultConfig(d, args.publicRepo);
  if (prompt) config = await interactive(config, prompt.ask);

  const localDir = localTemplatesDir();
  console.log(`Modelos: ${localDir ? `pasta local ${localDir}` : "download do GitHub"}\n`);
  const files = await planFiles(config, d.hasLock, localDir);

  for (const f of files) {
    const target = path.join(cwd, f.path);
    const exists = existsSync(target);
    const same = exists && readFileSync(target, "utf-8") === f.content;
    let action = !exists ? "criar" : same ? "igual" : args.force ? "sobrescrever" : "manter";
    if (exists && !same && !args.force && prompt && !args.dryRun) {
      const a = await prompt.ask(`${f.path} já existe e é diferente. Sobrescrever? (s/n)`, "n");
      action = a.toLowerCase().startsWith("s") ? "sobrescrever" : "manter";
    }
    console.log(`  ${action.padEnd(12)} ${f.path}`);
    if (args.dryRun || action === "igual" || action === "manter") continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf-8");
  }
  prompt?.close();

  if (args.dryRun) console.log("\n--dry-run: nada foi escrito.");
  console.log(`\nPróximos passos:
  1. Adicione os secrets no GitHub (Settings > Secrets and variables > Actions): ${workflowSecrets(config.scans).join(", ")}.
     Todos são opcionais: o scan sem segredo é pulado com aviso. NÃO é preciso SUPABASE_SERVICE_ROLE_KEY.
  2. Coloque audit-report.md no .gitignore.
  3. Teste local: npx tsx lib/audit/run.ts  e depois commit + push; dispare em Actions > Auditoria semanal > Run workflow.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((e: unknown) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
