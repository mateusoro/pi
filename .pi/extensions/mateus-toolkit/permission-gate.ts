import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, isAbsolute, normalize } from "node:path";
import { detectWriteTargets, splitCommandChain } from "./shell-write.ts";
import { log } from "./logger.ts";

// Permission gate - abordagem DENY-LIST
// Tudo é permitido POR PADRÃO. Bloqueia apenas comandos perigosos.

// ── Comandos perigosos que SEMPRE são bloqueados ──
const BLOCKED_COMMANDS: readonly string[] = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=/dev/zero",
  "dd if=/dev/random",
  "> /dev/sda",
  ":(){ :|:& };:",   // fork bomb
  "chmod -R 777 /",
  "chown -R root",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
  "systemctl stop",
  "killall",
  "pkill -9",
];

// ── Comandos que bloqueiam redirecionamento para paths do sistema ──
const SYSTEM_PATHS = [
  "/etc/",
  "/usr/",
  "/var/",
  "/boot/",
  "/sbin/",
  "/bin/",
  "/lib/",
  "/proc/",
  "/sys/",
  "/dev/",
];

/** Verifica se um caminho é do sistema (perigoso de escrever). */
function isSystemPath(path: string): boolean {
  const normalized = normalize(path);
  return SYSTEM_PATHS.some((sp) => normalized.startsWith(sp));
}

/** Verifica se um comando é perigoso (deny-list). */
function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  const trimmed = command.trim().toLowerCase();

  // Checar comandos bloqueados explicitamente
  for (const blocked of BLOCKED_COMMANDS) {
    if (trimmed === blocked || trimmed.startsWith(blocked + " ")) {
      return { dangerous: true, reason: `Comando bloqueado: "${blocked}"` };
    }
  }

  // rm sem ser dentro do cwd é tratado separadamente
  if (trimmed.startsWith("rm ")) {
    // rm é permitido (checado pelo isRmSafe)
    return { dangerous: false };
  }

  // Bloquear redirecionamento para paths do sistema
  const writes = detectWriteTargets(command);
  for (const write of writes) {
    if (isSystemPath(write.path)) {
      return {
        dangerous: true,
        reason: `Redirecionamento bloqueado: escrevendo em path do sistema "${write.path}"`,
      };
    }
  }

  return { dangerous: false };
}

/** Verifica se todos os alvos do rm estão dentro do cwd. */
function isRmSafe(command: string, cwd: string): { safe: boolean; offenders: string[] } {
  const args = command.replace(/^rm\s+/, "").split(/\s+/);
  const targets = args.filter((a) => !a.startsWith("-"));
  const normalizedCwd = normalize(cwd);
  const offenders: string[] = [];

  for (const target of targets) {
    let resolved: string;
    if (isAbsolute(target)) {
      resolved = normalize(target);
    } else {
      resolved = normalize(resolve(cwd, target));
    }
    if (!resolved.startsWith(normalizedCwd)) {
      offenders.push(target);
    }
  }

  return { safe: offenders.length === 0, offenders };
}

const SHELL_TOOLS = new Set(["bash", "Bash"]);

export function registerPermissionGate(pi: ExtensionAPI) {
  log("INFO", "Permission gate loaded (deny-list mode)");

  pi.on("tool_call", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const input: any = (event as any).input ?? (event as any).args;

    if (SHELL_TOOLS.has(toolName)) {
      const cmd = input?.command;
      if (typeof cmd !== "string") return;

      const segments = splitCommandChain(cmd);

      for (const segment of segments) {
        // 1. Checar rm (só dentro do cwd)
        if (segment.trimStart().startsWith("rm ")) {
          const { safe, offenders } = isRmSafe(segment, ctx.cwd);
          if (!safe) {
            log("BLOCK", `rm bloqueado (fora do cwd): ${offenders.join(", ")}`);
            return {
              block: true,
              reason:
                `rm bloqueado: ${offenders.map((o) => `"${o}"`).join(", ")} está fora do diretório de trabalho (${ctx.cwd}). ` +
                `rm só é permitido dentro de ${ctx.cwd}.`,
            };
          }
          continue;
        }

        // 2. Checar deny-list de comandos perigosos
        const { dangerous, reason } = isDangerousCommand(segment);
        if (dangerous) {
          log("BLOCK", reason!);
          return { block: true, reason: reason! };
        }
      }
    }
  });
}
