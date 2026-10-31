// Momentum radar scoring engine (pure functions, no I/O). EMA, RSI and ADX were checked against TA-Lib.
//
// Five 0-100 scores per coin and day, each the average PERCENTILE RANK of its parts across the
// coin universe on that day. Scores are relative: 80 means "stronger than ~80% of the list today",
// not a forecast. Parts only use candles up to and including the scored day.
//
//   bull  (short-term push):   7-day return, close vs EMA20, taker-buy share of 7-day volume
//   accum (accumulation):      Chaikin money flow 20d, OBV change over 30d / volume, taker net buy 30d
//   risk  (higher = riskier):  30-day volatility, 30-day max drawdown, 30-day downside deviation
//   heat  (higher = hotter):   RSI 14, close vs EMA50, 3-day vs 30-day volume
//   sust  (lasting trend):     close vs EMA100, EMA50 change over 20d, share of up days in 90d, signed ADX 14

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; qv: number; tb: number };
export type Scores = { bull: number; accum: number; risk: number; heat: number; sust: number };

export const PARTS: Record<keyof Scores, string[]> = {
  bull: ["r7", "ema20", "buy7"],
  accum: ["cmf20", "obv30", "net30"],
  risk: ["vol30", "dd30", "down30"],
  heat: ["rsi14", "ema50", "surge"],
  sust: ["ema100", "slope50", "up90", "adx"],
};

