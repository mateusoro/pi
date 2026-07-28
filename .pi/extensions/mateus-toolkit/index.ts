import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import { registerControleTendencia } from "./controle-tendencia.ts";
import { registerWebFetch } from "./webfetch.ts";
import { registerWebSearch } from "./websearch.ts";

/**
 * mateus-toolkit - Extensão modular
 *
 * Módulos:
 *   - controle-tendencia: create_todo, check_todo, get_todo, reforço
 *   - webfetch: busca URL e retorna texto
 *   - websearch: busca DuckDuckGo e retorna resultados
 */

export default function (pi: ExtensionAPI) {
  log("INFO", "Extension loading");

  registerControleTendencia(pi);
  registerWebFetch(pi);
  registerWebSearch(pi);

  log("INFO", "All modules registered");
}
