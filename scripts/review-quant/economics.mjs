// Numeric support for docs/proofs/economics/05-review-gapfills.tex.md
// Exact integer/rational arithmetic; no deps. Run: node scripts/review-quant/economics.mjs
// Every constant is cited in the doc; this script is the reproducible
// derivation of every number that appears in the tables.

const SAT = (x) => x.toLocaleString('en-US');

// ── shipped / spec-pinned parameters (00-model §5) ──────────────────────────
const SIGMA = 0.02; // stake = max(0.02 * volume, 5000)  escrow.ts:147
const ALPHA_I = 0.5; // incoherent slash                 escrow.ts:96
const STAKE_FLOOR = 5000; //                              escrow.ts:147
const DELTA = 0.95; // A1
const J = 3500; // sats/epoch steady state              spec L223
const P_EJECT = 0.5; //                                  A7
const L_STREAM = J / (1 - DELTA); // 70,000
const STREAM_TERM = DELTA * P_EJECT * L_STREAM; // 33,250
const BLOCK_REWARD_SATS = 312_500_000; // 3.125 BTC post-2024 halving

console.log('L_stream =', SAT(L_STREAM), ' delta*p_eject*L =', SAT(STREAM_TERM));

// ── 1. capture probability: exact binomial tail ────────────────────────────
function binom(n, k) {
  if (k < 0 || k > n) return 0n;
  let v = 1n;
  for (let i = 0n; i < BigInt(k); i++) v = (v * (BigInt(n) - i)) / (i + 1n);
  return v;
}
function exact(n, p, q, lo, hi) {
  let num = 0n;
  for (let k = lo; k <= Math.min(hi, n); k++) {
    num += binom(n, k) * p ** BigInt(k) * (q - p) ** BigInt(n - k);
  }
  return { num, den: q ** BigInt(n) };
}
function sci(num, den, sig = 4) {
  let e = 0, n = num, d = den;
  while (n >= d * 10n) { d *= 10n; e++; }
  while (n < d) { n *= 10n; e--; }
  const m = (n * 10n ** BigInt(sig)) / d;
  return `${(Number(m) / 10 ** sig).toFixed(sig)}e${e}`;
}
function dec3(x) {
  // sig-figure string from a JS float, for percentages
  if (x === 0) return '0';
  const e = Math.floor(Math.log10(x));
  if (e >= -3 && e < 0) return (x * 100).toFixed(6) + '%';
  return x.toExponential(3) + ' (' + (x * 100).toExponential(2) + '%)';
}

const RHOS = [[1, 3], [2, 5], [9, 20], [49, 100]];
const rhoLabel = { '1/3': '⅓ (0.333)', '2/5': '0.40', '9/20': '0.45', '49/100': '0.49' };

console.log('\n=== capture table (exact binomial) ===');
for (const N of [15, 45, 105, 201]) {
  const t = Math.ceil((2 * N) / 3);
  const cells = RHOS.map(([p, q]) => {
    const { num, den } = exact(N, BigInt(p), BigInt(q), t, N);
    return `${p}/${q}: ${sci(num, den)}`;
  });
  console.log(`N=${N} t=${t} mu(rho=1/3)=${(N / 3).toFixed(2)}  ` + cells.join('  '));
}
console.log('--- shipped ladder panels: 5,15,45,135,405 ---');
for (const N of [5, 15, 45, 135, 405]) {
  const t = Math.ceil((2 * N) / 3);
  const cells = RHOS.map(([p, q]) => {
    const { num, den } = exact(N, BigInt(p), BigInt(q), t, N);
    return `${p}/${q}: ${sci(num, den)}`;
  });
  console.log(`N=${N} t=${t}  ` + cells.join('  '));
}
console.log('--- shipped round-0 quorum 3-of-5 (0.6 < 2/3) ---');
for (const [p, q] of RHOS) {
  const { num, den } = exact(5, BigInt(p), BigInt(q), 3, 5);
  console.log(`3-of-5 rho=${p}/${q}: ${sci(num, den)}`);
}
console.log('--- round-0 quorum sweep, N=5 (courtConfirmationMachine.ts:223 defaults confirmQuorum to 1) ---');
for (const [p, q] of [[1, 3], [49, 100]]) {
  const cells = [];
  for (let tq = 1; tq <= 5; tq++) {
    const { num, den } = exact(5, BigInt(p), BigInt(q), tq, 5);
    cells.push(`q=${tq}: ${sci(num, den)}`);
  }
  console.log(`rho=${p}/${q}  ` + cells.join('  '));
}

