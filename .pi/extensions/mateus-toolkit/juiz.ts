import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, uuidv7 } from "@earendil-works/pi-ai";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { log } from "./logger.ts";

// juiz - Micro-agente juiz
//
// Avalia se a entrega da IA ATENDEU comprovadamente à solicitação do usuário.
// Recebe: solicitação original do usuário + plano (todo) + últimas 3 mensagens da IA.
// Responde no formato: ATENDEU  |  NAO_ATENDEU: <motivo>
//
// Uso:
//   1. Programático (gatilho do controle-tendencia): runJuiz(ctx, {...})
//   2. Tool 'juiz' chamável pelo LLM: registerJuiz(pi)

export interface JuizInput {
  userMessage: string;
  todoText: string;
  lastAssistantMessages: string[];
}

export type JuizVerdict = "atendeu" | "nao_atendeu" | "invalido" | "erro";

export interface JuizResult {
  status: JuizVerdict;
  motivo: string;
  error?: string;
}

const JUIZ_SYSTEM_PROMPT = `Você é o JUIZ de uma tarefa executada por uma IA de coding agent.

Você recebe:
1. A solicitação original do usuário
2. O plano (todo) criado para atender a solicitação
3. As últimas 3 mensagens escritas pela IA

Sua função é julgar se a entrega da IA ATENDEU COMPROVADAMENTE à solicitação do usuário,
verificando se o que foi entregue de fato cobre o que foi pedido no plano.

Regras:
- Responda APENAS ATENDEU se ficar COMPROVADO pelas mensagens da IA que o pedido foi atendido de fato.
- Se houver qualquer dúvida, se faltou algo do plano, se a IA apenas prometeu sem entregar,
  ou se não há evidência clara de implementação, responda NAO_ATENDEU com o motivo.
- NUNCA invente fatos. Baseie-se apenas no conteúdo fornecido.
- Se a solicitação do usuário estiver vazia, responda NAO_ATENDEU explicando que faltou o pedido original.

Responda EXATAMENTE em UM dos formatos abaixo, sem mais nada:

ATENDEU

OU

NAO_ATENDEU: <motivo explicando por que não ficou provado que a solicitação foi atendida>`;

/** Extrai as últimas N mensagens de texto da IA (role assistant) do branch da sessão. */
export function getLastAssistantMessages(ctx: ExtensionContext, count = 3): string[] {
  const out: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg || msg.role !== "assistant") continue;
    const text = (msg.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ")
      .trim();
    if (text) out.push(text);
  }
  return out.slice(-count);
}

/** Roda o micro-agente juiz usando o modelo ativo (ctx.model) — padrão do webfetch-agent. */
export async function runJuiz(ctx: ExtensionContext, input: JuizInput): Promise<JuizResult> {
  if (!ctx.model) {
    return { status: "erro", motivo: "", error: "Nenhum modelo ativo (ctx.model undefined)." };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return { status: "erro", motivo: "", error: `Sem API key para ${ctx.model.provider}.` };
  }

  const numbered = input.lastAssistantMessages.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Solicitação original do usuário\n${input.userMessage}\n\n## Plano (todo)\n${input.todoText}\n\n## Últimas 3 mensagens da IA\n${numbered}`,
      },
    ],
    timestamp: Date.now(),
  };

  log("INFO", "juiz: chamando modelo", { model: `${ctx.model.provider}/${ctx.model.id}`, lastMsgs: input.lastAssistantMessages.length });

  try {
    const response = await complete(
      ctx.model,
      { systemPrompt: JUIZ_SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: ctx.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
        timeoutMs: 120_000,
      },
    );

    if (response.stopReason === "aborted") {
      return { status: "erro", motivo: "", error: "Análise do juiz abortada." };
    }

    const texto = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const upper = texto.toUpperCase();
    if (upper.startsWith("NAO_ATENDEU") || upper.startsWith("NÃO_ATENDEU")) {
      const motivo = texto.replace(/^NAO_ATENDEU|^NÃO_ATENDEU\s*[:—-]?\s*/i, "").trim() || "Sem motivo informado.";
      log("INFO", "juiz: NAO_ATENDEU", { motivo: motivo.substring(0, 200) });
      return { status: "nao_atendeu", motivo };
    }
    if (upper.startsWith("ATENDEU")) {
      log("INFO", "juiz: ATENDEU");
      return { status: "atendeu", motivo: "" };
    }

    log("WARN", "juiz: resposta não parseável", { preview: texto.substring(0, 200) });
    return { status: "invalido", motivo: `(resposta do juiz não parseável: ${texto.substring(0, 200)})` };
  } catch (e) {
    log("ERROR", "juiz: chamada falhou", { error: (e as Error).message });
    return { status: "erro", motivo: "", error: (e as Error).message };
  }
}

/** Mensagem fixa hardcoded injetada no chat quando o juiz NÃO atestou a entrega. */
export function buildJudgeRetryMessage(motivo: string, lastUserMessage: string): string {
  const userSnippet = lastUserMessage.replace(/"/g, '\\"');
  return `[JUIZ - NÃO ATENDEU]
O juiz concluiu que a entrega NÃO ficou comprovada.

Motivo do juiz:
${motivo}

Sua ÚNICA resposta agora DEVE SER: create_todo(items=["passo1","passo2"...], summary="resumo") com o plano do que FALTA implementar para atender a solicitação.
Depois de criar o todo, implemente e conclua cada item, chamando check_todo(id=N) ao finalizar cada um.

A solicitação original do usuário foi: "${userSnippet}"`;
}

/** Registra a tool 'juiz' (chamável pelo LLM, no padrão do webfetch_agent). */
export function registerJuiz(pi: ExtensionAPI) {
  pi.registerTool({
    name: "juiz",
    label: "Juiz",
    description:
      "Micro-agente juiz: avalia se a entrega da IA atendeu comprovadamente ao pedido do usuário, " +
      "considerando o todo criado e as últimas mensagens escritas pela IA. " +
      "Retorna ATENDEU ou NAO_ATENDEU: <motivo>.",
    parameters: Type.Object({
      user_message: Type.String({ description: "Solicitação original do usuário" }),
      todo_text: Type.String({ description: "Plano/todo criado, com o estado de cada item" }),
      last_ai_messages: Type.Array(Type.String(), { description: "Últimas mensagens escritas pela IA (máx 3)" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const r = await runJuiz(ctx, {
        userMessage: params.user_message,
        todoText: params.todo_text,
        lastAssistantMessages: params.last_ai_messages,
      });
      if (r.status === "erro") {
        return {
          content: [{ type: "text", text: `Erro no juiz: ${r.error}` }],
          details: {},
          isError: true,
        };
      }
      const verdictText =
        r.status === "atendeu"
          ? "ATENDEU"
          : r.status === "nao_atendeu"
            ? `NAO_ATENDEU: ${r.motivo}`
            : `INVALIDO: ${r.motivo}`;
      return {
        content: [{ type: "text", text: verdictText }],
        details: { status: r.status, motivo: r.motivo },
      };
    },
  });
}
