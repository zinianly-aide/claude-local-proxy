function assertSafeTestCommand(cmd) {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new Error("test_command is required");
  }
  const trimmed = cmd.trim();
  if (!/^(pnpm|npm|node|corepack)\b/i.test(trimmed)) {
    throw new Error("test_command must start with pnpm|npm|node|corepack");
  }

  const forbidden = [
    /(^|[\s|;&])rm(\s|$)/i,
    /(^|[\s|;&])sudo(\s|$)/i,
    /(^|[\s|;&])chmod(\s|$)/i,
    /(^|[\s|;&])chown(\s|$)/i,
    /curl\s*\|/i,
    /wget\s*\|/i,
    /\|\s*sh\b/i,
    /;/,
    /&&/,
    /\|\|/,
    /\$\(/,
    /`/,
    /\/etc\b/i,
    /\/var\b/i,
    /~\/\.ssh/i,
    />\s*\//,
    />>\s*\//
  ];

  for (const rule of forbidden) {
    if (rule.test(trimmed)) {
      throw new Error(`test_command blocked by rule: ${rule}`);
    }
  }

  if (trimmed.split(/\r?\n/).length > 1) {
    throw new Error("test_command must be a single line");
  }

  return trimmed;
}

export { assertSafeTestCommand };
