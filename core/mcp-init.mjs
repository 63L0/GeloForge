import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertSafeWithinRoot, isForbiddenSecretPath } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { runMultiFileTransaction, withProjectLock } from "./project-lock.mjs";

const DEFAULT_CLIENTS = ["cursor", "vscode", "claude", "gemini"];
export const MCP_CLIENTS = {
  cursor: {
    config: ".cursor/mcp.json", key: "mcpServers",
    rules: ".cursor/rules/geloforge.mdc", frontmatter: "---\nalwaysApply: true\n---\n\n",
  },
  vscode: {
    config: ".vscode/mcp.json", key: "servers", type: "stdio",
    rules: ".github/instructions/geloforge.instructions.md", frontmatter: "---\napplyTo: '**'\n---\n\n",
  },
  claude: {
    config: ".mcp.json", key: "mcpServers", type: "stdio", rules: ".claude/rules/geloforge.md",
  },
  gemini: { config: ".gemini/settings.json", key: "mcpServers", rules: "GEMINI.md", appendRules: true },
  antigravity: { config: ".agents/mcp_config.json", key: "mcpServers", rules: "AGENTS.md", appendRules: true },
};
const CLIENTS = MCP_CLIENTS;

const START = "<!-- geloforge:mcp-init:start -->";
const END = "<!-- geloforge:mcp-init:end -->";
const RELEASE_ARCHIVE = /^https:\/\/github\.com\/63L0\/GeloForge\/releases\/download\/v(\d+\.\d+\.\d+)\/geloforge-\1\.tgz$/;

function readConfigFile(projectDir, relativePath) {
  const filePath = assertSafeWithinRoot(projectDir, relativePath);
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Expected a regular project file at ${relativePath}.`);
  return { filePath, relativePath, original: stat ? fs.readFileSync(filePath, "utf8") : null, mode: stat ? stat.mode & 0o777 : undefined };
}

export function parseConfig(source, filename) {
  // Keep source offsets so we can edit server fields without rewriting comments and other settings.
  const lexemes = [...source.matchAll(/"(?:[^"\\]|\\[\s\S])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[^\s]/g)];
  const tokens = lexemes.filter(([token]) => !token.startsWith("//") && !token.startsWith("/*"));
  const trailingCommas = new Set(tokens.filter(([token], index) =>
    token === "," && ["}", "]"].includes(tokens[index + 1]?.[0])));
  let clean = "";
  let offset = 0;
  for (const token of lexemes) {
    const [raw] = token;
    if (raw.startsWith("//") || raw.startsWith("/*") || trailingCommas.has(token)) {
      clean += source.slice(offset, token.index) + raw.replace(/[^\r\n]/g, " ");
      offset = token.index + raw.length;
    }
  }
  clean += source.slice(offset);
  let data;
  try {
    data = JSON.parse(clean.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in ${filename}. Fix the project configuration and retry.`);
  }
  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new Error(`Expected a JSON object in ${filename}.`);
  }
  return { tokens, data };
}

function readObject(tokens, open, key) {
  let index = open + 1;
  let last = null;
  let member = null;
  while (tokens[index][0] !== "}") {
    const name = JSON.parse(tokens[index][0]);
    const value = index + 2;
    let end = value;
    let depth = 0;
    while (end < tokens.length) {
      const [token] = tokens[end];
      if (depth === 0 && [",", "}"].includes(token)) break;
      if (token === "{" || token === "[") depth += 1;
      if (token === "}" || token === "]") depth -= 1;
      end += 1;
    }
    const comma = tokens[end][0] === ",";
    last = { keyToken: tokens[index], value, lastValueToken: tokens[end - 1], comma };
    if (name === key) {
      if (member) throw new Error(`Project MCP configuration contains duplicate ${key} keys.`);
      member = last;
    }
    index = comma ? end + 1 : end;
  }
  return { member, last, close: tokens[index] };
}

