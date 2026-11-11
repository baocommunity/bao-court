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

// ══════════════════════════════════════════════════════════════════════════
// 6. EXPERT RE-VERIFY (round 30) — docs/proofs/economics/06-expert-verify.tex.md
//    Five attacks on the post-fix incentive layer. Every number in 06 §1–§5.
// ══════════════════════════════════════════════════════════════════════════
const A_F = 0.9;          // A4 accuracy on MANUFACTURED disputes
const RHO_REWARD = 0.03;  // challenger reward ratio (T1: rho <= beta, Lemma 1.1/1.2)
const BETA_SPEC = 0.03;   // spec symmetric bond (spec L213-214)
const BETA_ESCROW = 0.05; // escrow.ts:117-129 baseBond = max(5% V, 10_000)
const ECON_GAMMA = 0.45;  // host DEFAULT_COURT_ECON_GAMMA
const N0 = 5, GROWTH = 3, MAX_ROUNDS = 5, SHIPPED_ROUNDS = 2;

// ── 6.1 (r30-1) the one-bond escalation option ────────────────────────────
// Shipped marginal cost of escalation is 0: onEscalate only checks MEMBERSHIP of
// (idx, bondProofHash) in state.challenges (confirmationMachineHandlers.ts:546-552);
// no event carries a per-round bond. EV(R) = (1-a^R)*rho - a^R*beta.
console.log('\n=== r30-1: escalation with ONE bond, R rounds (EV as % of V) ===');
const farmEV = (R, a, rho, beta) => (1 - a ** R) * rho - a ** R * beta;
for (const [name, beta] of [['spec 3%', BETA_SPEC], ['escrow 5%', BETA_ESCROW]]) {
  const cells = [0, 1, 2, 3, 4, 5].map((R) => `R${R}:${(farmEV(R, A_F, RHO_REWARD, beta) * 100).toFixed(3)}%`);
  console.log(`${name.padEnd(10)} ${cells.join('  ')}`);
  const flip = Math.log(RHO_REWARD / (RHO_REWARD + beta)) / Math.log(A_F);
  console.log(`           flip round R > ${flip.toFixed(2)} (=> R >= ${Math.ceil(flip)}); protocol cap 5 => ${MAX_ROUNDS < flip ? 'SAFE' : 'EXPLOITABLE'}`);
}
console.log('deterrent retained at shipped cap R=2:', ((farmEV(2, A_F, RHO_REWARD, BETA_SPEC) / farmEV(1, A_F, RHO_REWARD, BETA_SPEC)) * 100).toFixed(1) + '%');
console.log('deterrent retained at protocol cap R=5:', ((farmEV(5, A_F, RHO_REWARD, BETA_SPEC) / farmEV(1, A_F, RHO_REWARD, BETA_SPEC)) * 100).toFixed(1) + '%');

// a_f sensitivity: the flip round is a function of a MEASURED quantity (A4).
console.log('\na_f sensitivity (spec bond): the cap rule maxLadderRounds <= floor(ln(rho/(rho+beta))/ln a_f)');
for (const af of [0.9, 0.85, 0.8, 0.75, 0.7]) {
  const flip = Math.log(RHO_REWARD / (RHO_REWARD + BETA_SPEC)) / Math.log(af);
  console.log(`  a_f=${af}: flip at R>=${Math.ceil(flip)}  EV(R2)=${(farmEV(2, af, RHO_REWARD, BETA_SPEC) * 100).toFixed(3)}%  EV(R3)=${(farmEV(3, af, RHO_REWARD, BETA_SPEC) * 100).toFixed(3)}%  EV(R5)=${(farmEV(5, af, RHO_REWARD, BETA_SPEC) * 100).toFixed(3)}%  cap=>${Math.floor(flip)}`);
}

