import type { AuditConfig } from "./config";
import { fetchWithTimeout } from "./http";
import { log, redact, safeError } from "./redact";
import { env } from "./types";

/** Envia o relatório SÓ para os canais configurados (Resend e/ou Slack).
 * Falha de envio vira aviso no log, nunca derruba a auditoria. */

export type NotifySummary = { score: number; critical: number; high: number; runUrl?: string };

export async function sendEmail(config: AuditConfig, markdown: string, s: NotifySummary): Promise<string> {
  const key = env("RESEND_API_KEY");
  const to = env("NOTIFY_EMAIL") ?? (config.notifyEmail || undefined);
  if (!key) return "e-mail: não enviado (falta o secret RESEND_API_KEY: o envio usa uma conta gratuita no Resend)";
  if (!to) return "e-mail: não enviado (falta o destinatário: notifyEmail no audit.config.json ou o secret NOTIFY_EMAIL)";
  const from = env("RESEND_FROM") ?? "Auditoria <onboarding@resend.dev>";
  try {
    const res = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Auditoria ${config.projectName}: nota ${s.score}/100, ${s.critical} crítico(s)`,
        text: redact(markdown),
      }),
    });
    return res.ok ? "e-mail: enviado" : `e-mail: Resend respondeu ${res.status}`;
  } catch (error) {
    return `e-mail: falhou (${safeError(error)})`;
  }
}

export async function sendSlack(config: AuditConfig, s: NotifySummary): Promise<string> {
  const hook = env("SLACK_WEBHOOK_URL");
  if (!hook) return "slack: não configurado (SLACK_WEBHOOK_URL)";
  if (!hook.startsWith("https://hooks.slack.com/")) return "slack: SLACK_WEBHOOK_URL inválido (precisa ser https://hooks.slack.com/...)";
  const text = [
    `Auditoria de ${config.projectName}: nota ${s.score}/100`,
    `Crítico: ${s.critical} · Alto: ${s.high}`,
    s.runUrl ? `Relatório: ${s.runUrl}` : "Relatório completo no artefato audit-report da execução.",
  ].join("\n");
  try {
    const res = await fetchWithTimeout(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: redact(text) }),
    });
    return res.ok ? "slack: enviado" : `slack: respondeu ${res.status}`;
  } catch (error) {
    return `slack: falhou (${safeError(error)})`;
  }
}

export async function notify(config: AuditConfig, markdown: string, s: NotifySummary): Promise<void> {
  for (const line of [await sendEmail(config, markdown, s), await sendSlack(config, s)]) log.info(`  ${line}`);
}
