import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./http";

/** Lê `audit.config.json` (gerado pelo setup) na raiz do projeto. Campo
 * ausente ou inválido cai no padrão, com aviso; a auditoria nunca para por
 * causa da configuração. */

export type ScanId = "rls" | "deps" | "saude" | "forcaBruta" | "logs" | "codigo";

export type AuditConfig = {
  projectName: string;
  tenantColumn: string;
  notifyEmail: string;
  scans: Record<ScanId, boolean>;
  failOnCritical: boolean;
  /** Repositório público: o resumo das Actions e os artefatos ficam visíveis
   * para qualquer pessoa. Com true, o resumo leva só nota e contagens. */
  publicRepo: boolean;
  bruteForce: { keyPatterns: string[]; threshold: number; maxKeys: number };
  codigo: { eslint: boolean; build: boolean };
};

export const DEFAULT_CONFIG: AuditConfig = {
  projectName: "meu-projeto",
  tenantColumn: "organization_id",
  notifyEmail: "",
  scans: { rls: true, deps: true, saude: true, forcaBruta: false, logs: false, codigo: true },
  failOnCritical: true,
  publicRepo: false,
  bruteForce: { keyPatterns: ["ratelimit:*"], threshold: 10, maxKeys: 500 },
  codigo: { eslint: false, build: false },
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_PATTERN = /^[A-Za-z0-9:_*.@-]{1,100}$/;

export type LoadedConfig = { config: AuditConfig; warnings: string[]; source: string };

export function parseConfig(raw: unknown): { config: AuditConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: AuditConfig = structuredClone(DEFAULT_CONFIG);
  if (!isRecord(raw)) {
    warnings.push("audit.config.json não é um objeto JSON; usando o padrão.");
    return { config, warnings };
  }
  if (typeof raw.projectName === "string" && raw.projectName.trim()) {
    config.projectName = raw.projectName.trim().slice(0, 80);
  }
  if (typeof raw.tenantColumn === "string") {
    if (IDENTIFIER.test(raw.tenantColumn)) config.tenantColumn = raw.tenantColumn;
    else warnings.push(`tenantColumn "${raw.tenantColumn.slice(0, 40)}" inválida; usando "${config.tenantColumn}".`);
  }
  if (typeof raw.notifyEmail === "string" && raw.notifyEmail.trim()) {
    if (EMAIL.test(raw.notifyEmail.trim())) config.notifyEmail = raw.notifyEmail.trim();
    else warnings.push("notifyEmail inválido; ignorado.");
  }
  if (isRecord(raw.scans)) {
    for (const id of Object.keys(config.scans) as ScanId[]) {
      const value = raw.scans[id];
      if (typeof value === "boolean") config.scans[id] = value;
    }
  }
  if (typeof raw.failOnCritical === "boolean") config.failOnCritical = raw.failOnCritical;
  if (typeof raw.publicRepo === "boolean") config.publicRepo = raw.publicRepo;
  if (isRecord(raw.bruteForce)) {
    const bf = raw.bruteForce;
    if (Array.isArray(bf.keyPatterns)) {
      const patterns = bf.keyPatterns.filter((p): p is string => typeof p === "string" && KEY_PATTERN.test(p));
      if (patterns.length > 0) config.bruteForce.keyPatterns = patterns.slice(0, 10);
      else warnings.push("bruteForce.keyPatterns inválido; usando o padrão.");
    }
    if (typeof bf.threshold === "number" && bf.threshold > 0) config.bruteForce.threshold = bf.threshold;
    if (typeof bf.maxKeys === "number" && bf.maxKeys > 0) config.bruteForce.maxKeys = Math.min(bf.maxKeys, 5000);
  }
  if (isRecord(raw.codigo)) {
    if (typeof raw.codigo.eslint === "boolean") config.codigo.eslint = raw.codigo.eslint;
    if (typeof raw.codigo.build === "boolean") config.codigo.build = raw.codigo.build;
  }
  return { config, warnings };
}

export function loadConfig(cwd = process.cwd()): LoadedConfig {
  const file = path.join(cwd, "audit.config.json");
  if (!existsSync(file)) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warnings: ["audit.config.json não encontrado; usando a configuração padrão."],
      source: "padrão",
    };
  }
  try {
    const parsed = parseConfig(JSON.parse(readFileSync(file, "utf-8")) as unknown);
    return { ...parsed, source: "audit.config.json" };
  } catch {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warnings: ["audit.config.json com JSON inválido; usando a configuração padrão."],
      source: "padrão",
    };
  }
}