// ── 1b. minimum panel size for a capture-probability target ────────────────
function minN(tn, td, p, q, lim = 6000) {
  for (let n = 3; n <= lim; n++) {
    const t = Math.ceil((2 * n) / 3);
    const { num, den } = exact(n, BigInt(p), BigInt(q), t, n);
    if (num * BigInt(td) <= BigInt(tn) * den) return n;
  }
  return null;
}
console.log('\n=== minimum N such that P(capture) <= target ===');
for (const [p, q, tag] of [[1, 3, 'rho=1/3'], [2, 5, 'rho=0.40'], [9, 20, 'rho=0.45'], [49, 100, 'rho=0.49']]) {
  const row = [[1, 1000, '1e-3'], [1, 10000, '1e-4'], [1, 1e6, '1e-6'], [1, 1e9, '1e-9'], [1, 1e12, '1e-12']]
    .map(([tn, td, lab]) => `${lab}:${minN(tn, td, p, q)}`).join(' ');
  console.log(`${tag}  ${row}`);
}

// ── 2. cost-of-corruption: V_max per rail ─────────────────────────────────
// Resistance: V <= t * (p_flip * alpha * sigma * V + delta*p_eject*L) + kappa*m
// => V_max = (t * stream + kappa*m) / (1 - t * p_flip * alpha * sigma)
function vmaxProportional(t, pFlip, sigma = SIGMA, alpha = ALPHA_I) {
  const x = t * pFlip * alpha * sigma;
  const num = t * STREAM_TERM;
  if (x >= 1) return { infinite: true, x, num };
  return { infinite: false, x, vmax: num / (1 - x), num };
}
console.log('\n=== V_max, staked rail, proportional stake (sigma=0.02, alpha=0.5) ===');
for (const pFlip of [1, 0.9]) {
  console.log(`-- p_flip = ${pFlip} --`);
  for (const N of [5, 15, 45, 105, 135, 201, 405]) {
    const t = Math.ceil((2 * N) / 3);
    const r = vmaxProportional(t, pFlip);
    const label = r.infinite
      ? `UNBOUNDED (t*alpha*p*sigma = ${r.x.toFixed(2)} >= 1)`
      : `${SAT(Math.round(r.vmax))} sats (t*ap sigma = ${r.x.toFixed(2)})`;
    console.log(`N=${N} t=${t}  V_max=${label}`);
  }
}
console.log('crossover seat count t where t*p*alpha*sigma = 1: p=1 ->', 1 / (0.5 * SIGMA), ' p=0.9 ->', 1 / (0.9 * 0.5 * SIGMA));

// floor-stake regime (V_m small enough that 0.02 V_m < 5000 i.e. V_m < 250k)
console.log('\n=== V_max, staked rail, FLOOR stake (s=5000), no V-proportional term ===');
for (const N of [5, 15, 45, 105, 135, 201, 405]) {
  const t = Math.ceil((2 * N) / 3);
  const v = t * (ALPHA_I * STAKE_FLOOR + STREAM_TERM); // p_flip=1
  console.log(`N=${N} t=${t}  V_max=${SAT(Math.round(v))} sats   (t*alpha*s = ${SAT(Math.round(t * ALPHA_I * STAKE_FLOOR))})`);
}

// lightnng rail: alpha = 0
console.log('\n=== V_max, LIGHTNING rail (alpha=0: nothing to seize) ===');
for (const N of [5, 15, 45, 105, 135, 201, 405]) {
  const t = Math.ceil((2 * N) / 3);
  console.log(`N=${N} t=${t}  V_max=${SAT(t * STREAM_TERM)} sats  <= stream-only, exit-evadable`);
}

// ── 2b. gamma invariant: V <= gamma * sum(S), gamma = alpha*p_flip ────────
console.log('\n=== market-cap invariant V <= gamma * sum(S), gamma = alpha*p_flip ===');
const GAMMA = ALPHA_I; // 0.5 at p_flip = 1
for (const N of [5, 15, 45, 105, 135, 201, 405]) {
  const t = Math.ceil((2 * N) / 3);
  const ratio = (GAMMA * N * SIGMA); // gamma*sum(S)/V in the proportional regime
  console.log(`N=${N} t=${t}  gamma*SigmaS/V = ${ratio.toFixed(3)}  ${ratio >= 1 ? 'INVARIANT HOLDS' : 'invariant FAILS (needs stream term)'}`);
}
console.log(`proportional crossover N (gamma*N*sigma = 1): ${(1 / (GAMMA * SIGMA)).toFixed(0)}`);
console.log(`floor-stake capped market value per seat: gamma*s = ${SAT(GAMMA * STAKE_FLOOR)} sats/seat`);
for (const N of [45, 135, 405]) {
  console.log(`  N=${N}: V_max(cap rule) = ${SAT(Math.round(GAMMA * N * STAKE_FLOOR))} sats`);
}
console.log('escrow needed for V=1,000,000 at gamma=0.5:', SAT(Math.round(1e6 / GAMMA)), 'sats bonded');
console.log('  at s=0.02V=20,000 -> seats needed', Math.ceil(1e6 / GAMMA / (SIGMA * 1e6)));
console.log('  at s=5,000 floor  -> seats needed', Math.ceil(1e6 / GAMMA / STAKE_FLOOR));

