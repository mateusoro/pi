import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, isAbsolute, normalize } from "node:path";
import { detectWriteTargets, splitCommandChain } from "./shell-write.ts";
import { log } from "./logger.ts";

// Lista de comandos bash permitidos (whitelist).
const BUILTIN_SAFE_PREFIXES: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date",
  "which", "type", "env", "printenv", "uname", "whoami", "id",
  "git log", "git status", "git diff", "git show", "git branch",
  "git remote", "git stash list", "git tag",
  "find ", "grep ", "rg ", "ag ", "fd ", "sed ",
  "python ", "python3 ", "node ", "ruby ", "perl ",
  "pip show", "pip list", "npm list", "cargo metadata",
  "df ", "du ", "free ", "top -bn", "ps ",
  "curl -I", "curl --head",
  "cp ", "mv ", "mkdir ", "touch ",
];

export function parseExtraPrefixes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trimStart())
    .map((s) => (s.length > 0 && s !== " ".repeat(s.length) ? s : ""))
    .filter((s) => s.length > 0);
}

export function getSafePrefixes(): string[] {
  return [...BUILTIN_SAFE_PREFIXES, ...parseExtraPrefixes(process.env.MATEUS_BASH_ALLOW)];
}

// ── rm seguro: só dentro do cwd ──

/** Extrai os argumentos (não-flags) de um comando rm. */
function extractRmTargets(command: string): string[] {
  // Remove o "rm " inicial e flags como -rf, -f, -r, -i, etc.
  const args = command.replace(/^rm\s+/, "").split(/\s+/);
  return args.filter((a) => !a.startsWith("-"));
}

/** Verifica se todos os alvos do rm estão dentro do cwd. */
function isRmSafe(command: string, cwd: string): { safe: boolean; offenders: string[] } {
  const targets = extractRmTargets(command);
  const normalizedCwd = normalize(cwd);
  const offenders: string[] = [];

  for (const target of targets) {
    let resolved: string;
    if (isAbsolute(target)) {
      resolved = normalize(target);
    } else {
      resolved = normalize(resolve(cwd, target));
    }

    // Checa se está dentro do cwd
    if (!resolved.startsWith(normalizedCwd)) {
      offenders.push(target);
    }
  }

  return { safe: offenders.length === 0, offenders };
}

export function isSafeBash(command: string, prefixes: readonly string[] = getSafePrefixes(), cwd?: string): boolean {
  if (detectWriteTargets(command).length > 0) return false;
  const segments = splitCommandChain(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    // rm é tratado separadamente (permitido dentro do cwd)
    if (segment.trimStart().startsWith("rm ")) {
      return cwd ? isRmSafe(segment, cwd).safe : false;
    }
    return prefixes.some((p) => segment.startsWith(p));
  });
}

const SHELL_TOOLS = new Set(["bash", "Bash"]);

export function registerPermissionGate(pi: ExtensionAPI) {
  log("INFO", "Permission gate loaded");

  pi.on("tool_call", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const input: any = (event as any).input ?? (event as any).args;

    if (SHELL_TOOLS.has(toolName)) {
      const cmd = input?.command;
      if (typeof cmd === "string") {
        const cwd = ctx.cwd;

        // Checar rm separadamente
        const segments = splitCommandChain(cmd);
        for (const segment of segments) {
          if (segment.trimStart().startsWith("rm ")) {
            const { safe, offenders } = isRmSafe(segment, cwd);
            if (!safe) {
              log("BLOCK", `rm bloqueado (fora do cwd): ${offenders.join(", ")}`);
              return {
                block: true,
                reason:
                  `rm bloqueado: ${offenders.map((o) => `"${o}"`).join(", ")} está fora do diretório de trabalho (${cwd}). ` +
                  `rm só é permitido dentro de ${cwd}.`,
              };
            }
            // rm dentro do cwd é permitido, pula pra próxima checagem
            continue;
          }
        }

        // Checar whitelist para outros comandos
        if (!isSafeBash(cmd, undefined, cwd)) {
          const writes = detectWriteTargets(cmd);
          if (writes.length > 0) {
            log("BLOCK", `Shell write bloqueado: ${writes.map((w) => w.path).join(", ")}`);
            return {
              block: true,
              reason:
                `Shell whitelist: este comando escreve em ${writes.map((w) => `"${w.path}"`).join(", ")} ` +
                `via redirecionamento. Use a tool Write para arquivo novo, ou Edit para existente.`,
            };
          }
          const offender = segments.find((s) => {
            if (s.trimStart().startsWith("rm ")) return false;
            return !getSafePrefixes().some((p) => s.startsWith(p));
          }) ?? cmd;
          log("BLOCK", `Shell command bloqueado: ${offender.split(/\s+/)[0]}`);
          return {
            block: true,
            reason: `Shell whitelist: "${offender.split(/\s+/)[0]}" não está na lista de comandos permitidos.`,
          };
        }
      }
    }
  });
}
