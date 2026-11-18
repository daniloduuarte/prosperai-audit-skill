import { existsSync } from "node:fs";
import path from "node:path";
import { runFixedCommand } from "./exec";

/** Correção SEGURA de dependência, só quando você pede:
 *   npx tsx lib/audit/run.ts --fix-deps
 * Roda `npm audit fix` (nunca --force, então nunca sobe versão major), confere
 * os tipos (tsc) depois e, se piorou, desfaz package.json e package-lock.json.
 * Nunca faz commit nem push: você revisa o diff e decide. Se package.json ou
 * package-lock.json já têm mudança não salva no git, não faz nada. */

const FILES = ["package.json", "package-lock.json"] as const;
const TEN_MIN = 10 * 60_000;

export type FixResult = { status: "feito" | "nada" | "revertido" | "recusado"; detail: string };

function tscErrors(cwd: string): number | null {
  if (!existsSync(path.join(cwd, "tsconfig.json"))) return null;
  const r = runFixedCommand("npx", ["--no-install", "tsc", "--noEmit", "--incremental", "false", "--pretty", "false"], TEN_MIN);
  if (r.missing) return null;
  return `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).length;
}

function changed(): string {
  return runFixedCommand("git", ["status", "--porcelain", "--", ...FILES], 30_000).stdout.trim();
}

export function fixDeps(cwd = process.cwd()): FixResult {
  if (!existsSync(path.join(cwd, "package-lock.json"))) return { status: "recusado", detail: "Sem package-lock.json (só npm é suportado)." };
  const inside = runFixedCommand("git", ["rev-parse", "--is-inside-work-tree"], 30_000);
  if (inside.code !== 0) return { status: "recusado", detail: "A pasta não é um repositório git: sem git não dá para desfazer com segurança." };
  if (changed()) return { status: "recusado", detail: "package.json ou package-lock.json têm mudança não salva. Faça commit ou guarde antes." };

  const before = tscErrors(cwd);
  runFixedCommand("npm", ["audit", "fix"], TEN_MIN); // sai com código != 0 mesmo corrigindo em parte: o que vale é o diff
  if (!changed()) return { status: "nada", detail: "Nada a corrigir sem subir versão major (isso fica para decisão manual)." };

  const after = tscErrors(cwd);
  if (before !== null && after !== null && after > before) {
    runFixedCommand("git", ["checkout", "--", ...FILES], 30_000);
    runFixedCommand("npm", ["ci"], TEN_MIN);
    return { status: "revertido", detail: `Os tipos pioraram (${before} para ${after} erros): voltei package.json e package-lock.json e reinstalei.` };
  }
  return { status: "feito", detail: "Dependências atualizadas sem versão major. Revise com `git diff package.json package-lock.json`, rode seus testes e faça o commit. Nada foi enviado ao GitHub." };
}
