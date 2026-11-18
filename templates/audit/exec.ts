import { spawnSync } from "node:child_process";

/** Roda um comando FIXO (nome e argumentos escritos no código, nunca vindos
 * de dados remotos ou da configuração). No Windows, npm/npx são arquivos
 * .cmd e precisam de shell; como os argumentos são constantes, não há
 * injeção possível. */

export type CommandResult = { code: number | null; stdout: string; stderr: string; missing: boolean };

const ALLOWED = new Set(["npm", "npx", "git"]);
const SAFE_ARG = /^[A-Za-z0-9@._:/=-]+$/;

export function runFixedCommand(cmd: "npm" | "npx" | "git", args: readonly string[], timeoutMs: number): CommandResult {
  if (!ALLOWED.has(cmd) || !args.every((a) => SAFE_ARG.test(a))) {
    throw new Error("Comando não permitido.");
  }
  const win = process.platform === "win32";
  // No Windows a linha vai inteira para o shell; os argumentos já passaram
  // pela lista branca SAFE_ARG acima (sem espaço, aspas, ; | & $ etc.).
  const result = spawnSync(win ? [cmd, ...args].join(" ") : cmd, win ? [] : [...args], {
    encoding: "utf-8",
    shell: win,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const missing = Boolean(result.error && "code" in result.error && result.error.code === "ENOENT");
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing,
  };
}
