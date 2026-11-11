#!/usr/bin/env tsx
/**
 * Prosperaí Audit Skill — Setup Inteligente
 *
 * Comando: npx tsx https://raw.githubusercontent.com/daniloduuarte/prosperai-audit-skill/main/setup.ts
 *
 * Lê o projeto automaticamente (package.json, schema, env vars, estrutura)
 * e personaliza a skill sem perguntas desnecessárias.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q: string): Promise<string> {
 return new Promise((r) => rl.question(q, (a) => r(a.trim())));
}

// ── Detecção automática do projeto ──────────────────────────────────────

function detectProject() {
 const cwd = process.cwd();
 const info: Record<string, unknown> = {
 stack: "desconhecida",
 tenantColumn: "organization_id",
 hasSupabase: false,
 hasVercel: false,
 hasRedis: false,
 projectName: "",
 businessType: "",
 };

 // package.json
 const pkgPath = path.join(cwd, "package.json");
 if (fs.existsSync(pkgPath)) {
 try {
 const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
 info.projectName = pkg.name || "";
 const deps = { ...pkg.dependencies, ...pkg.devDependencies };
 if (deps["@supabase/supabase-js"] || deps["@supabase/ssr"]) info.hasSupabase = true;
 if (deps["next"]) info.stack = "next-supabase";
 if (deps["@upstash/redis"] || deps["ioredis"]) info.hasRedis = true;
 const name = (info.projectName as string).toLowerCase();
 if (name.includes("barber") || name.includes("barbearia")) info.businessType = "barbearia";
 else if (name.includes("estetica") || name.includes("beauty")) info.businessType = "estética";
 else if (name.includes("pet")) info.businessType = "pet shop";
 else if (name.includes("consult") || name.includes("saude")) info.businessType = "consultório";
 else info.businessType = "serviços";
 } catch {}
 }

 // .env / .env.local
 for (const envFile of [".env.local", ".env", ".env.production"]) {
 const p = path.join(cwd, envFile);
 if (fs.existsSync(p)) {
 const content = fs.readFileSync(p, "utf-8");
 if (content.includes("SUPABASE")) info.hasSupabase = true;
 if (content.includes("KV_REST") || content.includes("UPSTASH")) info.hasRedis = true;
 if (content.includes("VERCEL_TOKEN")) info.hasVercel = true;
 }
 }

 // vercel.json
 if (fs.existsSync(path.join(cwd, "vercel.json"))) info.hasVercel = true;

 // Detecta coluna de tenant no schema/migrations
 const migDir = path.join(cwd, "supabase", "migrations");
 if (fs.existsSync(migDir)) {
 const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort().reverse();
 for (const f of files.slice(0, 10)) {
 const sql = fs.readFileSync(path.join(migDir, f), "utf-8");
 const match = sql.match(/organization_id|tenant_id|company_id|org_id/i);
 if (match) {
 info.tenantColumn = match[0].toLowerCase();
 break;
 }
 }
 }

 return info;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
 console.log("\n🔒 Prosperaí Audit Skill — Setup Inteligente\n");
 console.log("Analisando seu projeto...\n");

 const info = detectProject();

 console.log(` 📦 Projeto: ${info.projectName || "(não detectado)"}`);
 console.log(` 🏢 Tipo: ${info.businessType}`);
 console.log(` ⚙️ Stack: ${info.stack}`);
 console.log(` 🗄️ Tenant: ${info.tenantColumn}`);
 console.log(` ✅ Supabase: ${info.hasSupabase ? "sim" : "não"}`);
 console.log(` ✅ Redis: ${info.hasRedis ? "sim" : "não"}`);
 console.log(` ✅ Vercel: ${info.hasVercel ? "sim" : "não"}\n`);

 // Só pergunta o e-mail se não encontrar no .env
 let notifyEmail = "";
 const envLocal = path.join(process.cwd(), ".env.local");
 if (fs.existsSync(envLocal)) {
 const m = fs.readFileSync(envLocal, "utf-8").match(/NOTIFY_EMAIL=(.+)/i);
 if (m) notifyEmail = m[1].trim().replace(/['"]/g, "");
 }
 if (!notifyEmail) {
 notifyEmail = await ask("📧 E-mail pra receber o relatório semanal: ");
 }

 console.log("\n⚙️ Gerando configuração personalizada...\n");

 const config = {
 projectName: info.projectName || "meu-projeto",
 businessType: info.businessType,
 stack: info.stack,
 notifyEmail,
 tenantColumn: info.tenantColumn,
 cronSchedule: "0 23 * * 0",
 hasSupabase: info.hasSupabase,
 hasRedis: info.hasRedis,
 hasVercel: info.hasVercel,
 generatedAt: new Date().toISOString(),
 };

 const skillDir = path.join(process.cwd(), ".claude", "skills", "auditoria");
 fs.mkdirSync(skillDir, { recursive: true });

 fs.writeFileSync(
 path.join(skillDir, "audit-config.json"),
 JSON.stringify(config, null, 2),
 );
 console.log(`✅ Config salva em .claude/skills/auditoria/audit-config.json`);

 const slackLine = config.hasRedis
 ? "SLACK_WEBHOOK_URL # opcional"
 : "# SLACK_WEBHOOK_URL # opcional";

 const skillMd = `# Skill: Auditoria Semanal do ${config.projectName}

## Propósito

Auditoria semanal automatizada para **${config.projectName}** (${config.businessType}).
Roda via GitHub Actions todo domingo às 23h UTC e envia relatório para ${notifyEmail || "(e-mail não configurado)"}.

## Stack detectada

${config.stack} · Supabase: ${config.hasSupabase ? "✅" : "❌"} · Redis: ${config.hasRedis ? "✅" : "❌"} · Vercel: ${config.hasVercel ? "✅" : "❌"}

## Coluna de tenant

\`${config.tenantColumn}\`

## Scans

1. Isolamento entre tenants (pg_policies ao vivo)
2. Força bruta (rate limit no Redis)
3. Vulnerabilidades (npm audit + outdated)
4. Regressão de código (tsc + eslint + build)
5. Incidentes (logs Vercel + cron_run_log)
6. Health check (Supabase, app, Upstash)

## Variáveis de ambiente (GitHub Secrets)

\`\`\`
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ACCESS_TOKEN
KV_REST_API_URL
KV_REST_API_TOKEN
VERCEL_TOKEN
DEPLOYED_APP_URL
${slackLine}
\`\`\`

## Disparo manual

\`\`\`bash
gh workflow run weekly-audit.yml
npx tsx lib/audit/run.ts
\`\`\`

---
Gerado automaticamente em ${config.generatedAt}.
`;

 fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);
 console.log(`✅ SKILL.md gerado`);

 const wfDir = path.join(process.cwd(), ".github", "workflows");
 fs.mkdirSync(wfDir, { recursive: true });

 const wf = `name: Weekly Audit — ${config.projectName}

on:
 schedule:
 - cron: "${config.cronSchedule}"
 workflow_dispatch:

jobs:
 audit:
 runs-on: ubuntu-latest
 steps:
 - uses: actions/checkout@v4
 - uses: actions/setup-node@v4
 with:
 node-version: 20
 cache: npm
 - run: npm ci
 - name: Run audit
 env:
 NEXT_PUBLIC_SUPABASE_URL: \${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
 SUPABASE_SERVICE_ROLE_KEY: \${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
 SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}
 KV_REST_API_URL: \${{ secrets.KV_REST_API_URL }}
 KV_REST_API_TOKEN: \${{ secrets.KV_REST_API_TOKEN }}
 VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
 DEPLOYED_APP_URL: \${{ secrets.DEPLOYED_APP_URL }}
 run: npx tsx lib/audit/run.ts
`;

 fs.writeFileSync(path.join(wfDir, "weekly-audit.yml"), wf);
 console.log(`✅ Workflow gerado`);

 console.log("\n🎉 Pronto! A auditoria está configurada pro seu projeto.");
 console.log(" Adicione as variáveis como GitHub Secrets e faça push.\n");
 rl.close();
}

main().catch((e) => {
 console.error("❌", e.message);
 rl.close();
 process.exit(1);
});