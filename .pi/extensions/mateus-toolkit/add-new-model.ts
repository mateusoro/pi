import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.ts";

// add-new-model - Configurar novo provider OpenAI-like
//
// Testa com curl, registra com pi.registerProvider() e salva para persistência

const PROVIDERS_FILE = join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent", "providers.json");

interface SavedProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
}

function loadSavedProviders(): SavedProvider[] {
  if (!existsSync(PROVIDERS_FILE)) return [];
  try {
    const raw = readFileSync(PROVIDERS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveProvider(provider: SavedProvider) {
  const providers = loadSavedProviders();
  const idx = providers.findIndex((p) => p.name === provider.name);
  if (idx >= 0) {
    providers[idx] = provider;
  } else {
    providers.push(provider);
  }
  writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2), "utf-8");
  log("INFO", "Provider salvo em providers.json", { name: provider.name });
}

function registerProviderFromConfig(pi: ExtensionAPI, provider: SavedProvider) {
  try {
    pi.registerProvider(provider.name, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      api: provider.api as any,
      models: provider.models,
    });
    log("INFO", "Provider registrado via pi.registerProvider", { name: provider.name });
  } catch (e: any) {
    log("WARN", "Falha ao registrar provider", { name: provider.name, error: e.message });
  }
}

// Registrar todos os providers salvos (chamado no startup)
export function registerAllSavedProviders(pi: ExtensionAPI) {
  const providers = loadSavedProviders();
  for (const p of providers) {
    registerProviderFromConfig(pi, p);
  }
}

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
      context_window: Type.Optional(Type.Number({ description: "Tamanho da janela de contexto em tokens (padrão: 128000)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { url, api_key, model_id, provider_name, context_window } = params;
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

      // 3. Teste OK - registrar provider e salvar para persistência
      const providerConfig: SavedProvider = {
        name,
        baseUrl: url,
        apiKey: api_key,
        api: "openai-completions",
        models: [{
          id: model_id,
          name: model_id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: context_window || 256000,
          maxTokens: 4096,
        }],
      };

      // Registrar imediatamente na sessão atual
      registerProviderFromConfig(pi, providerConfig);

      // Salvar para persistência (carregado no próximo startup)
      saveProvider(providerConfig);

      return {
        content: [{
          type: "text",
          text: [
            `✅ Provider "${name}" adicionado com sucesso!`,
            '',
            `URL: ${url}`,
            `Modelo: ${model_id}`,
            `Resposta: "${testOutput}"`,
            '',
            `O provider já está disponível nesta sessão.`,
            `Para usar em sessões futuras, reinicie o pi.`,
          ].join('\n'),
        }],
        details: { success: true, url, model_id, provider: name, response: testOutput, config: providerConfig },
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
