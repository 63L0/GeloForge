/**
 * Strict zero-dependency YAML 1.2 subset parser and Markdown frontmatter extractor.
 * Supports block mappings, nested mappings, block sequences (scalars and nested maps),
 * quoted and plain scalars, numbers, booleans, null, empty []/{}, simple inline scalar
 * arrays, and literal/folded block scalars (| and >).
 * Rejects tab indentation, duplicate mapping keys, unclosed quotes, and unquoted {{...}}.
 */

function stripComment(line, lineNumber, sourceLabel) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") {
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " ")) {
      return line.slice(0, i);
    }
  }
  if (inSingle || inDouble) {
    throw new Error(`${sourceLabel}:${lineNumber}: Unclosed string quote`);
  }
  return line;
}

function trySplitKeyValue(trimmed, lineNumber, sourceLabel) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inSingle) {
      if (ch === "'" && trimmed[i + 1] === "'") {
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ":" && (i + 1 === trimmed.length || trimmed[i + 1] === " ")) {
      const rawKey = trimmed.slice(0, i).trim();
      const rawVal = trimmed.slice(i + 1).trim();
      if (!rawKey) {
        throw new Error(`${sourceLabel}:${lineNumber}: Empty mapping key`);
      }
      const key = parseScalar(rawKey, lineNumber, sourceLabel);
      if (typeof key !== "string" || key.length === 0) {
        throw new Error(`${sourceLabel}:${lineNumber}: Mapping key must be a non-empty string`);
      }
      return { key, rawVal };
    }
  }
  return null;
}

function splitKeyValue(trimmed, lineNumber, sourceLabel) {
  const pair = trySplitKeyValue(trimmed, lineNumber, sourceLabel);
  if (!pair) {
    throw new Error(`${sourceLabel}:${lineNumber}: Expected mapping "key: value", got "${trimmed}"`);
  }
  return pair;
}

function unescapeDoubleQuoted(raw, lineNumber, sourceLabel) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= raw.length) {
      throw new Error(`${sourceLabel}:${lineNumber}: Trailing backslash in double-quoted string`);
    }
    const esc = raw[i];
    switch (esc) {
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "/":
        out += "/";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "u": {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error(`${sourceLabel}:${lineNumber}: Invalid \\uXXXX escape`);
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new Error(`${sourceLabel}:${lineNumber}: Unsupported escape "\\${esc}"`);
    }
  }
  return out;
}

function parseInlineArray(raw, lineNumber, sourceLabel) {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  const items = [];
  let token = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inSingle) {
      token += ch;
      if (ch === "'" && inner[i + 1] === "'") {
        token += inner[i + 1];
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      token += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        token += inner[i + 1];
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      token += ch;
    } else if (ch === '"') {
      inDouble = true;
      token += ch;
    } else if (ch === ",") {
      const trimmed = token.trim();
      if (!trimmed) {
        throw new Error(`${sourceLabel}:${lineNumber}: Empty item in inline array`);
      }
      items.push(parseScalar(trimmed, lineNumber, sourceLabel));
      token = "";
    } else {
      token += ch;
    }
  }
  const last = token.trim();
  if (!last) {
    throw new Error(`${sourceLabel}:${lineNumber}: Trailing comma in inline array`);
  }
  items.push(parseScalar(last, lineNumber, sourceLabel));
  return items;
}

function parseScalar(raw, lineNumber, sourceLabel) {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") {
    return null;
  }
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  if (s === "{}") {
    return {};
  }
  if (s === "[]") {
    return [];
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) {
      throw new Error(`${sourceLabel}:${lineNumber}: Malformed double-quoted scalar`);
    }
    return unescapeDoubleQuoted(s.slice(1, -1), lineNumber, sourceLabel);
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) {
      throw new Error(`${sourceLabel}:${lineNumber}: Malformed single-quoted scalar`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    return parseInlineArray(s, lineNumber, sourceLabel);
  }
  if (s.startsWith("{") || s.startsWith("[")) {
    throw new Error(
      `${sourceLabel}:${lineNumber}: Unsupported or unquoted flow collection (quote placeholders like "{{TOKEN}}")`
    );
  }
  if (/^-?(0|[1-9][0-9]*)$/.test(s)) {
    return Number.parseInt(s, 10);
  }
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(s)) {
    return Number.parseFloat(s);
  }
  return s;
}