export function ema(v: number[], p: number): (number | null)[] {
  const out: (number | null)[] = v.map(() => null);
  if (v.length < p) return out;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;   // seeded with the SMA, like TA-Lib
  out[p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

export function rsi(c: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = c.map(() => null);
  if (c.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// Wilder ADX with the sign of +DI - -DI (positive = up trend strength, negative = down trend)
export function signedAdx(k: Candle[], p = 14): (number | null)[] {
  const out: (number | null)[] = k.map(() => null);
  let tr = 0, pdm = 0, mdm = 0, adx: number | null = null;
  const first: number[] = [];
  for (let i = 1; i < k.length; i++) {
    const up = k[i].h - k[i - 1].h, dn = k[i - 1].l - k[i].l;
    const trI = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
    const pI = up > dn && up > 0 ? up : 0, mI = dn > up && dn > 0 ? dn : 0;
    if (i <= p) { tr += trI; pdm += pI; mdm += mI; if (i < p) continue; }
    else { tr = tr - tr / p + trI; pdm = pdm - pdm / p + pI; mdm = mdm - mdm / p + mI; }
    const pdi = tr ? 100 * pdm / tr : 0, mdi = tr ? 100 * mdm / tr : 0;
    const dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (adx === null) { first.push(dx); if (first.length === p) adx = first.reduce((a, b) => a + b, 0) / p; }
    else adx = (adx * (p - 1) + dx) / p;
    if (adx !== null) out[i] = pdi >= mdi ? adx : -adx;
  }
  return out;
}

const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Raw parts for day index i (null when there isn't enough history)
export function parts(k: Candle[], i: number, pre?: { e20: (number | null)[]; e50: (number | null)[]; e100: (number | null)[]; r14: (number | null)[]; adx: (number | null)[] }) {
  const c = k.map((x) => x.c);
  const P = pre ?? { e20: ema(c, 20), e50: ema(c, 50), e100: ema(c, 100), r14: rsi(c, 14), adx: signedAdx(k, 14) };
  const win = (n: number) => (i - n + 1 >= 0 ? k.slice(i - n + 1, i + 1) : null);
  const out: Record<string, number | null> = {};
  out.r7 = i >= 7 ? c[i] / c[i - 7] - 1 : null;
  out.ema20 = P.e20[i] ? c[i] / P.e20[i]! - 1 : null;
  const w7 = win(7), w30 = win(30), w20 = win(20), w90 = win(90), w3 = win(3);
  const sv = (w: Candle[]) => w.reduce((s, x) => s + x.v, 0);
  out.buy7 = w7 && sv(w7) ? w7.reduce((s, x) => s + x.tb, 0) / sv(w7) : null;
  out.cmf20 = w20 && sv(w20) ? w20.reduce((s, x) => s + (x.h > x.l ? ((x.c - x.l) - (x.h - x.c)) / (x.h - x.l) : 0) * x.v, 0) / sv(w20) : null;
  if (w30 && i >= 30 && sv(w30)) {
    let obv = 0;
    for (let j = i - 29; j <= i; j++) obv += c[j] > c[j - 1] ? k[j].v : c[j] < c[j - 1] ? -k[j].v : 0;
    out.obv30 = obv / sv(w30);
    out.net30 = w30.reduce((s, x) => s + 2 * x.tb - x.v, 0) / sv(w30);
    const rets = [];
    for (let j = i - 29; j <= i; j++) rets.push(Math.log(c[j] / c[j - 1]));
    out.vol30 = std(rets);
    out.down30 = Math.sqrt(rets.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / rets.length);
    let peak = -Infinity, dd = 0;
    for (const x of w30) { peak = Math.max(peak, x.c); dd = Math.max(dd, 1 - x.c / peak); }
    out.dd30 = dd;
    out.surge = w3 ? (sv(w3) / 3) / (sv(w30) / 30) : null;
  } else { out.obv30 = out.net30 = out.vol30 = out.down30 = out.dd30 = out.surge = null; }
  out.rsi14 = P.r14[i];
  out.ema50 = P.e50[i] ? c[i] / P.e50[i]! - 1 : null;
  out.ema100 = P.e100[i] ? c[i] / P.e100[i]! - 1 : null;
  out.slope50 = i >= 20 && P.e50[i] && P.e50[i - 20] ? P.e50[i]! / P.e50[i - 20]! - 1 : null;
  if (w90 && i >= 90) { let up = 0; for (let j = i - 89; j <= i; j++) if (c[j] > c[j - 1]) up++; out.up90 = up / 90; } else out.up90 = null;
  out.adx = P.adx[i];
  return out;
}

// Percentile rank (0-100) of each value among the non-null ones; ties share their average rank
export function percentiles(vals: (number | null)[]): (number | null)[] {
  const idx = vals.map((v, i) => [v, i] as const).filter(([v]) => v !== null && Number.isFinite(v)) as [number, number][];
  const out: (number | null)[] = vals.map(() => null);
  if (!idx.length) return out;
  if (idx.length === 1) { out[idx[0][1]] = 50; return out; }
  idx.sort((a, b) => a[0] - b[0]);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = ((i + j) / 2) / (idx.length - 1) * 100;
    for (let q = i; q <= j; q++) out[idx[q][1]] = r;
    i = j + 1;
  }
  return out;
}

// Scores for one day across the universe: rows = raw parts of each coin
export function scoreDay(rows: Record<string, number | null>[]): (Scores | null)[] {
  const pct: Record<string, (number | null)[]> = {};
  for (const ps of Object.values(PARTS)) for (const p of ps) pct[p] = percentiles(rows.map((r) => r[p] ?? null));
  return rows.map((_, i) => {
    const s: Partial<Scores> = {};
    for (const [name, ps] of Object.entries(PARTS) as [keyof Scores, string[]][]) {
      const v = ps.map((p) => pct[p][i]).filter((x): x is number => x !== null);
      // Need at least half of a score's parts, otherwise the coin has too little history for it
      s[name] = v.length >= Math.ceil(ps.length / 2) ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : (NaN as number);
    }
    return Object.values(s).some((x) => Number.isNaN(x)) ? null : s as Scores;
  });
}

export const STATES = ["extreme", "hot", "expand", "launch", "trend", "accum", "weak", "neutral"] as const;
export type State = typeof STATES[number];
// First match wins (most urgent first). Scores are relative ranks, so every state also needs an
// ABSOLUTE condition from the raw parts: in a falling market the "strongest" coin may still be
// falling, and that must not be called a breakout.
export function stateOf(s: Scores, p: Record<string, number | null> = {}): State {
  const pos = (k: string) => (p[k] ?? -1) > 0, neg = (k: string) => (p[k] ?? 1) < 0;
  const rsiv = p.rsi14 ?? 50, ext = p.ema50 ?? 0;
  if (s.risk >= 85 && s.heat >= 70 && (rsiv >= 60 || ext >= 0.15)) return "extreme";   // big swings while overheated
  if (s.heat >= 80 && (rsiv >= 65 || ext >= 0.15)) return "hot";
  if (s.bull >= 70 && s.sust >= 60 && pos("r7") && pos("ema20") && pos("ema100")) return "expand";   // push on a lasting trend
  if (s.bull >= 70 && pos("r7") && pos("ema20")) return "launch";                                   // push without a lasting trend yet
  if (s.sust >= 70 && s.bull >= 50 && s.risk < 60 && pos("ema100") && pos("slope50")) return "trend";
  if (s.accum >= 70 && s.bull < 55 && (pos("cmf20") || pos("net30"))) return "accum";               // money in before price moves
  if (s.bull < 30 && s.sust < 40 && neg("ema50")) return "weak";
  return "neutral";
}
