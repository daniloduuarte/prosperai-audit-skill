import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type AuditConfig, type ScanId } from "./config";
import { notify } from "./notify";
import { log, safeError } from "./redact";
import { buildMarkdown, computeScore, countBySeverity } from "./report";
import { scanCodigo } from "./scans/codigo";
import { scanDeps } from "./scans/deps";
import { scanForcaBruta } from "./scans/forca-bruta";
import { scanLogs } from "./scans/logs";
import { scanRls } from "./scans/rls";
import { scanSaude } from "./scans/saude";
import { env, type ScanOutcome, type ScanResult } from "./types";

/** Entrada: npx tsx lib/audit/run.ts (na raiz do projeto).
 * Sai com código 1 só se houver achado crítico e failOnCritical = true.
 * Scan pulado ou com erro nunca muda o código de saída. */

const SCANS: { id: ScanId; name: string; run: (c: AuditConfig) => ScanOutcome | Promise<ScanOutcome> }[] = [
  { id: "rls", name: "Isolamento e RLS", run: scanRls },
  { id: "deps", name: "Dependências", run: () => scanDeps() },
  { id: "saude", name: "Saúde", run: () => scanSaude() },
  { id: "forcaBruta", name: "Força bruta", run: scanForcaBruta },
  { id: "logs", name: "Logs de produção", run: () => scanLogs() },
  { id: "codigo", name: "Código", run: (c) => scanCodigo(c) },
];

async function runScan(scan: (typeof SCANS)[number], config: AuditConfig): Promise<ScanResult> {
  const start = Date.now();
  let outcome: ScanOutcome;
  if (!config.scans[scan.id]) {
    outcome = { status: "pulado", reason: `Desligado no audit.config.json (scans.${scan.id}: false).`, summary: [], findings: [] };
  } else {
    try {
      outcome = await scan.run(config);
    } catch (error) {
      outcome = { status: "erro", reason: safeError(error), summary: [], findings: [] };
    }
  }
  const result = { id: scan.id, name: scan.name, durationMs: Date.now() - start, ...outcome };
  const extra = result.status === "ok" ? `${result.findings.length} achado(s)` : (result.reason ?? "");
  log.info(`- ${scan.name}: ${result.status} (${result.durationMs} ms) ${extra}`);
  return result;
}

function runUrl(): string | undefined {
  const server = env("GITHUB_SERVER_URL");
  const repo = env("GITHUB_REPOSITORY");
  const id = env("GITHUB_RUN_ID");
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
}

async function main(): Promise<number> {
  const { config, warnings, source } = loadConfig();
  log.info(`Auditoria de ${config.projectName} (config: ${source})`);
  for (const w of warnings) log.warn(`Aviso: ${w}`);

  const results: ScanResult[] = [];
  for (const scan of SCANS) results.push(await runScan(scan, config));

  const markdown = buildMarkdown(results, { projectName: config.projectName, date: new Date(), warnings, runUrl: runUrl() });
  const reportPath = path.resolve(env("AUDIT_REPORT_PATH") ?? "audit-report.md");
  writeFileSync(reportPath, markdown, "utf-8");
  log.info(`Relatório salvo em ${reportPath}`);
  const counts = countBySeverity(results);
  const score = computeScore(results);
  const stepSummary = env("GITHUB_STEP_SUMMARY");
  if (stepSummary) {
    const minimal = `# Auditoria\n\nNota: ${score}/100 · Crítico: ${counts.critico} · Alto: ${counts.alto} · Médio: ${counts.medio}\n\nRepositório público: detalhes só no e-mail.\n`;
    appendFileSync(stepSummary, config.publicRepo ? minimal : `${markdown}\n`, "utf-8");
  }
  log.info(`Nota: ${score}/100 · crítico ${counts.critico} · alto ${counts.alto} · médio ${counts.medio}`);
  await notify(config, markdown, { score, critical: counts.critico, high: counts.alto, runUrl: runUrl() });

  if (counts.critico > 0 && config.failOnCritical) {
    log.warn("Saindo com código 1: há achado crítico (failOnCritical = true).");
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Erro inesperado do próprio runner (não de um scan): reporta sem segredo.
    log.warn(`Falha inesperada da auditoria: ${safeError(error)}`);
    process.exitCode = 2;
  });
