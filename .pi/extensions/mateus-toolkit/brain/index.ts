/**
 * brain/index.ts — Módulo "brain" da extensão mateus-toolkit
 *
 * Registra os tools de leitura/consulta do brain (Notion) como ferramentas
 * do pi. As funções modulares vivem em ./brain.ts (importáveis e testáveis).
 *
 * Tools registradas:
 *   - buscar_notion:   busca por texto em todos os campos e retorna
 *                      id, descricao, git, sessionId e keywords
 *   - carregar_notion: dado o id, traz o markdown completo + dados
 *
 * (brain_bootstrap e criar_page continuam desregistradas — o documentador
 *  chama criarPage diretamente.)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { buscarNotion, carregarNotion } from "./brain.ts";

export function registerBrain(pi: ExtensionAPI) {
  pi.registerTool({
    name: "buscar_notion",
    label: "Buscar Notion",
    description:
      "Busca por texto em TODOS os campos das páginas do brain (Notion): título, " +
      "propriedades, tags, git e corpo do markdown. Retorna apenas: id, descricao " +
      "(trecho do conteúdo), git, sessionId e keywords de cada página encontrada.",
    parameters: Type.Object({
      texto: Type.String({ description: "Texto a procurar nas páginas do brain" }),
    }),
    async execute(_id, params) {
      const messages: string[] = [];
      const result = buscarNotion(params.texto, { logger: (m) => messages.push(m) });
      return {
        content: [
          {
            type: "text",
            text: result.ok
              ? `Busca por "${result.query}": ${result.total} página(s).\n` +
                JSON.stringify(result.items, null, 2)
              : `Erro: ${result.message}`,
          },
        ],
        details: { ...result },
        isError: !result.ok,
      };
    },
  });

  pi.registerTool({
    name: "carregar_notion",
    label: "Carregar Notion",
    description:
      "Dado o id de uma página do brain (Notion), traz o markdown completo dela " +
      "e os dados estruturados (título, tipo, git, sessionId, keywords, status).",
    parameters: Type.Object({
      id: Type.String({ description: "Id da página no brain (retornado por buscar_notion)" }),
    }),
    async execute(_id, params) {
      const messages: string[] = [];
      const result = carregarNotion(params.id, { logger: (m) => messages.push(m) });
      return {
        content: [
          {
            type: "text",
            text: result.ok
              ? `## Markdown completo (${result.md!.length} chars)\n\n${result.md}\n\n---\n## Dados\n${JSON.stringify(result.dados, null, 2)}`
              : `Erro: ${result.message}`,
          },
        ],
        details: { ...result },
        isError: !result.ok,
      };
    },
  });
}
