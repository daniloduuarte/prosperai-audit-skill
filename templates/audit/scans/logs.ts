import { fetchWithTimeout, isRecord, readJson } from "../http";
import { safeError } from "../redact";
import { env, skipped, type Finding, type ScanOutcome } from "../types";

/** Erros 5xx nos logs de runtime da Vercel do deploy de produção atual.
 * Guarda só contagem e caminho, nunca a mensagem do log (pode ter dado de
 * cliente). A Vercel guarda poucos logs de runtime no plano Hobby. */

const API = "https://api.vercel.com";
const READ_WINDOW_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;

export type LogSummary = { total: number; errors: number; paths: Map<string, number> };

export function summarizeLogLines(text: string): LogSummary {
  const summary: LogSummary = { total: 0, errors: 0, paths: new Map() };
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let row: unknown;
    try {
      row = JSON.parse(t) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    summary.total += 1;
    const status = Number(row.responseStatusCode ?? row.statusCode ?? row.status ?? 0);
    const level = String(row.level ?? "").toLowerCase();
    if (status >= 500 || level === "error" || level === "fatal") {
      summary.errors += 1;
      const p = typeof row.requestPath === "string" ? row.requestPath.split("?")[0] : "(sem caminho)";
      summary.paths.set(p, (summary.paths.get(p) ?? 0) + 1);
    }
  }
  return summary;
}

function scoped(path: string, teamId: string | undefined): string {
  const url = new URL(path, API);
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

/** O endpoint de runtime logs é um stream: lê por alguns segundos e para. */
async function readStream(url: string, token: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_WINDOW_MS);
  let text = "";
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Vercel respondeu ${res.status} ao ler logs.`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_BYTES) break;
    }
    await reader.cancel().catch(() => undefined);
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return text;
}

export async function scanLogs(): Promise<ScanOutcome> {
  const token = env("VERCEL_TOKEN");
  const projectId = env("VERCEL_PROJECT_ID");
  const teamId = env("VERCEL_TEAM_ID") ?? env("VERCEL_ORG_ID");
  if (!token || !projectId) return skipped("VERCEL_TOKEN e VERCEL_PROJECT_ID não configurados.");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId) || (teamId && !/^[A-Za-z0-9_-]{1,100}$/.test(teamId))) {
    return skipped("VERCEL_PROJECT_ID ou VERCEL_TEAM_ID com formato inválido.");
  }
  try {
    const listUrl = scoped(`/v6/deployments?projectId=${projectId}&target=production&state=READY&limit=1`, teamId);
    const res = await fetchWithTimeout(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    const data = await readJson(res);
    if (!res.ok) throw new Error(`Vercel respondeu ${res.status} ao listar deploys.`);
    const deployments = isRecord(data) && Array.isArray(data.deployments) ? data.deployments : [];
    const latest = deployments.find(isRecord);
    const id = latest && typeof latest.uid === "string" ? latest.uid : null;
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return skipped("Nenhum deploy de produção pronto encontrado para esse projeto.");
    const text = await readStream(scoped(`/v1/projects/${projectId}/deployments/${id}/runtime-logs`, teamId), token);
    const s = summarizeLogLines(text);
    const top = [...s.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const findings: Finding[] =
      s.errors === 0
        ? []
        : [
            {
              severity: s.errors >= 20 ? "alto" : "medio",
              title: `${s.errors} erro(s) de servidor nos logs recentes`,
              where: top.map(([p, n]) => `${p} (${n})`).join(", "),
              why: "Erros 5xx ou de nível error em produção significam usuários recebendo falha.",
              fix: "Abra os logs na Vercel filtrando esses caminhos e corrija a causa; reverta o deploy se começou com ele.",
            },
          ];
    return {
      status: "ok",
      summary: [`${s.total} registro(s) lidos do deploy de produção atual`, `${s.errors} erro(s)`, "Janela curta: depende do quanto a Vercel guarda no seu plano"],
      findings,
    };
  } catch (error) {
    return { status: "erro", reason: safeError(error), summary: [], findings: [] };
  }
}
