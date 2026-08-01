import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import { registerControleTendencia } from "./controle-tendencia.ts";
import { registerWebFetch } from "./webfetch.ts";
import { registerWebFetchAgent } from "./webfetch-agent.ts";
import { registerJuiz } from "./juiz.ts";
import { registerWebSearch } from "./websearch.ts";
import { registerPermissionGate } from "./permission-gate.ts";
import { registerQualityMonitor } from "./quality-monitor.ts";
import { registerShellSession } from "./shell-session.ts";
import { registerAddNewModel } from "./add-new-model.ts";
import { registerBrain } from "./brain/index.ts";
import { registerYouTube } from "./youtube.ts";

/**
 * mateus-toolkit - Extensão modular
 *
 * Módulos:
 *   - controle-tendencia: create_todo, check_todo, get_todo, reforço
 *   - webfetch: busca URL e retorna texto
 *   - webfetch-agent: busca URL e um micro-agente analisa conforme prompt/detail
 *   - juiz: micro-agente que julga se a entrega atendeu ao pedido (roda quando todo 100%)
 *   - websearch: busca DuckDuckGo e retorna resultados
 *   - permission-gate: deny-list de comandos perigosos
 *   - quality-monitor: anti-loop, detecta respostas repetidas
 *   - shell-session: sessão bash persistente com timeout
 *   - add-new-model: configurar provider OpenAI-like
 *   - brain: MegaBrains no Notion via ntn CLI (tools buscar_notion/carregar_notion;
 *     brain_bootstrap/criar_page desregistradas — o documentador usa criarPage direto)
 *   - youtube: intermediador TS→python (youtube-tools): buscar vídeo e extrair legenda
 */

export default async function (pi: ExtensionAPI) {
  log("INFO", "Extension loading");

  registerControleTendencia(pi);
  registerWebFetch(pi);
  registerWebFetchAgent(pi);
  registerJuiz(pi);
  registerWebSearch(pi);
  registerPermissionGate(pi);
  registerQualityMonitor(pi);
  registerShellSession(pi);
  registerAddNewModel(pi);
  registerBrain(pi);
  registerYouTube(pi);

  log("INFO", "All modules registered");
}
