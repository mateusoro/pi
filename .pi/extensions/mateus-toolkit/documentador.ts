import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, uuidv7 } from "@earendil-works/pi-ai";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { log } from "./logger.ts";
import { criarPage } from "./brain/brain.ts";

// documentador - Micro-agente documentador/entregador
//
// Igual ao juiz, mas com o papel de ENTREGAR: só inicia DEPOIS do juiz retornar
// ATENDEU. Recebe: solicitação original do usuário + plano (todo) + últimas 3
// mensagens da IA. Gera uma descrição COMPLETA em Markdown da entrega e chama
// automaticamente o criar_page (com todas as validações do brain: metadata,
// 1 página por sessão, palavras-chave indexadas).
//
// Uso:
//   1. Programático (gatilho no controle-tendencia após juiz ATENDEU): runDocumentador(ctx, {...})
//   2. Tool 'documentador' chamável pelo LLM: registerDocumentador(pi)

export interface DocumentadorInput {
  userMessage: string;
  todoText: string;
  lastAssistantMessages: string[];
}

export interface DocumentadorResult {
  ok: boolean;
  pageId: string | null;
  url: string | null;
  error?: string;
  mdPreview?: string;
}

const DOC_SYSTEM_PROMPT = `Você é o DOCUMENTADOR de entregas de um agente de coding. Você materializa o propósito final: transformar o trabalho concluído em uma anotação completa no brain (Notion).

Você recebe:
1. A solicitação original do usuário
2. O plano (todo) criado e concluído
3. As últimas 3 mensagens escritas pela IA

Sua tarefa: criar uma DESCRIÇÃO COMPLETA, em Markdown puro, da entrega realizada — que será salva automaticamente como uma página do brain.

Regras do Markdown (validações obrigatórias):
- A PRIMEIRA linha DEVE ser um título: '# <Título claro e descritivo da entrega>' (o título é o nome da página).
- NÃO use frontmatter YAML nem HTML.
- Estruture com seções usando '## ' (ex.: ## Solicitação, ## O que foi implementado, ## Evidências, ## Arquivos, ## Resultado).
- Seja específico e factual: cite dados reais do que foi feito (IDs, URLs, resultados de testes, arquivos alterados) apenas se presentes no conteúdo recebido. NUNCA invente.
- DETERMINAÇÃO DO TIPO: analise a entrega. Se o texto MENCIONAR que foi alterado um repositório (ex.: 'alterei o repositório', 'modifiquei o repo'), que foi FEITO COMMIT ('commitei', 'fiz commit') ou que foi FEITO PUSH de repositório PRÓPRIO ('pushei', 'enviei para o repositório'), o tipo é 'codigo'. Caso contrário (pesquisa, estudo, notícias, documentação sem repo próprio), o tipo é 'pesquisa'.
- Por fim, termine com DUAS linhas finais, nesta ordem:
  'Tipo: codigo' ou 'Tipo: pesquisa' (conforme a regra acima)
  'Palavras-chave: kw1, kw2, kw3, ...' (3 a 8 palavras-chave em português separadas por vírgula)

Responda APENAS com o Markdown completo, sem comentários nem texto fora dele.`;

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