// The venue side: a forced round r summons n_r = 5*3^r seats at a per-summon
// operator cost c_s, and the panel is owed the spec's 25-sat/juror floor. The
// 25-sat mass is funded from the loser's bond up to ell = 2% of V per CASE (not
// per round), so the unfunded part is what the venue actually pays:
//   venue(R) = sum_{r<=R} n_r*c_s + max(0, sum_{r<=R} 25*n_r - ell)
console.log('\nvenue cost of a forced round (V = 1,000,000, ell = 2% of V, escrow bond 50,000)');
const VE = 1_000_000, ELL = 0.02 * VE, BOND = Math.max(0.05 * VE, 10_000);
for (const cs of [250, 500, 1000]) {
  const row = [];
  for (let R = 1; R <= MAX_ROUNDS; R++) {
    let n = 0;
    for (let r = 1; r <= R; r++) n += N0 * GROWTH ** r;
    const venue = n * cs + Math.max(0, 25 * n - ELL);
    const griefer = -farmEV(R, A_F, RHO_REWARD, BETA_ESCROW) * VE;
    row.push(`R${R}: venue ${SAT(venue)} / griefer ${SAT(griefer)} = ${(venue / griefer).toFixed(2)}x`);
  }
  console.log(`  c_s=${cs}:  ${row.join('  ')}`);
}
console.log(`  25-sat fee floor, whole ladder: ${SAT(25 * N0 * (GROWTH + GROWTH ** 2 + GROWTH ** 3 + GROWTH ** 4 + GROWTH ** 5))} sats of fee mass vs ${SAT(ELL)} funded => ${SAT(25 * N0 * (GROWTH + GROWTH ** 2 + GROWTH ** 3 + GROWTH ** 4 + GROWTH ** 5) - ELL)} unfunded`);

// ── 6.2 (r30-2) the frozen ladder vs a shrinking cohort ───────────────────
// Invariant V <= gamma*sum(S) needs n >= ceil(V/(gamma*s0)) in the floor regime
// and n >= ceil(1/(gamma*sigma)) above the knee V_k = s0/sigma.
console.log('\n=== r30-2: minimum adjudicating panel N_min(V) ===');
const V_KNEE = STAKE_FLOOR / SIGMA;
const nMin = (v) => (v <= V_KNEE ? Math.max(Math.ceil(v / (ECON_GAMMA * STAKE_FLOOR)), 3) : Math.ceil(1 / (ECON_GAMMA * SIGMA)));
for (const v of [50_000, 100_000, 250_000, 500_000, 1_000_000, 10_000_000]) {
  console.log(`  V=${SAT(v)}: N_min=${nMin(v)}`);
}
console.log('gamma*sigma*N:', [45, 112, 135, 405].map((N) => `${N}:${(ECON_GAMMA * SIGMA * N).toFixed(3)}`).join('  '));
console.log(`  135 -> 45 churn: capacity ${(ECON_GAMMA * SIGMA * 45).toFixed(3)}V vs ${(ECON_GAMMA * SIGMA * 135).toFixed(3)}V => ${(1 / (ECON_GAMMA * SIGMA * 45)).toFixed(2)}x short`);
console.log(`  honest cap at 45 seats = gamma*s0*N = ${SAT(ECON_GAMMA * STAKE_FLOOR * 45)} sats; a 1M market is ${(1_000_000 / (ECON_GAMMA * STAKE_FLOOR * 45)).toFixed(2)}x over`);

// ── 6.3 (r30-3) the quorum the cap never reads ────────────────────────────
// The cap of 05 (5.2) credits the prize UNWEIGHTED, i.e. it is the pi = 1/2
// slice of V_max(pi) = [t(1-pi)*stream + kappa*m] / [pi - t(1-pi)*alpha*sigma]
// (p_flip = 1-pi). A weaker quorum RAISES pi and therefore TIGHTENS the cap.
console.log('\n=== r30-3: the pi-family of the cap (t=30, alpha*sigma=0.01) ===');
const piCap = (pi, t = 30) => (t * (1 - pi) * STREAM_TERM) / (pi - t * (1 - pi) * ALPHA_I * SIGMA);
for (const pi of [0.05, 0.235, 0.25, 0.3, 0.5, 0.7, 0.9, 0.99]) {
  const den = pi - 30 * (1 - pi) * ALPHA_I * SIGMA;
  console.log(`  pi=${pi}: ${den > 0 ? SAT(Math.round(piCap(pi))) + ' sats' : 'unbounded (no profitable bribe at any V)'}`);
}
console.log(`  shipped (5.2) = pi=1/2 slice: ${SAT(piCap(0.5))}  ==  t*stream/(1-t*alpha*sigma) = ${SAT((30 * STREAM_TERM) / (1 - 30 * ALPHA_I * SIGMA))}`);
const kappaN5 = (p, q) => {
  const lo = exact(5, BigInt(p), BigInt(q), 3, 5);
  const hi = exact(5, BigInt(p), BigInt(q), 4, 5);
  return { lo: Number(lo.num) / Number(lo.den), hi: Number(hi.num) / Number(hi.den) };
};
console.log('  kappa_q = pi(3-of-5)/pi(4-of-5) at N=5:');
for (const [p, q] of RHOS) {
  const { lo, hi } = kappaN5(p, q);
  console.log(`    rho=${p}/${q}: ${lo.toFixed(6)} / ${hi.toFixed(6)} = kappa ${(lo / hi).toFixed(4)}  (45-seat floor cap / kappa = ${SAT((ECON_GAMMA * STAKE_FLOOR * 45) / (lo / hi))})`);
}
// weight share at which each regime starts
const cross = (n, t, target) => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const den = 10000n;
    const num = BigInt(Math.round(mid * 10000));
    if (Number(exact(n, num, den, t, n).num) / Number(den ** BigInt(n)) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};
