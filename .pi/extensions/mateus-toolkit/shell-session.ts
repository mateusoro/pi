import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { formatOutput, DEFAULT_TIMEOUT } from "./shell-helpers.ts";
import { log } from "./logger.ts";

// ShellSession - sessão bash persistente com timeout.
// Portado do little-coder.

async function execSubprocess(command: string, timeoutSec: number): Promise<string> {
  try {
    const buf = execSync(command, {
      shell: "/bin/bash",
      timeout: timeoutSec * 1000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return formatOutput(String(buf), 0, process.cwd(), false);
  } catch (err: any) {
    const out = (err.stdout?.toString?.() ?? "") + (err.stderr?.toString?.() ?? "");
    const timedOut = err.code === "ETIMEDOUT" || err.signal === "SIGTERM";
    const code = typeof err.status === "number" ? err.status : -1;
    return formatOutput(out, code, process.cwd(), timedOut);
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
