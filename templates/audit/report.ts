import { redact } from "./redact";
import { SEVERITY_LABEL, SEVERITY_ORDER, type Finding, type ScanResult, type Severity } from "./types";

/** Nota 0-100: começa em 100 e desconta por achado.
 * Crítico -25, alto -10, médio -4, baixo -1, info 0. Mínimo 0.
 * Scan pulado ou com erro não desconta (aparece na cobertura). */
export const SCORE_WEIGHTS: Record<Severity, number> = { critico: 25, alto: 10, medio: 4, baixo: 1, info: 0 };

export function countBySeverity(results: ScanResult[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critico: 0, alto: 0, medio: 0, baixo: 0, info: 0 };
  for (const r of results) for (const f of r.findings) counts[f.severity] += 1;
  return counts;
}

export function computeScore(results: ScanResult[]): number {
  const counts = countBySeverity(results);
  const penalty = SEVERITY_ORDER.reduce((sum, s) => sum + counts[s] * SCORE_WEIGHTS[s], 0);
  return Math.max(0, 100 - penalty);
}

const STATUS_LABEL = { ok: "rodou", pulado: "pulado", erro: "erro" } as const;

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function findingBlock(f: Finding, scan: string): string {
  return [
    `#### [${SEVERITY_LABEL[f.severity]}] ${f.title}`,
    `- **Onde:** ${f.where}`,
    `- **Por que importa:** ${f.why}`,
    `- **Como corrigir:** ${f.fix}`,
    `- **Scan:** ${scan}`,
    "",
  ].join("\n");
}

export type ReportMeta = { projectName: string; date: Date; warnings: string[]; runUrl?: string };

export function buildMarkdown(results: ScanResult[], meta: ReportMeta): string {
  const score = computeScore(results);
  const counts = countBySeverity(results);
  const ran = results.filter((r) => r.status === "ok").length;
  const lines: string[] = [
    `# Auditoria de ${meta.projectName}`,
    "",
    `Data: ${meta.date.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**Nota: ${score}/100** (cobertura: ${ran} de ${results.length} scans rodaram)`,
    "",
    `Crítico: ${counts.critico} · Alto: ${counts.alto} · Médio: ${counts.medio} · Baixo: ${counts.baixo} · Info: ${counts.info}`,
    "",
  ];
  if (meta.runUrl) lines.push(`Execução: ${meta.runUrl}`, "");
  lines.push("## Scans", "", "| Scan | Situação | Achados | Detalhe |", "|---|---|---|---|");
  for (const r of results) {
    const detail = r.status === "ok" ? r.summary.join("; ") : `${r.reason ?? ""}${r.summary.length ? ` (${r.summary.join("; ")})` : ""}`;
    lines.push(`| ${r.name} | ${STATUS_LABEL[r.status]} | ${r.findings.length} | ${cell(detail)} |`);
  }
  lines.push("");
  const all = results.flatMap((r) => r.findings.map((f) => ({ f, scan: r.name })));
  if (all.length === 0) {
    lines.push("## Achados", "", "Nenhum achado nos scans que rodaram.", "");
  } else {
    lines.push("## Achados", "");
    for (const s of SEVERITY_ORDER) {
      for (const { f, scan } of all.filter((x) => x.f.severity === s)) lines.push(findingBlock(f, scan));
    }
  }
  const notRun = results.filter((r) => r.status !== "ok");
  if (notRun.length > 0) {
    lines.push("## O que não rodou e por quê", "");
    for (const r of notRun) lines.push(`- **${r.name}** (${STATUS_LABEL[r.status]}): ${r.reason ?? "sem detalhe"}`);
    lines.push("");
  }
  if (meta.warnings.length > 0) {
    lines.push("## Avisos de configuração", "", ...meta.warnings.map((w) => `- ${w}`), "");
  }
  lines.push(
    "---",
    "Nota = 100 menos 25 por crítico, 10 por alto, 4 por médio, 1 por baixo (mínimo 0). Esta auditoria não é um pentest e não prova ausência de falhas.",
    "",
  );
  return redact(lines.join("\n"));
}

const esc = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COLOR: Record<Severity, string> = { critico: "#b42318", alto: "#c4320a", medio: "#b54708", baixo: "#475467", info: "#175cd3" };

/** Versão HTML do relatório (um arquivo só, sem script e sem recurso externo),
 * para abrir no navegador ou mandar por e-mail. Todo texto é escapado. */
export function buildHtml(results: ScanResult[], meta: ReportMeta): string {
  const score = computeScore(results);
  const counts = countBySeverity(results);
  const ran = results.filter((r) => r.status === "ok").length;
  const rows = results
    .map((r) => {
      const detail = r.status === "ok" ? r.summary.join("; ") : (r.reason ?? "");
      return `<tr><td>${esc(r.name)}</td><td>${STATUS_LABEL[r.status]}</td><td>${r.findings.length}</td><td>${esc(detail)}</td></tr>`;
    })
    .join("\n");
  const blocks = SEVERITY_ORDER.flatMap((sev) =>
    results.flatMap((r) =>
      r.findings
        .filter((f) => f.severity === sev)
        .map(
          (f) =>
            `<section style="border-left:4px solid ${COLOR[sev]};padding:4px 12px;margin:12px 0"><h3 style="margin:4px 0">[${SEVERITY_LABEL[sev]}] ${esc(f.title)}</h3><p><b>Onde:</b> ${esc(f.where)}</p><p><b>Por que importa:</b> ${esc(f.why)}</p><p><b>Como corrigir:</b> ${esc(f.fix)}</p><p><small>Scan: ${esc(r.name)}</small></p></section>`,
        ),
    ),
  );
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auditoria de ${esc(meta.projectName)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#101828}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d5dd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f4f7}</style></head><body>
<h1>Auditoria de ${esc(meta.projectName)}</h1>
<p>Data: ${esc(meta.date.toISOString().slice(0, 16).replace("T", " "))} UTC</p>
<p><b>Nota: ${score}/100</b> (cobertura: ${ran} de ${results.length} scans rodaram)</p>
<p>Crítico: ${counts.critico} · Alto: ${counts.alto} · Médio: ${counts.medio} · Baixo: ${counts.baixo} · Info: ${counts.info}</p>
<h2>Scans</h2><table><tr><th>Scan</th><th>Situação</th><th>Achados</th><th>Detalhe</th></tr>
${rows}
</table>
<h2>Achados</h2>
${blocks.length > 0 ? blocks.join("\n") : "<p>Nenhum achado nos scans que rodaram.</p>"}
<hr><p><small>Nota = 100 menos 25 por crítico, 10 por alto, 4 por médio, 1 por baixo (mínimo 0). Esta auditoria não é um pentest e não prova ausência de falhas.</small></p>
</body></html>
`;
  return redact(html);
}