console.log('  rho at which the pi-weighted cap stops being unbounded (pi = 0.2308): 3-of-5', cross(5, 3, 0.2308).toFixed(4), ' 4-of-5', cross(5, 4, 0.2308).toFixed(4));
console.log('  rho at which the P+eps bribe becomes free (pi = 0.5):            3-of-5', cross(5, 3, 0.5).toFixed(4), ' 4-of-5', cross(5, 4, 0.5).toFixed(4));

// ── 6.4 (r30-4) decaying commitment vs the retainer ───────────────────────
// shipped: w = w0 + (earned-w0)*exp(-lambda*idle), lambda = ln2/3, earned floored at 0.5
// pre-R23 cliff: w = 0.5 for idle <= 6, then w0.
const LAMBDA = Math.LN2 / 3;
const decayW = (earned, idle, w0 = 1) => w0 + (earned - w0) * Math.exp(-LAMBDA * idle);
const decayMean = (F, I) => { let s = 0.5 * F; for (let i = 1; i <= I; i++) s += decayW(0.5, i); return s / (F + I); };
const cliffMean = (F, I) => (0.5 * F + 0.5 * Math.min(I, 6) + Math.max(0, I - 6)) / (F + I);
console.log('\n=== r30-4: idle ramp from the penalty floor (earned = 0.5*w0) ===');
console.log('  ' + [0, 1, 2, 3, 4, 5, 6, 12, 100].map((i) => `${i}:${decayW(0.5, i).toFixed(3)}`).join('  '));
console.log('  cycle averages (F active / I idle): shipped decay vs pre-R23 cliff');
for (const [F, I] of [[6, 6], [6, 7], [1, 3], [1, 6], [1, 7], [1, 12], [1, 50]]) {
  console.log(`    ${F}/${I}: decay ${decayMean(F, I).toFixed(4)} vs cliff ${cliffMean(F, I).toFixed(4)}  (+${((decayMean(F, I) / cliffMean(F, I) - 1) * 100).toFixed(1)}%)`);
}
console.log('  ASYMMETRIC fix (anchor = earned >= w0 ? w0 : floor): constant 0.5000 => loop value 0.000');
console.log('  retainer optimum p* = max(0, 2*tau-1):', [0.5, 0.6, 0.75, 0.9, 1].map((tau) => `tau=${tau}->${Math.max(0, 2 * tau - 1).toFixed(2)}`).join('  '));

// ── 6.5 (r30-5) shadow mode / grandfathering ──────────────────────────────
console.log('\n=== r30-5: the frozen config is scale-free above 1/(gamma*sigma) ===');
console.log('  gamma*sigma*N:', [5, 15, 45, 112, 135, 405].map((N) => `${N}:${(ECON_GAMMA * SIGMA * N).toFixed(3)}`).join('  '));
console.log(`  frozen 135-seat config: ${ECON_GAMMA * SIGMA * 135 >= 1 ? 'cap null (unbounded) — CORRECT at every V' : 'cap binds'}`);
console.log(`  over-cap excess at the 45-seat shipped cap for a 1M market: ${SAT(1_000_000 - ECON_GAMMA * STAKE_FLOOR * 45)} sats (${(1_000_000 / (ECON_GAMMA * STAKE_FLOOR * 45)).toFixed(1)}x)`);
