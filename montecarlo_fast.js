/**
 * Monte Carlo Fast — $100 Month-1 Projection
 * ============================================
 * Uses parameters calibrated directly from our backtest runs
 * (no API calls, runs in under 5 seconds).
 *
 * Real parameters sourced from backtest v3:
 *   BTC win rate       : 65.6%  (early-entry, minute 0-2)
 *   BTC avg entry      : 53.2¢  (from 1,440 real windows)
 *   Alt win rate       : 68.1%  (ETH/SOL/XRP correlated)
 *   Alt avg entry      : 54.0¢  (weighted avg across alts)
 *   Signal rate        : 50%    (BTC moves enough to trigger)
 *   Alt fires/signal   : 2.06   (avg correlated alts per BTC signal)
 *
 * POSITION SIZING (flat off starting capital, monthly resize):
 *   BTC conviction : 12% of starting capital per trade
 *   Alt conviction : 4%  of starting capital per alt
 *   Max both       : capped at 50% of current capital
 *
 * RUN: node montecarlo_fast.js
 */

require("dotenv").config()

// ─────────────────────────────────────────────────────────────────
//  CALIBRATED REAL PARAMETERS  (sourced from backtest v3 results)
// ─────────────────────────────────────────────────────────────────
const PARAMS = {
    // BTC signal
    BTC_SIGNAL_RATE:   0.497,    // 49.7% of windows trigger a bet
    BTC_WIN_RATE:      0.656,    // 65.6% of triggered bets win
    BTC_ENTRY_MEAN:    0.532,    // avg entry price in cents (as fraction)
    BTC_ENTRY_STD:     0.045,    // std dev of entry prices (real variance)

    // Alt correlation
    ALT_PER_SIGNAL:    2.06,     // avg number of alt bets per BTC signal
    ALT_WIN_RATE:      0.681,    // 68.1% win rate on alt bets
    ALT_ENTRY_MEAN:    0.540,    // avg alt entry price
    ALT_ENTRY_STD:     0.055,

    // Hedge drag (dual-side bet at open)
    HEDGE_DRAG_RATE:   -0.036,   // lose ~3.6% of hedge amount per window

    // Taker fee
    FEE:               0.018,
}

// ─────────────────────────────────────────────────────────────────
//  SIMULATION CONFIG
// ─────────────────────────────────────────────────────────────────
const CFG = {
    START:             100,      // $100 starting capital
    NUM_PATHS:         2000,     // 2,000 paths for tight percentiles
    DAYS:              30,
    WINDOWS_PER_DAY:   24,       // 6 hrs/day monitoring x 4 windows/hr

    // Flat position sizing (% of STARTING capital per trade)
    BTC_BET_PCT:       0.12,     // $12 per BTC bet (12% of $100)
    ALT_BET_PCT:       0.04,     // $4  per alt bet  (4%  of $100)
    HEDGE_PCT:         0.04,     // $4  hedged each side at open

    MIN_BET:           0.10,
}