/** Roda o micro-agente documentador usando o modelo ativo (ctx.model) — padrão do juiz. */
export async function runDocumentador(
  ctx: ExtensionContext,
  input: DocumentadorInput,
  opts: { background?: boolean } = {},
): Promise<DocumentadorResult> {
  if (!ctx.model) {
    return { ok: false, pageId: null, url: null, error: "Nenhum modelo ativo (ctx.model undefined)." };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, pageId: null, url: null, error: `Sem API key para ${ctx.model.provider}.` };
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

  log("INFO", "documentador: chamando modelo", { model: `${ctx.model.provider}/${ctx.model.id}` });

  let md = "";
  try {
    const response = await complete(
      ctx.model,
      { systemPrompt: DOC_SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        // em background não usa o signal do turno (seria abortado quando o chat finaliza)
        signal: opts.background ? undefined : ctx.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
        timeoutMs: 120_000,
      },
    );

    if (response.stopReason === "aborted") {
      return { ok: false, pageId: null, url: null, error: "Geração do documentador abortada." };
    }

    md = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  } catch (e) {
    log("ERROR", "documentador: chamada falhou", { error: (e as Error).message });
    return { ok: false, pageId: null, url: null, error: (e as Error).message };
  }

  // ── Validações (todas as nossas validações criadas até agora) ──
  if (!md) {
    return { ok: false, pageId: null, url: null, error: "Documentador retornou Markdown vazio." };
  }
  if (!/^#\s+.+$/m.test(md)) {
    return { ok: false, pageId: null, url: null, error: "Markdown sem H1 (título) — página não criada.", mdPreview: md.slice(0, 120) };
  }
  if (md.length < 100) {
    return { ok: false, pageId: null, url: null, error: "Descrição muito curta — página não criada.", mdPreview: md.slice(0, 120) };
  }

  // extrai o TIPO (codigo se mencionou alterar/comitar/pushar repositório próprio; senão pesquisa)
  const tipoMatch = md.match(/^Tipo:\s*(codigo|pesquisa)/im);
  const tipo: "codigo" | "pesquisa" = tipoMatch && tipoMatch[1] === "codigo" ? "codigo" : "pesquisa";

  // extrai a linha de palavras-chave e remove as linhas de controle (Tipo/Palavras-chave)
  const kwMatch = md.match(/Palavras?-?chave:\s*(.+)/i);
  const keywords = kwMatch
    ? kwMatch[1].split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  const cleanMd = md
    .replace(/^Tipo:.*(?:\r?\n|$)/im, "")
    .replace(/Palavras?-?chave:.*(?:\r?\n|$)/i, "")
    .trim();

  log("INFO", "documentador: chamando criar_page automaticamente", { tipo, keywords: keywords.join(", ") });

  // metadata real da sessão (evita n/a): session id + provider/model do ctx
  let sessionId: string | null = null;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch { /* session ephemeral pode não ter id */ }
  const metadata = {
    sessionId,
    provider: ctx.model?.provider ?? null,
    model: ctx.model?.id ?? null,
  };

  // chamada automática ao criar_page (metadata + 1 página por sessão + indexação + tipo + git da pasta atual)
  const r = criarPage(cleanMd, tipo, keywords, { metadata, cwd: ctx.cwd });
  if (!r.ok) {
    log("ERROR", "documentador: criar_page falhou", { error: r.message });
    return { ok: false, pageId: null, url: null, error: r.message, mdPreview: cleanMd.slice(0, 120) };
  }

  log("INFO", "documentador: ENTREGUE — página criada/atualizada", {
    pageId: r.pageId,
    url: r.url,
    updated: r.updated,
    keywords: keywords.join(", "),
  });
  return {
    ok: true,
    pageId: r.pageId,
    url: r.url,
    error: undefined,
    mdPreview: cleanMd.slice(0, 120),
  };
}

/** Registra a tool 'documentador' (chamável pelo LLM, no padrão do juiz). */
export function registerDocumentador(pi: ExtensionAPI) {
  pi.registerTool({
    name: "documentador",
    label: "Documentador",
    description:
      "Micro-agente documentador: cria a descrição completa (Markdown) da entrega a partir da solicitação, " +
      "do todo e das últimas mensagens da IA, e chama automaticamente o criar_page no brain. " +
      "Só deve ser usado após o juiz retornar ATENDEU.",
    parameters: Type.Object({
      user_message: Type.String({ description: "Solicitação original do usuário" }),
      todo_text: Type.String({ description: "Plano/todo criado, com o estado de cada item" }),
      last_ai_messages: Type.Array(Type.String(), { description: "Últimas mensagens escritas pela IA (máx 3)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await runDocumentador(ctx, {
        userMessage: params.user_message,
        todoText: params.todo_text,
        lastAssistantMessages: params.last_ai_messages,
      });
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `Erro no documentador: ${r.error}` }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Entrega documentada no brain.${r.url ? `\nURL: ${r.url}` : ""}`,
          },
        ],
        details: { pageId: r.pageId, url: r.url },
        isError: false,
      };
    },
  });
}
