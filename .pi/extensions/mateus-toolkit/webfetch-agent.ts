import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { log } from "./logger.ts";

// webfetch-agent - Busca uma URL e usa um micro-agente para analisar o conteúdo
//
// Fluxo:
//   1. Tool recebe: url (obrigatório), prompt (obrigatório), detail (small|medium|large)
//   2. Internamente faz o fetch da URL (mesma lógica do webfetch.ts)
//   3. Monta o system prompt do micro-agente conforme o detail
//   4. Chama o modelo atual (ctx.model) com o conteúdo + prompt do usuário
//   5. Retorna a análise do micro-agente ao LLM principal

const DEFAULT_DETAIL = "medium";

const BASE_SYSTEM_PROMPT =
  "Você é um micro-agente analisador de conteúdo web. " +
  "Analise o conteúdo extraído da página informada e responda ao pedido do usuário " +
  "com base SOMENTE no conteúdo fornecido. " +
  "Se a informação não estiver presente no conteúdo, diga explicitamente que não está disponível. " +
  "Não invente fatos nem dados que não estejam no conteúdo.";

const DETAIL_GUIDANCE: Record<string, string> = {
  small:
    "Nível de detalhamento: SMALL — responda de forma curta e objetiva (máximo ~100 palavras), " +
    "apenas o essencial, sem rodeios.",
  medium:
    "Nível de detalhamento: MEDIUM — responda de forma detalhada (até ~300 palavras), " +
    "cobrindo os pontos principais com um pouco de contexto.",
  large:
    "Nível de detalhamento: LARGE — faça uma análise completa e aprofundada, sem limite de tamanho, " +
    "cobrindo todos os detalhes relevantes, com estrutura clara (seções/listas quando fizer sentido).",
};

function buildSystemPrompt(detail: string): string {
  const guidance = DETAIL_GUIDANCE[detail] ?? DETAIL_GUIDANCE[DEFAULT_DETAIL];
  return `${BASE_SYSTEM_PROMPT}\n\n${guidance}`;
}

async function fetchPageText(url: string): Promise<{ text: string; error?: undefined } | { text?: undefined; error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      headers: { "User-Agent": "mateus-toolkit/1.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { error: `HTTP ${res.status} ${res.statusText}` };
    }
    const ct = res.headers.get("content-type") || "";
    let text = await res.text();
    if (ct.includes("html")) {
      text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      text = text.replace(/<[^>]+>/g, " ");
      text = text.replace(/\s+/g, " ").trim();
    }
    if (text.length > 25_000) text = text.slice(0, 25_000);
    return { text };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function registerWebFetchAgent(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch_agent",
    label: "WebFetch Agent",
    description:
      "Busca uma URL e um micro-agente analisa o conteúdo conforme o prompt informado, " +
      "com nível de detalhamento configurável (small|medium|large).",
    parameters: Type.Object({
      url: Type.String({ description: "URL completa (http:// ou https://)" }),
      prompt: Type.String({
        description: "Pergunta/instrução sobre o conteúdo que o micro-agente deve responder",
      }),
      detail: Type.Optional(
        StringEnum(["small", "medium", "large"], {
          default: DEFAULT_DETAIL,
          description:
            "Nível de detalhamento da análise: small = resumo curto (~100 palavras), " +
            "medium = detalhado (~300 palavras), large = análise completa e aprofundada",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { url, prompt } = params;
      const detail: string = params.detail ?? DEFAULT_DETAIL;

      log("INFO", "webfetch_agent called", { url, promptLen: prompt.length, detail });

      // 1. Fetch interno (mesma lógica do webfetch.ts)
      const page = await fetchPageText(url);
      if (page.error !== undefined) {
        log("ERROR", "webfetch_agent fetch failed", { error: page.error });
        return {
          content: [{ type: "text", text: `Erro ao buscar a URL: ${page.error}` }],
          details: {},
          isError: true,
        };
      }
      log("INFO", "webfetch_agent fetch done", { chars: page.text.length });

      // 2. Precisa de um modelo para o micro-agente
      if (!ctx.model) {
        return {
          content: [{ type: "text", text: "Nenhum modelo ativo para o micro-agente (ctx.model undefined)." }],
          details: {},
          isError: true,
        };
      }

      // 3. Resolve auth do modelo atual
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        const reason = auth.ok ? `Sem API key para ${ctx.model.provider}` : auth.error;
        log("ERROR", "webfetch_agent auth failed", { reason });
        return {
          content: [{ type: "text", text: `Falha de autenticação do micro-agente: ${reason}` }],
          details: {},
          isError: true,
        };
      }

      // 4. Monta system prompt conforme detail + mensagem do usuário
      const systemPrompt = buildSystemPrompt(detail);
      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: `## Pedido do usuário\n${prompt}\n\n## URL analisada\n${url}\n\n## Conteúdo extraído da página\n${page.text}`,
          },
        ],
        timestamp: Date.now(),
      };

      // 5. Chama o micro-agente (modelo atual)
      log("INFO", "webfetch_agent calling model", { model: `${ctx.model.provider}/${ctx.model.id}`, detail });
      try {
        const response = await complete(
          ctx.model,
          { systemPrompt, messages: [userMessage] },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            signal: signal ?? ctx.signal,
            cacheRetention: "none",
            sessionId: uuidv7(),
            timeoutMs: 120_000,
          },
        );

        if (response.stopReason === "aborted") {
          return {
            content: [{ type: "text", text: "Análise cancelada (abortada)." }],
            details: {},
            isError: true,
          };
        }

        const answer = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();

        log("INFO", "webfetch_agent done", { answerLen: answer.length });
        return {
          content: [
            {
              type: "text",
              text: [
                `[webfetch_agent — ${url}]`,
                `URL: ${url}`,
                `Prompt: ${prompt}`,
                `Detail: ${detail}`,
                `---`,
                answer,
              ].join("\n"),
            },
          ],
          details: { url, prompt, detail },
        };
      } catch (e) {
        log("ERROR", "webfetch_agent model call failed", { error: (e as Error).message });
        return {
          content: [{ type: "text", text: `Erro na chamada do micro-agente: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