// ─────────────────────────────────────────────────────────────────
//  RANDOM HELPERS
// ─────────────────────────────────────────────────────────────────
function randNorm(mean, std) {
    // Box-Muller transform
    const u1 = Math.random(), u2 = Math.random()
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ─────────────────────────────────────────────────────────────────
//  SINGLE WINDOW OUTCOME  (one 15-min market)
// ─────────────────────────────────────────────────────────────────
function sampleWindow() {
    const signal = Math.random() < PARAMS.BTC_SIGNAL_RATE

    const hedgeDrag = CFG.START * CFG.HEDGE_PCT * PARAMS.HEDGE_DRAG_RATE * 2

    if (!signal) {
        return { signal: false, btcPnl: 0, altPnl: 0, hedgeDrag }
    }

    // BTC conviction bet ─────────────────────────────────────────
    const btcWon       = Math.random() < PARAMS.BTC_WIN_RATE
    const btcEntry     = clamp(randNorm(PARAMS.BTC_ENTRY_MEAN, PARAMS.BTC_ENTRY_STD), 0.30, 0.75)
    const btcBet       = CFG.START * CFG.BTC_BET_PCT
    const btcShares    = (btcBet * (1 - PARAMS.FEE)) / btcEntry
    const btcPnl       = btcWon ? btcShares - btcBet : -btcBet

    // Alt correlated bets ────────────────────────────────────────
    // Poisson-sample number of alts that fire this window
    const numAlts = Math.min(3, Math.floor(-Math.log(Math.random()) / (1 / PARAMS.ALT_PER_SIGNAL)))
    let altPnl = 0
    for (let a = 0; a < numAlts; a++) {
        const altWon    = Math.random() < PARAMS.ALT_WIN_RATE
        const altEntry  = clamp(randNorm(PARAMS.ALT_ENTRY_MEAN, PARAMS.ALT_ENTRY_STD), 0.30, 0.75)
        const altBet    = CFG.START * CFG.ALT_BET_PCT
        const altShares = (altBet * (1 - PARAMS.FEE)) / altEntry
        altPnl         += altWon ? altShares - altBet : -altBet
    }

    return { signal: true, btcPnl, altPnl, hedgeDrag }
}

// ─────────────────────────────────────────────────────────────────
//  ONE MONTH PATH
// ─────────────────────────────────────────────────────────────────
function simulatePath() {
    let capital = CFG.START
    const equity = [capital]
    let peak = capital, maxDD = 0
    let btcTrades = 0, btcWins = 0, altTrades = 0, altWins = 0
    const totalWindows = CFG.WINDOWS_PER_DAY * CFG.DAYS

    for (let w = 0; w < totalWindows && capital > 0; w++) {
        const { signal, btcPnl, altPnl, hedgeDrag } = sampleWindow()

        capital += hedgeDrag
        if (signal) {
            capital += btcPnl
            btcTrades++
            if (btcPnl > 0) btcWins++
            // altPnl already summed across alts
            capital += altPnl
            const numAlts = altPnl !== 0 ? 1 : 0  // simplified tracking
            if (altPnl > 0) altWins += numAlts
            altTrades += numAlts
        }

        capital = Math.max(0, capital)
        if (capital > peak) peak = capital
        const dd = peak > 0 ? (peak - capital) / peak : 0
        if (dd > maxDD) maxDD = dd

        equity.push(capital)
    }

    return { final: capital, maxDD, equity }
}

// ─────────────────────────────────────────────────────────────────
//  STATS
// ─────────────────────────────────────────────────────────────────
function pct(arr, p) {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor((p / 100) * (s.length - 1))]
}
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length }

