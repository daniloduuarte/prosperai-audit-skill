/** fetch com tempo limite. Só é chamado com URLs que vêm da configuração do
 * próprio projeto (variáveis de ambiente) ou de APIs fixas (Supabase, Vercel,
 * Resend): nenhum dado é enviado para outro lugar. */

export const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: init.redirect ?? "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/** Lê o corpo como JSON sem confiar no formato; devolve `unknown`. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { _raw: text.slice(0, 300) };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
