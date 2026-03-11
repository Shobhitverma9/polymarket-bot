/**
 * Monte Carlo Simulation — $100 Month-1 Projection
 * ==================================================
 * PHASE 1: Fetch real 15-min BTC + alt candles from Binance (last 60 days)
 *          Run the full v3 strategy on every window → build trade outcome pool
 *
 * PHASE 2: Run 1,000 simulated month-1 paths
 *          Each path randomly samples 30 days of windows from the pool
 *          Applies conservative position sizing (max 15% per BTC trade)
 *          Tracks equity curve & computes outcome statistics
 *
 * OUTPUT: Percentile distribution, ASCII histogram, risk metrics
 *
 * RUN: node montecarlo.js
 */

require("dotenv").config()
const axios = require("axios")

// ─────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────
const CFG = {
    // Data collection
    DAYS_TO_FETCH: 60,          // pull 60 days of real windows
    WINDOW_MIN: 15,
    ASSETS: {
        BTC: { pair: "BTCUSDT", weight: 1.00 },
        ETH: { pair: "ETHUSDT", weight: 0.85 },
        SOL: { pair: "SOLUSDT", weight: 0.78 },
        XRP: { pair: "XRPUSDT", weight: 0.65 },
    },

    // Strategy params (from v3 backtest)
    PM_LAG: 0.22,
    TAKER_FEE: 0.018,
    HEDGE_PCT: 0.04,
    MIN_BTC_MOVE: 0.04,        // %
    ENTRY_MINUTE: 1,
    ASSET_MIN_MOVE: 0.05,        // % for alts

    // Simulation
    STARTING_CAPITAL: 100,
    NUM_PATHS: 1000,
    DAYS_IN_MONTH: 30,

    // Trading session: ~6 hours/day active = 24 fifteen-minute windows/day
    // But only ~50% have signals → ~12 actual trades/day
    WINDOWS_PER_DAY: 24,

    // Realistic FLAT position sizing (key: sized off STARTING capital, not growing)
    // This avoids exponential runaway compounding in the sim
    // In reality a trader would re-size monthly, not every 15 mins
    BTC_BET_PCT: 0.12,   // risk 12% of starting capital per BTC conviction bet
    ALT_BET_PCT: 0.04,   // risk 4% of starting capital per alt bet
    MIN_BET: 0.10,   // minimum $0.10 bet

    // Dynamic sizing bands (confidence → fraction of MAX bet)
    SIZING: [
        { minConf: 0.85, frac: 1.00 },
        { minConf: 0.75, frac: 0.80 },
        { minConf: 0.65, frac: 0.60 },
        { minConf: 0.55, frac: 0.40 },
        { minConf: 0.00, frac: 0.00 },
    ],
}

// ─────────────────────────────────────────────────────────────────
//  MATH
// ─────────────────────────────────────────────────────────────────
function normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x))
    const d = 0.3989423 * Math.exp(-x * x / 2)
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
    return x > 0 ? 1 - p : p
}

function trueProb(openP, currP, minLeft, vol) {
    const frac = Math.max(0.001, minLeft / CFG.WINDOW_MIN)
    const d = ((currP - openP) / openP) / (vol * Math.sqrt(frac))
    return Math.max(0.01, Math.min(0.99, normalCDF(d)))
}

function pmPrice(openP, currP, minLeft, vol, lag = CFG.PM_LAG) {
    return 0.50 + lag * (trueProb(openP, currP, minLeft, vol) - 0.50)
}

function calcVol(candles) {
    if (candles.length < 2) return 0.003
    const rets = candles.slice(1).map((c, i) => Math.log(c.close / candles[i].close))
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const va = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length
    return Math.max(0.001, Math.sqrt(va) * Math.sqrt(CFG.WINDOW_MIN))
}

