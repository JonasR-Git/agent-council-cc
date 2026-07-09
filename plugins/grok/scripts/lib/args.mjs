export function splitRawArgumentString(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    let name = token.startsWith("--") ? token.slice(2) : token.slice(1);
    let inlineValue = null;
    if (name.includes("=")) {
      const eq = name.indexOf("=");
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    name = aliasMap[name] ?? name;

    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }

    if (valueOptions.has(name)) {
      if (inlineValue != null) {
        options[name] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next == null || next.startsWith("-")) {
        throw new Error(`Missing value for --${name}`);
      }
      options[name] = next;
      i += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}
