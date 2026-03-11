/**
 * 0x8dxd Strategy Backtester — v3 (Full Feature Set)
 * ====================================================
 * Implements all three core mechanics of the real strategy:
 *
 *  ① DUAL-SIDE HEDGING
 *     At window open → place small bet on BOTH Up and Down (~50¢ each)
 *     At minute 1-3 → when BTC direction becomes clear, place heavy
 *     conviction bet on the winning side using dynamic sizing
 *
 *  ② MULTI-ASSET CORRELATION
 *     BTC, ETH, SOL, XRP all fetched from Binance
 *     When BTC fires a signal → check if correlated assets confirm
 *     Fire simultaneous bets on all confirming assets
 *
 *  ③ DYNAMIC POSITION SIZING
 *     Bet size = f(confidence_score)
 *     confidence_score = weighted combo of:
 *       - BTC price delta magnitude
 *       - Time remaining in window
 *       - Cross-asset confirmation count
 *       - Historical vol-adjusted Z-score
 *
 * DATA : Binance 1-min OHLCV — free, no auth
 * RUN  : node backtest.js
 */

require("dotenv").config()
const axios = require("axios")

// ─────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────
const CFG = {
    WINDOW_MIN: 15,          // length of each Polymarket window (minutes)
    CAPITAL: 500,         // USDC allocated per BTC market window
    ASSET_CAPITAL: 150,         // USDC per correlated-asset window (XRP/SOL/ETH)
    DAYS_AGO: 90,
    WINDOWS: 200,
    TAKER_FEE: 0.018,       // 1.8% — post-Polymarket countermeasure
    PM_LAG: 0.22,        // Polymarket absorbs only 22% of price info instantly

    // Dual-side hedge: tiny opening bet on BOTH sides
    HEDGE_PCT: 0.04,        // 4% of capital each side = 8% total hedged

    // Signal threshold for entering conviction bet
    MIN_BTC_MOVE: 0.04,        // % BTC must move before we act
    ENTRY_MINUTE: 1,           // enter conviction bet at minute 1

    // Dynamic sizing bands (confidence → fraction of remaining capital)
    SIZING: [
        { minConf: 0.90, frac: 0.95 },
        { minConf: 0.75, frac: 0.80 },
        { minConf: 0.65, frac: 0.65 },
        { minConf: 0.55, frac: 0.45 },
        { minConf: 0.00, frac: 0.00 },  // below 55% → don't enter
    ],

    // Multi-asset: correlation thresholds
    ASSETS: {
        BTC: { pair: "BTCUSDT", weight: 1.0 },
        ETH: { pair: "ETHUSDT", weight: 0.85 },  // 85% correl with BTC
        SOL: { pair: "SOLUSDT", weight: 0.78 },
        XRP: { pair: "XRPUSDT", weight: 0.65 },
    },

    // Minimum asset-move (% in first minute) to fire a correlated bet
    ASSET_MIN_MOVE: 0.05,
}

// ─────────────────────────────────────────────────────────────────
//  MATH HELPERS
// ─────────────────────────────────────────────────────────────────
function normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x))
    const d = 0.3989423 * Math.exp(-x * x / 2)
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
    return x > 0 ? 1 - p : p
}

/** True probability BTC closes above open given current state */
function trueProb(openP, currentP, minLeft, vol15m) {
    const frac = Math.max(0.0001, minLeft / CFG.WINDOW_MIN)
    const d = ((currentP - openP) / openP) / (vol15m * Math.sqrt(frac))
    return Math.max(0.01, Math.min(0.99, normalCDF(d)))
}

/** Simulated Polymarket price with latency lag */
function pmPrice(openP, currentP, minLeft, vol15m, lag = CFG.PM_LAG) {
    const real = trueProb(openP, currentP, minLeft, vol15m)
    return 0.50 + lag * (real - 0.50)
}

/** Compute 15-min rolling volatility from candles */
function vol15m(candles) {
    if (candles.length < 2) return 0.003
    const rets = candles.slice(1).map((c, i) => Math.log(c.close / candles[i].close))
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const va = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length
    return Math.max(0.001, Math.sqrt(va) * Math.sqrt(CFG.WINDOW_MIN))
}