function editProperty(source, filename, keys, value) {
  const { tokens } = parseConfig(source, filename);
  let open = 0;
  for (const key of keys.slice(0, -1)) open = readObject(tokens, open, key).member.value;
  const key = keys.at(-1);
  const { member, last, close } = readObject(tokens, open, key);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = source.lastIndexOf("\n", close.index - 1) + 1;
  const closingIndent = source.slice(lineStart, close.index);
  const ownLine = /^\s*$/.test(closingIndent);
  const indent = ownLine ? closingIndent : "";
  const propertyIndent = `${indent}  `;
  const rendered = JSON.stringify(value, null, 2).replaceAll("\n", `${eol}${propertyIndent}`);
  if (member) {
    const valueEnd = member.lastValueToken.index + member.lastValueToken[0].length;
    return source.slice(0, tokens[member.value].index) + rendered + source.slice(valueEnd);
  }
  const insert = ownLine ? lineStart : close.index;
  const commaAt = last ? last.lastValueToken.index + last.lastValueToken[0].length : insert;
  const separator = last && !last.comma ? "," : "";
  return source.slice(0, commaAt) + separator + source.slice(commaAt, insert) +
    (ownLine ? "" : eol) + `${propertyIndent}${JSON.stringify(key)}: ${rendered}${eol}` + source.slice(insert);
}

function isGeloForgeServer(server) {
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) return false;
  if (server.type && server.type !== "stdio") return false;
  const command = server.command.split(/[\\/]/).at(-1);
  const args = server.args;
  if (/^geloforge(?:\.cmd)?$/i.test(command)) return args[0] === "mcp";
  if (/^npx(?:\.cmd)?$/i.test(command)) return args.some((arg) => /^geloforge(?:@\d.*)?$/.test(arg)) && args.includes("mcp");
  if (!/^node(?:\.exe)?$/i.test(command)) return false;
  return (args[1] === "mcp" && /(?:^|[\\/])geloforge\.mjs$/.test(args[0])) ||
    (args[1] === "exec" && args.some((arg) => /^geloforge@\d/.test(arg) || RELEASE_ARCHIVE.test(arg)) && args.includes("mcp"));
}

function updateServer(file, client, server) {
  const filename = file.relativePath;
  const source = file.original ?? "{}\n";
  const { tokens, data } = parseConfig(source, filename);
  if (!Object.hasOwn(data, client.key)) {
    return { data, content: editProperty(source, filename, [client.key], { geloforge: server }) };
  }
  const entries = data[client.key];
  if (!entries || Array.isArray(entries) || typeof entries !== "object") {
    throw new Error(`Expected ${client.key} to be an object in ${filename}.`);
  }
  // Check relevant duplicate keys even when the effective values already match.
  const map = readObject(tokens, 0, client.key).member;
  const target = readObject(tokens, map.value, "geloforge").member;
  if (!target) return { data, content: editProperty(source, filename, [client.key, "geloforge"], server) };
  if (!isGeloForgeServer(entries.geloforge)) {
    throw new Error(`The geloforge server name in ${filename} already belongs to a different command.`);
  }
  let content = source;
  for (const [key, value] of Object.entries(server)) {
    readObject(tokens, target.value, key);
    if (!isDeepStrictEqual(entries.geloforge[key], value)) {
      content = editProperty(content, filename, [client.key, "geloforge", key], value);
    }
  }
  return { data, content };
}

function updateRules(file, { frontmatter = "", appendRules = false, readOnly }) {
  const original = file.original ?? "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    START,
    "## GeloForge workflow",
    "",
    "- At the start of project work, call `geloforge_recommend` and review pending approvals.",
    "- Before auditing, debugging, or making changes, call `geloforge_context` with the task ID or a short query and `skills: true`.",
    "- Follow relevant skills returned with the context. If none match, continue with the project rules. Record any skills used in the handoff.",
    ...(readOnly ? [
      "- Use `geloforge_task` and `geloforge_checkpoint` to read task and checkpoint history.",
    ] : [
      "- Use `geloforge_task` to find or create the task and claim the intended file scope before editing. Respect lease collisions.",
      "- Use `geloforge_checkpoint` to record progress and verified evidence before handoff.",
    ]),
    END,
  ].join(eol);
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  if (start === -1 && end === -1) {
    if (original && !appendRules) throw new Error(`Existing rule ${file.relativePath} has no GeloForge section.`);
    return original ? `${original}${eol}${eol}${block}${eol}` : `${frontmatter}${block}${eol}`;
  }
  if (start === -1 || end < start || original.lastIndexOf(START) !== start || original.lastIndexOf(END) !== end) {
    throw new Error(`Invalid GeloForge section markers in ${file.relativePath}.`);
  }
  return original.slice(0, start) + block + original.slice(end + END.length);
}

