// run-terminal-pty.cjs
// Único entrypoint do run-terminal.
// Abre o TUI interativo do pi em um PTY real (node-pty), envia o prompt "oi"
// e imprime a saída completa capturada.
//
// Uso:
//   node run-terminal-pty.cjs [--model X] [--provider Y] [--prompt Z] [--timeout N]
//
// Entradas via env (sobrescritas pelos args): MODEL, PROVIDER, PROMPT, TIMEOUT_SEC.
//
// Equivale a rodar:
//   pi --model "opencode-go/deepseek-v4-flash"
// spawnando node.exe + dist/cli.js diretamente (mesmo que o wrapper pi), sem
// passar por cmd.exe (que tem armadilhas de citação no Windows).

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node-pty");

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function argFlag(flag) {
  return process.argv.indexOf(flag) >= 0;
}

// Detecta dinamicamente a raiz do projeto (a pasta que contém .pi/extensions).
// O driver fica em <raiz>/.pi/extensions/<modulo>/run-terminal-pty.cjs, então
// subimos até achar um diretório com .pi/extensions (as extensões a carregar).
function findProjectRoot() {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".pi", "extensions"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const PROJECT_ROOT = findProjectRoot();
if (!PROJECT_ROOT) {
  console.error("[run-terminal-pty] não encontrei a raiz do projeto (.pi/extensions) acima de " + __dirname);
  console.error("  Defina PROJECT_ROOT=<caminho> se a pasta estiver em outro local.");
  process.exit(1);
}

const PROVIDER = argVal("--provider", process.env.PROVIDER || "opencode-go");
const MODEL = argVal("--model", process.env.MODEL || "opencode-go/deepseek-v4-flash");
const PROMPT = argVal("--prompt", process.env.PROMPT || "oi");
const TIMEOUT_SEC = Number(argVal("--timeout", process.env.TIMEOUT_SEC || "120"));
const SEND_AT_SEC = Number(argVal("--send-at", "8")); // quando enviar o prompt, em s

// Localiza o executável do node e o cli.js do pi (mesmo caminho que o wrapper `pi` usa).
function findNodeExeAndCli() {
  const NODE = process.env.NODE || process.execPath; // node.exe em uso
  const candidates = [
    process.env.PI_CLI,
    path.join(path.dirname(NODE), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    path.join("C:/nvm4w/nodejs", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { NODE, CLI: p };
  }
  return null;
}

const found = findNodeExeAndCli();
if (!found) {
  console.error("[run-terminal-pty] cli.js do pi não encontrado (node_modules/@earendil-works/pi-coding-agent/dist/cli.js).");
  console.error("  Instale o pi globalmente ou defina PI_CLI=<caminho>/cli.js.");
  process.exit(1);
}
const { NODE, CLI } = found;

console.error(`[run-terminal-pty] node=${NODE}`);
console.error(`[run-terminal-pty] cli=${CLI}`);
console.error(`[run-terminal-pty] project_root=${PROJECT_ROOT}`);
console.error(`[run-terminal-pty] provider=${PROVIDER} model=${MODEL} prompt=${JSON.stringify(PROMPT)}`);
console.error("[run-terminal-pty] abrindo TUI interativo do pi na raiz do projeto (carrega as extensões)...");

// args idênticos a `pi --provider ... --model ... --no-session`.
// Obs.: o pi global instalado (0.74.2) NÃO aceita `--approve`; por isso o prompt
// "Trust project folder?" é aceito automaticamente no onData (envio de Enter).
const args = [
  CLI,
  "--provider", PROVIDER,
  "--model", MODEL,
  "--no-session",
];

const term = spawn(NODE, args, {
  name: "xterm-256color",
  cols: 140,
  rows: 34,
  cwd: PROJECT_ROOT, // roda o pi na raiz do projeto p/ auto-descobrir .pi/extensions
  env: { ...process.env },
});

let output = "";
const t0 = Date.now();
let sent = false;

let trustHandled = false;

term.onData((data) => {
  output += data;
  process.stdout.write(data); // espelha a TUI

  // Aceita automaticamente o prompt "Trust project folder?" (Enter na opção destacada).
  if (!trustHandled && /trust|confian([aç])|trust project folder/i.test(data)) {
    trustHandled = true;
    console.error("\n[run-terminal-pty] prompt de confiança detectado; aceitando (Enter)...");
    setTimeout(() => { try { term.write("\r"); } catch (_) {} }, 600);
  }
});

// Envia o prompt de forma confiável via timer independente (não depende de onData).
const sendTimer = setInterval(() => {
  if (!sent && Date.now() - t0 > SEND_AT_SEC * 1000) {
    sent = true;
    clearInterval(sendTimer);
    console.error(`\n[run-terminal-pty] enviando prompt: ${JSON.stringify(PROMPT)}`);
    setTimeout(() => { try { term.write(PROMPT + "\r"); } catch (_) {} }, 800);
  }
}, 300);

setTimeout(() => {
  console.error("\n[run-terminal-pty] fim da coleta. fecha PTY.");
  clearInterval(sendTimer);
  try { term.kill(); } catch (_) {}
  // Imprime a saída completa limpa (sem ANSI) na stdout.
  const plain = output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>0-9u?]/g, "")
    .replace(/[\x00]/g, "");
  console.log("\n==================== RESULTADO COMPLETO (INTERATIVO/PTY) ====================\n");
  console.log(plain.replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n"));
  process.exit(0);
}, TIMEOUT_SEC * 1000);
