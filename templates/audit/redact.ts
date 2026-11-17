/** Redação de segredos: tudo que vai para log, relatório, e-mail ou Slack
 * passa por aqui. Duas camadas: (1) o VALOR exato de toda variável de
 * ambiente com nome de segredo; (2) formatos conhecidos de token, para o
 * caso de um segredo chegar por outro caminho (ex.: dentro de uma mensagem
 * de erro de uma API). */

const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|WEBHOOK|DSN|PRIVATE|CREDENTIAL)/i;
const MASK = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT (anon/service role)
  /\bsbp_[A-Za-z0-9]{16,}/g, // token pessoal do Supabase
  /\bsb_secret_[A-Za-z0-9_-]{8,}/g, // chave secreta nova do Supabase
  /\bre_[A-Za-z0-9_]{12,}/g, // Resend
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack bot/user token
  /https:\/\/hooks\.slack\.com\/[^\s"'<>)]+/g, // webhook do Slack
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // cabeçalho de autorização
  /(:\/\/)[^\s/:@"']+:[^\s/@"']+@/g, // usuário:senha dentro de URL
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function secretValuesFrom(source: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    if (!value || !SECRET_NAME.test(name)) continue;
    const trimmed = value.trim();
    if (trimmed.length >= 6) values.add(trimmed);
  }
  // Mais longos primeiro: evita deixar pedaço de um segredo que contém outro.
  return [...values].sort((a, b) => b.length - a.length);
}

export function createRedactor(source: Record<string, string | undefined>): (text: string) => string {
  const exact = secretValuesFrom(source).map((v) => new RegExp(escapeRegExp(v), "g"));
  return (text: string): string => {
    let out = String(text);
    for (const re of exact) out = out.replace(re, MASK);
    for (const re of TOKEN_PATTERNS) {
      out = out.replace(re, (match, p1: unknown) => {
        if (typeof p1 === "string" && p1 === "://") return `://${MASK}@`;
        if (typeof p1 === "string" && /^(Bearer|Basic)$/i.test(p1)) return `${p1} ${MASK}`;
        return match.length > 0 ? MASK : match;
      });
    }
    return out;
  };
}

let cached: ((text: string) => string) | null = null;

/** Redator ligado ao process.env atual. */
export function redact(text: string): string {
  if (!cached) cached = createRedactor(process.env);
  return cached(text);
}

/** Mensagem de erro já redigida, sem stack trace. */
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message).slice(0, 500);
}

/** Console com redação obrigatória. Use sempre este, nunca console.log direto. */
export const log = {
  info: (...parts: unknown[]): void => console.log(redact(parts.map(String).join(" "))),
  warn: (...parts: unknown[]): void => console.warn(redact(parts.map(String).join(" "))),
};
