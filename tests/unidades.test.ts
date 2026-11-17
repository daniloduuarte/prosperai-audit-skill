import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../templates/audit/config";
import { runFixedCommand } from "../templates/audit/exec";
import { createRedactor } from "../templates/audit/redact";
import { buildMarkdown, computeScore } from "../templates/audit/report";
import { auditFindings, parseNpmAudit, parseNpmOutdated } from "../templates/audit/scans/deps";
import { maskIdentifier, splitKey } from "../templates/audit/scans/forca-bruta";
import { summarizeLogLines } from "../templates/audit/scans/logs";
import type { ScanResult } from "../templates/audit/types";

const audit = JSON.parse(readFileSync(new URL("./fixtures/npm-audit.json", import.meta.url), "utf-8")) as unknown;

test("npm audit: severidade traduzida, título, correção e produção x dev", () => {
  const pk = parseNpmAudit(audit, new Set(["pacote-web", "parser-qs"]));
  const by = Object.fromEntries(pk.map((p) => [p.name, p]));
  assert.equal(by["pacote-web"].severity, "critico");
  assert.equal(by["parser-qs"].severity, "medio"); // "moderate" do npm
  assert.equal(by["ferramenta-cli"].production, false);
  assert.match(by["pacote-web"].fix, /npm audit fix/);
  assert.match(by["parser-qs"].fix, /pacote-web para 3\.0\.0 \(versão major/);
  assert.match(by["ferramenta-cli"].title, /glob-velho/);
  const sev = Object.fromEntries(auditFindings(pk).map((f) => [f.where, f.severity]));
  assert.equal(sev["pacote ferramenta-cli"], "baixo"); // alto, mas só dev
});

test("npm audit: erro do npm vira exceção, sem vulnerabilidades vira lista vazia", () => {
  assert.throws(() => parseNpmAudit({ error: { code: "ENOLOCK", summary: "sem lockfile" } }, null), /ENOLOCK|sem lockfile/);
  assert.deepEqual(parseNpmAudit({ auditReportVersion: 2, vulnerabilities: {} }, null), []);
});

test("npm outdated: detecta major e pacote não instalado", () => {
  const out = parseNpmOutdated({ next: { current: "14.2.0", wanted: "14.2.5", latest: "15.1.0" }, zod: { wanted: "3.23.0", latest: "3.23.0" } });
  assert.deepEqual(out.map((o) => [o.name, o.major]), [["next", true], ["zod", false]]);
  assert.equal(out[1].current, "não instalado");
});

test("redação: valor de env com nome de segredo e formatos conhecidos somem", () => {
  const r = createRedactor({ SUPABASE_ACCESS_TOKEN: "sbp_abcdef0123456789abcdef", MY_API_KEY: "valor-secreto-123", PATH: "/usr/bin" });
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWZha2U";
  const text = `token sbp_abcdef0123456789abcdef chave valor-secreto-123 jwt ${jwt} Authorization: Bearer abc.def.ghi123 hook https://hooks.slack.com/services/T000/B000/XXXX url https://user:senha@host.com/x resend re_AbCdEf123456789 path /usr/bin`;
  const out = r(text);
  for (const leak of ["sbp_abcdef", "valor-secreto-123", "eyJhbGci", "abc.def.ghi123", "hooks.slack.com/services", "user:senha", "re_AbCdEf"]) {
    assert.ok(!out.includes(leak), `vazou ${leak}: ${out}`);
  }
  assert.ok(out.includes("/usr/bin"), "não deve redigir variável que não é segredo");
});

test("config: valores inválidos caem no padrão com aviso; nada vira SQL", () => {
  const { config, warnings } = parseConfig({ tenantColumn: "x; drop table y", notifyEmail: "nao-e-email", scans: { rls: false, logs: "sim" } });
  assert.equal(config.tenantColumn, DEFAULT_CONFIG.tenantColumn);
  assert.equal(config.notifyEmail, "");
  assert.equal(config.scans.rls, false);
  assert.equal(config.scans.logs, DEFAULT_CONFIG.scans.logs);
  assert.equal(warnings.length, 2);
});

test("nota: 100 menos pesos, mínimo 0; scan pulado não desconta", () => {
  const mk = (sev: ScanResult["findings"][number]["severity"][]): ScanResult => ({
    id: "x", name: "X", status: "ok", summary: [], durationMs: 1,
    findings: sev.map((severity) => ({ severity, title: "t", where: "w", why: "y", fix: "f" })),
  });
  const skippedScan: ScanResult = { id: "s", name: "S", status: "pulado", reason: "sem segredo", summary: [], findings: [], durationMs: 0 };
  assert.equal(computeScore([mk(["critico", "alto", "medio", "baixo", "info"]), skippedScan]), 60);
  assert.equal(computeScore([mk(["critico", "critico", "critico", "critico", "critico"])]), 0);
  const md = buildMarkdown([mk(["alto"]), skippedScan], { projectName: "demo", date: new Date(0), warnings: [] });
  assert.match(md, /Nota: 90\/100/);
  assert.match(md, /O que não rodou e por quê[\s\S]*sem segredo/);
  assert.match(md, /\*\*Como corrigir:\*\*/);
});

test("exec: só npm/npx com argumentos da lista branca", () => {
  assert.throws(() => runFixedCommand("npm", ["audit", "--json", "& calc"], 1000), /não permitido/);
  assert.throws(() => runFixedCommand("npm", ["run", "x;rm"], 1000), /não permitido/);
  assert.throws(() => runFixedCommand("rm" as "npm", ["-rf"], 1000), /não permitido/);
});

test("força bruta: identificadores mascarados", () => {
  assert.equal(maskIdentifier("203.0.113.45"), "203.0.x.x");
  assert.equal(maskIdentifier("maria.silva@exemplo.com"), "ma***@e***.com");
  assert.deepEqual(splitKey("ratelimit:login:email:ana@exemplo.com"), { prefix: "ratelimit:login:email:", identifier: "ana@exemplo.com" });
  assert.deepEqual(splitKey("ratelimit:ip:198.51.100.7"), { prefix: "ratelimit:ip:", identifier: "198.51.100.7" });
});

test("logs: conta 5xx e nível error, guarda só o caminho sem query", () => {
  const lines = [
    JSON.stringify({ level: "info", responseStatusCode: 200, requestPath: "/" }),
    JSON.stringify({ level: "error", responseStatusCode: 500, requestPath: "/api/x?token=segredo", message: "dado do cliente" }),
    JSON.stringify({ level: "warning", statusCode: 502, requestPath: "/api/x" }),
    "linha que não é json",
  ].join("\n");
  const s = summarizeLogLines(lines);
  assert.equal(s.total, 3);
  assert.equal(s.errors, 2);
  assert.deepEqual([...s.paths.entries()], [["/api/x", 2]]);
});
