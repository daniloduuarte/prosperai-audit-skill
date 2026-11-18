---
name: auditoria
description: Roda e interpreta a auditoria de segurança de {{PROJECT}} (RLS e isolamento por {{TENANT}}, dependências, saúde, força bruta, logs, código). Use quando pedirem "roda a auditoria", "como está a segurança", "lê o relatório da auditoria" ou quando o workflow weekly-audit falhar.
---

# Auditoria de {{PROJECT}}

Código em `lib/audit/`, configuração em `audit.config.json`, agenda em `.github/workflows/weekly-audit.yml`.

## Como rodar

```bash
npx tsx lib/audit/run.ts
```

- Rode na raiz do projeto. Os scans leem variáveis de ambiente (veja abaixo); sem elas, o scan é PULADO com o motivo no relatório, nunca quebra.
- Saída: `audit-report.md` na raiz (não commitar). No GitHub Actions, o mesmo texto vai para o resumo da execução e para o artefato `audit-report`.
- Código de saída 1 só quando há achado crítico (`failOnCritical` no config).

Para carregar o `.env.local` sem expor valores: `npx tsx --env-file=.env.local lib/audit/run.ts` (Node 20.6+). Nunca imprima, copie ou cole valores de segredo na conversa.

## Variáveis por scan

| Scan | Precisa de |
|---|---|
| RLS | `SUPABASE_ACCESS_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL` (ou `SUPABASE_PROJECT_REF`) |
| Dependências | `package-lock.json` |
| Saúde | `DEPLOYED_APP_URL` e/ou `NEXT_PUBLIC_SUPABASE_URL` |
| Força bruta | `KV_REST_API_URL` + `KV_REST_API_READ_ONLY_TOKEN` |
| Logs | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` (se for de equipe) |
| Código | `tsconfig.json` e dependências instaladas |

A auditoria NÃO usa `SUPABASE_SERVICE_ROLE_KEY`. Não peça nem adicione essa chave.

## Como ler o relatório

1. Comece pela nota e pela tabela "Scans". Scan "pulado" ou "erro" significa ponto cego, não aprovação: diga isso ao usuário.
2. Trate os achados na ordem: Crítico, Alto, Médio, Baixo. Info é só contexto.
3. Para cada achado, confirme no código ou no schema antes de concluir que é real. Achados de RLS "médio" (coluna de tenant não usada, função SECURITY DEFINER) muitas vezes são intencionais: verifique a migration que criou a policy ou a função.

## Como corrigir

- NUNCA aplique correção sem pedir. Apresente: o achado, a evidência, a correção proposta (SQL ou diff) e o risco de quebrar algo. Espere o "pode".
- Mudança de RLS ou de função vai como migration nova em `supabase/migrations/`, testada em banco local antes de produção. Nunca rode SQL direto na produção.
- Antes de remover uma policy `using (true)`, confira quem depende dela (páginas públicas sem login costumam depender).
- Dependência: com o pedido do usuário, `npx tsx lib/audit/run.ts --fix-deps` (npm audit fix sem `--force`, desfaz se os tipos piorarem, sem commit nem push); ou versão major exige ler o changelog e rodar os testes.
- Depois de corrigir, rode a auditoria de novo e mostre a diferença de nota.

## Modo offline e relatório HTML

- Sem `SUPABASE_ACCESS_TOKEN`, o scan de RLS lê só `supabase/migrations` (a linha de resumo começa com MODO OFFLINE). Não vê o que foi mudado direto no painel: avise o usuário.
- O relatório sai também em `audit-report.html`, para abrir no navegador.

## Limites

Não é pentest e não prova ausência de falhas. O scan de RLS confere a estrutura (policies, RLS ligado, funções), não testa acessos de verdade com usuários. Testes de isolamento com dois usuários de tenants diferentes continuam necessários.
