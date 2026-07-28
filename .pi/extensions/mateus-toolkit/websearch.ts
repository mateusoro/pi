import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { log } from "./logger.ts";

export function registerWebSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "WebSearch",
    description: "Busca na web via DuckDuckGo e retorna os top ~8 resultados como Markdown.",
    parameters: Type.Object({
      query: Type.String({ description: "Termo de busca" }),
    }),
    async execute(_id, { query }) {
      log("INFO", "websearch called", { query });
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = await res.text();

        const titleRe = /class="result__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/g;

        const titles: Array<{ link: string; title: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = titleRe.exec(body)) && titles.length < 8) {
          titles.push({ link: m[1], title: m[2].replace(/<[^>]+>/g, "").trim() });
        }
        const snippets: string[] = [];
        while ((m = snippetRe.exec(body)) && snippets.length < 8) {
          snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
        }

        if (titles.length === 0) {
          log("INFO", "websearch: no results");
          return { content: [{ type: "text", text: "Nenhum resultado encontrado" }], details: {} };
        }

        const out = titles
          .map((t, i) => `**${t.title}**\n${t.link}\n${snippets[i] ?? ""}`)
          .join("\n\n");

        log("INFO", "websearch done", { results: titles.length });
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e) {
        log("ERROR", "websearch failed", { error: (e as Error).message });
        return {
          content: [{ type: "text", text: `Erro: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
