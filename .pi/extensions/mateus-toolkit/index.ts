import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import { registerControleTendencia } from "./controle-tendencia.ts";
import { registerWebFetch } from "./webfetch.ts";
import { registerWebSearch } from "./websearch.ts";
import { registerPermissionGate } from "./permission-gate.ts";
import { registerQualityMonitor } from "./quality-monitor.ts";
import { registerShellSession } from "./shell-session.ts";
import { registerAddNewModel, registerAllSavedProviders } from "./add-new-model.ts";
import { registerLmStudioProvider } from "./lmstudio-provider.ts";

/**
 * mateus-toolkit - Extensão modular
 *
 * Módulos:
 *   - controle-tendencia: create_todo, check_todo, get_todo, reforço
 *   - webfetch: busca URL e retorna texto
 *   - websearch: busca DuckDuckGo e retorna resultados
 *   - permission-gate: deny-list de comandos perigosos
 *   - quality-monitor: anti-loop, detecta respostas repetidas
 *   - shell-session: sessão bash persistente com timeout
 *   - add-new-model: configurar provider OpenAI-like
 *   - lmstudio-provider:provider local do LM Studio
 */

export default async function (pi: ExtensionAPI) {
  log("INFO", "Extension loading");

  registerControleTendencia(pi);
  registerWebFetch(pi);
  registerWebSearch(pi);
  registerPermissionGate(pi);
  registerQualityMonitor(pi);
  registerShellSession(pi);
  registerAddNewModel(pi);
  registerAllSavedProviders(pi); // Carrega providers salvos do providers.json
  await registerLmStudioProvider(pi);

  log("INFO", "All modules registered");
}
