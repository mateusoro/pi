import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";

// LM Studio provider - registra modelos locais do LM Studio

export async function registerLmStudioProvider(pi: ExtensionAPI) {
  log("INFO", "Registering LM Studio provider");

  try {
    const response = await fetch("http://localhost:1234/v1/models");
    const payload = await response.json() as {
      data: Array<{
        id: string;
        name?: string;
      }>;
    };

    const models = payload.data
      .filter((m) => m.id !== "text-embedding-nomic-embed-text-v1.5")
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      }));

    // Registrar provider com auth API key que não requer login
    pi.registerProvider("lmstudio", {
      name: "LM Studio",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      api: "openai-completions",
      models,
    });

    log("INFO", "LM Studio provider registered", { models: models.map((m) => m.id) });
  } catch (e: any) {
    log("ERROR", "Failed to register LM Studio provider", { error: e.message });
  }
}