function launchCommand({ projectDir, harnessDir, readOnly }) {
  const args = ["mcp", "--project", projectDir];
  if (readOnly) args.push("--read-only");
  const npm = process.env.npm_execpath;
  if (harnessDir.split(path.sep).includes("_npx") && npm && path.isAbsolute(npm) && fs.existsSync(npm)) {
    let installed;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(harnessDir, "..", "..", "package-lock.json"), "utf8"));
      installed = lock.packages?.["node_modules/geloforge"];
    } catch {
      // An npm cache without installation metadata still has the local CLI.
    }
    const version = installed?.version;
    const archive = `geloforge-${version}.tgz`;
    const npmArchive = `https://registry.npmjs.org/geloforge/-/${archive}`;
    const githubArchive = `https://github.com/63L0/GeloForge/releases/download/v${version}/${archive}`;
    const source = installed?.resolved === npmArchive ? `geloforge@${version}` : installed?.resolved;
    if (/^\d+\.\d+\.\d+$/.test(version) && (installed.resolved === npmArchive || source === githubArchive)) {
      return { command: process.execPath, args: [npm, "exec", "--yes", "--package", source, "--", "geloforge", ...args] };
    }
  }
  return { command: process.execPath, args: [path.join(harnessDir, "scripts", "geloforge.mjs"), ...args] };
}

export function initMcpClients({ projectDir, harnessDir, clients, dryRun = false, readOnly = false }) {
  const names = clients?.length ? [...new Set(clients)] : DEFAULT_CLIENTS;
  for (const name of names) {
    if (!Object.hasOwn(CLIENTS, name)) throw new Error(`Unknown MCP client "${name}". Use cursor, vscode, claude, gemini, or antigravity.`);
  }
  const run = () => {
    loadProjectManifestAndState(projectDir, harnessDir);
    const launch = launchCommand({ projectDir, harnessDir, readOnly });
    const edits = names.flatMap((name) => {
      const client = CLIENTS[name];
      const config = readConfigFile(projectDir, client.config);
      const entry = client.type ? { type: client.type, ...launch } : launch;
      const { data, content } = updateServer(config, client, entry);
      const gemini = name === "gemini";
      const customContext = gemini ? data.context?.fileName : null;
      const contextName = Array.isArray(customContext) ? customContext[0] : customContext;
      const rulesPath = contextName || client.rules;
      if (typeof rulesPath !== "string" || !/\.mdc?$/i.test(rulesPath) || isForbiddenSecretPath(rulesPath)) {
        throw new Error(`Invalid project instruction file name for ${name}.`);
      }
      const rules = readConfigFile(projectDir, rulesPath);
      return [
        { ...config, content },
        { ...rules, content: updateRules(rules, { frontmatter: client.frontmatter, appendRules: client.appendRules, readOnly }) },
      ];
    });
    const destinations = edits.map(({ filePath }) => process.platform === "win32" ? filePath.toLowerCase() : filePath);
    if (new Set(destinations).size !== edits.length) {
      throw new Error("MCP clients reference the same project instruction file. Select separate instruction files for each client.");
    }
    const files = edits.map(({ relativePath, original, content }) => ({
      path: relativePath,
      action: original === content ? "unchanged" : original === null ? "create" : "update",
    }));
    if (!dryRun) {
      // Configs may contain other servers' credentials. Keep rollback data in memory.
      const writes = edits.filter(({ original, content }) => original !== content);
      runMultiFileTransaction(writes.map(({ filePath, content, mode }) => ({ filePath, content, mode })));
    }
    return { projectDir, clients: names, dryRun, readOnly, files };
  };
  return dryRun ? run() : withProjectLock(projectDir, run);
}
