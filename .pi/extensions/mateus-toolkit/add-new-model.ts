import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.ts";

// add-new-model - Configurar novo provider OpenAI-like
//
// Testa com curl primeiro, depois fornece config pro settings.json

export function registerAddNewModel(pi: ExtensionAPI) {
  log("INFO", "Add new model loaded");

  pi.registerTool({
    name: "add_new_model",
    label: "Add New Model",
    description:
      "Configure um novo provider OpenAI-like no pi. " +
      "Forneça: url, api_key, model_id. Testa com curl e retorna config.",
    parameters: Type.Object({
      url: Type.String({ description: "URL do endpoint (ex: https://api.exemplo.com/v1)" }),
      api_key: Type.String({ description: "Chave da API" }),
      model_id: Type.String({ description: "ID do modelo (ex: gpt-4, qwen3.7-plus)" }),
      provider_name: Type.Optional(Type.String({ description: "Nome do provider (padrão: custom)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { url, api_key, model_id, provider_name } = params;
      const name = provider_name || "custom";

      log("INFO", "add_new_model called", { url, model_id, provider: name, keyLen: api_key.length, keyStart: api_key.substring(0, 10) });

      // 1. Testar com curl
      let testOk = false;
      let testOutput = "";
      let testError = "";

      const body = JSON.stringify({
        model: model_id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        stream: false,
      });

      // Montar URL correta (evitar duplicar /chat/completions)
      let endpoint = url.trim();
      if (!endpoint.endsWith("/chat/completions")) {
        if (!endpoint.endsWith("/")) endpoint += "/";
        endpoint += "chat/completions";
      }

      // Usar arquivo temporário pra evitar problemas com escaping no PowerShell
      const tmpFile = join(process.env.TEMP || process.env.TMP || ".", "pi-test-body.json");
      writeFileSync(tmpFile, body, "utf-8");
      log("INFO", "Temp file criado", { tmpFile, bodyLen: body.length });

      const testCmd = `curl -s -m 15 -H "Authorization: Bearer ${api_key}" -H "Content-Type: application/json" -d @${tmpFile} ${endpoint}`;
      log("INFO", "Testando com curl...", { url: endpoint });

      try {
        log("INFO", "Executando curl...");
        const result = execSync(testCmd, {
          encoding: "utf-8",
          timeout: 20000,
          windowsHide: true,
        });
        log("INFO", "Curl retornou", { len: result.length, preview: result.substring(0, 100) });

        const parsed = JSON.parse(result);

        if (parsed.choices && parsed.choices.length > 0) {
          testOk = true;
          testOutput = parsed.choices[0].message?.content || "(sem conteúdo)";
          log("INFO", "Teste OK", { response: testOutput.substring(0, 50) });
        } else if (parsed.error) {
          testError = parsed.error.message || JSON.stringify(parsed.error);
          log("WARN", "Teste falhou (API error)", { error: testError });
        } else {
          testError = "Resposta sem choices: " + result.substring(0, 200);
          log("WARN", "Teste falhou (sem choices)");
        }
      } catch (e: any) {
        testError = e.message?.substring(0, 300) || "Erro desconhecido";
        log("ERROR", "Teste falhou (exception)", { error: testError });
      } finally {
        try { unlinkSync(tmpFile); } catch {}
      }

      // 2. Se o teste falhou, retornar erro
      if (!testOk) {
        return {
          content: [{
            type: "text",
            text: `❌ Teste FALHOU\n\nModelo: ${model_id}\nURL: ${url}\n\nErro:\n${testError}\n\nVerifique:\n- URL está correta?\n- API key é válida?\n- Modelo "${model_id}" existe neste endpoint?`,
          }],
          details: { success: false, url, model_id, error: testError },
          isError: true,
        };
      }

      // 3. Teste OK - gerar config do settings.json
      const config = {
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
      };

      const settingsPath = `${process.env.USERPROFILE || process.env.HOME}/.pi/agent/settings.json`;

      return {
        content: [{
          type: "text",
          text: [
            `✅ Teste OK! Modelo ${model_id} funcionou.`,
            '',
            `URL: ${url}`,
            `Provider: ${name}`,
            `Resposta: "${testOutput}"`,
            '',
            'Para adicionar, edite settings.json:',
            '',
            '```json',
            JSON.stringify({ providers: config }, null, 2),
            '```',
            '',
            `Ou use /settings no pi interativo.`,
          ].join('\n'),
        }],
        details: { success: true, url, model_id, provider: name, response: testOutput, config },
      };
    },
  });

  // ── Comando /models ──
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
        ctx.ui.notify(`Erro: ${e.message}`, "error");
      }
    },
  });
}
