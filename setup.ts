#!/usr/bin/env tsx
/**
 * Prosperaí Audit Skill — Setup Wizard
 *
 * Comando: npx tsx https://raw.githubusercontent.com/daniloduuarte/prosperai-audit-skill/main/setup.ts
 *
 * Faz perguntas sobre o negócio da pessoa e personaliza a skill automaticamente.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log("\n🔒 Prosperaí Audit Skill — Setup\n");
  console.log("Vou fazer algumas perguntas pra personalizar a auditoria pro seu projeto.\n");

  const projectName = await ask("Nome do projeto (ex: Minha Barbearia): ") || "meu-projeto";
  const businessType = await ask("Tipo de negócio (barbearia, estética, pet shop, consultório, outro): ") || "serviços";
  const stack = await ask("Stack do projeto (next-supabase, next-firebase, outro): ") || "next-supabase";
  const notifyEmail = await ask("E-mail pra receber o relatório semanal: ") || "";
  const slackWebhook = await ask("Slack webhook URL (opcional, Enter pra pular): ");
  const tenantColumn = await ask("Nome da coluna de tenant no banco (padrão: organization_id): ") || "organization_id";
  const cronSchedule = await ask("Horário da auditoria (cron expression, padrão: 0 23 * * 0 = domingo 23h UTC): ") || "0 23 * * 0";

  console.log("\n⚙️  Gerando configuração personalizada...\n");

  const config = {
    projectName,
    businessType,
    stack,
    notifyEmail,
    slackWebhook: slackWebhook || undefined,
    tenantColumn,
    cronSchedule,
    generatedAt: new Date().toISOString(),
  };

  // Cria diretório .claude/skills/auditoria se não existir
  const skillDir = path.join(process.cwd(), ".claude", "skills", "auditoria");
  fs.mkdirSync(skillDir, { recursive: true });

  // Salva config personalizada
  const configPath = path.join(skillDir, "audit-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✅ Config salva em ${configPath}`);

  // Gera SKILL.md personalizado
  const skillMd = `# Skill: Auditoria Semanal do ${projectName}

## Propósito

Auditoria semanal automatizada para **${projectName}** (${businessType}).
Roda via GitHub Actions no horário \`${cronSchedule}\` e envia relatório para ${notifyEmail || "(e-mail não configurado)"}.

## Stack detectada

${stack}

## Coluna de tenant

\`${tenantColumn}\` — usada em todos os scans de isolamento.

## O que cada scan cobre

1. **Isolamento entre tenants** — consulta \`pg_policies\` ao vivo e sinaliza tabelas sem RLS, policies públicas em tabelas sensíveis, e desvios do padrão.
2. **Força bruta** — verifica chaves de rate limit no Upstash Redis.
3. **Vulnerabilidades** — \`npm audit\` + \`npm outdated\`.
4. **Regressão de código** — tsc + eslint + build + diff estrutural.
5. **Incidentes** — logs da Vercel (5xx/timeout) + histórico de crons.
6. **Health check** — Supabase, app em produção, Upstash.

## Variáveis de ambiente necessárias (GitHub Secrets)

\`\`\`
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ACCESS_TOKEN
KV_REST_API_URL
KV_REST_API_TOKEN
VERCEL_TOKEN
DEPLOYED_APP_URL
${slackWebhook ? "SLACK_WEBHOOK_URL" : "# SLACK_WEBHOOK_URL — opcional"}
\`\`\`

## Disparo manual

\`\`\`bash
gh workflow run weekly-audit.yml
# ou local:
npx tsx lib/audit/run.ts
\`\`\`

---
Gerado automaticamente pelo setup wizard em ${config.generatedAt}.
`;

  const skillMdPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, skillMd);
  console.log(`✅ SKILL.md gerado em ${skillMdPath}`);

  // Gera workflow personalizado
  const workflowDir = path.join(process.cwd(), ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });

  const workflowYml = `name: Weekly Audit — ${projectName}

on:
  schedule:
    - cron: "${cronSchedule}"
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
          ${slackWebhook ? 'SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}' : ''}
        run: npx tsx lib/audit/run.ts
`;

  const workflowPath = path.join(workflowDir, "weekly-audit.yml");
  fs.writeFileSync(workflowPath, workflowYml);
  console.log(`✅ Workflow gerado em ${workflowPath}`);

  console.log("\n🎉 Setup completo! Resumo:\n");
  console.log(`   Projeto:    ${projectName}`);
  console.log(`   Negócio:    ${businessType}`);
  console.log(`   Stack:      ${stack}`);
  console.log(`   Tenant col: ${tenantColumn}`);
  console.log(`   Cron:       ${cronSchedule}`);
  console.log(`   E-mail:     ${notifyEmail || "(não configurado)"}`);
  console.log(`   Slack:      ${slackWebhook || "(não configurado)"}`);
  console.log("\n📋 Próximos passos:");
  console.log("   1. Adicione as variáveis acima como GitHub Secrets no repositório");
  console.log("   2. Faça commit e push dos arquivos gerados");
  console.log("   3. A auditoria vai rodar automaticamente todo domingo às 23h UTC");
  console.log("   4. Disparo manual: gh workflow run weekly-audit.yml\n");

  rl.close();
}

main().catch((err) => {
  console.error("❌ Erro no setup:", err.message);
  rl.close();
  process.exit(1);
});