import type { AuditConfig } from "../config";
import { fetchWithTimeout, isRecord, readJson } from "../http";
import { safeError } from "../redact";
import { env, skipped, type Finding, type ScanOutcome } from "../types";

/** Foto do momento das chaves de rate limit no Upstash Redis (REST). Só
 * comandos de leitura: SCAN, TYPE, ZCARD, GET. Não é histórico: o Redis
 * apaga as chaves quando a janela expira. IPs e e-mails saem mascarados
 * no relatório. */

const READ_COMMANDS = new Set(["SCAN", "TYPE", "ZCARD", "GET"]);

async function command(url: string, token: string, cmd: (string | number)[]): Promise<unknown> {
  if (!READ_COMMANDS.has(String(cmd[0]))) throw new Error("Comando Redis não permitido.");
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await readJson(res);
  if (!res.ok || !isRecord(data) || "error" in data) {
    const detail = isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(`Upstash respondeu: ${detail}`);
  }
  return data.result;
}

export function maskIdentifier(id: string): string {
  const ipv4 = id.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.x.x`;
  const email = id.match(/^([^@]{1,2})[^@]*@(.)[^@]*(\.[^.@]+)$/);
  if (email) return `${email[1]}***@${email[2]}***${email[3]}`;
  if (id.includes(":") && /^[0-9a-f:]+$/i.test(id)) return `${id.split(":").slice(0, 2).join(":")}:x`;
  return id.length > 6 ? `${id.slice(0, 4)}***` : "***";
}

/** Separa o identificador (último pedaço) do prefixo da chave. */
export function splitKey(key: string): { prefix: string; identifier: string } {
  const emailOrIp = key.match(/^(.*?:)([^:]+@[^:]+|\d{1,3}(?:\.\d{1,3}){3})$/);
  if (emailOrIp) return { prefix: emailOrIp[1], identifier: emailOrIp[2] };
  const idx = key.lastIndexOf(":");
  return idx < 0 ? { prefix: "", identifier: key } : { prefix: key.slice(0, idx + 1), identifier: key.slice(idx + 1) };
}

async function scanKeys(url: string, token: string, pattern: string, max: number): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  let rounds = 0;
  do {
    const result = await command(url, token, ["SCAN", cursor, "MATCH", pattern, "COUNT", 200]);
    if (!Array.isArray(result) || result.length < 2 || !Array.isArray(result[1])) break;
    cursor = String(result[0]);
    keys.push(...(result[1] as unknown[]).map(String));
    rounds += 1;
  } while (cursor !== "0" && keys.length < max && rounds < 200);
  return keys.slice(0, max);
}

async function countFor(url: string, token: string, key: string): Promise<number> {
  const type = await command(url, token, ["TYPE", key]);
  if (type === "zset") return Number(await command(url, token, ["ZCARD", key])) || 0;
  if (type === "string") return Number(await command(url, token, ["GET", key])) || 0;
  return 0;
}

export async function scanForcaBruta(config: AuditConfig): Promise<ScanOutcome> {
  const url = env("KV_REST_API_URL") ?? env("UPSTASH_REDIS_REST_URL");
  const token =
    env("KV_REST_API_READ_ONLY_TOKEN") ?? env("KV_REST_API_TOKEN") ?? env("UPSTASH_REDIS_REST_TOKEN");
  if (!url || !token) return skipped("KV_REST_API_URL e KV_REST_API_READ_ONLY_TOKEN (ou KV_REST_API_TOKEN) não configurados.");
  if (!url.startsWith("https://")) return skipped("KV_REST_API_URL precisa começar com https://.");
  try {
    const { keyPatterns, threshold, maxKeys } = config.bruteForce;
    const all = new Set<string>();
    for (const pattern of keyPatterns) {
      for (const key of await scanKeys(url, token, pattern, maxKeys)) {
        if (!key.includes(":events:")) all.add(key); // telemetria do @upstash/ratelimit, não contador
      }
    }
    const offenders: { key: string; count: number }[] = [];
    for (const key of [...all].slice(0, maxKeys)) {
      const count = await countFor(url, token, key);
      if (count >= threshold) offenders.push({ key, count });
    }
    offenders.sort((a, b) => b.count - a.count);
    const findings: Finding[] = offenders.slice(0, 20).map((o) => {
      const { prefix, identifier } = splitKey(o.key);
      return {
        severity: offenders.length >= 5 ? "alto" : "medio",
        title: `${o.count} tentativas na janela de rate limit`,
        where: `${prefix}${maskIdentifier(identifier)}`,
        why: "Muitas tentativas do mesmo IP ou identificador podem ser força bruta de senha ou abuso de formulário.",
        fix: "Confira nos logs de autenticação; se for ataque, bloqueie o IP no firewall/WAF e ative proteção contra bots (Turnstile, hCaptcha).",
      };
    });
    return {
      status: "ok",
      summary: [
        `${all.size} chave(s) lidas com ${keyPatterns.join(", ")}; limite de alerta: ${threshold}`,
        `${offenders.length} identificador(es) no limite ou acima`,
        "É uma foto do momento da execução, não o histórico da semana",
      ],
      findings,
    };
  } catch (error) {
    return { status: "erro", reason: safeError(error), summary: [], findings: [] };
  }
}
