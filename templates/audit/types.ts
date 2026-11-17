/** Tipos compartilhados da auditoria. */

export type Severity = "critico" | "alto" | "medio" | "baixo" | "info";

export const SEVERITY_ORDER: Severity[] = ["critico", "alto", "medio", "baixo", "info"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo",
  info: "Info",
};

export type Finding = {
  severity: Severity;
  /** O que foi encontrado, em uma frase. */
  title: string;
  /** Onde: tabela, pacote, URL, arquivo. */
  where: string;
  /** Por que importa. */
  why: string;
  /** Como corrigir. */
  fix: string;
};

export type ScanStatus = "ok" | "pulado" | "erro";

export type ScanResult = {
  id: string;
  name: string;
  status: ScanStatus;
  /** Motivo do pulo ou do erro, sempre explicado em texto simples. */
  reason?: string;
  /** Linhas de resumo (ex.: "42 tabelas lidas"). */
  summary: string[];
  findings: Finding[];
  durationMs: number;
};

export type ScanOutcome = Omit<ScanResult, "id" | "name" | "durationMs">;

export function skipped(reason: string): ScanOutcome {
  return { status: "pulado", reason, summary: [], findings: [] };
}

/** Lê uma variável de ambiente; string vazia conta como ausente (secret não
 * configurado no GitHub Actions chega como ""). */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}
