// youtube.ts — Intermediador YouTube (buscar vídeo → extrair legenda)
//
// Chama o python youtube-tools/youtube_tools.py (baseado em yt-dlp) via execFile
// e devolve o resultado ao LLM. Fluxo padrão (como websearch → webfetch):
//   1. youtube_search:      busca vídeos por termo → retorna resultados com url
//   2. youtube_transcript:  extrai a legenda de um vídeo (url ou id)
//
// Requisitos: python com yt-dlp e youtube-transcript-api instalados
// (verificado: Python 3.13.12, yt-dlp 2026.03.17, youtube-transcript-api ok).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "youtube-tools", "youtube_tools.py");

interface PythonResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Executa o python com argumentos e retorna stdout/stderr (timeout e maxBuffer altos). */
function runPython(args: string[], timeoutMs: number): Promise<PythonResult> {
  return new Promise((resolve) => {
    execFile(
      "python",
      [SCRIPT, ...args],
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** Tenta JSON.parse do stdout; retorna null se não for JSON. */
function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function registerYouTube(pi: ExtensionAPI) {
  log("INFO", "YouTube module loaded");

  // ── youtube_search: buscar vídeos ──
  pi.registerTool({
    name: "youtube_search",
    label: "YouTube Search",
    description:
      "Busca vídeos no YouTube por termo (ex.: 'como resolver erro X') e retorna os " +
      "resultados com título, url, duração, views e canal. Use o url de um resultado " +
      "depois com youtube_transcript para extrair a legenda do vídeo.",
    parameters: Type.Object({
      query: Type.String({ description: "Termo de busca" }),
      max: Type.Optional(
        Type.Integer({ description: "Máximo de resultados (padrão 5, máx 10)", default: 5 }),
      ),
    }),
    async execute(_id, params) {
      const max = Math.min(Math.max(params.max ?? 5, 1), 10);
      log("INFO", "youtube_search called", { query: params.query, max });
      const r = await runPython(["search-videos", params.query, "-m", String(max)], 120_000);
      if (!r.ok) {
        log("ERROR", "youtube_search failed", { stderr: r.stderr.slice(0, 300) });
        return {
          content: [{ type: "text", text: `Erro: ${r.stderr || r.stdout}` }],
          details: {},
          isError: true,
        };
      }
      const data = parseJson(r.stdout);
      if (!Array.isArray(data)) {
        return {
          content: [{ type: "text", text: `Resposta não parseável:\n${r.stdout.slice(0, 500)}` }],
          details: {},
          isError: true,
        };
      }
      const compact = data.map((v: any) => ({
        id: v.id,
        title: v.title,
        url: v.url,
        duration: v.duration,
        view_count: v.view_count,
        channel: v.channel,
        upload_date: v.upload_date,
      }));
      log("INFO", "youtube_search done", { results: compact.length });
      return {
        content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
        details: { total: compact.length },
      };
    },
  });

  // ── youtube_transcript: extrair legenda ──
  pi.registerTool({
    name: "youtube_transcript",
    label: "YouTube Transcript",
    description:
      "Extrai a legenda/transcrição de um vídeo do YouTube (URL completa ou só o id). " +
      "Retorna o texto completo da transcrição — use para resolver o problema com o " +
      "conteúdo exato dito no vídeo.",
    parameters: Type.Object({
      url: Type.String({ description: "URL do vídeo (ex.: https://www.youtube.com/watch?v=ID) ou só o ID" }),
      lang: Type.Optional(
        Type.String({ description: "Idioma da legenda (padrão pt-BR; use 'all' para qualquer)", default: "pt-BR" }),
      ),
    }),
    async execute(_id, params) {
      const lang = params.lang ?? "pt-BR";
      log("INFO", "youtube_transcript called", { url: params.url.slice(0, 80), lang });
      const r = await runPython(["transcript", params.url, "-l", lang], 180_000);
      if (!r.ok) {
        log("ERROR", "youtube_transcript failed", { stderr: r.stderr.slice(0, 300) });
        return {
          content: [{ type: "text", text: `Erro: ${r.stderr || r.stdout}` }],
          details: {},
          isError: true,
        };
      }
      const data = parseJson(r.stdout) as { code?: number; text?: string; error?: string } | null;
      if (!data) {
        return {
          content: [{ type: "text", text: `Resposta não parseável:\n${r.stdout.slice(0, 500)}` }],
          details: {},
          isError: true,
        };
      }
      if (data.code !== 0) {
        return {
          content: [{ type: "text", text: `Não foi possível extrair a legenda: ${data.error ?? "sem motivo"}` }],
          details: {},
          isError: true,
        };
      }
      const text = data.text ?? "";
      log("INFO", "youtube_transcript done", { chars: text.length });
      return {
        content: [{ type: "text", text: text.slice(0, 25_000) + (text.length > 25_000 ? "\n…(truncado)" : "") }],
        details: { chars: text.length },
      };
    },
  });
}