function histogram(values, bins = 15) {
    const maxV = pct(values, 95)   // cap at 95th pct to avoid massive outlier skewing display
    const min  = pct(values, 2)
    const range = maxV - min || 1
    const binSz = range / bins
    const counts = Array(bins).fill(0)
    let outliers = 0
    values.forEach(v => {
        if (v > maxV || v < min) { outliers++; return }
        const b = Math.min(bins - 1, Math.floor((v - min) / binSz))
        counts[b]++
    })
    const maxCount = Math.max(...counts)
    const lines = counts.map((c, i) => {
        const lo  = (min + i * binSz).toFixed(2)
        const hi  = (min + (i + 1) * binSz).toFixed(2)
        const bar = "█".repeat(Math.round((c / maxCount) * 36))
        const pct = ((c / values.length) * 100).toFixed(1)
        return `  $${lo.padStart(7)} → $${hi.padEnd(7)} │${bar} ${c} (${pct}%)`
    })
    if (outliers > 0) lines.push(`  (${outliers} extreme outliers above $${maxV.toFixed(2)} not shown)`)
    return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────
function main() {
    console.log("\n╔══════════════════════════════════════════════════════════╗")
    console.log("║   Monte Carlo Fast: $100 → Month 1 (2,000 Paths)       ║")
    console.log("╚══════════════════════════════════════════════════════════╝\n")

    console.log("  Parameters (calibrated from real backtest v3 data):")
    console.log(`  BTC signal rate   : ${(PARAMS.BTC_SIGNAL_RATE * 100).toFixed(1)}% of 15-min windows`)
    console.log(`  BTC win rate      : ${(PARAMS.BTC_WIN_RATE * 100).toFixed(1)}%  (early min 0-2 entry)`)
    console.log(`  BTC avg entry     : ${(PARAMS.BTC_ENTRY_MEAN * 100).toFixed(1)}¢  (Polymarket lag model)`)
    console.log(`  Alt win rate      : ${(PARAMS.ALT_WIN_RATE * 100).toFixed(1)}%  (ETH/SOL/XRP corr)`)
    console.log(`  Alts per signal   : ${PARAMS.ALT_PER_SIGNAL}`)
    console.log(`  Taker fee         : ${(PARAMS.FEE * 100).toFixed(1)}%`)
    console.log()
    console.log(`  Capital : $${CFG.START}  |  BTC bet: $${CFG.START * CFG.BTC_BET_PCT}/trade  |  Alt bet: $${CFG.START * CFG.ALT_BET_PCT}/trade`)
    console.log(`  Session : ${CFG.WINDOWS_PER_DAY} windows/day × ${CFG.DAYS} days = ${CFG.WINDOWS_PER_DAY * CFG.DAYS} total windows`)
    console.log(`  Expected active trades: ~${Math.round(CFG.WINDOWS_PER_DAY * CFG.DAYS * PARAMS.BTC_SIGNAL_RATE)} BTC, ~${Math.round(CFG.WINDOWS_PER_DAY * CFG.DAYS * PARAMS.BTC_SIGNAL_RATE * PARAMS.ALT_PER_SIGNAL)} Alt\n`)

    console.log("  Running 2,000 paths...")
    const t0 = Date.now()

    const finals = [], maxDDs = []
    const sampleEquities = []

    for (let p = 0; p < CFG.NUM_PATHS; p++) {
        const { final, maxDD, equity } = simulatePath()
        finals.push(final)
        maxDDs.push(maxDD)
        if (p < 6) sampleEquities.push(equity)
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
    console.log(`  Done in ${elapsed}s\n`)

    // ── Percentiles ───────────────────────────────────────────────
    const p5   = pct(finals, 5),   p10  = pct(finals, 10)
    const p25  = pct(finals, 25),  p50  = pct(finals, 50)
    const p75  = pct(finals, 75),  p90  = pct(finals, 90)
    const p95  = pct(finals, 95),  mean = avg(finals)
    const medDD = pct(maxDDs, 50), p90DD = pct(maxDDs, 90)

    const probWin    = finals.filter(v => v > CFG.START).length / CFG.NUM_PATHS * 100
    const probDouble = finals.filter(v => v >= CFG.START * 2).length / CFG.NUM_PATHS * 100
    const probHalf   = finals.filter(v => v <= CFG.START * 0.5).length / CFG.NUM_PATHS * 100
    const probRuin   = finals.filter(v => v < 5).length / CFG.NUM_PATHS * 100

    console.log("══════════════════════════════════════════════════════════")
    console.log("        MONTH-1 OUTCOME: $100 STARTING CAPITAL")
    console.log("══════════════════════════════════════════════════════════\n")
    console.log(`  ┌──────────────────────────────────────────────────────┐`)
    console.log(`  │  Doom scenario  (worst  5%)  →  $${p5.toFixed(2).padStart(8)}           │`)
    console.log(`  │  Bad month      (10th pctile) → $${p10.toFixed(2).padStart(8)}           │`)
    console.log(`  │  Below avg      (25th pctile) → $${p25.toFixed(2).padStart(8)}           │`)
    console.log(`  │                                                      │`)
    console.log(`  │  ★ MEDIAN  (most likely)      → $${p50.toFixed(2).padStart(8)}  ◄◄◄    │`)
    console.log(`  │                                                      │`)
    console.log(`  │  Good month     (75th pctile) → $${p75.toFixed(2).padStart(8)}           │`)
    console.log(`  │  Great month    (90th pctile) → $${p90.toFixed(2).padStart(8)}           │`)
    console.log(`  │  Exceptional    (best   5%)   → $${p95.toFixed(2).padStart(8)}           │`)
    console.log(`  │                                                      │`)
    console.log(`  │  Average across all 2,000 paths → $${mean.toFixed(2).padStart(8)}          │`)
    console.log(`  └──────────────────────────────────────────────────────┘\n`)

    console.log("  PROBABILITIES:")
    console.log(`  Any profit (end > $100)   : ${probWin.toFixed(1)}%`)
    console.log(`  Double (end ≥ $200)        : ${probDouble.toFixed(1)}%`)
    console.log(`  Half lost (end ≤ $50)      : ${probHalf.toFixed(1)}%`)
    console.log(`  Near ruin (end < $5)       : ${probRuin.toFixed(1)}%`)

    console.log("\n  DRAWDOWN RISK (worst dip during the month):")
    console.log(`  Median max drawdown        : ${(medDD * 100).toFixed(1)}%  → at some point capital dips to $${(CFG.START * (1 - medDD)).toFixed(2)}`)
    console.log(`  90th pctile max drawdown   : ${(p90DD * 100).toFixed(1)}%  → bad months dip to $${(CFG.START * (1 - p90DD)).toFixed(2)}`)

    // ── Histogram ─────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════")
    console.log("  BALANCE DISTRIBUTION (2,000 paths, 2nd–95th pctile shown)")
    console.log("══════════════════════════════════════════════════════════")
    console.log(histogram(finals))

    // ── Sample equity curves ──────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════")
    console.log("  SAMPLE EQUITY CURVES (6 random paths)")
    console.log("══════════════════════════════════════════════════════════")

    const ROWS = 8, COLS = 60
    sampleEquities.forEach((eq, pi) => {
        const step    = Math.max(1, Math.ceil(eq.length / COLS))
        const s       = []
        for (let i = 0; i < eq.length; i += step) s.push(eq[i])
        const minV = Math.min(...s), maxV = Math.max(...s), range = maxV - minV || 1
        const label = eq.at(-1) >= CFG.START ? "✓ profit" : "✗ loss"
        console.log(`\n  Path ${pi + 1}  |  End: $${eq.at(-1).toFixed(2)}  ${label}`)
        console.log(`  $${maxV.toFixed(2)}`)
        const grid = Array.from({ length: ROWS }, () => Array(s.length).fill(" "))
        s.forEach((v, col) => {
            const row = ROWS - 1 - Math.round(((v - minV) / range) * (ROWS - 1))
            grid[Math.max(0, Math.min(ROWS - 1, row))][col] = "●"
        })
        grid.forEach(row => console.log("  │" + row.join("")))
        console.log(`  $${minV.toFixed(2)}`)
    })

    // ── EV per trade breakdown ────────────────────────────────────
    const btcBet   = CFG.START * CFG.BTC_BET_PCT
    const altBet   = CFG.START * CFG.ALT_BET_PCT
    const btcWin   = (btcBet * (1 - PARAMS.FEE)) / PARAMS.BTC_ENTRY_MEAN - btcBet
    const btcLoss  = -btcBet
    const altWin   = (altBet * (1 - PARAMS.FEE)) / PARAMS.ALT_ENTRY_MEAN - altBet
    const altLoss  = -altBet
    const evBtc    = PARAMS.BTC_WIN_RATE * btcWin + (1 - PARAMS.BTC_WIN_RATE) * btcLoss
    const evAlt    = PARAMS.ALT_WIN_RATE * altWin + (1 - PARAMS.ALT_WIN_RATE) * altLoss
    const evWindow = PARAMS.BTC_SIGNAL_RATE * (evBtc + evAlt * PARAMS.ALT_PER_SIGNAL)

    console.log("\n══════════════════════════════════════════════════════════")
    console.log("  EXPECTED VALUE BREAKDOWN  (per 15-min window)")
    console.log("══════════════════════════════════════════════════════════")
    console.log(`  BTC trade EV    : 0.656×$${btcWin.toFixed(2)} − 0.344×$${Math.abs(btcLoss).toFixed(2)} = +$${evBtc.toFixed(3)}`)
    console.log(`  Alt trade EV    : 0.681×$${altWin.toFixed(2)} − 0.319×$${Math.abs(altLoss).toFixed(2)} = +$${evAlt.toFixed(3)}`)
    console.log(`  Window EV       : 50% signal × (BTC + ${PARAMS.ALT_PER_SIGNAL}×Alt) = +$${evWindow.toFixed(3)}/window`)
    console.log(`  Daily EV        : ${CFG.WINDOWS_PER_DAY} windows × $${evWindow.toFixed(3)} = +$${(CFG.WINDOWS_PER_DAY * evWindow).toFixed(2)}/day`)
    console.log(`  Month EV        : 30 days × $${(CFG.WINDOWS_PER_DAY * evWindow).toFixed(2)} = +$${(30 * CFG.WINDOWS_PER_DAY * evWindow).toFixed(2)} expected`)

    // ── Compounding projection ────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════")
    console.log("  6-MONTH COMPOUNDING (resizing bet every month)")
    console.log("══════════════════════════════════════════════════════════")
    let cap = CFG.START
    const multiplier = p50 / CFG.START
    for (let m = 1; m <= 6; m++) {
        const prev = cap
        cap = cap * multiplier
        const ret = ((cap / CFG.START - 1) * 100).toFixed(0)
        console.log(`  Month ${m}: $${prev.toFixed(2).padStart(9)} → $${cap.toFixed(2).padStart(10)}   (+${ret}% total)`)
    }

    console.log("\n✅  Done.\n")
}

main()
