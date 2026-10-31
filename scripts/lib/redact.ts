// Credential redaction. Best-effort and deterministic; the gate in
// findings.ts refuses any finding that still matches a pattern.

interface Pat { re: RegExp; keepPrefix: boolean }

// Order matters: specific token formats first, generic key=value last.
export const PATTERNS: Pat[] = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, keepPrefix: false },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, keepPrefix: false },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, keepPrefix: false },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, keepPrefix: false },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, keepPrefix: false },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, keepPrefix: false },
  { re: /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}\b/g, keepPrefix: false },
  { re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g, keepPrefix: false },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keepPrefix: false },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, keepPrefix: false },
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi, keepPrefix: true },
  {
    re: /((?:password|passwd|pwd|api[_-]?key|secret|token|access[_-]?key|private[_-]?key|client[_-]?secret|auth)["']?\s*[:=]\s*["']?)(?![\s"']|\[REDACTED\]|\*{3}|[A-Za-z0-9]{0,4}\*{4}|[A-Za-z_$][\w$]*\s*[.(\[]|\$|\{|%|<|None\b|null\b|undefined\b|true\b|false\b)([^\s"',;)}]{4,})/gi,
    keepPrefix: true,
  },
];

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { re, keepPrefix } of PATTERNS) {
    out = out.replace(re, (m: string, g1?: string) => {
      count++;
      if (!keepPrefix || typeof g1 !== "string") return "[REDACTED]";
      // URL credentials: keep scheme+user, drop the password.
      if (m.endsWith("@")) return m.slice(0, m.length - g1.length - 1) + "[REDACTED]@";
      return g1 + "[REDACTED]";
    });
  }
  return { text: out, count };
}

/** True when the text still contains a credential-shaped value. */
export function hasSecret(text: string): boolean {
  return PATTERNS.some(({ re }) => { re.lastIndex = 0; const hit = re.test(text); re.lastIndex = 0; return hit; });
}

/** Deep-redact every string in a JSON value. */
export function redactValue<T>(v: T): { value: T; count: number } {
  let count = 0;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") { const r = redact(x); count += r.count; return r.text; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return { value: walk(v) as T, count };
}