// ─────────────────────────────────────────────────────────────────
//  ③ DYNAMIC SIZING — confidence → bet fraction
// ─────────────────────────────────────────────────────────────────
function confidenceScore(pctMove, vol15min, confirmedAssets, totalAssets, minuteUsed) {
    const z = Math.abs(pctMove / 100) / vol15min
    const zScore = Math.min(1.0, z / 3.0)
    const crossConf = totalAssets > 0 ? confirmedAssets / totalAssets : 0
    const timeBonus = Math.max(0, 1 - minuteUsed / 7)
    const raw = 0.45 * zScore + 0.35 * crossConf + 0.20 * timeBonus
    return 0.50 + raw * 0.45
}

function betFraction(conf) {
    for (const band of CFG.SIZING) {
        if (conf >= band.minConf) return band.frac
    }
    return 0
}

// ─────────────────────────────────────────────────────────────────
//  BINANCE FETCHER
// ─────────────────────────────────────────────────────────────────
async function fetchCandles(pair, startMs, n = CFG.WINDOW_MIN + 2) {
    try {
        const r = await axios.get("https://api.binance.com/api/v3/klines", {
            params: { symbol: pair, interval: "1m", startTime: startMs, limit: n },
            timeout: 10000,
        })
        return r.data.map(k => ({
            t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4]
        }))
    } catch { return null }
}

// ─────────────────────────────────────────────────────────────────
//  ① DUAL-SIDE HEDGE P&L
// ─────────────────────────────────────────────────────────────────
function calcHedgePnl(capital) {
    const hedgeBet = capital * CFG.HEDGE_PCT
    const hedgeShares = (hedgeBet * (1 - CFG.TAKER_FEE)) / 0.50
    // One side wins (+shares - bet), one side loses (-bet). Near net-zero.
    return hedgeShares - hedgeBet - hedgeBet
}

// ─────────────────────────────────────────────────────────────────
//  ② CROSS-ASSET CORRELATION CHECK
// ─────────────────────────────────────────────────────────────────
function checkCorrelation(candleMap, btcDirection) {
    let confirmed = 0
    const total = Object.keys(candleMap).length - 1  // exclude BTC
    for (const [asset, candles] of Object.entries(candleMap)) {
        if (asset === "BTC" || !candles || candles.length < 2) continue
        const pct = (candles[CFG.ENTRY_MINUTE]?.close - candles[0].open) / candles[0].open * 100
        if (Math.abs(pct) < CFG.ASSET_MIN_MOVE) continue
        if ((pct > 0 ? "UP" : "DOWN") === btcDirection) confirmed++
    }
    return { confirmed, total }
}

// ─────────────────────────────────────────────────────────────────
//  SIMULATE A SINGLE BTC WINDOW
// ─────────────────────────────────────────────────────────────────
function simulateWindow(candleMap, capital) {
    const btc = candleMap["BTC"]
    if (!btc || btc.length < CFG.WINDOW_MIN) return null

    const openP = btc[0].open
    const closeP = btc[CFG.WINDOW_MIN - 1]?.close ?? btc.at(-1).close
    const vBtc = vol15m(btc)
    const outcome = closeP >= openP ? "UP" : "DOWN"

    // ① Hedge: always placed regardless of signal
    const hedgePnl = calcHedgePnl(capital)

    // Signal detection at entry minute
    const em = Math.min(CFG.ENTRY_MINUTE, btc.length - 1)
    const btcNow = btc[em].close
    const pctMove = (btcNow - openP) / openP * 100

    if (Math.abs(pctMove) < CFG.MIN_BTC_MOVE) {
        return {
            outcome, signal: false, direction: null, pctMove,
            conviction: 0, confirmedAssets: 0,
            convictionPnl: 0, hedgePnl, totalPnl: hedgePnl
        }
    }

    const direction = pctMove > 0 ? "UP" : "DOWN"

    // ② Cross-asset confirmation
    const { confirmed, total } = checkCorrelation(candleMap, direction)

    // ③ Dynamic sizing
    const conf = confidenceScore(pctMove, vBtc, confirmed, total, em)
    const frac = betFraction(conf)

    let convictionPnl = 0
    if (frac > 0) {
        const available = capital * (1 - CFG.HEDGE_PCT * 2)
        const betAmt = available * frac
        const minLeft = CFG.WINDOW_MIN - em
        const upEst = pmPrice(openP, btcNow, minLeft, vBtc)
        const entryPrice = direction === "UP" ? upEst : (1 - upEst)
        const shares = (betAmt * (1 - CFG.TAKER_FEE)) / entryPrice
        convictionPnl = direction === outcome ? shares - betAmt : -betAmt
    }

    return {
        outcome, signal: true, direction, pctMove, conviction: frac,
        confirmedAssets: confirmed, convictionPnl, hedgePnl,
        totalPnl: hedgePnl + convictionPnl
    }
}

