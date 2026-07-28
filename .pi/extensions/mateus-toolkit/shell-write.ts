// Análise de comandos shell para os guards de bash e write.

export type WriteKind = "redirect" | "append" | "tee" | "dd";

export interface ShellWrite {
  path: string;
  kind: WriteKind;
}

const CHAIN_OPERATORS = ["&&", "||", ";", "|", "\n"];

function scan(
  cmd: string,
  visit: (ch: string, index: number, quoted: boolean) => void,
): void {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === null && ch === "\\") {
      i++;
      continue;
    }
    if (quote === "'" && ch === "\\") {
      visit(ch, i, true);
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      continue;
    }
    visit(ch, i, quote !== null);
  }
}

const HEREDOC_START = /<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/;

export function stripHeredocBodies(cmd: string): string {
  let out = cmd;
  let searchFrom = 0;
  for (let guard = 0; guard < 32; guard++) {
    const rest = out.slice(searchFrom);
    const m = HEREDOC_START.exec(rest);
    if (!m || m.index === undefined) break;
    const at = searchFrom + m.index;
    if (out[at + 2] === "<") {
      searchFrom = at + 3;
      continue;
    }
    const delim = m[1] ?? m[2] ?? m[3] ?? "";
    const bodyStart = out.indexOf("\n", at + m[0].length);
    if (bodyStart === -1 || !delim) {
      searchFrom = at + m[0].length;
      continue;
    }
    const lines = out.slice(bodyStart + 1).split("\n");
    let consumed = 0;
    let closed = false;
    for (const line of lines) {
      consumed += line.length + 1;
      if (line.trim() === delim) {
        closed = true;
        break;
      }
    }
    const bodyEnd = closed
      ? Math.min(bodyStart + consumed, out.length)
      : out.length;
    out = out.slice(0, at) + out.slice(bodyEnd);
    searchFrom = at;
  }
  return out;
}

export function splitCommandChain(raw: string): string[] {
  const cmd = stripHeredocBodies(raw);
  const cuts: Array<{ at: number; len: number }> = [];
  scan(cmd, (_ch, i, quoted) => {
    if (quoted) return;
    for (const op of CHAIN_OPERATORS) {
      if (cmd.startsWith(op, i)) {
        const last = cuts[cuts.length - 1];
        if (last && i < last.at + last.len) return;
        cuts.push({ at: i, len: op.length });
        return;
      }
    }
  });

  const segments: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    segments.push(cmd.slice(start, cut.at));
    start = cut.at + cut.len;
  }
  segments.push(cmd.slice(start));
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isFdTarget(target: string): boolean {
  return target.startsWith("&");
}

export function detectWriteTargets(raw: string): ShellWrite[] {
  const cmd = stripHeredocBodies(raw);
  const writes: ShellWrite[] = [];
  const redirects: Array<{ at: number; kind: WriteKind }> = [];

  scan(cmd, (ch, i, quoted) => {
    if (quoted || ch !== ">") return;
    if (cmd[i - 1] === ">") return;
    const append = cmd[i + 1] === ">";
    redirects.push({ at: i + (append ? 2 : 1), kind: append ? "append" : "redirect" });
  });

  for (const { at, kind } of redirects) {
    const rest = cmd.slice(at);
    if (rest.trimStart().startsWith("(")) continue;
    const target = firstWord(rest);
    if (!target || isFdTarget(target)) continue;
    writes.push({ path: unquote(target), kind });
  }

  for (const segment of splitCommandChain(cmd)) {
    const words = splitWords(segment);
    if (words.length === 0) continue;
    if (words[0] === "tee") {
      for (const w of words.slice(1)) {
        if (w.startsWith("-")) continue;
        writes.push({ path: unquote(w), kind: "tee" });
      }
    }
    if (words[0] === "dd") {
      for (const w of words.slice(1)) {
        if (w.startsWith("of=")) writes.push({ path: unquote(w.slice(3)), kind: "dd" });
      }
    }
  }

  const seen = new Set<string>();
  return writes.filter((w) => {
    if (!w.path || seen.has(w.path)) return false;
    seen.add(w.path);
    return true;
  });
}

function unquote(word: string): string {
  if (word.length >= 2 && (word[0] === '"' || word[0] === "'") && word[word.length - 1] === word[0]) {
    return word.slice(1, -1);
  }
  return word.replace(/\\(.)/g, "$1");
}

function firstWord(s: string): string {
  return splitWords(s)[0] ?? "";
}

function splitWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === null && ch === "\\") {
      cur += ch + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      cur += ch;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      cur += ch;
      continue;
    }
    if (quote === null && /\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    if (quote === null && (ch === ">" || ch === "<")) {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}
