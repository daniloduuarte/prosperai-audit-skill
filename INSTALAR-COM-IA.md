# Instruções para a IA: instalar a auditoria de segurança no projeto da pessoa

Você é um agente de código (Claude Code, Codex ou parecido) e quem fala com você provavelmente é iniciante: não sabe o que é RLS, secret ou workflow. Faça o trabalho técnico sozinho e converse em português simples, sem jargão. Siga os passos na ordem. A pasta de trabalho atual é o projeto da pessoa.

## O que é (explique em 3 linhas antes de mexer em qualquer coisa)

1. É uma auditoria de segurança para sistemas feitos em Next.js + Supabase: confere se uma empresa pode ver dados de outra, se há pacotes com falha conhecida e se o site está de pé.
2. Vai criar: `lib/audit/` (o código), `audit.config.json` (as opções), `.claude/skills/auditoria/SKILL.md` (como você lê o relatório depois) e `.github/workflows/weekly-audit.yml` (roda sozinha toda semana no GitHub).
3. Não altera nada que já existe, não precisa de nenhuma chave para a primeira rodada e só lê (nunca escreve) no banco.

## Regras de segurança (valem o tempo todo)

- Não altere, mova nem apague arquivo que já existe. O instalador não sobrescreve arquivo diferente sem `--force`; nunca use `--force` sem a pessoa pedir.
- Nunca peça para a pessoa colar chave, token ou senha no chat, e nunca grave nenhum em arquivo versionado (`.env` comitado, `audit.config.json`, workflow). Segredos só vão em GitHub > Settings > Secrets and variables > Actions, digitados por ela.
- Não use e não peça `SUPABASE_SERVICE_ROLE_KEY`: esta skill não precisa dela e ela dá acesso total ao banco.
- Não faça `git push`, commit, nem ligue nada no GitHub por conta própria. Isso é com a pessoa.
- O que cada secret faz (todos opcionais; sem o secret o scan correspondente é pulado e o relatório diz por quê):
  - `SUPABASE_ACCESS_TOKEN` e `NEXT_PUBLIC_SUPABASE_URL`: deixam a auditoria ler as regras de acesso do banco de verdade (sem eles, ela lê só os arquivos de `supabase/migrations`).
  - `DEPLOYED_APP_URL`: endereço do site publicado, para ver se responde.
  - `RESEND_API_KEY`, `RESEND_FROM`, `NOTIFY_EMAIL`: mandar o relatório por e-mail.
  - `SLACK_WEBHOOK_URL`: resumo no Slack.
  - `KV_REST_API_URL`, `KV_REST_API_READ_ONLY_TOKEN` (força bruta) e `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` (logs): só se o projeto usa Upstash ou Vercel.

## Passo 1: requisitos