function confScore(pctMove, vol, confirmedAlts, totalAlts, minute) {
    const z = Math.min(1.0, Math.abs(pctMove / 100) / vol / 3.0)
    const crossConf = totalAlts > 0 ? confirmedAlts / totalAlts : 0
    const timeBonus = Math.max(0, 1 - minute / 7)
    return 0.50 + (0.45 * z + 0.35 * crossConf + 0.20 * timeBonus) * 0.45
}

function betFrac(conf) {
    for (const b of CFG.SIZING) if (conf >= b.minConf) return b.frac
    return 0
}

// ─────────────────────────────────────────────────────────────────
//  BINANCE
// ─────────────────────────────────────────────────────────────────
async function fetchCandles(pair, startMs, n = CFG.WINDOW_MIN + 2) {
    try {
        const r = await axios.get("https://api.binance.com/api/v3/klines", {
            params: { symbol: pair, interval: "1m", startTime: startMs, limit: n },
            timeout: 10000,
        })
        return r.data.map(k => ({ t: +k[0], open: +k[1], close: +k[4] }))
    } catch { return null }
}

// ─────────────────────────────────────────────────────────────────
//  PHASE 1: Extract trade record from one real window
//  Returns: { signal, won, entryPrice, altTrades }
//  entryPrice is the Polymarket price we'd have paid (0–1)
//  altTrades:  array of { won, entryPrice, weight }
// ─────────────────────────────────────────────────────────────────
function extractTradeRecord(candleMap) {
    const btc = candleMap["BTC"]
    if (!btc || btc.length < CFG.WINDOW_MIN) return null

    const openP = btc[0].open
    const closeP = btc[CFG.WINDOW_MIN - 1]?.close ?? btc.at(-1).close
    const vol = calcVol(btc)
    const outcome = closeP >= openP ? "UP" : "DOWN"

    // Hedge PnL rate (always applied): near-zero but slightly negative due to fee
    // At 50¢ entry, one side wins: net = (bet*0.982/0.50 - bet) + (-bet) = 0.964bet - bet = -0.036bet
    const hedgeRate = -0.036  // lose 3.6% of hedge amount (fee drag)

    // Signal
    const em = Math.min(CFG.ENTRY_MINUTE, btc.length - 1)
    const btcNow = btc[em].close
    const pctMove = (btcNow - openP) / openP * 100

    if (Math.abs(pctMove) < CFG.MIN_BTC_MOVE) {
        return { signal: false, hedgeRate, won: null, entryPrice: null, conf: 0, altTrades: [] }
    }

    const direction = pctMove > 0 ? "UP" : "DOWN"

    // Check alts
    let confirmedAlts = 0
    const altTrades = []
    for (const [asset, acfg] of Object.entries(CFG.ASSETS)) {
        if (asset === "BTC") continue
        const ac = candleMap[asset]
        if (!ac || ac.length < CFG.WINDOW_MIN) continue
        const em2 = Math.min(CFG.ENTRY_MINUTE, ac.length - 1)
        const pct2 = (ac[em2].close - ac[0].open) / ac[0].open * 100
        if (Math.abs(pct2) < CFG.ASSET_MIN_MOVE) continue
        if ((pct2 > 0 ? "UP" : "DOWN") !== direction) continue

        confirmedAlts++
        const closeA = ac[CFG.WINDOW_MIN - 1]?.close ?? ac.at(-1).close
        const wonAlt = (direction === "UP") === (closeA >= ac[0].open)
        const lagA = CFG.PM_LAG * acfg.weight
        const upEstA = pmPrice(ac[0].open, ac[em2].close, CFG.WINDOW_MIN - em2, calcVol(ac), lagA)
        const entryA = direction === "UP" ? upEstA : (1 - upEstA)

        altTrades.push({ won: wonAlt, entryPrice: entryA, weight: acfg.weight })
    }

    const conf = confScore(pctMove, vol, confirmedAlts, Object.keys(CFG.ASSETS).length - 1, em)
    const frac = betFrac(conf)

    // BTC entry price
    const minLeft = CFG.WINDOW_MIN - em
    const upEst = pmPrice(openP, btcNow, minLeft, vol)
    const entryPrice = direction === "UP" ? upEst : (1 - upEst)

    const wonBTC = direction === outcome

    return { signal: true, hedgeRate, won: wonBTC, entryPrice, conf, frac, altTrades }
}

