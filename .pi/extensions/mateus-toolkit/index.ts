import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import { registerControleTendencia } from "./controle-tendencia.ts";
import { registerWebFetch } from "./webfetch.ts";
import { registerWebFetchAgent } from "./webfetch-agent.ts";
import { registerWebSearch } from "./websearch.ts";
import { registerPermissionGate } from "./permission-gate.ts";
import { registerQualityMonitor } from "./quality-monitor.ts";
import { registerShellSession } from "./shell-session.ts";
import { registerAddNewModel } from "./add-new-model.ts";

/**
 * mateus-toolkit - Extensão modular
 *
 * Módulos:
 *   - controle-tendencia: create_todo, check_todo, get_todo, reforço
 *   - webfetch: busca URL e retorna texto
 *   - webfetch-agent: busca URL e um micro-agente analisa conforme prompt/detail
 *   - websearch: busca DuckDuckGo e retorna resultados
 *   - permission-gate: deny-list de comandos perigosos
 *   - quality-monitor: anti-loop, detecta respostas repetidas
 *   - shell-session: sessão bash persistente com timeout
 *   - add-new-model: configurar provider OpenAI-like
 */

export default async function (pi: ExtensionAPI) {
  log("INFO", "Extension loading");

  registerControleTendencia(pi);
  registerWebFetch(pi);
  registerWebFetchAgent(pi);
  registerWebSearch(pi);
  registerPermissionGate(pi);
  registerQualityMonitor(pi);
  registerShellSession(pi);
  registerAddNewModel(pi);

  log("INFO", "All modules registered");
}
