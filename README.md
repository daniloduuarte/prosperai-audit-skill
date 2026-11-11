# Prosperaí Audit Skill

Skill de auditoria semanal automatizada para projetos SaaS multi-tenant (Next.js + Supabase). Roda todo domingo às 23h59 UTC via GitHub Actions e envia relatório completo por e-mail.

## O que faz

1. **Isolamento entre tenants** — consulta `pg_policies` ao vivo e sinaliza tabelas sem RLS, policies públicas em tabelas sensíveis, e desvios do padrão estabelecido.
2. **Força bruta** — verifica chaves de rate limit no Upstash Redis (IP/e-mail perto ou batendo no limite).
3. **Vulnerabilidades** — `npm audit` + `npm outdated` reais no runner do CI.
4. **Regressão de código** — tsc + eslint + build + diff estrutural (via `verify-saas`).
5. **Incidentes** — logs da Vercel (5xx/timeout) + histórico real de crons (`cron_run_log`).
6. **Health check** — Supabase, app em produção, Upstash.

## Instalação

```bash
npx tsx https://raw.githubusercontent.com/daniloduuarte/prosperai-audit-skill/main/setup.ts
```

O comando roda um wizard interativo que pergunta sobre o seu negócio (tipo de serviço, stack, canais de notificação) e personaliza a skill automaticamente para o seu projeto.

## Variáveis de ambiente necessárias (GitHub Secrets)

```
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ACCESS_TOKEN       # Management API, pro scan de RLS
KV_REST_API_URL             # Upstash Redis
KV_REST_API_TOKEN
VERCEL_TOKEN                # pra ler logs de runtime
DEPLOYED_APP_URL
SLACK_WEBHOOK_URL           # opcional
```

## Disparo manual

```bash
gh workflow run weekly-audit.yml
# ou local:
npx tsx lib/audit/run.ts
```

## Consultar último relatório

```sql
select * from audit_reports order by timestamp desc limit 1;
```

## Licença

MIT