// ─────────────────────────────────────────────────────────────────
//  PHASE 2: Simulate one month-1 path given pool of real records
// ─────────────────────────────────────────────────────────────────
function simulatePath(pool, startCap) {
    let capital = startCap
    const equity = [capital]
    const totalWindows = CFG.WINDOWS_PER_DAY * CFG.DAYS_IN_MONTH
    let maxDrawdownPct = 0
    let peak = capital
    let btcTrades = 0, btcWins = 0, altTrades = 0, altWins = 0

    // Fixed bet sizes derived from STARTING capital
    // (re-sized once per month in real life, not every 15 mins)
    const btcBaseBet = startCap * CFG.BTC_BET_PCT
    const altBaseBet = startCap * CFG.ALT_BET_PCT

    for (let w = 0; w < totalWindows; w++) {
        if (capital <= 0) break

        const rec = pool[Math.floor(Math.random() * pool.length)]
        if (!rec) continue

        // ① Hedge drag (tiny, both sides at 50¢)
        const hedgeBet = Math.min(startCap * CFG.HEDGE_PCT, capital * 0.05)
        capital += hedgeBet * rec.hedgeRate * 2

        // ② BTC conviction bet — fixed size, scaled by dynamic confidence frac
        if (rec.signal && rec.frac > 0) {
            const betAmt = Math.min(btcBaseBet * rec.frac, capital * 0.50)
            if (betAmt >= CFG.MIN_BET) {
                const shares = (betAmt * (1 - CFG.TAKER_FEE)) / rec.entryPrice
                const pnl = rec.won ? shares - betAmt : -betAmt
                capital += pnl
                btcTrades++
                if (rec.won) btcWins++
            }
        }

        // ③ Alt correlation bets — fixed size, scaled by weight × frac
        if (rec.signal && rec.frac > 0) {
            for (const alt of rec.altTrades) {
                const betAmt = Math.min(altBaseBet * alt.weight * rec.frac, capital * 0.15)
                if (betAmt < CFG.MIN_BET) continue
                const shares = (betAmt * (1 - CFG.TAKER_FEE)) / alt.entryPrice
                const pnl = alt.won ? shares - betAmt : -betAmt
                capital += pnl
                altTrades++
                if (alt.won) altWins++
            }
        }

        capital = Math.max(0, capital)

        if (capital > peak) peak = capital
        const dd = peak > 0 ? (peak - capital) / peak : 0
        if (dd > maxDrawdownPct) maxDrawdownPct = dd

        equity.push(capital)
    }

    return {
        final: capital,
        maxDrawdownPct,
        btcWinRate: btcTrades > 0 ? btcWins / btcTrades : 0,
        altWinRate: altTrades > 0 ? altWins / altTrades : 0,
        equity,
    }
}

// ─────────────────────────────────────────────────────────────────
//  STATS HELPERS
// ─────────────────────────────────────────────────────────────────
function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.floor((p / 100) * (sorted.length - 1))
    return sorted[idx]
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length }

