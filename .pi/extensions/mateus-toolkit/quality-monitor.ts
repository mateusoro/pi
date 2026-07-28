import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";

// Detecção de loops e problemas de qualidade na resposta do modelo.

interface ToolCall {
  name: string;
  input: unknown;
}

type QualityResult =
  | { ok: true }
  | { ok: false; reason: string };

function assessResponse(
  text: string,
  toolCalls: ToolCall[],
  recentToolCalls: ToolCall[],
  knownTools: Set<string>,
): QualityResult {
  // 1. Resposta vazia sem tool calls
  if (!text.trim() && toolCalls.length === 0) {
    return { ok: false, reason: "empty_response" };
  }

  // 2. Tool name inventado
  for (const tc of toolCalls) {
    if (!tc.name) return { ok: false, reason: "empty_tool_name" };
    if (knownTools.size > 0 && !knownTools.has(tc.name)) {
      return { ok: false, reason: `unknown_tool:${tc.name}` };
    }
  }

  // 3. Tool call repetido (mesmo name+input do turno anterior)
  if (toolCalls.length > 0 && recentToolCalls.length > 0) {
    for (const tc of toolCalls) {
      for (const prev of recentToolCalls) {
        if (tc.name === prev.name &&
            JSON.stringify(tc.input) === JSON.stringify(prev.input)) {
          return { ok: false, reason: "repeated_tool_call" };
        }
      }
    }
  }

  return { ok: true };
}

function buildCorrectionMessage(reason: string): string {
  const corrections: Record<string, string> = {
    empty_response:
      "Sua resposta anterior foi vazia. Responda com texto ou uma tool call para fazer progresso.",
    empty_tool_name:
      "Sua tool call ficou sem nome. Especifique um nome de tool válido.",
    repeated_tool_call:
      "Você fez a EXATA MESMA tool call do turno anterior. Está em loop. Tente uma abordagem diferente ou explique o que está tentando fazer.",
  };

  if (reason.startsWith("unknown_tool:")) {
    const toolName = reason.slice("unknown_tool:".length);
    return `A tool '${toolName}' não existe. Use: read, write, edit, bash, grep, find, ls, webfetch, websearch.`;
  }

  return corrections[reason] ?? `Problema detectado: ${reason}. Tente novamente.`;
}

function phraseForUser(reason: string): string {
  if (reason.startsWith("unknown_tool:")) {
    return `modelo chamou tool inexistente (${reason.slice("unknown_tool:".length)})`;
  }
  const phrases: Record<string, string> = {
    empty_response: "modelo retornou resposta vazia",
    empty_tool_name: "modelo emitiu tool call sem nome",
    repeated_tool_call: "modelo repetiu a tool call anterior idêntica",
  };
  return phrases[reason] ?? `problema de qualidade (${reason})`;
}

const MAX_CONSECUTIVE_CORRECTIONS = 2;

let previousToolCalls: ToolCall[] = [];
let consecutiveFailures = 0;

export function registerQualityMonitor(pi: ExtensionAPI) {
  log("INFO", "Quality monitor loaded");

  const knownTools = new Set<string>();
  pi.on("tool_execution_start", async (event) => {
    const name = (event as any).toolName;
    if (typeof name === "string") knownTools.add(name);
  });

  pi.on("session_start", async () => {
    previousToolCalls = [];
    consecutiveFailures = 0;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = (event as any).message;
    if (!message) return;

    // Pular turnos interrompidos (ESC, abort)
    if (message.stopReason === "aborted") return;

    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("\n");
    const currentCalls: ToolCall[] = content
      .filter((c: any) => c?.type === "toolCall")
      .map((c: any) => ({ name: c.name, input: c.arguments ?? c.input ?? {} }));

    const verdict = assessResponse(text, currentCalls, previousToolCalls, knownTools);

    previousToolCalls = currentCalls;

    if (verdict.ok) {
      consecutiveFailures = 0;
      return;
    }

    consecutiveFailures++;
    log("WARN", `Quality issue: ${verdict.reason} (consecutive: ${consecutiveFailures})`);

    if (consecutiveFailures > MAX_CONSECUTIVE_CORRECTIONS) {
      log("WARN", `Max corrections reached (${consecutiveFailures}), backing off`);
      ctx.ui.notify(`harness intervention: ${phraseForUser(verdict.reason)} — desistindo após ${consecutiveFailures} tentativas.`, "warning");
      return;
    }

    const correction = buildCorrectionMessage(verdict.reason);
    ctx.ui.notify(`harness intervention: ${phraseForUser(verdict.reason)} — redirecionando modelo.`, "info");
    pi.sendUserMessage(correction, { deliverAs: "steer" });
  });
}