// ── 3. P+eps: the parasitic discount factor ───────────────────────────────
// Juror deviation, bribed minus honest, is +X with probability pi and -X with
// probability 1-pi (X = alpha*s + P/|C|, state-symmetric). A contract that pays
// R only in the losing state is accepted iff (2pi-1)X + (1-pi)R >= 0, so
// R = max(0, (1-2pi)X/(1-pi)) and the briber's EXPECTED cost is
// (1-pi)R = max(0, 1-2pi)*X  -- a discount factor of (1-2pi)^+ , zero at pi>=1/2.
console.log('\n=== P+eps: expected briber cost per juror, as a multiple of X ===');
for (const pi of [0, 0.25, 0.4, 0.45, 0.5, 0.6, 0.9, 0.99]) {
  const cost = Math.max(0, 1 - 2 * pi);
  const R = pi < 0.5 ? ((1 - 2 * pi) / (1 - pi)) : 0;
  console.log(`pi=${pi}  refund R/X = ${R.toFixed(3)}  expected cost/X = ${cost.toFixed(3)}`);
}

// ── 4. seed grinding: one-seat-decisive probability ────────────────────────
// The marginal value of a re-drawn seat is bounded by P(X = t-1) (one seat short)
console.log('\n=== seed grinding: P(exactly one seat short) = upper bound on DeltaP ===');
for (const N of [15, 45, 105, 201]) {
  const t = Math.ceil((2 * N) / 3);
  const cells = RHOS.map(([p, q]) => {
    const { num, den } = exact(N, BigInt(p), BigInt(q), t - 1, t - 1);
    return `${p}/${q}: ${sci(num, den)}`;
  });
  console.log(`N=${N} t=${t}  ` + cells.join('  '));
}
console.log('\nviability V > R_blk / DeltaP  (R_blk =', SAT(BLOCK_REWARD_SATS), 'sats = 3.125 BTC):');
for (const N of [15, 45, 105]) {
  const t = Math.ceil((2 * N) / 3);
  const cells = RHOS.map(([p, q]) => {
    const { num, den } = exact(N, BigInt(p), BigInt(q), t - 1, t - 1);
    const d = Number(num) / Number(den);
    const v = BLOCK_REWARD_SATS / d;
    return `${p}/${q}: V>${v.toExponential(2)} sats (${(v / 1e8).toExponential(2)} BTC)`;
  });
  console.log(`N=${N} t=${t}`);
  for (const c of cells) console.log('   ' + c);
}

// ── 5. sqrt-stake splitting ───────────────────────────────────────────────
console.log('\n=== sqrt-stake splitting: weight gain sqrt(k), ceiling from the 1% gate ===');
const C_GATE = 0.01; // selection.ts:275 stakeCapacity >= 0.01 * marketVolume
for (const [w, Vm] of [[1e6, 1e6], [1e7, 1e6], [1e6, 1e8]]) {
  const kmax = Math.floor(w / (C_GATE * Vm));
  const gain = Math.sqrt(Math.max(1, kmax));
  console.log(`w=${SAT(w)} V_m=${SAT(Vm)}  k_max=${kmax}  sqrt(k_max)=${gain.toFixed(2)}x weight gain, weight ${Math.sqrt(w).toFixed(2)} -> ${(Math.sqrt(kmax * w)).toFixed(2)}`);
}
// saturation: total weight = w / sqrt(c*Vm)  -> linear in w
console.log('saturated weight(w) = w / sqrt(c*Vm) -> LINEAR in w');
for (const Vm of [1e6, 1e8]) {
  const line = [1e6, 4e6, 16e6].map((w) => `${SAT(w)}->${(w / Math.sqrt(C_GATE * Vm)).toFixed(0)}`).join('  ');
  console.log(`V_m=${SAT(Vm)}: ${line}  (4x stake -> 4x weight)`);
}
