import { existsSync } from "node:fs";
import path from "node:path";
import { runFixedCommand } from "../exec";
import { isRecord } from "../http";
import { safeError } from "../redact";
import { SEVERITY_ORDER, skipped, type Finding, type ScanOutcome, type Severity } from "../types";

/** npm audit + npm outdated. Os dois saem com código 1 quando ACHAM algo
 * (comportamento normal do npm): o JSON do stdout é lido mesmo assim. */

const FROM_NPM: Record<string, Severity> = { critical: "critico", high: "alto", moderate: "medio", low: "baixo", info: "info" };
const MAX_FINDINGS = 40;

export type AuditPackage = { name: string; severity: Severity; title: string; fix: string; production: boolean };
export type OutdatedPackage = { name: string; current: string; latest: string; major: boolean };

export function parseNpmAudit(json: unknown, productionNames: Set<string> | null): AuditPackage[] {
  if (!isRecord(json)) throw new Error("Saída do npm audit não é JSON.");
  if (isRecord(json.error)) throw new Error(`npm audit falhou: ${String(json.error.summary ?? json.error.code ?? "erro")}`);
  const vulns = isRecord(json.vulnerabilities) ? json.vulnerabilities : {};
  const out: AuditPackage[] = [];
  for (const [name, raw] of Object.entries(vulns)) {
    if (!isRecord(raw)) continue;
    const severity = FROM_NPM[String(raw.severity)];
    if (!severity) continue;
    const via = Array.isArray(raw.via) ? raw.via : [];
    const advisory = via.find((v): v is Record<string, unknown> => isRecord(v) && typeof v.title === "string");
    const title = advisory ? String(advisory.title) : `Depende de pacote vulnerável (${via.filter((v) => typeof v === "string").join(", ") || "transitivo"})`;
    const fixAvailable = raw.fixAvailable;
    const fix =
      fixAvailable === true
        ? "npm audit fix resolve sem versão major."
        : isRecord(fixAvailable)
          ? `Atualize ${String(fixAvailable.name)} para ${String(fixAvailable.version)}${fixAvailable.isSemVerMajor === true ? " (versão major: leia o changelog)" : ""} e rode os testes.`
          : "Sem correção publicada ainda. Avalie trocar o pacote ou mitigar o uso.";
    out.push({ name, severity, title, fix, production: productionNames === null || productionNames.has(name) });
  }
  return out;
}

export function parseNpmOutdated(json: unknown): OutdatedPackage[] {
  if (!isRecord(json)) return [];
  const out: OutdatedPackage[] = [];
  for (const [name, raw] of Object.entries(json)) {
    const info = Array.isArray(raw) ? raw[0] : raw; // workspaces devolvem lista
    if (!isRecord(info) || typeof info.latest !== "string") continue;
    const current = typeof info.current === "string" ? info.current : "não instalado";
    const major = typeof info.current === "string" && current.split(".")[0] !== info.latest.split(".")[0];
    out.push({ name, current, latest: info.latest, major });
  }
  return out;
}

function devSeverity(s: Severity): Severity {
  return s === "critico" || s === "alto" ? "baixo" : "info";
}

export function auditFindings(packages: AuditPackage[]): Finding[] {
  return packages.map((p) => ({
    severity: p.production ? p.severity : devSeverity(p.severity),
    title: p.production ? p.title : `${p.title} (só em devDependencies)`,
    where: `pacote ${p.name}`,
    why: p.production
      ? "Dependência que vai para produção com vulnerabilidade conhecida (CVE/GHSA)."
      : "Só ferramenta de desenvolvimento/build; não roda no app no ar, mas roda no CI.",
    fix: p.fix,
  }));
}

function parseStdout(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as unknown;
  } catch {
    return null;
  }
}

export function scanDeps(cwd = process.cwd()): ScanOutcome {
  if (!existsSync(path.join(cwd, "package.json"))) return skipped("Sem package.json na raiz.");
  if (!existsSync(path.join(cwd, "package-lock.json"))) {
    return skipped("Sem package-lock.json: npm audit precisa do lockfile do npm (pnpm/yarn não são suportados ainda).");
  }
  try {
    const full = runFixedCommand("npm", ["audit", "--json"], 180_000);
    if (full.missing) return skipped("npm não encontrado no PATH.");
    const fullJson = parseStdout(full.stdout);
    if (fullJson === null) throw new Error(`npm audit não devolveu JSON (código ${String(full.code)}).`);
    const prod = parseStdout(runFixedCommand("npm", ["audit", "--json", "--omit=dev"], 180_000).stdout);
    const prodNames = isRecord(prod) && isRecord(prod.vulnerabilities) ? new Set(Object.keys(prod.vulnerabilities)) : null;
    const packages = parseNpmAudit(fullJson, prodNames);
    const findings = auditFindings(packages)
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
      .slice(0, MAX_FINDINGS);
    const outdated = parseNpmOutdated(parseStdout(runFixedCommand("npm", ["outdated", "--json"], 180_000).stdout));
    const majors = outdated.filter((o) => o.major);
    if (majors.length > 0) {
      findings.push({
        severity: "info",
        title: `${majors.length} pacote(s) com versão major nova`,
        where: majors.slice(0, 15).map((o) => `${o.name} ${o.current} -> ${o.latest}`).join("; "),
        why: "Ficar muitas versões atrás dificulta receber correções de segurança depois.",
        fix: "Planeje a atualização lendo o changelog de cada um; não precisa ser urgente.",
      });
    }
    const prodCount = packages.filter((p) => p.production).length;
    return {
      status: "ok",
      summary: [
        `${packages.length} pacote(s) vulnerável(is): ${prodCount} em produção, ${packages.length - prodCount} só em dev`,
        `${outdated.length} desatualizado(s), ${majors.length} com major nova`,
        ...(packages.length > MAX_FINDINGS ? [`Mostrando ${MAX_FINDINGS} de ${packages.length}; rode npm audit para a lista completa`] : []),
      ],
      findings,
    };
  } catch (error) {
    return { status: "erro", reason: safeError(error), summary: [], findings: [] };
  }
}