function tokenizeLines(text, sourceLabel) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  const tokens = [];

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const lineNumber = idx + 1;
    const rawLine = rawLines[idx];
    const indentMatch = rawLine.match(/^[ \t]*/);
    const leading = indentMatch ? indentMatch[0] : "";
    if (leading.includes("\t")) {
      throw new Error(`${sourceLabel}:${lineNumber}: Tabs are forbidden in YAML indentation`);
    }
    const stripped = stripComment(rawLine, lineNumber, sourceLabel);
    const trimmed = stripped.trim();
    if (trimmed === "") {
      continue;
    }
    if ((trimmed === "---" || trimmed === "...") && leading.length === 0) {
      continue;
    }
    tokens.push({
      lineNumber,
      indent: leading.length,
      trimmed,
      rawLine,
    });
  }
  return tokens;
}

function parseBlockScalar(tokens, startIndex, parentIndent, indicator) {
  const mode = indicator[0]; // '|' or '>'
  const chomp = indicator.slice(1); // '' or '-' or '+'
  const lines = [];
  let blockIndent = null;
  let i = startIndex;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent <= parentIndent) {
      break;
    }
    if (blockIndent === null) {
      blockIndent = tok.indent;
    }
    lines.push(tok.rawLine.slice(blockIndent));
    i += 1;
  }

  let joined = mode === ">" ? lines.join(" ") : lines.join("\n");
  if (chomp !== "-") {
    joined += "\n";
  }
  return { value: joined, nextIndex: i };
}

function parseBlockValue(tokens, index, parentIndent, sourceLabel, allowSameIndentSeq = false) {
  if (index >= tokens.length) {
    return { value: null, nextIndex: index };
  }
  const next = tokens[index];
  const isSeqStart = next.trimmed === "-" || next.trimmed.startsWith("- ");
  if (isSeqStart && (next.indent > parentIndent || (allowSameIndentSeq && next.indent === parentIndent))) {
    return parseSequence(tokens, index, next.indent, sourceLabel);
  }
  if (next.indent <= parentIndent) {
    return { value: null, nextIndex: index };
  }
  if (isSeqStart) {
    return parseSequence(tokens, index, next.indent, sourceLabel);
  }
  return parseMapping(tokens, index, next.indent, sourceLabel);
}

function parseSequence(tokens, startIndex, seqIndent, sourceLabel) {
  const arr = [];
  let i = startIndex;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent < seqIndent) {
      break;
    }
    if (tok.indent > seqIndent) {
      throw new Error(`${sourceLabel}:${tok.lineNumber}: Unexpected sequence indentation (${tok.indent} > ${seqIndent})`);
    }
    if (tok.trimmed !== "-" && !tok.trimmed.startsWith("- ")) {
      break;
    }

    const afterDash = tok.trimmed.slice(1).trim();
    if (afterDash === "") {
      const child = parseBlockValue(tokens, i + 1, seqIndent, sourceLabel, false);
      arr.push(child.value);
      i = child.nextIndex;
      continue;
    }

    const inlineMapping = trySplitKeyValue(afterDash, tok.lineNumber, sourceLabel);
    if (inlineMapping) {
      // Inline mapping entry inside a sequence item: "- key: val"
      const obj = {};
      const itemIndent = tok.indent + 2;
      const { key, rawVal } = inlineMapping;
      i += 1;
      if (rawVal === "" || rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
        if (rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
          const blk = parseBlockScalar(tokens, i, itemIndent, rawVal);
          obj[key] = blk.value;
          i = blk.nextIndex;
        } else {
          const child = parseBlockValue(tokens, i, itemIndent, sourceLabel, true);
          obj[key] = child.value;
          i = child.nextIndex;
        }
      } else {
        obj[key] = parseScalar(rawVal, tok.lineNumber, sourceLabel);
      }

      // Consume remaining keys at itemIndent belonging to this same list-item object.
      while (i < tokens.length && tokens[i].indent >= itemIndent) {
        const subTok = tokens[i];
        if (subTok.indent > itemIndent) {
          throw new Error(`${sourceLabel}:${subTok.lineNumber}: Unexpected indentation inside sequence mapping`);
        }
        if (subTok.trimmed === "-" || subTok.trimmed.startsWith("- ")) {
          break;
        }
        const subKv = splitKeyValue(subTok.trimmed, subTok.lineNumber, sourceLabel);
        if (Object.hasOwn(obj, subKv.key)) {
          throw new Error(`${sourceLabel}:${subTok.lineNumber}: Duplicate key "${subKv.key}"`);
        }
        i += 1;
        if (subKv.rawVal === "|" || subKv.rawVal === "|-" || subKv.rawVal === ">" || subKv.rawVal === ">-") {
          const blk = parseBlockScalar(tokens, i, itemIndent, subKv.rawVal);
          obj[subKv.key] = blk.value;
          i = blk.nextIndex;
        } else if (subKv.rawVal === "") {
          const child = parseBlockValue(tokens, i, itemIndent, sourceLabel, true);
          obj[subKv.key] = child.value;
          i = child.nextIndex;
        } else {
          obj[subKv.key] = parseScalar(subKv.rawVal, subTok.lineNumber, sourceLabel);
        }
      }
      arr.push(obj);
      continue;
    }

    arr.push(parseScalar(afterDash, tok.lineNumber, sourceLabel));
    i += 1;
  }

  return { value: arr, nextIndex: i };
}

