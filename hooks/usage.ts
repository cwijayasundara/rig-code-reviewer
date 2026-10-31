// Pure formatting helpers for the review dashboard (no mods-API calls here,
// so they can be unit-probed from node and reused by register.ts).
// Shapes, probed against Claude Code 2.1.316:
//   $.session.usage() -> { context: { tokens, window, percent }, cost: { usd }, rateLimits: [...] }
//   status.json usage  -> { totals: { input_tokens, output_tokens, total_cost_usd }, stages: [...] }

export interface LiveUsage {
  context?: { tokens?: number; window?: number; percent?: number };
  cost?: { usd?: number };
}

export interface RunUsage {
  totals?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
}

export function fmtTokens(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "$?";
  return "$" + n.toFixed(3);
}

// One compact line: live session context/cost, plus the accumulated
// review-run totals when status.json carries them.
export function usageSummary(live: LiveUsage | null, run: RunUsage | null): string {
  const parts: string[] = [];
  const ctx = live?.context;
  if (ctx && (ctx.tokens !== undefined || ctx.window !== undefined)) {
    const pct = ctx.percent !== undefined ? ` (${ctx.percent}%)` : "";
    parts.push(`${fmtTokens(ctx.tokens)}/${fmtTokens(ctx.window)}${pct}`);
  }
  if (live?.cost?.usd !== undefined) parts.push(fmtUsd(live.cost.usd));
  const t = run?.totals;
  if (t && (t.total_cost_usd || t.input_tokens || t.output_tokens)) {
    parts.push(`run ${fmtTokens((t.input_tokens ?? 0) + (t.output_tokens ?? 0))} tok · ${fmtUsd(t.total_cost_usd)}`);
  }
  return parts.length ? "⛽ " + parts.join(" · ") : "";
}

// Multi-line block for /review-dashboard.
export function usageDetail(live: LiveUsage | null, run: (RunUsage & { stages?: unknown[] }) | null): string[] {
  const lines: string[] = [];
  const ctx = live?.context;
  if (ctx) lines.push(`Session context: ${fmtTokens(ctx.tokens)}/${fmtTokens(ctx.window)} tokens (${ctx.percent ?? "?"}% of window)`);
  if (live?.cost?.usd !== undefined) lines.push(`Session cost: ${fmtUsd(live.cost.usd)}`);
  const t = run?.totals;
  if (t) {
    lines.push(`Review run: ${fmtTokens(t.input_tokens)} in / ${fmtTokens(t.output_tokens)} out · ${fmtUsd(t.total_cost_usd)} total`);
    const stages = (run as { stages?: { stage?: string; input_tokens?: number; output_tokens?: number; total_cost_usd?: number }[] }).stages ?? [];
    for (const s of stages) {
      lines.push(`  ${s.stage}: ${fmtTokens((s.input_tokens ?? 0) + (s.output_tokens ?? 0))} tok · ${fmtUsd(s.total_cost_usd)}`);
    }
  }
  return lines;
}
