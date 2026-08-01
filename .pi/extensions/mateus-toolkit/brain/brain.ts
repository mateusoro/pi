/**
 * brain.ts — MegaBrains bootstrap (Notion via ntn CLI)
 *
 * Módulo da extensão "brain" (dentro do mateus-toolkit).
 * Funções exportadas (modulares):
 *   - isLoggedIn(): verifica se o ntn está logado (ntn whoami)
 *   - openLoginTerminal(): abre um terminal novo rodando `ntn login`
 *   - ensureBrain(): garante página "MateusNotion" + database "Brain" + indexador "Indice"
 *   - ensurePage() / ensureDatabase() / ensureDataSource(): passos individuais
 *
 * Uso standalone (sem o pi):
 *   node brain.ts            # executa o bootstrap completo
 *   node brain.ts --dry      # mostra o que faria sem criar nada
 *   node brain.ts --check    # só verifica login + existência (read-only)
 *
 * Uso como módulo (extensão do pi): importar as funções e registrá-las em index.ts.
 *
 * Requer: node >= 22.18 (type stripping) e ntn instalado e no PATH.
 */

import { execSync, spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ===== Configuração do brain =====
export const BRAIN_PAGE = "MateusNotion"; // página mãe do brain (workspace root)
export const BRAIN_DB = "Brain";          // database (container) dentro da página mãe
export const BRAIN_DS = "Indice";         // data source (indexador) dentro do database
const LOGIN_CMD = "ntn login";            // comando real de autenticação (o correto é login)

export interface BrainResult {
  loggedIn: boolean;
  pageId: string | null;
  dbId: string | null;
  dsId: string | null;
  createdPage: boolean;
  createdDb: boolean;
  createdDs: boolean;
}

export interface BrainOptions {
  dry?: boolean;
  checkOnly?: boolean;
  logger?: (msg: string) => void;
}

// ===== Helpers =====

function run(cmd: string, json = false): string {
  return execSync(cmd + (json ? " --json" : ""), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJsonTemp(obj: unknown): string {
  const file = join(tmpdir(), `brain-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

function apiPost(path: string, body: unknown): string {
  return apiCall("POST", path, body);
}

function apiCall(method: string, path: string, body: unknown): string {
  const file = writeJsonTemp(body);
  try {
    // sintaxe correta do ntn api: <path> + -X <METHOD> + -d @file (retorna JSON puro)
    let cleanPath = path.replace(/^\/+/, "");
    if (!cleanPath.startsWith("v1/")) cleanPath = "v1/" + cleanPath;
    return run(`ntn api ${cleanPath} -X ${method} -d @${file}`);
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

// ===== 1. Login (módulo) =====

export function isLoggedIn(): boolean {
  try {
    const out = run("ntn whoami");
    return out.length > 0;
  } catch {
    return false;
  }
}

export function openLoginTerminal(): void {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "cmd", "/k", LOGIN_CMD], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else if (platform === "darwin") {
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${LOGIN_CMD}"`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    try {
      spawn("x-terminal-emulator", ["-e", "bash", "-lc", LOGIN_CMD], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {
      spawn("gnome-terminal", ["--", "bash", "-lc", LOGIN_CMD], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  }
}

// ===== 2. Página mãe / busca =====

// extrai o título de um resultado de busca (novo modelo: properties.title; antigo: title)
function resultTitle(r: {
  properties?: Record<string, { title?: Array<{ plain_text?: string }> }>;
  title?: Array<{ plain_text?: string }>;
}): string {
  const viaProps = r.properties?.title?.title?.map((t) => t.plain_text ?? "").join("") ?? "";
  if (viaProps) return viaProps;
  return r.title?.map((t) => t.plain_text ?? "").join("") ?? "";
}

export function findPageByTitle(title: string): string | null {
  const out = apiPost("search", { query: title });
  const data = JSON.parse(out) as {
    results?: Array<{ object: string; id: string } & Parameters<typeof resultTitle>[0]>;
  };
  for (const r of data.results ?? []) {
    if (r.object !== "page") continue;
    if (resultTitle(r) === title) return r.id;
  }
  return null;
}

// A busca do Notion (novo modelo 2025-09-03) retorna objetos `data_source`
// (nunca `database`), com `database_parent.page_id` e `parent.database_id`.
export function findDataSourceUnder(
  pageId: string,
  dsTitle: string,
): { dsId: string; databaseId: string } | null {
  const out = apiPost("search", { query: dsTitle });
  const data = JSON.parse(out) as {
    results?: Array<{
      object: string;
      id: string;
      database_parent?: { page_id?: string };
      parent?: { database_id?: string };
    } & Parameters<typeof resultTitle>[0]>;
  };
  for (const r of data.results ?? []) {
    if (r.object !== "data_source") continue;
    if (r.database_parent?.page_id !== pageId) continue;
    if (resultTitle(r) !== dsTitle) continue;
    const databaseId = r.parent?.database_id;
    if (!databaseId) continue;
    return { dsId: r.id, databaseId };
  }
  return null;
}

// Lista os data sources de um database via `ntn datasources resolve --json`
// (chamada direta à API — NÃO sofre lag de indexação como o search).
export function listDataSources(databaseId: string): Array<{ id: string; name: string }> {
  try {
    const out = run(`ntn datasources resolve ${databaseId}`, true); // --json
    const data = JSON.parse(out) as { data_sources?: Array<{ id: string; name: string }> };
    return data.data_sources ?? [];
  } catch {
    return [];
  }
}

// ===== Criações (módulos) =====

export function createWorkspacePage(title: string): string {
  const body = {
    parent: { type: "workspace", workspace: true },
    properties: { title: { title: [{ text: { content: title } }] } },
  };
  const out = apiPost("pages", body);
  return (JSON.parse(out) as { id: string }).id;
}

export function createDatabase(pageId: string, title: string): string {
  const body = {
    parent: { type: "page_id", page_id: pageId },
    title: [{ text: { content: title } }],
    properties: { Nome: { title: {} } },
  };
  const out = apiPost("databases", body);
  return (JSON.parse(out) as { id: string }).id;
}

export function createDataSource(databaseId: string, title: string): string {
  const body = {
    parent: { database_id: databaseId },
    title: [{ text: { content: title } }],
    properties: {
      Nome: { title: {} },
      Tipo: {
        select: {
          options: [
            { name: "projeto" },
            { name: "decisao" },
            { name: "doc" },
            { name: "ideia" },
          ],
        },
      },
      Tags: { multi_select: {} },
      Status: {
        select: { options: [{ name: "Ativo" }, { name: "Arquivado" }] },
      },
    },
  };
  const out = apiPost("data_sources", body);
  return (JSON.parse(out) as { id: string }).id;
}

// ===== Orquestração =====

// espera o índice de busca do Notion propagar (evita duplicar em re-execuções)
function searchWithRetry(
  find: () => string | null,
  log: (msg: string) => void,
  attempts = 4,
  delayMs = 2000,
): string | null {
  for (let i = 0; i < attempts; i++) {
    const found = find();
    if (found) return found;
    if (i < attempts - 1) {
      log(`[busca] não encontrado ainda, aguardando indexação (tentativa ${i + 1}/${attempts})...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  return null;
}

/** Orquestra o bootstrap completo. Idempotente. */
export function ensureBrain(opts: BrainOptions = {}): BrainResult {
  const dry = opts.dry ?? false;
  const checkOnly = opts.checkOnly ?? false;
  const log = opts.logger ?? ((m: string) => console.log(m));

  const result: BrainResult = {
    loggedIn: false,
    pageId: null,
    dbId: null,
    dsId: null,
    createdPage: false,
    createdDb: false,
    createdDs: false,
  };

  // 1) Login
  if (!isLoggedIn()) {
    log(`[login] NÃO autenticado (${dry || checkOnly ? "--dry/--check, não abre terminal" : "abrindo terminal novo para: " + LOGIN_CMD})`);
    if (!dry && !checkOnly) openLoginTerminal();
    return result;
  }
  result.loggedIn = true;
  log("[login] ✅ Autenticado");

  // 2) Página mãe
  let pageId = searchWithRetry(() => findPageByTitle(BRAIN_PAGE), log);
  if (pageId) {
    log(`[pagina] ✅ "${BRAIN_PAGE}" já existe (${pageId})`);
  } else if (dry || checkOnly) {
    log(`[pagina] ⚠️ "${BRAIN_PAGE}" NÃO existe — seria criada (--dry/--check, não cria)`);
    return result;
  } else {
    pageId = createWorkspacePage(BRAIN_PAGE);
    result.createdPage = true;
    log(`[pagina] ✅ "${BRAIN_PAGE}" criada (${pageId})`);
  }
  result.pageId = pageId;

  if (checkOnly) {
    log("--check concluído (read-only).");
    return result;
  }

  // 3) Database (o database cria um data source automático "Brain")
  let dbId: string | null = null;
  const auto = searchWithRetry(() => findDataSourceUnder(pageId, BRAIN_DB), log);
  if (auto) {
    dbId = auto.databaseId;
    log(`[database] ✅ "${BRAIN_DB}" já existe (${dbId})`);
  } else if (dry) {
    log(`[database] ⚠️ "${BRAIN_DB}" NÃO existe — seria criado`);
  } else {
    dbId = createDatabase(pageId, BRAIN_DB);
    result.createdDb = true;
    log(`[database] ✅ "${BRAIN_DB}" criado (${dbId})`);
  }
  result.dbId = dbId;

  // 4) Indexador "Indice": checa via resolve (sem lag) e cria se faltar
  if (dbId) {
    const list = listDataSources(dbId);
    const existing = list.find((d) => d.name === BRAIN_DS);
    if (existing) {
      result.dsId = existing.id;
      log(`[data source] ✅ indexador "${BRAIN_DS}" já existe (${existing.id})`);
    } else if (dry) {
      log(`[data source] ⚠️ indexador "${BRAIN_DS}" seria criado`);
    } else {
      result.dsId = createDataSource(dbId, BRAIN_DS);
      result.createdDs = true;
      log(`[data source] ✅ indexador "${BRAIN_DS}" criado (${result.dsId})`);
    }
  }

  log("\n🎉 Brain pronto. IDs:");
  log(`  página mãe:     ${result.pageId ?? "n/a"}`);
  log(`  database:       ${result.dbId ?? "n/a"}`);
  log(`  data source:    ${result.dsId ?? "n/a"}`);

  return result;
}

export interface CriarPageResult {
  ok: boolean;
  pageId: string | null;
  url: string | null;
  title: string | null;
  dsId: string | null;
  tipo: "pesquisa" | "codigo" | null;
  gitUrl: string | null;
  sessionId: string | null;
  palavrasChave: string[];
  updated: boolean;
  message: string;
}

/** Normaliza uma URL de git (trim, remove .git final e sujeira de markdown como backticks). */
export function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

/**
 * Extrai a URL de um repositório git do markdown (github/gitlab/bitbucket, http ou ssh).
 * Retorna null se não encontrar.
 */
export function extractGitUrl(md: string): string | null {
  // captura a URL primeiro (sem grupo guloso engolindo o host)
  const m = md.match(
    /(https?:\/\/[^\s"'()<>]+|git@[^\s:]+:[^\s"'()<>]+|ssh:\/\/git@[^\s"'()<>]+)/i,
  );
  if (!m) return null;
  const raw = m[1].replace(/[`),.;]+$/, "");
  // valida se parece um repositório git
  const isGitish =
    /(github\.com|gitlab\.com|gitlab\.[a-z.]+|bitbucket\.org|\.git(\/|$))/i.test(raw) ||
    raw.startsWith("git@");
  return isGitish ? normalizeGitUrl(raw) : null;
}

/** Garante o schema do indexador: propriedade Git (url) + opções pesquisa/codigo no Tipo. */
export function ensureIndexSchema(
  log: (m: string) => void,
): { ok: boolean; message: string } {
  const dsId = getIndiceDsId();
  if (!dsId) return { ok: false, message: "Brain não inicializado (sem Indice). Rode brain_bootstrap." };
  try {
    const out = run(`ntn api v1/data_sources/${dsId}`);
    const ds = JSON.parse(out) as {
      properties?: Record<
        string,
        { url?: unknown; select?: { options?: Array<{ name?: string }> } }
      >;
    };
    const props = ds.properties ?? {};
    const hasGit = Boolean(props.Git?.url);
    const hasSession = Boolean(props.Session?.rich_text);
    const tipoOptions = (props.Tipo?.select?.options ?? []).map((o) => o.name ?? "");
    const hasTypes = tipoOptions.includes("pesquisa") && tipoOptions.includes("codigo");
    if (hasGit && hasSession && hasTypes) return { ok: true, message: "Schema do índice já completo." };

    const patch: Record<string, unknown> = {};
    if (!hasGit) patch.Git = { url: {} };
    if (!hasSession) patch.Session = { rich_text: {} };
    if (!hasTypes) {
      const all = Array.from(new Set([...tipoOptions, "pesquisa", "codigo"]));
      patch.Tipo = { select: { options: all.map((name) => ({ name })) } };
    }
    apiCall("PATCH", `v1/data_sources/${dsId}`, { properties: patch });
    log("[schema] ✅ Indexador atualizado (Git + Session + opções pesquisa/codigo)");
    return { ok: true, message: "Schema do índice atualizado." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `Erro ao garantir schema: ${msg}` };
  }
}

/** Busca no índice a página cujo Git é igual a `url`. Retorna o ID ou null. */
export function findPageByGitUrl(dsId: string, gitUrl: string): string | null {
  const file = writeJsonTemp({ property: "Git", url: { equals: gitUrl } });
  try {
    const out = run(`ntn datasources query ${dsId} --filter-file ${file} --json`);
    const data = JSON.parse(out) as { results?: Array<{ id: string }> };
    return data.results?.[0]?.id ?? null;
  } catch {
    return null;
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Busca no índice a página da sessão (Session rich_text == sessionId).
 * Regra: 1 página por sessão (o session é o id da pesquisa).
 */
export function findPageBySessionId(
  dsId: string,
  sessionId: string,
): string | null {
  const file = writeJsonTemp({ property: "Session", rich_text: { equals: sessionId } });
  try {
    const out = run(`ntn datasources query ${dsId} --filter-file ${file} --json`);
    const data = JSON.parse(out) as { results?: Array<{ id: string }> };
    return data.results?.[0]?.id ?? null;
  } catch {
    return null;
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Lê uma página do índice e devolve { title, body, tags }:
 * o `ntn pages get` devolve frontmatter YAML (properties) + corpo markdown.
 */
export function getPageMarkdown(pageId: string): {
  title: string | null;
  body: string;
  tags: string[];
} {
  const raw = run(`ntn pages get ${pageId}`);
  let title: string | null = null;
  let tags: string[] = [];
  let body = raw;
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      const fm = lines.slice(1, end);
      for (const line of fm) {
        const m = line.match(/^Nome:\s*(.*)$/);
        if (m) title = m[1].trim();
      }
      // Tags é uma lista YAML: "Tags:" seguida de "- item"
      const ti = fm.findIndex((l) => /^Tags:/.test(l));
      if (ti >= 0) {
        for (let i = ti + 1; i < fm.length; i++) {
          const item = fm[i].match(/^\s*-\s*(.+)$/);
          if (item) tags.push(item[1].trim());
          else if (fm[i].trim() !== "" && !/^[A-Za-z-]+:/.test(fm[i])) break;
        }
      }
      body = lines.slice(end + 1).join("\n").replace(/^\s*\n/, "");
    }
  }
  return { title, body: body.trim(), tags };
}

/**
 * Anexa um novo markdown no FINAL do conteúdo de uma página existente
 * (1 página por sessão): preserva o título original e mescla as tags.
 */
export function appendToPage(
  pageId: string,
  newMd: string,
  newTags: string[],
): { ok: boolean; message: string } {
  const { title, body, tags } = getPageMarkdown(pageId);
  // remove linha de metadata (blockquote) e H1 inicial (título é a property Nome)
  // para não duplicar ao recompor o conteúdo
  let core = body.replace(/^>\s*.+\n+/, "").replace(/^#\s+.+\n+/, "").trim();
  const prefix = title ? `# ${title}` : "";
  const merged = [prefix, core, "---", newMd].filter((s) => s.length > 0).join("\n\n");
  const contentOk = editPageContent(pageId, merged);
  const mergedTags = Array.from(new Set([...tags, ...newTags]));
  const propsOk =
    mergedTags.length > 0
      ? setPageProperties(pageId, { Tags: { multi_select: mergedTags.map((name) => ({ name })) } })
      : true;
  return {
    ok: contentOk && propsOk,
    message: `Anexado ao final da página ${pageId} (conteúdo: ${contentOk}, tags: ${propsOk})`,
  };
}

/** Define propriedades de uma página existente (ex.: Tipo, Git). */
export function setPageProperties(
  pageId: string,
  props: Record<string, unknown>,
): boolean {
  try {
    apiCall("PATCH", `v1/pages/${pageId}`, { properties: props });
    return true;
  } catch {
    return false;
  }
}

/** Atualiza o conteúdo Markdown de uma página existente. */
export function editPageContent(pageId: string, md: string): boolean {
  try {
    execSync(`ntn pages edit ${pageId}`, {
      input: md,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Extrai o título de uma página do markdown (primeiro H1). */
export function extractTitle(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Info de metadata passável explicitamente (fallback para env vars do pi). */
export interface MetadataInfo {
  sessionId?: string | null;
  provider?: string | null;
  model?: string | null;
}

/**
 * Bloco de metadata fixo, colocado no INÍCIO antes do texto adicionado:
 * data, hora, sessão do pi, provider/modelo e nome do PC — em visual de nota
 * pequena: blockquote + texto cinza (Notion não suporta tamanho de fonte via
 * markdown; gray é a renderização mais próxima de "letra pequena").
 * Prioridade: info explícita > env vars do pi > "n/a".
 */
export function buildMetadataBlock(info: MetadataInfo = {}): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);
  const session = info.sessionId ?? process.env.PI_SESSION_ID ?? "n/a";
  const provider = info.provider ?? process.env.PI_PROVIDER ?? "n/a";
  const model = info.model ?? process.env.PI_MODEL ?? "n/a";
  const pc = hostname() || process.env.COMPUTERNAME || "n/a";
  return `> <span color="gray">_meta: ${date} ${time} · sessão ${session} · ${provider}/${model} · PC ${pc}_</span>`;
}

/** Anexa o bloco de metadata fixo no início do markdown a ser adicionado. */
export function withMetadata(md: string, info: MetadataInfo = {}): string {
  return `${buildMetadataBlock(info)}\n\n${md}`;
}

/**
 * Acha o ID do indexador "Indice" do brain (página MateusNotion → data source). */
export function getIndiceDsId(): string | null {
  const pageId = findPageByTitle(BRAIN_PAGE);
  if (!pageId) return null;
  const found = findDataSourceUnder(pageId, BRAIN_DS);
  return found?.dsId ?? null;
}

/**
 * criar_page: recebe o Markdown text-only + tipo (pesquisa|codigo) + palavrasChave,
 * e o sistema processa o restante (título = primeiro H1, destino = data source "Indice",
 * indexação em Tags).
 *
 * - tipo "pesquisa": SEMPRE cria uma página nova.
 * - tipo "codigo": extrai a URL do git do markdown; se a URL já tem anotação no
 *   índice (propriedade Git), ATUALIZA a página existente (conteúdo + props);
 *   senão, cria uma página nova indexada pelo git.
 * - palavrasChave: indexadas na propriedade Tags (multi_select) para indexação futura.
 */
export function criarPage(
  md: string,
  tipo: "pesquisa" | "codigo" = "pesquisa",
  palavrasChave: string[] = [],
  opts: { logger?: (m: string) => void; metadata?: MetadataInfo } = {},
): CriarPageResult {
  const log = opts.logger ?? ((m: string) => console.log(m));
  const keywords = palavrasChave.map((k) => k.trim()).filter(Boolean);
  // session id: metadata explícita (documentador) ou env do pi (sessão atual)
  const sessionId = opts.metadata?.sessionId ?? process.env.PI_SESSION_ID ?? null;
  const fail = (message: string): CriarPageResult => ({
    ok: false,
    pageId: null,
    url: null,
    title: null,
    dsId: null,
    tipo,
    gitUrl: null,
    sessionId,
    palavrasChave: keywords,
    updated: false,
    message,
  });

  if (!md.trim()) return fail("Markdown vazio — nada a criar.");
  if (!isLoggedIn()) {
    return fail("Não autenticado no ntn. Rode brain_bootstrap (abre o login) ou `ntn login`.");
  }

  const dsId = getIndiceDsId();
  if (!dsId) {
    return fail(`Brain não inicializado (sem data source "${BRAIN_DS}"). Rode brain_bootstrap primeiro.`);
  }

  // garante schema do índice (Git + Tipo pesquisa/codigo) — idempotente
  const schema = ensureIndexSchema(log);
  if (!schema.ok) log(`[schema] ⚠️ ${schema.message}`);

  const gitUrl = extractGitUrl(md);

  // === tipo "pesquisa": 1 página por sessão (Session é o id da pesquisa) ===
  // Se já existe na sessão, ANEXA o novo md no final da anterior; senão cria.
  if (tipo === "pesquisa" && sessionId) {
    const existing = findPageBySessionId(dsId, sessionId);
    if (existing) {
      const res = appendToPage(existing, withMetadata(md, opts.metadata), keywords);
      log(`[criar_page] 🔄 pesquisa já existe nesta sessão (${sessionId}) → anexado ao final da página ${existing} (${res.message})`);
      return {
        ok: res.ok,
        pageId: existing,
        url: null,
        title: null,
        dsId,
        tipo,
        gitUrl,
        sessionId,
        palavrasChave: keywords,
        updated: true,
        message: `Pesquisa já existe nesta sessão do pi — conteúdo anexado ao final da página ${existing}.`,
      };
    }
  }

  // === tipo "codigo": valida o git — se já existe anotação, ATUALIZA ===
  if (tipo === "codigo") {
    if (gitUrl) {
      const existing = findPageByGitUrl(dsId, gitUrl);
      if (existing) {
        const contentOk = editPageContent(existing, withMetadata(md, opts.metadata));
        const props: Record<string, unknown> = {
          Tipo: { select: { name: "codigo" } },
          Git: { url: gitUrl },
        };
        const title = extractTitle(md);
        if (title) props.Nome = { title: [{ text: { content: title } }] };
        if (keywords.length) props.Tags = { multi_select: keywords.map((name) => ({ name })) };
        const propsOk = setPageProperties(existing, props);
        log(`[criar_page] 🔄 git já anotado no brain (${gitUrl}) → página ${existing} atualizada (conteúdo: ${contentOk}, props: ${propsOk})`);
        return {
          ok: contentOk && propsOk,
          pageId: existing,
          url: null,
          title: null,
          dsId,
          tipo,
          gitUrl,
          palavrasChave: keywords,
          updated: true,
          message: `Git já anotado no brain — página ${existing} atualizada.`,
        };
      }
    }
    log(`[criar_page] 🆕 código sem anotação prévia${gitUrl ? ` (${gitUrl})` : " (sem git detectado no md)"} → criando nova página`);
  }

  // === criação (pesquisa sempre passa por aqui; código quando não há anotação) ===
  // metadata fixa no INÍCIO, antes do texto adicionado (data, hora, sessão, provider/model, PC)
  const mdComMeta = withMetadata(md, opts.metadata);
  const mdTitle = extractTitle(md) ?? "";
  try {
    const out = execSync(`ntn pages create --parent data-source:${dsId} --json`, {
      input: mdComMeta,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const page = JSON.parse(out.trim()) as {
      id: string;
      url?: string;
      properties?: Record<string, { title?: Array<{ plain_text?: string }> }>;
    };
    const title = mdTitle || (page.properties?.Nome?.title?.[0]?.plain_text ?? null);

    // indexa: Nome (título explícito, pois a metadata vem antes do H1) + Tipo + Session + Git + Tags
    const props: Record<string, unknown> = {
      Nome: { title: [{ text: { content: mdTitle } }] },
      Tipo: { select: { name: tipo } },
    };
    if (sessionId) props.Session = { rich_text: [{ text: { content: sessionId } }] };
    if (gitUrl) props.Git = { url: gitUrl };
    if (keywords.length) props.Tags = { multi_select: keywords.map((name) => ({ name })) };
    const propsOk = setPageProperties(page.id, props);

    log(`[criar_page] ✅ "${title ?? "?"}" criada (${page.id}) no indexador "${BRAIN_DS}" (${tipo}${sessionId ? `, session ${sessionId.slice(0, 8)}…` : ""}${gitUrl ? `, git ${gitUrl}` : ""}${keywords.length ? `, tags ${keywords.join(", ")}` : ""}, props: ${propsOk})`);
    return {
      ok: true,
      pageId: page.id,
      url: page.url ?? null,
      title,
      dsId,
      tipo,
      gitUrl,
      sessionId,
      palavrasChave: keywords,
      updated: false,
      message: `Página criada no indexador "${BRAIN_DS}" (${tipo})`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Erro ao criar página via ntn: ${msg}`);
  }
}

// ===== CLI (roda só quando executado diretamente: node brain.ts) =====

function main(): void {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const checkOnly = args.includes("--check");

  console.log("🧠 MegaBrains bootstrap — Notion via ntn");
  const result = ensureBrain({ dry, checkOnly });

  if (!result.loggedIn) {
    process.exit(dry || checkOnly ? 1 : 0);
  }
  if (checkOnly) process.exit(0);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main();
}