function asciiHistogram(values, bins = 20) {
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1
    const binSize = range / bins
    const counts = Array(bins).fill(0)
    values.forEach(v => {
        const b = Math.min(bins - 1, Math.floor((v - min) / binSize))
        counts[b]++
    })
    const maxCount = Math.max(...counts)
    const lines = []
    counts.forEach((count, i) => {
        const lo = (min + i * binSize).toFixed(0)
        const hi = (min + (i + 1) * binSize).toFixed(0)
        const bar = "█".repeat(Math.round(count / maxCount * 40))
        const pct = ((count / values.length) * 100).toFixed(1)
        lines.push(`  $${lo.padStart(6)}–$${hi.padEnd(6)} │${bar} ${count} (${pct}%)`)
    })
    return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════╗")
    console.log("║        Monte Carlo: $100 → Month 1 Projection           ║")
    console.log("╚══════════════════════════════════════════════════════════╝\n")
    console.log(`  Strategy      : 0x8dxd dual-hedge + multi-asset + dynamic sizing`)
    console.log(`  Starting cap  : $${CFG.STARTING_CAPITAL}`)
    console.log(`  Position size : BTC ${(CFG.BTC_BET_PCT * 100).toFixed(0)}% of start cap, Alt ${(CFG.ALT_BET_PCT * 100).toFixed(0)}% per trade`)
    console.log(`  Trading hours : ~6hrs/day (${CFG.WINDOWS_PER_DAY} windows/day)`)
    console.log(`  Simulated paths: ${CFG.NUM_PATHS.toLocaleString()}`)
    console.log(`  Real data from : last ${CFG.DAYS_TO_FETCH} days of Binance 1-min OHLCV\n`)

    // ── PHASE 1: Build real trade pool ────────────────────────────
    console.log("  ─── PHASE 1: Building real trade outcome pool ───────────")
    const now = Date.now()
    const startT = now - CFG.DAYS_TO_FETCH * 86400_000
    const winMs = CFG.WINDOW_MIN * 60_000

    // Sample every 5 hours → ~288 windows (fast ~2 min fetch, statistically valid for MC)
    const allTimes = []
    for (let t = startT; t < now - winMs; t += 5 * 60 * 60_000) allTimes.push(t)

    console.log(`  Fetching ${allTimes.length} windows (1 per 5hrs × ${CFG.DAYS_TO_FETCH} days) from 4 assets...`)

    const pool = []
    const BATCH = 4, DELAY = 400

    for (let i = 0; i < allTimes.length; i += BATCH) {
        const batch = allTimes.slice(i, i + BATCH)
        const results = await Promise.all(batch.map(async (t) => {
            const candleMap = {}
            await Promise.all(Object.entries(CFG.ASSETS).map(async ([asset, acfg]) => {
                candleMap[asset] = await fetchCandles(acfg.pair, t)
            }))
            return extractTradeRecord(candleMap)
        }))
        results.forEach(r => { if (r) pool.push(r) })

        if (i % (BATCH * 10) === 0) {
            process.stdout.write(`\r  Fetched: ${Math.min(i + BATCH, allTimes.length)}/${allTimes.length} windows, pool size: ${pool.length}`)
        }
        if (i + BATCH < allTimes.length) await new Promise(r => setTimeout(r, DELAY))
    }

    const signalWindows = pool.filter(r => r.signal)
    const noSignal = pool.filter(r => !r.signal)
    const realWinRate = signalWindows.length > 0
        ? (signalWindows.filter(r => r.won).length / signalWindows.length * 100).toFixed(1)
        : "N/A"
    const signalRate = (signalWindows.length / pool.length * 100).toFixed(1)
    const avgEntry = signalWindows.length > 0
        ? (signalWindows.reduce((a, r) => a + r.entryPrice, 0) / signalWindows.length * 100).toFixed(1)
        : "N/A"

    console.log(`\n\n  Pool built: ${pool.length} real windows`)
    console.log(`  Signal rate    : ${signalRate}%  (${signalWindows.length} signal, ${noSignal.length} no-signal)`)
    console.log(`  BTC win rate   : ${realWinRate}%`)
    console.log(`  Avg entry price: ${avgEntry}¢`)

    // ── PHASE 2: Run 1,000 Monte Carlo paths ──────────────────────
    console.log(`\n  ─── PHASE 2: Running ${CFG.NUM_PATHS} simulated month-1 paths ───`)

    const finalBalances = []
    const maxDrawdowns = []
    const btcWinRates = []
    const pathEquities = []

    for (let p = 0; p < CFG.NUM_PATHS; p++) {
        const result = simulatePath(pool, CFG.STARTING_CAPITAL)
        finalBalances.push(result.final)
        maxDrawdowns.push(result.maxDrawdownPct)
        btcWinRates.push(result.btcWinRate)
        // Store a few sample equity curves
        if (p < 5 || p === CFG.NUM_PATHS - 1) pathEquities.push(result.equity)
        if (p % 100 === 0) process.stdout.write(`\r  Simulating path ${p + 1}/${CFG.NUM_PATHS}...`)
    }

    // ── RESULTS ───────────────────────────────────────────────────
    const p5 = percentile(finalBalances, 5)
    const p10 = percentile(finalBalances, 10)
    const p25 = percentile(finalBalances, 25)
    const p50 = percentile(finalBalances, 50)
    const p75 = percentile(finalBalances, 75)
    const p90 = percentile(finalBalances, 90)
    const p95 = percentile(finalBalances, 95)
    const avg = mean(finalBalances)
    const avgDD = mean(maxDrawdowns)
    const medDD = percentile(maxDrawdowns, 50)

    const probProfit = finalBalances.filter(b => b > CFG.STARTING_CAPITAL).length / CFG.NUM_PATHS * 100
    const probDouble = finalBalances.filter(b => b >= CFG.STARTING_CAPITAL * 2).length / CFG.NUM_PATHS * 100
    const probHalfLoss = finalBalances.filter(b => b <= CFG.STARTING_CAPITAL * 0.5).length / CFG.NUM_PATHS * 100
    const probRuin = finalBalances.filter(b => b <= CFG.STARTING_CAPITAL * 0.1).length / CFG.NUM_PATHS * 100

    console.log("\n\n══════════════════════════════════════════════════════════")
    console.log("              MONTH 1 OUTCOME DISTRIBUTION")
    console.log("══════════════════════════════════════════════════════════")
    console.log(`  Starting capital : $${CFG.STARTING_CAPITAL.toFixed(2)}`)
    console.log()
    console.log("  PERCENTILE OUTCOMES:")
    console.log(`  ┌──────────────────────────────────────────────────┐`)
    console.log(`  │  Worst 5%    (doom scenario)   → $${p5.toFixed(2).padStart(8)}       │`)
    console.log(`  │  10th pctile (bad month)       → $${p10.toFixed(2).padStart(8)}       │`)
    console.log(`  │  25th pctile (below average)   → $${p25.toFixed(2).padStart(8)}       │`)
    console.log(`  │  MEDIAN      (most likely)     → $${p50.toFixed(2).padStart(8)}  ◄    │`)
    console.log(`  │  75th pctile (good month)      → $${p75.toFixed(2).padStart(8)}       │`)
    console.log(`  │  90th pctile (great month)     → $${p90.toFixed(2).padStart(8)}       │`)
    console.log(`  │  Best 5%     (exceptional)     → $${p95.toFixed(2).padStart(8)}       │`)
    console.log(`  │                                                  │`)
    console.log(`  │  Average across all paths      → $${avg.toFixed(2).padStart(8)}       │`)
    console.log(`  └──────────────────────────────────────────────────┘`)

    console.log()
    console.log("  PROBABILITY ANALYSIS:")
    console.log(`  Probability of ANY profit        : ${probProfit.toFixed(1)}%`)
    console.log(`  Probability of DOUBLING ($200+)  : ${probDouble.toFixed(1)}%`)
    console.log(`  Probability of -50% loss ($50-)  : ${probHalfLoss.toFixed(1)}%`)
    console.log(`  Probability of ruin (<$10)       : ${probRuin.toFixed(1)}%`)

    console.log()
    console.log("  DRAWDOWN RISK:")
    console.log(`  Avg max drawdown in a month      : ${(avgDD * 100).toFixed(1)}%`)
    console.log(`  Median max drawdown              : ${(medDD * 100).toFixed(1)}%`)
    console.log(`  90th pctile max drawdown         : ${(percentile(maxDrawdowns, 90) * 100).toFixed(1)}%`)

    // ── Histogram ────────────────────────────────────────────────
    console.log()
    console.log("══════════════════════════════════════════════════════════")
    console.log("  DISTRIBUTION OF MONTH-1 FINAL BALANCES")
    console.log(`  (n=${CFG.NUM_PATHS} simulations, each line = one balance bucket)`)
    console.log("══════════════════════════════════════════════════════════")
    console.log(asciiHistogram(finalBalances))

    // ── Sample equity curves ─────────────────────────────────────
    console.log()
    console.log("══════════════════════════════════════════════════════════")
    console.log("  SAMPLE EQUITY CURVES (5 random paths)")
    console.log("══════════════════════════════════════════════════════════")

    const ROWS = 10, COLS = 55
    pathEquities.slice(0, 5).forEach((eq, pi) => {
        const step = Math.max(1, Math.ceil(eq.length / COLS))
        const sampled = []
        for (let i = 0; i < eq.length; i += step) sampled.push(eq[i])
        const minV = Math.min(...sampled), maxV = Math.max(...sampled)
        const range = maxV - minV || 1

        console.log(`\n  Path ${pi + 1}  |  Start: $${CFG.STARTING_CAPITAL}  →  End: $${eq.at(-1).toFixed(2)}`)
        console.log(`  $${maxV.toFixed(0)}`)
        const grid = Array.from({ length: ROWS }, () => Array(sampled.length).fill(" "))
        sampled.forEach((v, col) => {
            const row = ROWS - 1 - Math.round(((v - minV) / range) * (ROWS - 1))
            grid[Math.max(0, Math.min(ROWS - 1, row))][col] = "●"
        })
        grid.forEach(row => console.log("  │" + row.join("")))
        console.log(`  $${minV.toFixed(0)}`)
        console.log(`   ${"─".repeat(sampled.length)}`)
    })

    // ── Advice ────────────────────────────────────────────────────
    console.log()
    console.log("══════════════════════════════════════════════════════════")
    console.log("  KEY TAKEAWAYS")
    console.log("══════════════════════════════════════════════════════════")
    const medianReturn = ((p50 / CFG.STARTING_CAPITAL - 1) * 100).toFixed(1)
    const bestReturn = ((p95 / CFG.STARTING_CAPITAL - 1) * 100).toFixed(1)
    const worstReturn = ((p5 / CFG.STARTING_CAPITAL - 1) * 100).toFixed(1)

    console.log(`  • Median month-1 outcome  : +${medianReturn}% → $${p50.toFixed(2)}`)
    console.log(`  • Best realistic outcome  : +${bestReturn}% → $${p95.toFixed(2)}`)
    console.log(`  • Worst realistic outcome : ${worstReturn}% → $${p5.toFixed(2)}`)
    console.log(`  • Most paths reach profit : ${probProfit.toFixed(0)}% probability`)
    console.log()
    console.log("  POSITION SIZING IS EVERYTHING:")
    console.log(`  Max ${(CFG.MAX_BTC_FRACTION * 100).toFixed(0)}% per BTC trade limits ruin risk to ${probRuin.toFixed(1)}%`)
    console.log(`  Increasing to 30% per trade would dramatically raise ruin risk`)
    console.log()
    console.log("  COMPOUNDING PATH (if median holds each month):")
    let comp = CFG.STARTING_CAPITAL
    for (let m = 1; m <= 6; m++) {
        comp *= (p50 / CFG.STARTING_CAPITAL)
        console.log(`  Month ${m}: $${comp.toFixed(2)}`)
    }

    console.log("\n✅  Done.\n")
}

main().catch(e => { console.error(e.message); process.exit(1) })