// ─────────────────────────────────────────────────────────────────
//  SIMULATE CORRELATED ASSET BETS
// ─────────────────────────────────────────────────────────────────
function simulateAssets(candleMap, btcResult) {
    if (!btcResult?.signal || btcResult.conviction === 0) return { pnl: 0, trades: 0, wins: 0 }
    let pnl = 0, trades = 0, wins = 0

    for (const [asset, acfg] of Object.entries(CFG.ASSETS)) {
        if (asset === "BTC") continue
        const candles = candleMap[asset]
        if (!candles || candles.length < CFG.WINDOW_MIN) continue

        const em = Math.min(CFG.ENTRY_MINUTE, candles.length - 1)
        const openA = candles[0].open
        const pct = (candles[em].close - openA) / openA * 100
        if (Math.abs(pct) < CFG.ASSET_MIN_MOVE) continue

        const assetDir = pct > 0 ? "UP" : "DOWN"
        if (assetDir !== btcResult.direction) continue  // must confirm BTC

        const closeA = candles[CFG.WINDOW_MIN - 1]?.close ?? candles.at(-1).close
        const vAsset = vol15m(candles)
        const minLeft = CFG.WINDOW_MIN - em
        const lag = CFG.PM_LAG * acfg.weight
        const upEst = pmPrice(openA, candles[em].close, minLeft, vAsset, lag)
        const entryP = btcResult.direction === "UP" ? upEst : (1 - upEst)
        const betAmt = CFG.ASSET_CAPITAL * acfg.weight * btcResult.conviction
        const shares = (betAmt * (1 - CFG.TAKER_FEE)) / entryP
        const won = (btcResult.direction === "UP") === (closeA >= openA)
        pnl += won ? shares - betAmt : -betAmt
        trades += 1
        if (won) wins++
    }
    return { pnl, trades, wins }
}

