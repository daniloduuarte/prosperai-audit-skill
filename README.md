# Audit Skill para Next.js + Supabase

Auditoria semanal de segurança para SaaS multi-tenant em Next.js + Supabase, pensada para o Claude Code. O setup copia para o seu projeto o código da auditoria (`lib/audit/`), uma skill que ensina o Claude Code a rodar e ler o relatório, e um workflow do GitHub Actions que roda tudo toda semana.

Nasceu no [Prosperaí](https://prosperai.online), um sistema de agenda para negócios de atendimento, onde um vazamento de dados entre empresas seria o pior erro possível. O código deste repositório é genérico: não tem nada específico daquele produto.

## Instalação em 3 passos

Requisitos: Node 20 ou mais novo, projeto com `package.json` (npm), repositório no GitHub.

**1. Rode o setup na raiz do seu projeto**

```bash
git clone --depth 1 https://github.com/daniloduuarte/prosperai-audit-skill /tmp/audit-skill
npx tsx /tmp/audit-skill/setup.ts
```

Leia o `setup.ts` antes de rodar. Opções: `--yes` (aceita o que foi detectado, sem perguntas), `--dry-run` (mostra o que faria e não escreve nada), `--public-repo` (veja "Repositório público" abaixo), `--force` (sobrescreve arquivos existentes). Sem `--force`, arquivo existente e diferente nunca é sobrescrito sem perguntar.

O setup escreve:

| Arquivo | O que é |
|---|---|
| `lib/audit/` | Código da auditoria (TypeScript, sem dependências novas no seu projeto). |
| `audit.config.json` | Nome do projeto, coluna de tenant, scans ligados, limites. |
| `.claude/skills/auditoria/SKILL.md` | Instruções para o Claude Code rodar, ler o relatório e propor correções (nunca aplica sem pedir). |
| `.github/workflows/weekly-audit.yml` | Agenda semanal (domingo 23h UTC) e disparo manual. |

**2. Cadastre os secrets no GitHub** (Settings > Secrets and variables > Actions). Todos são opcionais: o scan sem o seu segredo é pulado e o relatório diz por quê.

**3. Teste local e suba**

```bash
npx tsx lib/audit/run.ts
```

Depois faça commit (coloque `audit-report.md` no `.gitignore`), push, e dispare em Actions > Auditoria semanal > Run workflow.

## Scans e o que cada um precisa

| Scan | O que confere | Precisa de |
|---|---|---|
| RLS e isolamento | Tabelas do schema `public` sem RLS (crítico); policy `using (true)` para anon/public em tabela com coluna sensível como email, cpf, cnpj, token, senha, phone, secret, key (alto); tabela com a coluna de tenant em que nenhuma policy usa essa coluna (médio); função `SECURITY DEFINER` executável por anon (médio) | `SUPABASE_ACCESS_TOKEN` e `NEXT_PUBLIC_SUPABASE_URL` (ou `SUPABASE_PROJECT_REF`) |
| Dependências | `npm audit` separando produção de dev, e `npm outdated` | `package-lock.json` |
| Saúde | GET no app (status, tempo, cabeçalhos de segurança) e HEAD na API REST do Supabase | `DEPLOYED_APP_URL` e/ou `NEXT_PUBLIC_SUPABASE_URL` |
| Força bruta (opcional) | Chaves de rate limit no Upstash Redis acima do limite configurado | `KV_REST_API_URL` e `KV_REST_API_READ_ONLY_TOKEN` |
| Logs (opcional) | Erros 5xx nos logs de runtime do deploy de produção na Vercel | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` se o projeto for de equipe |
| Código | `tsc --noEmit`; eslint e build se ligados no config | `tsconfig.json` e dependências instaladas |

Notificação (opcional): e-mail via Resend (`RESEND_API_KEY`, `NOTIFY_EMAIL`, `RESEND_FROM`) e resumo no Slack (`SLACK_WEBHOOK_URL`).

## Relatório

Sai em `audit-report.md`, no resumo da execução do GitHub Actions e no artefato `audit-report`. Cada achado traz o quê, onde, por que importa e como corrigir. Exemplo com dados fictícios:

```markdown
# Auditoria de loja-exemplo

**Nota: 76/100** (cobertura: 4 de 6 scans rodaram)

Crítico: 0 · Alto: 2 · Médio: 1 · Baixo: 0 · Info: 1

| Scan | Situação | Achados | Detalhe |
|---|---|---|---|
| Isolamento e RLS | rodou | 2 | 38 tabelas e 71 policies lidas no schema public |
| Dependências | rodou | 2 | 1 pacote vulnerável: 1 em produção, 0 só em dev |
| Saúde | rodou | 0 | App: HTTP 200 em 412 ms |
| Força bruta | pulado | 0 | Desligado no audit.config.json |
| Logs de produção | pulado | 0 | VERCEL_TOKEN e VERCEL_PROJECT_ID não configurados |
| Código | rodou | 0 | tsc: sem erros |

#### [Alto] Leitura pública (using true) em tabela com colunas sensíveis
- **Onde:** public.clientes, policy "leitura publica" (colunas: email, phone)
- **Por que importa:** RLS filtra linhas, não colunas: a policy expõe todas as colunas para qualquer visitante.
- **Como corrigir:** mova as colunas sensíveis para outra tabela com policy restrita.
```

**Nota:** começa em 100 e desconta 25 por crítico, 10 por alto, 4 por médio e 1 por baixo (mínimo 0). Scan pulado ou com erro não desconta, mas aparece na cobertura: nota alta com cobertura baixa não quer dizer muita coisa.

**Código de saída:** 1 só quando há achado crítico (desligue com `"failOnCritical": false`). Scan pulado ou com erro nunca faz a execução falhar.

## Segurança

- **Sem service role.** A auditoria NÃO usa `SUPABASE_SERVICE_ROLE_KEY` e não precisa dela. Não cadastre essa chave para isso.
- **Só leitura.** O scan de RLS manda à Management API apenas consultas `select` fixas, escritas no código (nenhum valor da configuração entra no SQL), pedindo execução somente leitura. O Redis recebe só `SCAN`, `TYPE`, `ZCARD` e `GET`.
- **Segredos nunca aparecem.** Todo texto de log, relatório, e-mail e Slack passa por uma redação que remove o valor de toda variável com nome de segredo e formatos conhecidos de token (JWT, `sbp_`, Bearer, webhook do Slack, URL com senha). IPs e e-mails do scan de força bruta saem mascarados.
- **Sem comando vindo de fora.** Os únicos comandos executados são `npm` e `npx` com argumentos fixos no código (lista branca); nada vindo de API, banco ou configuração vira comando. Sem `eval`.
- **Dados só para quem você configurou.** As chamadas vão para: Management API do Supabase, sua URL do Supabase, sua URL do app, seu Redis, a API da Vercel, a Resend e o seu webhook do Slack. O `npm audit` envia a lista de dependências ao registro do npm (comportamento normal do npm).
- **Workflow:** actions fixadas por SHA, `permissions: contents: read`, `persist-credentials: false`, segredos só no passo da auditoria (não no `npm ci`), tempo limite de 20 minutos.

Permissão mínima de cada token:

| Secret | Recomendação |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Token pessoal do Supabase. Ele não tem escopo: dá acesso a todos os projetos da conta. Se a sua organização permitir, gere com um membro de papel Read-only e confira se as consultas funcionam. Guarde só como secret e revogue quando não usar mais. |
| `KV_REST_API_READ_ONLY_TOKEN` | Use o token somente leitura do Upstash, não o de escrita (`KV_REST_API_TOKEN` funciona, mas dá mais poder que o necessário). |
| `VERCEL_TOKEN` | A Vercel não tem token só de leitura: limite o escopo à equipe do projeto e defina expiração. |
| `RESEND_API_KEY` | Permissão "Sending access", restrita ao seu domínio. |
| `SLACK_WEBHOOK_URL` | Incoming webhook de um canal só. |

**Repositório público:** em repositório público, o resumo das execuções e os artefatos do GitHub Actions ficam visíveis para qualquer pessoa, e o relatório mostra justamente onde estão as brechas. Use repositório privado. Se precisar ser público, rode o setup com `--public-repo`: o resumo leva só a nota e as contagens, o artefato não é gerado e o relatório completo vai só por e-mail. Pelo mesmo motivo, deixe `notifyEmail` vazio no config e use o secret `NOTIFY_EMAIL`.

## Rodar local

```bash
npx tsx lib/audit/run.ts
npx tsx --env-file=.env.local lib/audit/run.ts   # carrega variáveis do .env.local (Node 20.6+)
```

## Limites honestos

- **Não é pentest** e não prova ausência de falhas. Um relatório limpo só diz que estes padrões não foram encontrados.
- O scan de RLS lê a **estrutura** (RLS ligado, texto das policies, permissão de funções). Ele não testa acesso real com dois usuários de tenants diferentes, não entende a lógica de dentro de funções e não confere views sem `security_invoker`, buckets do Storage nem o código que usa a service role. Testes de isolamento com usuários reais continuam necessários.
- "Coluna sensível" é por nome: coluna com nome neutro guardando dado pessoal passa despercebida, e o contrário gera alerta a revisar.
- Força bruta é uma foto do momento da execução, não o histórico da semana.
- Logs da Vercel: janela curta (depende do plano) e formato da API que pode mudar.
- Só npm (`package-lock.json`); pnpm e yarn ainda não.

## Desenvolvimento

```bash
npm install
npm test          # node:test + tsx, sem rede e sem credenciais
npm run typecheck
```

## Licença

MIT
