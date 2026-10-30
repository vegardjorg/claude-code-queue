// =============================================================
// helperScan.js: the machine scan of a custom helper agent file (an agent definition of the project's own, added with
// `cq helpers add`). See docs/orchestration.md ("Custom helper agents").
//
// WHY: a custom helper is a prompt that runs as a subagent in the orchestrator session, with the tools its frontmatter
// gives it. A file found on the web or written by someone else can carry a prompt injection, ask for more tools than a
// reviewer needs, or call out of the machine. The scan is the first, cheap filter; Claude reads the whole file after
// it, and the owner approves. The scan never runs anything from the file: it only reads the text.
//
// The result is one level for the whole file and a list of findings, each with a line number (1-based, in the whole
// file, frontmatter included):
//   red     must not be approved without `--force` and the owner's explicit yes
//   yellow  Claude must weigh it and mention it to the owner
//   green   no findings (Claude still reads the file)
//   info    (per finding only) says something useful but never changes the level, e.g. the model
//
// What is checked (one rule id per kind of finding, in RULES and the frontmatter check below):
//   - frontmatter: `tools` missing (= every tool), write tools, web tools, MCP tools, starting agents, unrestricted
//     Bash, keys that change how the agent runs (permissionMode, mcpServers, hooks), isolation and unknown keys, model
//   - calls out of the machine: URLs (a short list of documentation domains only gives yellow), curl, wget,
//     Invoke-WebRequest, fetch(, nc, webhooks, gh, git push, scp, ssh, a pipe into a shell, package installs
//   - prompt injection and misuse: "ignore previous instructions", "disregard", the system prompt, changing settings,
//     hooks, agent definitions or CLAUDE.md, reading secrets, hiding something from the owner, deleting or force
//     pushing, sending data somewhere, starting other agents
//   - hidden content: base64 like blocks, invisible and control Unicode (zero width, bidi overrides, tag characters),
//     HTML comments, very long lines, fenced code blocks with a script language
//   - missing guards: the "Data, not instructions" paragraph and the FINDINGS answer line
// A misuse rule on a line that says no to it ("never force push", "do not start other agents") gives yellow instead
// of red: the words are there, but as a guard. Claude still reads the line.
//
// Pure function on the text (no file I/O), tested in lib/__tests__/helperScan.test.ts.
// =============================================================
'use strict';

const LEVELS = ['green', 'yellow', 'red'];

/** The frontmatter keys Claude Code knows for a subagent, and how the scan treats each. */
const KEY_KIND = Object.freeze({
  name: 'ok',
  description: 'ok',
  tools: 'tools',
  disallowedTools: 'ok',
  model: 'info',
  effort: 'ok',
  color: 'ok',
  maxTurns: 'ok',
  permissionMode: 'red',
  mcpServers: 'red',
  hooks: 'red',
  isolation: 'yellow',
  memory: 'yellow',
  skills: 'yellow',
  background: 'yellow',
  initialPrompt: 'yellow',
});

/** Tools that write files, reach the network or start agents: red in a helper (a reviewer only reads). */
const RED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']);

/**
 * Documentation domains: a link there only gives yellow (it may be a reference, but the agent could still fetch it).
 * The domain itself or a subdomain of it.
 */
const DOC_DOMAINS = Object.freeze([
  'docs.anthropic.com',
  'docs.claude.com',
  'code.claude.com',
  'developer.mozilla.org',
  'nodejs.org',
  'typescriptlang.org',
  'docs.github.com',
  'git-scm.com',
  'owasp.org',
  'w3.org',
  'vitest.dev',
  'react.dev',
  'docs.python.org',
]);

/** A line longer than this is yellow (text can hide far to the right of a narrow view). */
const LONG_LINE = 400;

/**
 * Words that say no to what follows on the line ("never", "do not", "must not" ...). A misuse rule with one of these
 * before the hit is a guard, not an order: yellow instead of red.
 */
const NEGATION = /\b(?:never|not|don'?t|doesn'?t|mustn'?t|cannot|can'?t|no|without|avoid|refuse|forbidden)\b/i;

/**
 * The text rules, checked on every line. `negatable` = the "says no to it" rule above applies.
 * Each regex is used with .exec on one line (no g flag, so no lastIndex state between lines).
 */