// ─────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════╗")
    console.log("║   0x8dxd Backtest v3 — Dual-Hedge + Multi-Asset + Dyn  ║")
    console.log("╚══════════════════════════════════════════════════════════╝\n")
    console.log("  Strategy features:")
    console.log("  ① Dual-side hedge  : " + (CFG.HEDGE_PCT * 200).toFixed(0) + "% of capital on each side at open")
    console.log("  ② Multi-asset      : BTC + ETH + SOL + XRP simultaneously")
    console.log("  ③ Dynamic sizing   : confidence score → bet fraction")
    console.log(`\n  Capital/BTC window : $${CFG.CAPITAL}`)
    console.log(`  Capital/alt window : $${CFG.ASSET_CAPITAL} × correlation weight`)
    console.log(`  Windows tested     : ${CFG.WINDOWS}  (last ${CFG.DAYS_AGO} days)\n`)

    const now = Date.now()
    const start = now - CFG.DAYS_AGO * 86400_000
    const winMs = CFG.WINDOW_MIN * 60_000
    const all = []
    for (let t = start; t < now - winMs * 2; t += winMs) all.push(t)
    const windows = all.sort(() => 0.5 - Math.random()).slice(0, CFG.WINDOWS).sort((a, b) => a - b)

    const stats = {
        btcTrades: 0, btcWins: 0, btcLosses: 0, btcNoSignal: 0,
        altTrades: 0, altWins: 0,
        totalBtcPnl: 0, totalAltPnl: 0, totalHedgePnl: 0,
        confidence: [],
        confirmed2plus: 0, confirmed1: 0, confirmed0: 0,
        dynamicSizes: { "95%": 0, "80%": 0, "65%": 0, "45%": 0, "skip": 0 },
    }

    const startCap = CFG.CAPITAL * 10 + CFG.ASSET_CAPITAL * 20
    let capital = CFG.CAPITAL * 10
    let altCap = CFG.ASSET_CAPITAL * 20
    const equity = []

    console.log("  Fetching BTC + ETH + SOL + XRP data...\n")

    const BATCH = 5, DELAY = 350
    for (let i = 0; i < windows.length; i += BATCH) {
        const batch = windows.slice(i, i + BATCH)
        const batchData = await Promise.all(batch.map(async (t) => {
            const candleMap = {}
            await Promise.all(Object.entries(CFG.ASSETS).map(async ([asset, acfg]) => {
                candleMap[asset] = await fetchCandles(acfg.pair, t)
            }))
            return { t, candleMap }
        }))

        for (const { candleMap } of batchData) {
            const result = simulateWindow(candleMap, CFG.CAPITAL)
            if (!result) continue
            const altResult = simulateAssets(candleMap, result)

            stats.totalHedgePnl += result.hedgePnl
            stats.totalBtcPnl += result.convictionPnl
            stats.totalAltPnl += altResult.pnl
            stats.altTrades += altResult.trades
            stats.altWins += altResult.wins
            capital += result.totalPnl
            altCap += altResult.pnl
            equity.push(capital + altCap)

            if (result.signal) {
                stats.btcTrades++
                stats.confidence.push(result.conviction)
                if (result.conviction > 0) {
                    if (result.convictionPnl > 0) stats.btcWins++
                    else stats.btcLosses++
                }
                if (result.confirmedAssets >= 2) stats.confirmed2plus++
                else if (result.confirmedAssets === 1) stats.confirmed1++
                else stats.confirmed0++
                const f = result.conviction
                if (f >= 0.90) stats.dynamicSizes["95%"]++
                else if (f >= 0.75) stats.dynamicSizes["80%"]++
                else if (f >= 0.60) stats.dynamicSizes["65%"]++
                else if (f >= 0.40) stats.dynamicSizes["45%"]++
                else stats.dynamicSizes["skip"]++
            } else {
                stats.btcNoSignal++
            }
        }
        process.stdout.write(`\r  Progress: ${Math.min(i + BATCH, windows.length)}/${windows.length}`)
        if (i + BATCH < windows.length) await new Promise(r => setTimeout(r, DELAY))
    }

    const totalPnl = stats.totalBtcPnl + stats.totalAltPnl + stats.totalHedgePnl
    const endCap = startCap + totalPnl
    const btcWR = stats.btcTrades > 0 ? (stats.btcWins / stats.btcTrades * 100).toFixed(1) : "N/A"
    const altWR = stats.altTrades > 0 ? (stats.altWins / stats.altTrades * 100).toFixed(1) : "N/A"
    const avgConf = stats.confidence.length
        ? (stats.confidence.reduce((a, b) => a + b, 0) / stats.confidence.length * 100).toFixed(1) : "N/A"

    console.log("\n\n══════════════════════════════════════════════════════════")
    console.log("                        RESULTS")
    console.log("══════════════════════════════════════════════════════════")
    console.log()
    console.log("  ① BTC MARKETS (with Dual-Side Hedge)")
    console.log(`    Signal windows   : ${stats.btcTrades}  |  No signal: ${stats.btcNoSignal}`)
    console.log(`    Conviction W/L   : ${stats.btcWins} / ${stats.btcLosses}  (${btcWR}% win rate)`)
    console.log(`    Conviction P&L   : ${stats.totalBtcPnl >= 0 ? "+" : ""}$${stats.totalBtcPnl.toFixed(2)}`)
    console.log(`    Hedge P&L        : ${stats.totalHedgePnl >= 0 ? "+" : ""}$${stats.totalHedgePnl.toFixed(2)}`)
    console.log()
    console.log("  ② MULTI-ASSET CORRELATED BETS (ETH + SOL + XRP)")
    console.log(`    Alt trades fired : ${stats.altTrades}`)
    console.log(`    Alt win rate     : ${altWR}%`)
    console.log(`    Alt total P&L    : ${stats.totalAltPnl >= 0 ? "+" : ""}$${stats.totalAltPnl.toFixed(2)}`)
    console.log()
    console.log("  ③ DYNAMIC SIZING DISTRIBUTION")
    console.log(`    Avg confidence   : ${avgConf}%`)
    console.log(`    95% bet size     : ${stats.dynamicSizes["95%"]} windows (highest conviction)`)
    console.log(`    80% bet size     : ${stats.dynamicSizes["80%"]} windows`)
    console.log(`    65% bet size     : ${stats.dynamicSizes["65%"]} windows`)
    console.log(`    45% bet size     : ${stats.dynamicSizes["45%"]} windows`)
    console.log(`    Skipped (low)    : ${stats.dynamicSizes["skip"]} windows`)
    console.log()
    console.log("  CROSS-ASSET CONFIRMATION")
    console.log(`    2+ assets confirm: ${stats.confirmed2plus} windows`)
    console.log(`    1 asset confirms : ${stats.confirmed1} windows`)
    console.log(`    0 assets confirm : ${stats.confirmed0} windows (BTC alone)`)
    console.log()
    console.log("══════════════════════════════════════════════════════════")
    console.log("  FINAL PERFORMANCE")
    console.log("══════════════════════════════════════════════════════════")
    console.log(`  Starting capital : $${startCap.toFixed(2)}`)
    console.log(`  Final capital    : $${endCap.toFixed(2)}`)
    console.log()
    console.log("  P&L BREAKDOWN:")
    console.log(`    BTC conviction  : ${stats.totalBtcPnl >= 0 ? "+" : ""}$${stats.totalBtcPnl.toFixed(2)}`)
    console.log(`    Alt correlation : ${stats.totalAltPnl >= 0 ? "+" : ""}$${stats.totalAltPnl.toFixed(2)}`)
    console.log(`    Dual-side hedge : ${stats.totalHedgePnl >= 0 ? "+" : ""}$${stats.totalHedgePnl.toFixed(2)}`)
    console.log(`                      ${"─".repeat(30)}`)
    console.log(`    TOTAL P&L       : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`)
    console.log(`    Total Return    : ${((endCap / startCap - 1) * 100).toFixed(2)}%`)

    // ASCII equity curve
    if (equity.length > 1) {
        const ROWS = 12, COLS = 55
        const step = Math.max(1, Math.ceil(equity.length / COLS))
        const sampled = []
        for (let i = 0; i < equity.length; i += step) sampled.push(equity[i])
        const minV = Math.min(...sampled), maxV = Math.max(...sampled)
        const range = maxV - minV || 1
        console.log()
        console.log("══════════════════════════════════════════════════════════")
        console.log("  EQUITY CURVE  (BTC + Alt combined)")
        console.log("══════════════════════════════════════════════════════════")
        console.log(`  $${maxV.toFixed(0)}`)
        const grid = Array.from({ length: ROWS }, () => Array(sampled.length).fill(" "))
        sampled.forEach((v, col) => {
            const row = ROWS - 1 - Math.round(((v - minV) / range) * (ROWS - 1))
            grid[Math.max(0, Math.min(ROWS - 1, row))][col] = "●"
        })
        grid.forEach(row => console.log("  |" + row.join("")))
        console.log(`  $${minV.toFixed(0)}`)
        console.log(`   ${"─".repeat(sampled.length)}`)
        console.log(`   Start${" ".repeat(Math.max(1, sampled.length - 10))}End`)
    }

    console.log("\n✅  Done.\n")
}

main().catch(e => { console.error(e.message); process.exit(1) })
