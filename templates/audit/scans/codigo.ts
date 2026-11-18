import { existsSync } from "node:fs";
import path from "node:path";
import type { AuditConfig } from "../config";
import { runFixedCommand } from "../exec";
import { redact } from "../redact";
import { skipped, type Finding, type ScanOutcome } from "../types";

/** Checagem de código: tsc --noEmit (padrão), eslint e build (opcionais no
 * audit.config.json). Usa --no-install: nunca baixa pacote na hora (o
 * pacote "tsc" do npm NÃO é o TypeScript). */

const TEN_MIN = 10 * 60_000;

export function countTsErrors(output: string): { count: number; sample: string[] } {
  const lines = output.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  return { count: lines.length, sample: lines.slice(0, 8).map((l) => redact(l.trim()).slice(0, 200)) };
}

function notInstalled(out: string): boolean {
  return /could not determine executable|not found|npm error canceled|ENOENT/i.test(out);
}

export function scanCodigo(config: AuditConfig, cwd = process.cwd()): ScanOutcome {
  if (!existsSync(path.join(cwd, "package.json"))) return skipped("Sem package.json na raiz.");
  const summary: string[] = [];
  const findings: Finding[] = [];
  let ran = 0;

  if (existsSync(path.join(cwd, "tsconfig.json"))) {
    const r = runFixedCommand("npx", ["--no-install", "tsc", "--noEmit", "--incremental", "false", "--pretty", "false"], TEN_MIN);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.missing || (r.code !== 0 && notInstalled(out) && !/error TS/.test(out))) {
      summary.push("tsc: pulado (typescript não instalado; rode npm ci antes)");
    } else {
      ran += 1;
      const { count, sample } = countTsErrors(out);
      summary.push(count === 0 && r.code === 0 ? "tsc: sem erros" : `tsc: ${count} erro(s)`);
      if (r.code !== 0) {
        findings.push({
          severity: "medio",
          title: `TypeScript com ${count || "algum"} erro(s) de tipo`,
          where: sample.join(" | ") || "saída do tsc",
          why: "Erro de tipo costuma ser bug real esperando acontecer, e trava o build em projetos com checagem estrita.",
          fix: "Rode npx tsc --noEmit localmente e corrija na ordem em que aparecem.",
        });
      }
    }
  } else {
    summary.push("tsc: pulado (sem tsconfig.json)");
  }

  if (config.codigo.eslint) {
    const r = runFixedCommand("npx", ["--no-install", "eslint", ".", "--max-warnings=-1"], TEN_MIN);
    if (r.missing || (r.code !== 0 && notInstalled(`${r.stdout}${r.stderr}`))) summary.push("eslint: pulado (não instalado)");
    else {
      ran += 1;
      summary.push(r.code === 0 ? "eslint: sem erros" : "eslint: com erros");
      if (r.code !== 0) {
        findings.push({ severity: "baixo", title: "ESLint encontrou erros", where: "npx eslint .", why: "Regras de lint pegam bugs comuns e padrões perigosos.", fix: "Rode npx eslint . e corrija os erros." });
      }
    }
  }

  if (config.codigo.build) {
    const r = runFixedCommand("npm", ["run", "build", "--if-present"], TEN_MIN);
    ran += 1;
    summary.push(r.code === 0 ? "build: ok" : "build: falhou");
    if (r.code !== 0) {
      findings.push({ severity: "alto", title: "Build falhou", where: "npm run build", why: "Se o build quebra, o próximo deploy não sobe.", fix: "Rode npm run build localmente e corrija o primeiro erro." });
    }
  }

  if (ran === 0) return { ...skipped("Nenhuma checagem de código pôde rodar (sem tsconfig.json ou TypeScript não instalado)."), summary };
  return { status: "ok", summary, findings };
}
