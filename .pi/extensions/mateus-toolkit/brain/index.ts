/**
 * brain/index.ts — Módulo "brain" da extensão mateus-toolkit
 *
 * Registra os tools do brain como ferramentas do pi.
 * As funções modulares vivem em ./brain.ts (importáveis e testáveis via node).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ensureBrain, criarPage, BRAIN_PAGE, BRAIN_DB, BRAIN_DS } from "./brain.ts";

export function registerBrain(pi: ExtensionAPI) {
  pi.registerTool({
    name: "brain_bootstrap",
    label: "Brain Bootstrap",
    description:
      `Garante o brain no Notion via ntn CLI (idempotente): página "${BRAIN_PAGE}" ` +
      `+ database "${BRAIN_DB}" + indexador "${BRAIN_DS}". Se não estiver logado, ` +
      "abre um terminal novo para `ntn login`.",
    parameters: Type.Object({
      dry: Type.Optional(
        Type.Boolean({ description: "Simula sem criar nada (read-only)" }),
      ),
      checkOnly: Type.Optional(
        Type.Boolean({ description: "Só verifica login + existência (read-only)" }),
      ),
    }),
    async execute(_id, params) {
      const messages: string[] = [];
      const result = ensureBrain({
        dry: params?.dry ?? false,
        checkOnly: params?.checkOnly ?? false,
        logger: (m) => messages.push(m),
      });
      return {
        content: [{ type: "text", text: messages.join("\n") }],
        details: { ...result },
        isError: !result.loggedIn,
      };
    },
  });

  pi.registerTool({
    name: "criar_page",
    label: "Criar Page (Brain)",
    description:
      `Cria uma página no brain do Notion (indexador "${BRAIN_DS}" da página "${BRAIN_PAGE}"). ` +
      "Recebe o Markdown text-only e o sistema processa o restante (título do primeiro H1). " +
      "Parâmetro tipo: \"pesquisa\" (1 página por sessão do pi — o session é o id da pesquisa; " +
      "se a sessão já tem anotação, ANEXA o novo conteúdo no final da página existente em vez de criar) " +
      "ou \"codigo\" " +
      "(extrai a URL do git do markdown; se essa URL já tem anotação no brain, ATUALIZA a página existente; senão cria).",
    parameters: Type.Object({
      md: Type.String({
        description: "Markdown text-only do conteúdo da página (o título será o primeiro H1)",
      }),
      tipo: Type.Union(
        [
          Type.Literal("pesquisa", {
            description: "1 página por sessão do pi (session = id da pesquisa); se já existe, anexa no final",
          }),
          Type.Literal("codigo", {
            description: "Valida o git do markdown e atualiza a anotação existente no brain se houver",
          }),
        ],
        { default: "pesquisa" },
      ),
      palavrasChave: Type.Optional(
        Type.Array(
          Type.String({ description: "Palavra-chave/tag para indexar pesquisas e códigos semelhantes" }),
          { description: "Palavras-chave indexadas na propriedade Tags do índice" },
        ),
      ),
    }),
    async execute(_id, params) {
      const messages: string[] = [];
      const result = criarPage(params.md, params.tipo ?? "pesquisa", params.palavrasChave ?? [], {
        logger: (m) => messages.push(m),
      });
      return {
        content: [
          {
            type: "text",
            text:
              result.message +
              (result.url ? `\nURL: ${result.url}` : "") +
              (result.gitUrl ? `\nGit: ${result.gitUrl}` : "") +
              (result.updated ? "\n(anotação atualizada)" : ""),
          },
        ],
        details: { ...result },
        isError: !result.ok,
      };
    },
  });
}
