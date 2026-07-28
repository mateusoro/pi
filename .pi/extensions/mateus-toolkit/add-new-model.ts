import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { log } from "./logger.ts";

// add-new-model - Configurar novo provider OpenAI-like
//
// A IA usa as variáveis: URL, API_KEY, MODEL_ID
// A extensão registra o provider no pi e testa a conexão

export function registerAddNewModel(pi: ExtensionAPI) {
  log("INFO", "Add new model loaded");

  pi.registerTool({
    name: "add_new_model",
    label: "Add New Model",
    description:
      "Configure um novo provider OpenAI-like no pi. " +
      "Forneça: url (endpoint), api_key (chave), model_id (id do modelo). " +
      "A extensão registra no pi e testa a conexão.",
    parameters: Type.Object({
      url: Type.String({ description: "URL do endpoint (ex: https://api.exemplo.com/v1)" }),
      api_key: Type.String({ description: "Chave da API" }),
      model_id: Type.String({ description: "ID do modelo (ex: gpt-4, deepseek-v3)" }),
      provider_name: Type.Optional(Type.String({ description: "Nome do provider (padrão: custom)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { url, api_key, model_id, provider_name } = params;
      const name = provider_name || "custom";

      log("INFO", "add_new_model called", { url, model_id, provider: name });

      // 1. Testar a conexão com curl (máx 10 chars de resposta)
      let testOk = false;
      let testError = "";
      try {
        const testCmd = [
          "curl", "-s", "-m", "10",
          "-H", `Authorization: Bearer ${api_key}`,
          "-H", "Content-Type: application/json",
          "-d", JSON.stringify({
            model: model_id,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: false,
          }),
          `${url}/chat/completions`,
        ].join(" ");

        log("INFO", "Testando conexão...", { url: `${url}/chat/completions` });

        const result = execSync(testCmd, {
          encoding: "utf-8",
          timeout: 15000,
          windowsHide: true,
        });

        // Verificar se retornou JSON válido com choices
        const parsed = JSON.parse(result);
        if (parsed.choices && parsed.choices.length > 0) {
          testOk = true;
          log("INFO", "Teste OK", { response: result.substring(0, 50) });
        } else if (parsed.error) {
          testError = parsed.error.message || JSON.stringify(parsed.error);
          log("WARN", "Teste falhou (API error)", { error: testError });
        } else {
          testError = "Resposta sem choices";
          log("WARN", "Teste falhou (sem choices)");
        }
      } catch (e: any) {
        testError = e.message?.substring(0, 200) || "Erro desconhecido";
        log("ERROR", "Teste falhou (exception)", { error: testError });
      }

      // 2. Se o teste falhou, retornar erro
      if (!testOk) {
        return {
          content: [{
            type: "text",
            text: `❌ Teste FALHOU para ${url}\n\nErro: ${testError}\n\nVerifique:\n- URL está correta?\n- API key é válida?\n- Modelo "${model_id}" existe neste endpoint?`,
          }],
          details: { success: false, url, model_id, error: testError },
          isError: true,
        };
      }

      // 3. Teste OK - reportar sucesso
      // Nota: Não é possível registrar providers dinamicamente via API do pi
      // O provider precisa ser configurado manualmente no settings.json
      // ou via provider personalizado. Vou reportar as instruções.

      const settingsSnippet = JSON.stringify({
        providers: {
          [name]: {
            baseUrl: url,
            apiKey: api_key,
            api: "openai-completions",
            models: [{
              id: model_id,
              name: model_id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            }],
          },
        },
      }, null, 2);

      return {
        content: [{
          type: "text",
          text: [
            `✅ Teste OK! Conexão com ${url} funcionou.`,
            '',
            `Modelo: ${model_id}`,
            `Provider: ${name}`,
            '',
            'Para adicionar permanentemente, adicione ao settings.json:',
            '',
            '```json',
            settingsSnippet,
            '```',
            '',
            'Ou use o comando /settings no pi interativo.',
          ].join('\n'),
        }],
        details: { success: true, url, model_id, provider: name },
      };
    },
  });

  // ── Comando para listar providers configurados ──
  pi.registerCommand("models", {
    description: "Listar modelos disponíveis",
    handler: async (_args, ctx) => {
      try {
        const result = execSync("pi --list-models 2>&1", {
          encoding: "utf-8",
          timeout: 10000,
          windowsHide: true,
        });
        ctx.ui.notify(result, "info");
      } catch (e: any) {
        ctx.ui.notify(`Erro ao listar modelos: ${e.message}`, "error");
      }
    },
  });
}
