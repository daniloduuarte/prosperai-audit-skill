import { fetchWithTimeout } from "../http";
import { safeError } from "../redact";
import { env, skipped, type Finding, type ScanOutcome } from "../types";

/** Saúde: GET no app publicado e HEAD na API REST do Supabase. Nenhuma
 * credencial é enviada; só confere se responde, em quanto tempo e quais
 * cabeçalhos de segurança voltam. */

const SLOW_MS = 3000;

function validHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function headerFindings(where: string, headers: Headers): Finding[] {
  const missing: string[] = [];
  if (!headers.get("strict-transport-security")) missing.push("Strict-Transport-Security");
  if (headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") missing.push("X-Content-Type-Options: nosniff");
  const csp = headers.get("content-security-policy") ?? "";
  if (!headers.get("x-frame-options") && !/frame-ancestors/i.test(csp)) missing.push("X-Frame-Options ou frame-ancestors");
  if (missing.length === 0) return [];
  return [
    {
      severity: "baixo",
      title: "Cabeçalhos de segurança ausentes",
      where: `${where} (faltando: ${missing.join(", ")})`,
      why: "Sem eles o navegador fica mais exposto a clickjacking, MIME sniffing e downgrade para HTTP.",
      fix: "Adicione os cabeçalhos em next.config (headers()) ou no proxy/CDN.",
    },
  ];
}

async function checkApp(raw: string, summary: string[], findings: Finding[]): Promise<void> {
  const url = validHttpUrl(raw);
  if (!url) {
    findings.push({ severity: "medio", title: "DEPLOYED_APP_URL inválida", where: "DEPLOYED_APP_URL", why: "Sem URL válida não dá para checar o app.", fix: "Use a URL completa, ex.: https://app.exemplo.com" });
    return;
  }
  if (url.protocol === "http:") {
    findings.push({ severity: "medio", title: "App configurado em HTTP, sem TLS", where: url.origin, why: "Tráfego sem criptografia expõe sessão e dados.", fix: "Publique e configure a URL em https://." });
  }
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url.toString(), { method: "GET" }, 15_000);
    const ms = Date.now() - start;
    summary.push(`App: HTTP ${res.status} em ${ms} ms`);
    if (res.status >= 500) {
      findings.push({ severity: "alto", title: `App respondeu ${res.status}`, where: url.origin, why: "Erro de servidor na página inicial: usuários podem estar sem acesso.", fix: "Veja os logs do deploy atual e reverta se for regressão." });
    } else if (res.status >= 400) {
      findings.push({ severity: "medio", title: `App respondeu ${res.status}`, where: url.origin, why: "A URL configurada não carrega normalmente.", fix: "Confira se DEPLOYED_APP_URL aponta para a página certa e se ela está pública." });
    }
    if (ms > SLOW_MS) {
      findings.push({ severity: "baixo", title: `App lento (${ms} ms)`, where: url.origin, why: "Resposta acima de 3 s piora a experiência e pode indicar problema.", fix: "Investigue cold start, consultas lentas e cache." });
    }
    await res.body?.cancel();
    findings.push(...headerFindings(url.origin, res.headers));
  } catch (error) {
    summary.push("App: sem resposta");
    findings.push({ severity: "alto", title: "App não respondeu", where: url.origin, why: `Falha ao conectar: ${safeError(error)}`, fix: "Confira se o deploy está no ar e se o domínio resolve." });
  }
}

async function checkSupabase(raw: string, summary: string[], findings: Finding[]): Promise<void> {
  const url = validHttpUrl(raw);
  if (!url) return;
  const target = new URL("/rest/v1/", url).toString();
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(target, { method: "HEAD" }, 15_000);
    summary.push(`Supabase REST: HTTP ${res.status} em ${Date.now() - start} ms (401 sem chave é o esperado)`);
    if (res.status >= 500) {
      findings.push({ severity: "alto", title: `Supabase respondeu ${res.status}`, where: url.origin, why: "A API do banco está com erro: o app provavelmente também.", fix: "Veja status.supabase.com e os logs do projeto. Projeto pausado também causa isso." });
    }
  } catch (error) {
    summary.push("Supabase REST: sem resposta");
    findings.push({ severity: "alto", title: "Supabase não respondeu", where: url.origin, why: `Falha ao conectar: ${safeError(error)}`, fix: "Confira se o projeto está ativo (não pausado) e a URL correta." });
  }
}

export async function scanSaude(): Promise<ScanOutcome> {
  const app = env("DEPLOYED_APP_URL");
  const supabase = env("NEXT_PUBLIC_SUPABASE_URL") ?? env("SUPABASE_URL");
  if (!app && !supabase) return skipped("Nem DEPLOYED_APP_URL nem NEXT_PUBLIC_SUPABASE_URL configurados.");
  const summary: string[] = [];
  const findings: Finding[] = [];
  if (app) await checkApp(app, summary, findings);
  else summary.push("App: pulado (DEPLOYED_APP_URL não configurado)");
  if (supabase) await checkSupabase(supabase, summary, findings);
  else summary.push("Supabase: pulado (NEXT_PUBLIC_SUPABASE_URL não configurado)");
  return { status: "ok", summary, findings };
}