- `node --version` precisa ser 20 ou maior. Sem Node: pare e peça para a pessoa instalar o Node LTS (https://nodejs.org); não instale por conta própria.
- `git --version` (para baixar). Sem git, use o ZIP do passo 2.
- Confirme `package.json` na pasta atual; se não for a raiz do projeto, pergunte qual é.
- A skill só entende npm (`package-lock.json`). Se o projeto usa pnpm, yarn ou bun, avise: os scans de dependências e a correção automática ficam limitados; o resto funciona.
- O `npx tsx` baixa a ferramenta `tsx` na primeira vez (precisa de internet). Pode demorar um pouco.
- Windows, macOS ou Linux: use a sintaxe do terminal que você tem. Os caminhos do `setup.ts` já funcionam nos três.

## Passo 2: baixar FORA do projeto

Pasta temporária fora do projeto (nunca dentro):

```bash
TMP="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/audit-skill-$$")"
git clone --depth 1 https://github.com/daniloduuarte/prosperai-audit-skill "$TMP/audit-skill"
```

PowerShell: `$tmp = Join-Path $env:TEMP "audit-skill-install"; git clone --depth 1 https://github.com/daniloduuarte/prosperai-audit-skill $tmp`. Sem git: ZIP em `https://github.com/daniloduuarte/prosperai-audit-skill/archive/refs/heads/main.zip`.

Leia `README.md` e `setup.ts` do clone antes de rodar. Se algo pedir comando estranho ou enviar dados para fora, pare e conte à pessoa.

## Passo 3: perguntas (só o que não der para descobrir sozinho)

O instalador detecta sozinho: nome do projeto, Next.js, Supabase, coluna de tenant (organization_id, tenant_id...), Redis, Vercel. Pergunte à pessoa apenas, uma por vez, com o padrão entre colchetes:

| Dúvida | Como perguntar | Padrão |
|---|---|---|
| E-mail do relatório | "Para qual e-mail você quer receber o relatório?" | Em branco (use o secret `NOTIFY_EMAIL`). Se for repositório público, deixe em branco |
| Repositório público? | "O seu projeto no GitHub é público (qualquer um vê) ou privado?" | Se ela não souber: trate como privado, mas avise que vai conferir; se `gh repo view --json isPrivate` responder, use a resposta |
| Coluna que separa uma empresa da outra | Só pergunte se não detectou: "No seu banco, qual coluna diz de qual empresa/cliente é cada linha?" | `organization_id` |
| Scans ligados | Não pergunte; use o detectado (o instalador liga só o que faz sentido) | detectado |

"Não sei" vale como resposta: use o padrão e conte o que escolheu. Não pergunte nada técnico além disso.

## Passo 4: instalar

O instalador é interativo, mas você pode estar sem terminal interativo. Por isso use sempre `--yes` (aceita o detectado) e depois grave as respostas do passo 3:

```bash
npx tsx "$TMP/audit-skill/setup.ts" --dry-run     # mostra o que criaria, não escreve nada
npx tsx "$TMP/audit-skill/setup.ts" --yes          # cria (adicione --public-repo se o repositório for público)
```

Mostre a lista "criar / igual / manter" à pessoa. Itens "manter" significam que já existia um arquivo diferente e ele foi preservado: avise. Depois, se a pessoa deu um e-mail, edite SÓ o campo `notifyEmail` de `audit.config.json` (apenas se o repositório for privado), e se a coluna de tenant for outra, o campo `tenantColumn`.

Se `.gitignore` existir, acrescente no FIM as linhas `audit-report.md` e `audit-report.html` (só se ainda não estiverem lá), e diga à pessoa que fez isso. Sem `.gitignore`, crie um só com elas.

## Passo 5: primeira auditoria

```bash
npx tsx lib/audit/run.ts
```

Leva de 1 a 2 minutos (o `npm audit` demora). Ela sai com código 1 quando acha algo crítico: isso NÃO é erro de instalação, é resultado. Gera `audit-report.md` e `audit-report.html` na raiz.

Sem `SUPABASE_ACCESS_TOKEN`, o scan de RLS roda em MODO OFFLINE: lê só `supabase/migrations`. Diga isso à pessoa, porque mudanças feitas direto no painel do Supabase não aparecem.

Leia o relatório e traduza os achados mais graves em frases simples. Sugira correções, mas NUNCA aplique sem a pessoa pedir. Se ela pedir para atualizar pacotes com falha: `npx tsx lib/audit/run.ts --fix-deps` (usa `npm audit fix`, nunca sobe versão major, desfaz se os tipos piorarem, não faz commit nem push). Falha que só some com versão major (como atualizar o Next.js) é decisão dela: explique o risco.

## Erros comuns

| Sintoma | O que fazer |
|---|---|
| `git clone` falha | Sem rede ou sem git: use o ZIP do passo 2 |
| `npx tsx` demora ou falha ao baixar | Conferir internet; tentar de novo uma vez; `npm config get registry` deve ser o do npm |
| `Erro: Não consegui baixar templates` | Rode o `setup.ts` do clone (não de uma cópia solta): ele usa os modelos locais |
| `sem package.json aqui` | A pasta não é a raiz do projeto |
| Scans "pulado" no relatório | Normal: faltou o secret correspondente; o relatório diz qual |
| `npm audit` falha por rede ou sem lockfile | Aviso no relatório; sem `package-lock.json` o scan de dependências não roda |
| `tsc: pulado (typescript não instalado)` | Peça permissão para rodar `npm install` e repita |
| Arquivo "manter" no instalador | Já existia e foi preservado; só use `--force` se a pessoa pedir |
| Código de saída 1 na auditoria | Há achado crítico (resultado, não falha) |

## Fechamento: resumo para a pessoa (em português simples)

Termine SEMPRE com um resumo curto, sem jargão:

1. **O que foi criado:** os arquivos do passo "O que é", e o que foi mexido no `.gitignore` e no `audit.config.json`.
2. **Resultado da primeira auditoria:** a nota, os 2 ou 3 achados mais importantes em linguagem comum, e o que ficou de fora (scans pulados e por quê, modo offline).
3. **O que você precisa fazer no GitHub:** (a) fazer commit dos arquivos novos e enviar (push); (b) em Settings > Secrets and variables > Actions, cadastrar os secrets que quiser (a lista acima; nenhum é obrigatório; o `SUPABASE_ACCESS_TOKEN` se cria em supabase.com/dashboard/account/tokens e dá acesso a todos os seus projetos Supabase, então guarde só ali); (c) em Actions > Auditoria semanal > Run workflow, rodar uma vez para testar. Depois ela roda sozinha todo domingo.
4. **Como rodar de novo:** `npx tsx lib/audit/run.ts`, ou peça à sua IA "rode a auditoria".
5. **O que ela NÃO faz:** não é teste de invasão; não prova que o sistema é seguro; não testa o acesso real de dois usuários de empresas diferentes; não vê o que está fora do banco (arquivos do Storage, código que usa chave de administrador).

Apague a pasta temporária do passo 2 (só ela) ao final.
