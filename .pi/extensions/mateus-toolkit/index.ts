import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import { registerControleTendencia } from "./controle-tendencia.ts";
import { registerWebFetch } from "./webfetch.ts";
import { registerWebSearch } from "./websearch.ts";
import { registerPermissionGate } from "./permission-gate.ts";
import { registerQualityMonitor } from "./quality-monitor.ts";
import { registerShellSession } from "./shell-session.ts";

/**
 * mateus-toolkit - Extensão modular
 *
 * Módulos:
 *   - controle-tendencia: create_todo, check_todo, get_todo, reforço
 *   - webfetch: busca URL e retorna texto
 *   - websearch: busca DuckDuckGo e retorna resultados
 *   - permission-gate: whitelist de comandos bash + rm dentro do cwd
 *   - quality-monitor: anti-loop, detecta respostas repetidas
 *   - shell-session: sessão bash persistente com timeout
 */

export default function (pi: ExtensionAPI) {
  log("INFO", "Extension loading");

  registerControleTendencia(pi);
  registerWebFetch(pi);
  registerWebSearch(pi);
  registerPermissionGate(pi);
  registerQualityMonitor(pi);
  registerShellSession(pi);

  log("INFO", "All modules registered");
}
