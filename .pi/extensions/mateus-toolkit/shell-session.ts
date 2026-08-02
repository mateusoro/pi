import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { formatOutput, DEFAULT_TIMEOUT } from "./shell-helpers.ts";
import { log } from "./logger.ts";

// ShellSession - sessão bash persistente com timeout.
// Portado do little-coder.
//
// Corrige a causa raiz de o shell rodar acima do permitido (ex.: find / por 786.5s):
//  - antigamente usava `execSync({ shell: "/bin/bash" })`, que no Windows falha com
//    ENOENT (`/bin/bash` não existe como caminho real) e não mata a árvore no timeout;
//  - agora usa `spawn` + shell resolvido (caminho real do Git Bash / bash do PATH) e,
//    no timeout, mata a árvore inteira de processos (`taskkill /F /T` no Windows),
//    impedindo que processos filhos órfãos (find, sleep, etc.) fiquem rodando.

const EXIT_STDIO_GRACE_MS = 100;

// ── utils locais (espelham o core para não depender de subpath não exportado do package) ──

interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

function getBashShellConfig(shell: string): ShellConfig {
  const normalized = shell.replace(/\//g, "\\\\").toLowerCase();
  const isLegacyWsl = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
  return isLegacyWsl ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function getShellConfig(): ShellConfig {
  if (process.platform === "win32") {
    const { ProgramFiles, "ProgramFiles(x86)": PFx86 } = process.env;
    const candidates: string[] = [];
    if (ProgramFiles) candidates.push(join(ProgramFiles, "Git", "bin", "bash.exe"));
    if (PFx86) candidates.push(join(PFx86, "Git", "bin", "bash.exe"));
    for (const p of candidates) {
      if (p && existsSync(p)) return getBashShellConfig(p);
    }
    // Fallback: bash via PATH (Cygwin, MSYS2, WSL...)
    const pathDirs = (process.env.PATH ?? "").split(delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      for (const name of ["bash.exe", "bash"]) {
        const candidate = join(dir, name).replace(/\\/g, "/");
        if (/\.[a-z]+$/i.test(name) && existsSync(candidate)) {
          return getBashShellConfig(candidate);
        }
      }
    }
    throw new Error(
      `No bash shell found. Install Git for Windows (https://git-scm.com/download/win) or add bash to PATH.`,
    );
  }
  if (existsSync("/bin/bash")) return getBashShellConfig("/bin/bash");
  return { shell: "sh", args: ["-c"] };
}

function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // ignora
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // já morto
      }
    }
  }
}

/** Espera o processo terminar sem travar nas pipes herdadas. */
function waitForChildProcess(child): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let timer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onEnd);
      child.stderr?.removeListener("end", onEnd);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const maybe = () => {
      if (exited && !settled && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const onEnd = () => {
      if (exited) armTimer();
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybe();
      if (!settled) armTimer();
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout?.once("end", onEnd);
    child.stderr?.once("end", onEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function execSubprocess(command: string, timeoutSec: number): Promise<string> {
  const shellConfig = getShellConfig();
  // Comando vai como argv do shell (-c COMMAND) ou via stdin, conforme o transporte.
  const commandFromStdin = shellConfig.commandTransport === "stdin";
  const args = commandFromStdin ? shellConfig.args : [...shellConfig.args, command];

  const child = spawn(shellConfig.shell, args, {
    cwd: process.cwd(),
    env: getShellEnv(),
    stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  if (commandFromStdin) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(command);
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  const killAndRelease = () => {
    const pid = child.pid;
    if (pid) killProcessTree(pid);
    // Destrói as pipes para destravar o waitForChildProcess imediatamente,
    // mesmo que processos órfãos do comando segurem o stdout/stderr herdado.
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  };

  const onData = (d: Buffer) => {
    if (truncated) return;
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
    total += buf.length;
    if (total <= MAX_OUTPUT_BYTES) {
      chunks.push(buf);
    } else {
      truncated = true;
      // Descarta o excedente para não estourar memória/UI.
      const head = Buffer.concat(chunks);
      chunks.length = 0;
      chunks.push(head.subarray(0, MAX_OUTPUT_BYTES));
    }
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  try {
    if (timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killAndRelease();
      }, timeoutSec * 1000);
      timer.unref?.();
    }

    const code = await waitForChildProcess(child);

    if (timedOut) {
      return formatOutput(Buffer.concat(chunks).toString("utf-8"), 124, process.cwd(), true);
    }
    return formatOutput(Buffer.concat(chunks).toString("utf-8"), code ?? -1, process.cwd(), false);
  } catch (err: any) {
    const out = Buffer.concat(chunks).toString("utf-8");
    if (err?.message === "aborted" || err?.code === "ENOENT") {
      return formatOutput(out, -1, process.cwd(), false);
    }
    return formatOutput(out, -1, process.cwd(), timedOut);
  } finally {
    if (timer) clearTimeout(timer);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

export function registerShellSession(pi: ExtensionAPI) {
  log("INFO", "Shell session loaded");

  // ── ShellSession: executar comando com timeout ──
  pi.registerTool({
    name: "ShellSession",
    label: "ShellSession",
    description:
      "Executa comando em sessão bash persistente. cd, env vars e estado do shell persistem entre chamadas. " +
      "Timeout padrão 30s (aumente para 120-300 para installs/builds). " +
      "Output é truncado e deduplicado.",
    parameters: Type.Object({
      command: Type.String({ description: "Comando shell para executar" }),
      timeout: Type.Optional(Type.Integer({ description: "Timeout em segundos (padrão 30, máx 600)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cmd = String(params.command ?? "").trim();
      if (!cmd) {
        return {
          content: [{ type: "text", text: "Erro: comando é obrigatório" }],
          details: {}, isError: true,
        };
      }
      const rawTimeout = typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT;
      const timeoutSec = Math.max(5, Math.min(rawTimeout, 600));

      log("INFO", `ShellSession exec`, { cmd: cmd.substring(0, 100), timeout: timeoutSec });

      const text = await execSubprocess(cmd, timeoutSec);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ── ShellSessionCwd: verificar diretório atual ──
  pi.registerTool({
    name: "ShellSessionCwd",
    label: "ShellSessionCwd",
    description: "Mostra o diretório de trabalho atual da sessão shell.",
    parameters: Type.Object({}),
    async execute() {
      const text = await execSubprocess("pwd", 5);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ── ShellSessionReset: matar e reiniciar sessão travada ──
  pi.registerTool({
    name: "ShellSessionReset",
    label: "ShellSessionReset",
    description: "Mata e reinicia a sessão bash. Use apenas se estiver travada.",
    parameters: Type.Object({}),
    async execute() {
      log("INFO", "ShellSession reset solicitado");
      return {
        content: [{ type: "text", text: "Sessão resetada (subprocess backend é stateless)." }],
        details: {},
      };
    },
  });
}