function parseMapping(tokens, startIndex, mapIndent, sourceLabel) {
  const obj = {};
  let i = startIndex;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent < mapIndent) {
      break;
    }
    if (tok.indent > mapIndent) {
      throw new Error(`${sourceLabel}:${tok.lineNumber}: Unexpected mapping indentation (${tok.indent} > ${mapIndent})`);
    }
    if (tok.trimmed === "-" || tok.trimmed.startsWith("- ")) {
      break;
    }

    const { key, rawVal } = splitKeyValue(tok.trimmed, tok.lineNumber, sourceLabel);
    if (Object.hasOwn(obj, key)) {
      throw new Error(`${sourceLabel}:${tok.lineNumber}: Duplicate mapping key "${key}"`);
    }
    i += 1;

    if (rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
      const blk = parseBlockScalar(tokens, i, mapIndent, rawVal);
      obj[key] = blk.value;
      i = blk.nextIndex;
    } else if (rawVal === "") {
      const child = parseBlockValue(tokens, i, mapIndent, sourceLabel, true);
      obj[key] = child.value;
      i = child.nextIndex;
    } else {
      obj[key] = parseScalar(rawVal, tok.lineNumber, sourceLabel);
    }
  }

  return { value: obj, nextIndex: i };
}

export function parseYaml(text, sourceLabel = "<yaml>") {
  const tokens = tokenizeLines(text, sourceLabel);
  if (tokens.length === 0) {
    return null;
  }
  const first = tokens[0];
  if (first.indent !== 0) {
    throw new Error(`${sourceLabel}:${first.lineNumber}: Root YAML element must start at column 0`);
  }
  const result =
    first.trimmed === "-" || first.trimmed.startsWith("- ")
      ? parseSequence(tokens, 0, 0, sourceLabel)
      : parseMapping(tokens, 0, 0, sourceLabel);

  if (result.nextIndex < tokens.length) {
    const leftover = tokens[result.nextIndex];
    throw new Error(`${sourceLabel}:${leftover.lineNumber}: Unexpected trailing YAML token "${leftover.trimmed}"`);
  }
  return result.value;
}

export function extractFrontmatter(markdownText, sourceLabel = "<markdown>") {
  const normalized = markdownText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`${sourceLabel}: Missing opening YAML frontmatter delimiter "---" on line 1`);
  }
  const closeIdx = normalized.indexOf("\n---", 3);
  if (closeIdx === -1) {
    throw new Error(`${sourceLabel}: Missing closing YAML frontmatter delimiter "---"`);
  }
  const afterClose = normalized.slice(closeIdx + 4);
  if (afterClose.length > 0 && !afterClose.startsWith("\n")) {
    throw new Error(`${sourceLabel}: Invalid closing YAML frontmatter delimiter`);
  }
  const yamlBlock = normalized.slice(4, closeIdx);
  return parseYaml(yamlBlock, `${sourceLabel} (frontmatter)`);
}
