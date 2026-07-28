import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectWriteTargets, splitCommandChain } from "./shell-write.ts";
import { log } from "./logger.ts";

// Lista de comandos bash permitidos (whitelist).
// Espaço no final = word boundary ("find " não matcha "findbug").
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

export function isSafeBash(command: string, prefixes: readonly string[] = getSafePrefixes()): boolean {
  if (detectWriteTargets(command).length > 0) return false;
  const segments = splitCommandChain(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => prefixes.some((p) => segment.startsWith(p)));
}

const SHELL_TOOLS = new Set(["bash", "Bash"]);

export function registerPermissionGate(pi: ExtensionAPI) {
  log("INFO", "Permission gate loaded");

  pi.on("tool_call", async (event, _ctx) => {
    const toolName = (event as any).toolName;
    const input: any = (event as any).input ?? (event as any).args;

    if (SHELL_TOOLS.has(toolName)) {
      const cmd = input?.command;
      if (typeof cmd === "string" && !isSafeBash(cmd)) {
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
        const offender = splitCommandChain(cmd).find((s) => !isSafeBash(s)) ?? cmd;
        log("BLOCK", `Shell command bloqueado: ${offender.split(/\s+/)[0]}`);
        return {
          block: true,
          reason: `Shell whitelist: "${offender.split(/\s+/)[0]}" não está na lista de comandos permitidos.`,
        };
      }
    }
  });
}