const RULES = Object.freeze([
  // ---- Calls out of the machine ----
  { id: 'curl', level: 'red', group: 'outbound', re: /\bcurl\b/i, text: 'curl (a call out of the machine)' },
  { id: 'wget', level: 'red', group: 'outbound', re: /\bwget\b/i, text: 'wget (a call out of the machine)' },
  {
    id: 'invoke-webrequest',
    level: 'red',
    group: 'outbound',
    re: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i,
    text: 'Invoke-WebRequest / iwr (a call out of the machine)',
  },
  { id: 'fetch', level: 'red', group: 'outbound', re: /\bfetch\s*\(/i, text: 'fetch( (a network call in code)' },
  {
    id: 'netcat',
    level: 'red',
    group: 'outbound',
    re: /\b(?:nc|ncat|netcat)\s+(?:-\w|\S+\s+\d{2,5}\b)/i,
    text: 'nc / netcat (a raw network connection)',
  },
  { id: 'webhook', level: 'red', group: 'outbound', re: /\bweb-?hooks?\b/i, text: 'a webhook (sends data out)' },
  { id: 'gh', level: 'red', group: 'outbound', re: /(?:^|[\s`'"(])gh\s+[a-z]/i, text: 'gh (the GitHub CLI acts on the remote)' },
  { id: 'git-push', level: 'red', group: 'outbound', re: /\bgit\s+push\b/i, text: 'git push', negatable: true },
  { id: 'scp', level: 'red', group: 'outbound', re: /\bscp\s+\S/i, text: 'scp (copies files to another machine)' },
  { id: 'ssh', level: 'red', group: 'outbound', re: /\bssh\s+[-\w@]/i, text: 'ssh (a shell on another machine)' },
  {
    id: 'pipe-shell',
    level: 'red',
    group: 'outbound',
    re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|iex|Invoke-Expression|pwsh|powershell|cmd|python3?|node)\b/i,
    text: 'a pipe into a shell (runs what comes in)',
  },
  {
    id: 'package-install',
    level: 'red',
    group: 'outbound',
    re: /\b(?:npx\s+\S|npm\s+(?:i|install|add)\b|pnpm\s+(?:add|dlx|i|install)\b|yarn\s+(?:add|dlx)\b|pip3?\s+install\b|uvx\s+\S|bunx\s+\S)/i,
    text: 'a package install or npx (downloads and runs code)',
  },
  // ---- Prompt injection and misuse ----
  {
    id: 'ignore-instructions',
    level: 'red',
    group: 'injection',
    re: /\bignore\s+(?:(?:all|the|any|your|every|of|these|those)\s+)*(?:(?:previous|prior|above|earlier|preceding|other|system|original)\s+)?(?:instructions|rules|guidelines|prompts?|directions)\b/i,
    text: '"ignore ... instructions" (a classic prompt injection)',
    negatable: true,
  },
  { id: 'disregard', level: 'red', group: 'injection', re: /\bdisregard\b/i, text: '"disregard"', negatable: true },
  {
    id: 'system-prompt-leak',
    level: 'red',
    group: 'injection',
    re: /\b(?:reveal|print|show|repeat|output|leak|dump|copy|send)\b[^.\n]{0,40}\bsystem\s+prompt\b/i,
    text: 'asks for the system prompt',
    negatable: true,
  },
  { id: 'system-prompt', level: 'yellow', group: 'injection', re: /\bsystem\s+prompt\b/i, text: 'mentions the system prompt' },
  {
    id: 'change-config',
    level: 'red',
    group: 'injection',
    re: /\b(?:edit|change|modify|update|write|overwrite|append|add|create|delete|remove|disable|replace|patch)\b[^.\n]{0,60}(?:settings(?:\.local)?\.json|\.claude\/|\bhooks?\b|agent\s+(?:definitions?|files?)|CLAUDE(?:\.queue)?\.md|\.mcp\.json|queue\.config\.json|\.github\/workflows|permissions?)/i,
    text: 'asks to change settings, hooks, agent definitions or CLAUDE.md',
    negatable: true,
  },
  {
    id: 'read-secrets',
    level: 'red',
    group: 'injection',
    re: /\b(?:read|cat|type|print|open|dump|show|list|copy|collect|gather|grab|include|extract|look\s+(?:in|at))\b[^.\n]{0,60}(?:\.env\b|\bsecrets?\b|\btokens?\b|api[_ -]?keys?|\.ssh\b|id_rsa|id_ed25519|credentials?|\.npmrc|\.netrc|\bpasswords?\b|private\s+keys?)/i,
    text: 'asks to read secrets (.env, tokens, keys, ~/.ssh, credentials)',
    negatable: true,
  },
  {
    id: 'secret-path',
    level: 'yellow',
    group: 'injection',
    re: /(?:~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|(?:^|[\s`'"/])\.env(?:\.\w+)?\b|\.npmrc|\.netrc|credentials\.json|\.aws\/)/i,
    text: 'mentions a secret file (.env, ~/.ssh, credentials)',
  },
  {
    id: 'hide',
    level: 'red',
    group: 'injection',
    re: /\b(?:secretly|covertly)\b|\b(?:hide|hiding|conceal|concealing|keep\s+(?:it|this|that)\s+secret)\b[^.\n]{0,40}\b(?:from|owner|user|human|orchestrator)\b|\b(?:don'?t|do\s+not|never|without)\s+(?:tell|telling|inform|informing|mention|mentioning|notify|notifying|show|showing|report|reporting|asking)\b[^.\n]{0,40}\b(?:owner|user|human|orchestrator|anyone|them)\b/i,
    text: 'hides something from the owner or the user',
  },
  {
    id: 'destructive',
    level: 'red',
    group: 'injection',
    re: /\brm\s+-[a-z]*[rf]|\bRemove-Item\b[^\n]*-Recurse|\bgit\s+push\b[^\n]*(?:--force|\s-f\b)|--force-with-lease|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f|\bdel\s+\/[sq]|\brmdir\s+\/s|\bforce[- ]push|\b(?:delete|erase|wipe|destroy)\b[^.\n]{0,40}\b(?:files?|branch(?:es)?|repo(?:sitory)?|folders?|director(?:y|ies)|history|database|tables?)\b/i,
    text: 'deletes or force pushes',
    negatable: true,
  },
  {
    id: 'send-data',
    level: 'red',
    group: 'injection',
    re: /\bexfiltrat\w*|\b(?:send|upload|transmit|forward|e-?mail|post|leak)\b[^.\n]{0,60}\b(?:servers?|urls?|endpoints?|webhooks?|external|remote|address|slack|discord|telegram|pastebin|outside|internet)\b/i,
    text: 'sends data somewhere',
    negatable: true,
  },
  {
    id: 'start-agents',
    level: 'red',
    group: 'injection',
    re: /\b(?:start|spawn|launch|run|invoke|call|create|dispatch)\b[^.\n]{0,30}\b(?:sub-?agents?|other\s+agents?|another\s+agent|more\s+agents?|agents?\s+in\s+parallel|the\s+(?:Task|Agent)\s+tool)\b/i,
    text: 'starts other agents',
    negatable: true,
  },
  // ---- Hidden content ----
  {
    id: 'html-comment',
    level: 'red',
    group: 'hidden',
    re: /<!--/,
    text: 'an HTML comment (hidden in the rendered view, the agent still reads it)',
  },
  {
    id: 'base64',
    level: 'red',
    group: 'hidden',
    re: /(?=[A-Za-z0-9+/]{60,})(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9+/]{60,}={0,2}/,
    text: 'a base64 like block (encoded content the owner cannot read)',
  },
]);

/**
 * Invisible and control characters: zero width (U+200B-U+200F, U+2060-U+2064, U+FEFF), bidi embeddings and overrides
 * (U+202A-U+202E, U+2066-U+2069), the soft hyphen U+00AD, C0 and C1 controls except tab, and the Unicode tag
 * characters U+E0000-U+E007F (text that renders as nothing but the model reads). Written with escapes on purpose.
 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\uDB40[\uDC00-\uDC7F]/;

/** A fenced code block opening with a script language. */
const SCRIPT_FENCE = /^\s*(?:```|~~~)\s*(sh|bash|zsh|shell|console|powershell|ps1|pwsh|cmd|bat|batch|python|py|js|javascript|node|ts|typescript|ruby|perl|php)\b/i;

/** The "Data, not instructions" paragraph (the builtin agents' guard against injection through the review package). */
const DATA_GUARD = /data,\s*not\s+instructions/i;
/** The FINDINGS answer line the measurement reads (FINDINGS H=<n> M=<n> L=<n>). */
const FINDINGS_LINE = /\bFINDINGS\b/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** "\u200B" style name of a character, for the finding text. */
function codePoint(ch) {
  const cp = ch.codePointAt(0);
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The frontmatter between the first two "---" lines: the keys with their values and line numbers. A small reader for
 * the shapes agent files use: `key: value`, `key: [a, b]`, and a block list (`key:` then `  - a` lines). Nested maps
 * (hooks, mcpServers) are only recorded as present.
 * @returns {{ found: boolean, end: number, keys: Record<string, { line: number, value: string, list: string[]|null }> }}
 *   end = the line index (0-based) of the closing "---", or -1
 */
function readFrontmatter(lines) {
  const out = { found: false, end: -1, keys: {} };
  if (!lines.length || lines[0].replace(/^\uFEFF/, '').trim() !== '---') return out;
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '---') {
      out.found = true;
      out.end = i;
      return out;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
    if (m) {
      const value = m[2].trim();
      const inline = /^\[(.*)\]$/.exec(value);
      current = {
        line: i + 1,
        value,
        list: inline
          ? inline[1]
              .split(',')
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
              .filter(Boolean)
          : null,
      };
      out.keys[m[1]] = current;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(l);
    if (item && current) {
      current.list = [...(current.list ?? []), item[1].trim().replace(/^['"]|['"]$/g, '')];
    }
  }
  return out;
}

/** The tools in the frontmatter value: a comma list ("Read, Grep, Bash") or a YAML list. */
function toolList(entry) {
  if (!entry) return null;
  if (entry.list) return entry.list;
  return entry.value
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Is the host one of the documentation domains (or a subdomain)? */
function docDomain(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  return DOC_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Scan one agent file.
 * @param {string} text the whole file
 * @returns {{ level: 'green'|'yellow'|'red', findings: { level: string, line: number, rule: string, group: string,
 *   text: string, excerpt: string }[], counts: { red: number, yellow: number, info: number },
 *   frontmatter: Record<string, string> }}
 */
function scanHelper(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  const findings = [];
  const add = (level, line, rule, group, what, excerpt = '') =>
    findings.push({ level, line, rule, group, text: what, excerpt: String(excerpt).trim().slice(0, 80) });

  // ---- The frontmatter ----
  const fm = readFrontmatter(lines);
  const frontmatter = {};
  if (!fm.found) {
    add('red', 1, 'no-frontmatter', 'frontmatter', 'no frontmatter (--- name, description, tools ---): not a valid agent file');
  } else {
    for (const [key, entry] of Object.entries(fm.keys)) {
      frontmatter[key] = entry.value;
      const kind = KEY_KIND[key];
      if (!kind) add('yellow', entry.line, 'unknown-key', 'frontmatter', `unknown frontmatter key "${key}"`, key);
      else if (kind === 'red')
        add('red', entry.line, `key-${key}`, 'frontmatter', `${key} in the frontmatter (changes how the agent runs or what it can reach)`, key);
      else if (kind === 'yellow')
        add('yellow', entry.line, `key-${key}`, 'frontmatter', `${key} in the frontmatter`, `${key}: ${entry.value}`);
      else if (kind === 'info' && key === 'model')
        add('info', entry.line, 'model', 'frontmatter', `model: ${entry.value || '(empty)'}`, entry.value);
    }
    if (!fm.keys.description)
      add('yellow', 1, 'no-description', 'frontmatter', 'no description (Claude Code needs it to know what the agent is for)');
    const tools = toolList(fm.keys.tools);
    if (!tools || !tools.length) {
      add('red', fm.keys.tools?.line ?? 1, 'tools-missing', 'frontmatter', 'tools is missing: the agent gets EVERY tool (write, web, MCP, agents)');
    } else {
      const line = fm.keys.tools.line;
      for (const t of tools) {
        const bare = t.replace(/\(.*$/, '').trim();
        if (t === '*' || bare === '*') add('red', line, 'tool-all', 'frontmatter', 'tools: * (every tool)', t);
        else if (RED_TOOLS.has(bare)) add('red', line, `tool-${bare}`, 'frontmatter', `tool ${bare} (writes files, reaches the network or starts agents)`, t);
        else if (/^mcp__/i.test(bare)) add('red', line, 'tool-mcp', 'frontmatter', `MCP tool ${bare} (reaches outside the repo)`, t);
        else if ((bare === 'Bash' || bare === 'PowerShell') && bare === t)
          add('yellow', line, 'tool-bash', 'frontmatter', `unrestricted ${bare} (can run any command; the push guard and the read guard apply)`, t);
      }
    }
  }

  // ---- Every line: calls out, injection and misuse, hidden content ----
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    // Invisible characters first (one finding per line, naming the first one). A BOM at the very start is harmless.
    const scanLine = i === 0 ? l.replace(/^\uFEFF/, '') : l;
    const inv = INVISIBLE.exec(scanLine);
    if (inv) add('red', n, 'invisible-unicode', 'hidden', `an invisible or control character (${codePoint(inv[0])})`, '');
    if (l.length > LONG_LINE) add('yellow', n, 'long-line', 'hidden', `a very long line (${l.length} characters)`, l.slice(0, 40));
    // Fenced code blocks: a block with a script language is yellow (its lines are scanned like the rest).
    if (/^\s*(?:```|~~~)/.test(l)) {
      if (!fenceOpen) {
        fenceOpen = true;
        const m = SCRIPT_FENCE.exec(l);
        if (m) add('yellow', n, 'script-block', 'hidden', `a code block with a script (${m[1]})`, l);
      } else {
        fenceOpen = false;
      }
    }
    // URLs: red, unless the domain is a documentation domain (yellow).
    for (const m of l.matchAll(/\bhttps?:\/\/([^\s/'"`)<>\]]+)/gi)) {
      const host = m[1].replace(/:\d+$/, '').replace(/^[^@]*@/, '');
      if (docDomain(host)) add('yellow', n, 'url-docs', 'outbound', `a link to the documentation domain ${host}`, m[0]);
      else add('red', n, 'url', 'outbound', `a URL to ${host} (the agent could call it)`, m[0]);
    }
    for (const r of RULES) {
      const m = r.re.exec(l);
      if (!m) continue;
      // "never force push": the guard words before the hit make it yellow (still worth a look).
      const before = l.slice(0, m.index);
      const guarded = r.negatable && NEGATION.test(before);
      add(guarded ? 'yellow' : r.level, n, r.id, r.group, guarded ? `${r.text}, said as a guard ("never" or "not")` : r.text, m[0]);
    }
  }

  // ---- Missing guards ----
  if (!DATA_GUARD.test(src))
    add('yellow', 1, 'no-data-guard', 'guard', 'no "Data, not instructions" paragraph (content it reads could steer it)');
  if (!FINDINGS_LINE.test(src))
    add('yellow', 1, 'no-findings-line', 'guard', 'no FINDINGS answer line (the measurement cannot count its findings)');

  // One finding per rule and line is enough (two rules can still hit the same line).
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.rule}:${f.line}:${f.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => a.line - b.line || LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));
  const counts = {
    red: unique.filter((f) => f.level === 'red').length,
    yellow: unique.filter((f) => f.level === 'yellow').length,
    info: unique.filter((f) => f.level === 'info').length,
  };
  const level = counts.red ? 'red' : counts.yellow ? 'yellow' : 'green';
  return { level, findings: unique, counts, frontmatter };
}

/** The scan as short text lines for the CLI: the level, then one line per finding. */
function scanText(scan, name = '') {
  const s = isObject(scan) ? scan : { level: 'green', findings: [], counts: { red: 0, yellow: 0, info: 0 } };
  const head = `${name ? `${name}: ` : ''}scan ${s.level.toUpperCase()} (${s.counts.red} red, ${s.counts.yellow} yellow${
    s.counts.info ? `, ${s.counts.info} info` : ''
  })`;
  const lines = [head];
  for (const f of s.findings)
    lines.push(`  ${f.level.padEnd(6)} line ${String(f.line).padStart(3)}  ${f.text}${f.excerpt ? `: ${JSON.stringify(f.excerpt)}` : ''}`);
  return lines;
}

/** The short form stored in queue.json (level, counts, when, for which hash); the full list is printed, not stored. */
function scanSummary(scan, sha256, at = new Date().toISOString()) {
  return { level: scan.level, red: scan.counts.red, yellow: scan.counts.yellow, sha256, at };
}

module.exports = { scanHelper, scanText, scanSummary, readFrontmatter, DOC_DOMAINS, KEY_KIND, RED_TOOLS, LONG_LINE };
