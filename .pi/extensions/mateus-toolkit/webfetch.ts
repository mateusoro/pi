import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { log } from "./logger.ts";

export function registerWebFetch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "WebFetch",
    description: "Busca uma URL e retorna conteúdo em texto (HTML removido). Máx 25K chars.",
    parameters: Type.Object({
      url: Type.String({ description: "URL completa (http:// ou https://)" }),
      prompt: Type.Optional(Type.String({ description: "Dica do que extrair (informativo)" })),
    }),
    async execute(_id, { url }) {
      log("INFO", "webfetch called", { url });
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
          return {
            content: [{ type: "text", text: `Erro: HTTP ${res.status} ${res.statusText}` }],
            details: {},
            isError: true,
          };
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
        log("INFO", "webfetch done", { chars: text.length });
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        log("ERROR", "webfetch failed", { error: (e as Error).message });
        return {
          content: [{ type: "text", text: `Erro: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
