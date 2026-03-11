/**
 * paperbot.js — 0x8dxd Strategy Bot  (PM-FIRST Architecture v3)
 * ==============================================================
 * STRATEGY: Polymarket Lag Detection
 *   1. Scan ALL active uncertain crypto prediction markets on Polymarket
 *   2. Parse question → extract asset, direction (above/below), threshold price, expiry
 *   3. Compute Binance-implied fair value (lognormal Black-Scholes digital option)
 *   4. Compare vs real CLOB ask → detect lag ≥ LAG_THRESHOLD (5¢)
 *   5. Enter paper position at real CLOB price
 *   6. Monitor every N minutes (adaptive to time-to-expiry)
 *   7. Exit: Take Profit | Stop Loss | Settlement
 *
 * EXPIRY TIERS (determines monitor frequency & LAG sensitivity):
 *   🔴 ULTRA  < 6h  → monitor every 1 min  — highest sensitivity
 *   🟠 SHORT  < 24h → monitor every 2 min
 *   🟡 MEDIUM < 72h → monitor every 5 min
 *   🟢 LONG   < 14d → monitor every 15 min
 *
 * TP / SL on Polymarket:
 *   Polymarket has NO native stop/limit-exit orders.
 *   TP & SL are implemented by the bot monitoring CLOB prices and
 *   placing a market SELL when the threshold is crossed.
 *   In live mode: TP → limit sell order placed right after entry.
 *                 SL → market sell triggered by monitor loop.
 *
 * RUN:  node paperbot.js   (or: npm run paperbot)
 * STOP: Ctrl+C  (saves final report to paper_trades.json)
 */

require('dotenv').config()
const WebSocket = require('ws')
const fs        = require('fs')
const path      = require('path')
const axios     = require('axios')

// ───────────────────────────────────────────────────────────────
//  ① CONFIG
// ───────────────────────────────────────────────────────────────
const CONFIG = {
    PAPER_TRADING:    true,     // ← flip to false for live trading

    // Capital
    STARTING_CAPITAL: 10,       // $10 paper start
    BET_PCT:          0.10,     // 10% of capital per trade
    MIN_BET:          1.00,     // Polymarket minimum — $1 USDC
    MAX_OPEN:         6,        // max concurrent open positions

    // Signal thresholds
    LAG_THRESHOLD:    0.05,     // 5¢ gap between fair value and PM CLOB price = entry
    STOP_LOSS_FRAC:   0.30,     // close if PM price drops 30% from entry (relative)
    TAKE_PROFIT_FRAC: 0.18,     // close if PM price rises 18% from entry (relative)

    // Market filters (widen to catch more markets)
    MAX_DAYS_EXPIRY:  30,       // max 30 days to expiry
    MIN_UNCERTAINTY:  0.10,     // Yes price must be in [10%, 90%] range
    MIN_LIQUIDITY:    100,      // minimum $100 liquidity on the market

    // Scan settings
    SCAN_INTERVAL_MS: 30 * 1000,   // full PM scan every 30 seconds

    // Adaptive monitor intervals (by expiry tier)
    MONITOR_MS: {
        ULTRA:  1 * 60 * 1000,    // <6h  → every 1 min
        SHORT:  2 * 60 * 1000,    // <24h → every 2 min
        MEDIUM: 5 * 60 * 1000,    // <72h → every 5 min
        LONG:  15 * 60 * 1000,    // <30d → every 15 min
    },

    // Per-tier lag threshold boost (near-expiry markets need smaller lag to trade)
    LAG_BOOST: {
        ULTRA:  -0.02,  // entry at 3¢ lag for ultra-short markets
        SHORT:  -0.01,  // 4¢ for short
        MEDIUM:  0.00,  // 5¢ default
        LONG:    0.02,  // 7¢ for long (need more edge)
    },

    // Annualised volatility per asset (for fair value calc)
    ANNUAL_VOL: {
        BTC:  0.75, ETH: 0.85, SOL: 1.10, XRP: 0.90,
        DOGE: 1.20, BNB: 0.80, ADA: 1.00, AVAX: 1.15,
        LINK: 1.05, MATIC: 1.20, DOT: 1.00, SHIB: 1.50,
    },

    // Polymarket APIs
    PM_GAMMA:      'https://gamma-api.polymarket.com',
    PM_CLOB:       'https://clob.polymarket.com',
    PM_API_KEY:    process.env.PM_API_KEY    || '',
    PM_SECRET:     process.env.PM_SECRET     || '',
    PM_PASSPHRASE: process.env.PM_PASSPHRASE || '',

    TAKER_FEE: 0.018,   // 1.8% taker fee

    LOG_FILE: path.join(__dirname, 'paper_trades.json'),
}

// ───────────────────────────────────────────────────────────────
//  ② ASSET MAP — all tracked crypto assets
// ───────────────────────────────────────────────────────────────
const ASSET_MAP = {
    BTC:   { pair: 'BTCUSDT',  vol: 0.75,  terms: ['Will Bitcoin', 'bitcoin price', 'BTC price', 'Will BTC', 'bitcoin above', 'bitcoin below'] },
    ETH:   { pair: 'ETHUSDT',  vol: 0.85,  terms: ['Will Ethereum', 'ethereum price', 'ETH price', 'Will ETH'] },
    SOL:   { pair: 'SOLUSDT',  vol: 1.10,  terms: ['Will Solana', 'solana price', 'SOL price'] },
    XRP:   { pair: 'XRPUSDT',  vol: 0.90,  terms: ['Will XRP', 'xrp price', 'ripple price'] },
    DOGE:  { pair: 'DOGEUSDT', vol: 1.20,  terms: ['Will Dogecoin', 'dogecoin price', 'DOGE price'] },
    BNB:   { pair: 'BNBUSDT',  vol: 0.80,  terms: ['Will BNB', 'bnb price', 'binance coin price'] },
    ADA:   { pair: 'ADAUSDT',  vol: 1.00,  terms: ['Will Cardano', 'cardano price', 'ADA price'] },
    AVAX:  { pair: 'AVAXUSDT', vol: 1.15,  terms: ['Will Avalanche', 'avalanche price', 'AVAX price'] },
    LINK:  { pair: 'LINKUSDT', vol: 1.05,  terms: ['Will Chainlink', 'chainlink price', 'LINK price'] },
    MATIC: { pair: 'MATICUSDT', vol: 1.20, terms: ['Will Polygon', 'polygon price', 'MATIC price', 'POL price'] },
    DOT:   { pair: 'DOTUSDT',  vol: 1.00,  terms: ['Will Polkadot', 'polkadot price', 'DOT price'] },
    SHIB:  { pair: 'SHIBUSDT', vol: 1.50,  terms: ['Will Shiba', 'shiba inu price', 'SHIB price'] },
}

// Aliases used in question parser
const ASSET_ALIASES = {
    'bitcoin': 'BTC', 'btc': 'BTC',
    'ethereum': 'ETH', 'eth': 'ETH',
    'solana': 'SOL', 'sol': 'SOL',
    'xrp': 'XRP', 'ripple': 'XRP',
    'dogecoin': 'DOGE', 'doge': 'DOGE',
    'bnb': 'BNB', 'binance coin': 'BNB',
    'cardano': 'ADA', 'ada': 'ADA',
    'avalanche': 'AVAX', 'avax': 'AVAX',
    'chainlink': 'LINK', 'link': 'LINK',
    'polygon': 'MATIC', 'matic': 'MATIC', 'pol': 'MATIC',
    'polkadot': 'DOT', 'dot': 'DOT',
    'shiba': 'SHIB', 'shib': 'SHIB', 'shiba inu': 'SHIB',
}

// ───────────────────────────────────────────────────────────────
//  ③ STATE
// ───────────────────────────────────────────────────────────────

const binancePrices = {}           // { BTC: 84000, ETH: 2100, ... }
Object.keys(ASSET_MAP).forEach(a => { binancePrices[a] = null })

const activeMarkets = []           // discovered PM markets (refreshed every 15 min)
let monitorTimers   = new Map()    // posId → adaptive timer handle

const portfolio = {
    capital:       CONFIG.STARTING_CAPITAL,
    start:         CONFIG.STARTING_CAPITAL,
    openPositions: [],
    closedTrades:  [],
    dayStart:      CONFIG.STARTING_CAPITAL,
    sessionStart:  new Date(),
}

let scanCount    = 0
let totalSignals = 0

// ───────────────────────────────────────────────────────────────
//  ④ EXPIRY TIER CLASSIFIER
// ───────────────────────────────────────────────────────────────

function getExpiryTier(endMs) {
    const hoursLeft = (endMs - Date.now()) / 3_600_000
    if (hoursLeft < 6)   return 'ULTRA'
    if (hoursLeft < 24)  return 'SHORT'
    if (hoursLeft < 72)  return 'MEDIUM'
    return 'LONG'
}

const TIER_EMOJI = { ULTRA: '🔴', SHORT: '🟠', MEDIUM: '🟡', LONG: '🟢' }
const TIER_LABEL = { ULTRA: '<6h', SHORT: '<24h', MEDIUM: '<72h', LONG: '<30d' }

// ───────────────────────────────────────────────────────────────
//  ⑤ MATH: NORMAL CDF + LOGNORMAL FAIR VALUE
// ───────────────────────────────────────────────────────────────

function normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x))
    const d = 0.3989423 * Math.exp(-x * x / 2)
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
    return x > 0 ? 1 - p : p
}

/**
 * Black-Scholes digital option fair value.
 * "What is the probability asset stays ABOVE (or BELOW) threshold by expiry,
 *  given current price and annualised volatility?"
 */
function computeFairValue(currentPrice, threshold, daysLeft, annualVol, direction) {
    if (daysLeft <= 0) {
        const yes = direction === 'above' ? currentPrice >= threshold : currentPrice <= threshold
        return yes ? 0.99 : 0.01
    }
    const T = Math.max(daysLeft / 365, 1 / (365 * 24))   // min 1 hour
    const d = Math.log(currentPrice / threshold) / (annualVol * Math.sqrt(T))
    const probAbove = normalCDF(d)
    return Math.max(0.01, Math.min(0.99, direction === 'above' ? probAbove : 1 - probAbove))
}

// ───────────────────────────────────────────────────────────────
//  ⑥ QUESTION PARSER
// ───────────────────────────────────────────────────────────────

/**
 * Parses Polymarket question text to extract:
 *   { asset, direction: 'above'|'below', threshold }
 * Handles formats like:
 *   "Will Bitcoin be above $84,000 on March 15?"
 *   "Will ETH reach $3k by end of March?"
 *   "Will Solana drop below $100 by April?"
 *   "Will BTC hit $100,000 before April 2026?"
 */
function parseMarketQuestion(question) {
    const q = question.toLowerCase()

    // Detect asset
    let asset = null
    for (const [alias, sym] of Object.entries(ASSET_ALIASES)) {
        if (q.includes(alias)) { asset = sym; break }
    }
    if (!asset) return null

    // Detect direction
    let direction = null
    if (/above|reach|exceed|hit|break|over|surpass|cross|past/.test(q)) direction = 'above'
    else if (/below|drop|fall|under|crash|dip|sink/.test(q)) direction = 'below'
    if (!direction) return null

    // Extract price threshold
    let threshold = null
    const p1 = question.match(/\$[\d,]+(\.\d+)?\s*[Bb]/g)     // $100b → billion
    const p2 = question.match(/\$[\d,]+(\.\d+)?\s*[Mm]/g)     // $1m → million
    const p3 = question.match(/\$[\d,]+(\.\d+)?\s*[Kk]/g)     // $84k → thousand
    const p4 = question.match(/\$[\d,]+(\.\d+)?/g)             // $84,000

    if (p1?.length)      threshold = parseFloat(p1[0].replace(/[$,bB]/g,'')) * 1e9
    else if (p2?.length) threshold = parseFloat(p2[0].replace(/[$,mM]/g,'')) * 1e6
    else if (p3?.length) threshold = parseFloat(p3[0].replace(/[$,kK]/g,'')) * 1e3
    else if (p4?.length) threshold = parseFloat(p4[0].replace(/[$,]/g,''))

    if (!threshold || threshold <= 0) return null

    return { asset, direction, threshold }
}

// ───────────────────────────────────────────────────────────────
//  ⑦ POLYMARKET MARKET DISCOVERY
// ───────────────────────────────────────────────────────────────

async function discoverPMMarkets() {
    log('\n🔎 Discovering Polymarket crypto prediction markets...')
    const now       = Date.now()
    const maxExpiry = now + CONFIG.MAX_DAYS_EXPIRY * 86_400_000
    const found     = []
    const seen      = new Set()

    for (const [asset, cfg] of Object.entries(ASSET_MAP)) {
        for (const term of cfg.terms) {
            try {
                const r = await axios.get(`${CONFIG.PM_GAMMA}/markets`, {
                    params: { active: true, closed: false, keyword: term, limit: 20 },
                    timeout: 6000,
                })
                for (const m of r.data) {
                    if (seen.has(m.conditionId)) continue
                    if (!m.enableOrderBook || !m.clobTokenIds) continue
                    if (parseFloat(m.liquidity || '0') < CONFIG.MIN_LIQUIDITY) continue

                    const endMs = new Date(m.endDate).getTime()
                    if (isNaN(endMs) || endMs < now || endMs > maxExpiry) continue

                    const rawPrices = JSON.parse(m.outcomePrices || '["0.5","0.5"]')
                    const yesPrice  = parseFloat(rawPrices[0])
                    if (yesPrice < CONFIG.MIN_UNCERTAINTY || yesPrice > (1 - CONFIG.MIN_UNCERTAINTY)) continue

                    const parsed = parseMarketQuestion(m.question)
                    if (!parsed || parsed.asset !== asset) continue

                    const tokenIds = JSON.parse(m.clobTokenIds)
                    seen.add(m.conditionId)
                    const tier = getExpiryTier(endMs)
                    found.push({
                        conditionId:  m.conditionId,
                        question:     m.question,
                        endDate:      m.endDate,
                        endMs,
                        tier,
                        asset:        parsed.asset,
                        direction:    parsed.direction,
                        threshold:    parsed.threshold,
                        yesTokenId:   tokenIds[0],
                        noTokenId:    tokenIds[1],
                        liquidity:    parseFloat(m.liquidity || '0'),
                        lastYesPrice: yesPrice,
                        clobYesAsk:   yesPrice,  // refreshed each scan
                        fairValue:    null,
                        lag:          null,
                    })
                }
            } catch (_) { /* rate limit / timeout — silently skip */ }
        }
    }

    // Sort: ULTRA first, then by expiry ascending (shortest = most volatile = most edge)
    const tierOrder = { ULTRA: 0, SHORT: 1, MEDIUM: 2, LONG: 3 }
    found.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.endMs - b.endMs)

    activeMarkets.length = 0
    for (const m of found) activeMarkets.push(m)

    // Group output by tier
    const byTier = { ULTRA: [], SHORT: [], MEDIUM: [], LONG: [] }
    for (const m of activeMarkets) byTier[m.tier].push(m)

    log(`  📋 Found ${activeMarkets.length} tradeable markets across ${Object.keys(ASSET_MAP).length} assets\n`)
    for (const [tier, markets] of Object.entries(byTier)) {
        if (markets.length === 0) continue
        log(`  ${TIER_EMOJI[tier]} ${tier} (${TIER_LABEL[tier]}) — ${markets.length} markets`)
        for (const m of markets) {
            const hoursLeft = ((m.endMs - Date.now()) / 3_600_000).toFixed(1)
            log(`     ${m.asset} ${m.direction.toUpperCase()} $${m.threshold.toLocaleString()} | Yes=${(m.lastYesPrice*100).toFixed(1)}¢ | liq=$${m.liquidity.toFixed(0)} | ${hoursLeft}h left`)
        }
    }

    if (activeMarkets.length === 0) {
        log('  ⚠️  No suitable markets found. Bot will retry in 15 minutes.')
        log('     Tips to find more markets:')
        log('       — Markets near current prices (within ±20%) are most likely to be uncertain')
        log('       — Try widening MIN_UNCERTAINTY or MAX_DAYS_EXPIRY in CONFIG')
    }
}

// ───────────────────────────────────────────────────────────────
//  ⑧ CLOB PRICE FETCHER
// ───────────────────────────────────────────────────────────────

async function getCLOBPrice(tokenId) {
    try {
        const r = await axios.get(`${CONFIG.PM_CLOB}/book`, {
            params: { token_id: tokenId }, timeout: 4000,
        })
        const asks = r.data?.asks || []
        const bids = r.data?.bids || []
        if (asks.length > 0) {
            return {
                ask: parseFloat(asks[0].price),
                bid: bids.length > 0 ? parseFloat(bids[0].price) : null,
                spread: bids.length > 0
                    ? parseFloat(asks[0].price) - parseFloat(bids[0].price)
                    : null,
                source: 'book',
            }
        }
    } catch (_) {}
    try {
        const r = await axios.get(`${CONFIG.PM_CLOB}/last-trade-price`, {
            params: { token_id: tokenId }, timeout: 4000,
        })
        const p = r.data?.price ? parseFloat(r.data.price) : null
        return p ? { ask: p, bid: p, spread: 0, source: 'last-trade' } : null
    } catch (_) {}
    return null
}

// ───────────────────────────────────────────────────────────────
//  ⑨ SCAN LOOP — compare PM CLOB vs Binance-implied fair value
// ───────────────────────────────────────────────────────────────

async function runScan() {
    scanCount++
    const now    = Date.now()
    const assets = Object.keys(binancePrices).filter(a => binancePrices[a] !== null)
    log(`\n⟳ Scan #${scanCount} [${new Date().toISOString().slice(11,19)}] — ${activeMarkets.length} markets | assets live: ${assets.join(',')}`)

    if (activeMarkets.length === 0) {
        log('  (No markets. Next discovery in 15 min)')
        return
    }

    for (const market of activeMarkets) {
        const binancePrice = binancePrices[market.asset]
        if (!binancePrice) continue

        const daysLeft   = Math.max(0, (market.endMs - now) / 86_400_000)
        const hoursLeft  = daysLeft * 24
        const annualVol  = CONFIG.ANNUAL_VOL[market.asset] || 0.90
        const fairValue  = computeFairValue(binancePrice, market.threshold, daysLeft, annualVol, market.direction)
        market.fairValue = fairValue
        market.tier      = getExpiryTier(market.endMs)

        // Fetch real CLOB price
        let clobAsk = market.lastYesPrice
        const clob  = await getCLOBPrice(market.yesTokenId)
        if (clob) {
            clobAsk = clob.ask
            market.clobYesAsk = clob.ask
        }

        const lag    = fairValue - clobAsk
        market.lag   = lag
        const lagThreshold = CONFIG.LAG_THRESHOLD + (CONFIG.LAG_BOOST[market.tier] || 0)

        const tierEmoji = TIER_EMOJI[market.tier]
        const spreadStr = clob?.spread != null ? ` spread=${(clob.spread*100).toFixed(1)}¢` : ''
        log(`  ${tierEmoji} ${market.asset} ${market.direction.toUpperCase()} $${market.threshold.toLocaleString()} (${hoursLeft.toFixed(1)}h)`)
        log(`    Binance=$${binancePrice.toLocaleString(undefined,{maximumFractionDigits:4})}  Fair=${(fairValue*100).toFixed(1)}¢  CLOB=${(clobAsk*100).toFixed(1)}¢  Lag=${lag >= 0 ? '+' : ''}${(lag*100).toFixed(1)}¢${spreadStr}`)

        if (Math.abs(lag) < lagThreshold) {
            log(`    → No edge (|lag|=${(Math.abs(lag)*100).toFixed(1)}¢ < ${(lagThreshold*100).toFixed(0)}¢)`)
            continue
        }

        const alreadyOpen = portfolio.openPositions.some(p => p.conditionId === market.conditionId)
        if (alreadyOpen) { log(`    → Already open`); continue }

        if (portfolio.openPositions.length >= CONFIG.MAX_OPEN) {
            log(`    → Max ${CONFIG.MAX_OPEN} positions open — skipping`)
            continue
        }

        // ── SIGNAL ────────────────────────────────────────────
        totalSignals++
        const direction   = lag > 0 ? 'YES' : 'NO'
        const tokenId     = direction === 'YES' ? market.yesTokenId : market.noTokenId
        const entryPrice  = direction === 'YES' ? clobAsk : (1 - clobAsk)
        const targetPrice = direction === 'YES' ? fairValue : (1 - fairValue)

        log(`  🎯 SIGNAL #${totalSignals} [${market.tier}]: BUY ${direction} on ${market.asset} — lag=${(lag*100).toFixed(1)}¢  threshold=${(lagThreshold*100).toFixed(0)}¢`)
        log(`     Entry=${(entryPrice*100).toFixed(1)}¢  Fair target=${(targetPrice*100).toFixed(1)}¢`)
        log(`     "${market.question.slice(0,70)}"`)

        const betAmt = Math.min(
            CONFIG.STARTING_CAPITAL * CONFIG.BET_PCT,
            portfolio.capital * 0.25,
        )
        await enterPosition(market, direction, entryPrice, tokenId, betAmt, targetPrice)
    }
}

// ───────────────────────────────────────────────────────────────
//  ⑩ POSITION ENTRY
// ───────────────────────────────────────────────────────────────

async function enterPosition(market, direction, entryPrice, tokenId, betAmt, targetPrice) {
    if (betAmt < CONFIG.MIN_BET) {
        log(`  ⚠️  Bet $${betAmt.toFixed(2)} below minimum $${CONFIG.MIN_BET} — skipped`)
        return null
    }
    if (portfolio.capital < betAmt) {
        log(`  ⚠️  Insufficient capital — skipped`)
        return null
    }
    if (CONFIG.PAPER_TRADING) return placePaperOrder(market, direction, entryPrice, tokenId, betAmt, targetPrice)
    else                      return await placeLiveOrder(market, direction, entryPrice, tokenId, betAmt, targetPrice)
}

function placePaperOrder(market, direction, entryPrice, tokenId, betAmt, targetPrice) {
    const feeCost   = betAmt * CONFIG.TAKER_FEE
    const shares    = (betAmt - feeCost) / entryPrice
    const stopPrice = entryPrice * (1 - CONFIG.STOP_LOSS_FRAC)
    const tpPrice   = entryPrice * (1 + CONFIG.TAKE_PROFIT_FRAC)

    const pos = {
        id:           `${market.asset}-${direction}-${Date.now()}`,
        conditionId:  market.conditionId,
        question:     market.question,
        asset:        market.asset,
        direction,
        tier:         market.tier,
        threshold:    market.threshold,
        marketDir:    market.direction,
        tokenId,
        entryPrice,
        targetPrice,
        stopPrice,    // paper SL price (monitored by bot)
        tpPrice,      // paper TP price (monitored by bot)
        betAmt,
        shares,
        feePaid:      feeCost,
        openedAt:     new Date().toISOString(),
        endMs:        market.endMs,
        mode:         'PAPER',
    }

    portfolio.capital -= betAmt
    portfolio.openPositions.push(pos)

    const hoursLeft = ((market.endMs - Date.now()) / 3_600_000).toFixed(1)
    log(`  📝 PAPER ORDER:`)
    log(`     ${TIER_EMOJI[market.tier]} ${direction} ${market.asset} — "${market.question.slice(0,60)}..."`)
    log(`     Entry: ${(entryPrice*100).toFixed(1)}¢  |  Fair: ${(targetPrice*100).toFixed(1)}¢  |  Bet: $${betAmt.toFixed(2)}  |  Shares: ${shares.toFixed(3)}`)
    log(`     📉 Stop Loss  : ${(stopPrice*100).toFixed(1)}¢  (paper monitor — no native PM stop order)`)
    log(`     🎯 Take Profit: ${(tpPrice*100).toFixed(1)}¢  (paper monitor — live: limit sell on CLOB)`)
    log(`     Expires: ${new Date(market.endMs).toUTCString()}  (${hoursLeft}h)`)

    // Start adaptive monitor timer for this position
    startPositionMonitor(pos)
    return pos
}

/**
 * LIVE MODE STUB
 * In live mode, TP = limit sell placed immediately after buy fill.
 * SL = monitored by bot → market sell when threshold crossed.
 * No native stop/TP orders exist on Polymarket CLOB.
 */
async function placeLiveOrder(market, direction, entryPrice, tokenId, betAmt) {
    throw new Error('Live mode not yet implemented. Set PAPER_TRADING=true.')
}

// ───────────────────────────────────────────────────────────────
//  ⑪ ADAPTIVE POSITION MONITOR
//     Near-expiry positions are checked much more frequently.
// ───────────────────────────────────────────────────────────────

function startPositionMonitor(pos) {
    const interval = CONFIG.MONITOR_MS[pos.tier] || CONFIG.MONITOR_MS.LONG
    const tierLabel = TIER_LABEL[pos.tier]
    log(`  ⏱  ${pos.id}: monitoring every ${interval/60000} min [${pos.tier} ${tierLabel}]`)

    const timer = setInterval(async () => {
        // Re-check tier in case time has passed (e.g. LONG → MEDIUM → SHORT → ULTRA)
        const newTier = getExpiryTier(pos.endMs)
        if (newTier !== pos.tier) {
            log(`  📢 ${pos.id} tier upgraded: ${pos.tier} → ${newTier} (faster monitoring)`)
            pos.tier = newTier
            clearInterval(timer)
            monitorTimers.delete(pos.id)
            startPositionMonitor(pos)  // restart with new interval
            return
        }
        await checkPosition(pos)
    }, interval)

    monitorTimers.set(pos.id, timer)
}

async function checkPosition(pos) {
    // Is it still open?
    const stillOpen = portfolio.openPositions.some(p => p.id === pos.id)
    if (!stillOpen) {
        if (monitorTimers.has(pos.id)) {
            clearInterval(monitorTimers.get(pos.id))
            monitorTimers.delete(pos.id)
        }
        return
    }

    const clob = await getCLOBPrice(pos.tokenId)
    if (!clob) { log(`  ⏳ ${pos.id}: CLOB unavailable — holding`); return }

    const currentPrice = clob.ask
    const move         = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1)
    const pnlEst       = (currentPrice - pos.entryPrice) * pos.shares
    const now          = Date.now()
    const hoursLeft    = ((pos.endMs - now) / 3_600_000).toFixed(2)

    log(`  👁  ${TIER_EMOJI[pos.tier]} ${pos.direction} ${pos.asset}: entry=${(pos.entryPrice*100).toFixed(1)}¢ now=${(currentPrice*100).toFixed(1)}¢ (${move}%)  estPnL=${pnlEst >= 0 ? '+' : ''}$${pnlEst.toFixed(3)}  ${hoursLeft}h left`)

    if (now >= pos.endMs) {
        log(`    ⌛ EXPIRED — settling`)
        await closePosition(pos, currentPrice, 'SETTLEMENT')
    } else if (currentPrice >= pos.tpPrice) {
        log(`    🎯 TAKE PROFIT: ${(currentPrice*100).toFixed(1)}¢ ≥ ${(pos.tpPrice*100).toFixed(1)}¢`)
        await closePosition(pos, currentPrice, 'TAKE_PROFIT')
    } else if (currentPrice <= pos.stopPrice) {
        log(`    🛑 STOP LOSS: ${(currentPrice*100).toFixed(1)}¢ ≤ ${(pos.stopPrice*100).toFixed(1)}¢`)
        await closePosition(pos, currentPrice, 'STOP_LOSS')
    }
}

async function closePosition(pos, closePrice, reason) {
    const stillOpen = portfolio.openPositions.some(p => p.id === pos.id)
    if (!stillOpen) return  // already closed

    // Clean up monitor timer
    if (monitorTimers.has(pos.id)) {
        clearInterval(monitorTimers.get(pos.id))
        monitorTimers.delete(pos.id)
    }

    const grossReturn = pos.shares * closePrice
    const exitFee     = grossReturn * CONFIG.TAKER_FEE
    const netReturn   = grossReturn - exitFee
    const pnl         = netReturn - pos.betAmt
    const won         = closePrice > pos.entryPrice

    portfolio.capital += netReturn
    portfolio.openPositions = portfolio.openPositions.filter(p => p.id !== pos.id)
    portfolio.closedTrades.push({ ...pos, closePrice, pnl, won, closeReason: reason, closedAt: new Date().toISOString() })

    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(4)}` : `-$${Math.abs(pnl).toFixed(4)}`
    log(`  ${won ? '✅' : '❌'} CLOSED [${reason}]: ${pos.direction} ${pos.asset}`)
    log(`     Entry: ${(pos.entryPrice*100).toFixed(1)}¢ → Exit: ${(closePrice*100).toFixed(1)}¢  P&L: ${pnlStr}`)
    log(`     "${pos.question.slice(0,60)}..."`)
    printPortfolio()
    saveTrades()
}

// ───────────────────────────────────────────────────────────────
//  ⑫ BINANCE WEBSOCKET — real-time trade prices
// ───────────────────────────────────────────────────────────────

function connectBinanceWS() {
    const streams = Object.values(ASSET_MAP).map(a => `${a.pair.toLowerCase()}@trade`).join('/')
    const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`)

    ws.on('open', () => {
        log(`\n✅ Binance WebSocket connected — streaming ${Object.keys(ASSET_MAP).length} assets`)
    })
    ws.on('message', data => {
        try {
            const t = JSON.parse(data).data
            if (!t?.p) return
            const sym = t.s?.toUpperCase()
            for (const [asset, cfg] of Object.entries(ASSET_MAP)) {
                if (cfg.pair.toUpperCase() === sym) {
                    binancePrices[asset] = parseFloat(t.p)
                    break
                }
            }
        } catch (_) {}
    })
    ws.on('close', () => { log('⚠️  Binance WS disconnected — reconnecting in 5s'); setTimeout(connectBinanceWS, 5000) })
    ws.on('error', e => log(`⚠️  Binance WS error: ${e.message}`))
    return ws
}

// ───────────────────────────────────────────────────────────────
//  ⑬ LOGGING & PORTFOLIO
// ───────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString().slice(11, 19)
    console.log(`[${ts}] ${msg}`)
}

function printPortfolio() {
    const pnl     = portfolio.capital - portfolio.start
    const pnlPct  = ((portfolio.capital / portfolio.start - 1) * 100).toFixed(2)
    const wins    = portfolio.closedTrades.filter(t => t.won).length
    const losses  = portfolio.closedTrades.filter(t => !t.won).length
    const wr      = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '—'
    const elapsed = Math.floor((Date.now() - portfolio.sessionStart.getTime()) / 3_600_000)
    const livePrices = ['BTC','ETH','SOL','XRP','DOGE','BNB'].map(a => `${a}=$${(binancePrices[a]||0).toFixed(binancePrices[a]>1?0:4)}`).join('  ')

    console.log()
    console.log('  ┌──────────────────────────────────────────────────────')
    console.log(`  │  PORTFOLIO  (${CONFIG.PAPER_TRADING ? 'PAPER' : '⚠️  LIVE'})`)
    console.log(`  │  Capital  : $${portfolio.capital.toFixed(4)}  (${pnl >= 0 ? '+' : ''}${pnlPct}%)`)
    console.log(`  │  Trades   : ${wins}W / ${losses}L  (${wr}% win rate)   ${portfolio.openPositions.length} open`)
    console.log(`  │  Signals  : ${totalSignals}  |  Scans: ${scanCount}  |  Runtime: ${elapsed}h`)
    console.log(`  │  ${livePrices}`)
    console.log('  └──────────────────────────────────────────────────────')
    console.log()
}

function dailySummary() {
    log('\n' + '═'.repeat(60))
    log(`  DAILY SUMMARY — ${new Date().toDateString()}`)
    const today   = new Date().getDate()
    const todayT  = portfolio.closedTrades.filter(t => new Date(t.closedAt).getDate() === today)
    const todayPnl = todayT.reduce((a, t) => a + t.pnl, 0)
    log(`  Trades today : ${todayT.length}  (${todayT.filter(t=>t.won).length}W / ${todayT.filter(t=>!t.won).length}L)`)
    log(`  Today P&L   : ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(4)}`)
    log(`  Total capital: $${portfolio.capital.toFixed(4)}`)
    log('═'.repeat(60))
    portfolio.dayStart = portfolio.capital
    saveTrades()
}

function saveTrades() {
    const data = {
        savedAt:       new Date().toISOString(),
        mode:          CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE',
        strategy:      'PM-First Lag Detection v3',
        assets:        Object.keys(ASSET_MAP),
        startCap:      portfolio.start,
        currentCap:    portfolio.capital,
        totalPnl:      portfolio.capital - portfolio.start,
        totalSignals,
        scanCount,
        openPositions: portfolio.openPositions,
        closedTrades:  portfolio.closedTrades,
    }
    fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify(data, null, 2))
    log(`  💾 Saved ${portfolio.closedTrades.length} closed + ${portfolio.openPositions.length} open trades`)
}

// ───────────────────────────────────────────────────────────────
//  ⑭ GRACEFUL SHUTDOWN
// ───────────────────────────────────────────────────────────────

function shutdown() {
    console.log('\n\n⛔  Shutting down...')
    for (const timer of monitorTimers.values()) clearInterval(timer)
    printPortfolio()

    const wins    = portfolio.closedTrades.filter(t => t.won).length
    const losses  = portfolio.closedTrades.filter(t => !t.won).length
    const total   = wins + losses
    const totalPnl = portfolio.capital - portfolio.start

    console.log('  ── FINAL REPORT ──')
    console.log(`  Strategy  : PM-First Lag Detection v3`)
    console.log(`  Assets    : ${Object.keys(ASSET_MAP).join(', ')}`)
    console.log(`  Trades    : ${total}  (${wins}W / ${losses}L = ${total > 0 ? (wins/total*100).toFixed(1) : '0'}% win rate)`)
    console.log(`  Signals   : ${totalSignals} across ${scanCount} scans`)
    console.log(`  Start     : $${portfolio.start.toFixed(2)}`)
    console.log(`  End       : $${portfolio.capital.toFixed(2)}`)
    console.log(`  P&L       : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)}`)

    saveTrades()
    process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// ───────────────────────────────────────────────────────────────
//  ⑮ MAIN
// ───────────────────────────────────────────────────────────────

async function main() {
    console.clear()
    console.log('╔═══════════════════════════════════════════════════════════════╗')
    console.log(`║  0x8dxd Paper Bot v3 — ${CONFIG.PAPER_TRADING ? 'PAPER TRADING MODE         ' : '⚠️  LIVE TRADING MODE     '} ║`)
    console.log('║  Strategy : PM-First Lag Detection                           ║')
    console.log(`║  Assets   : ${Object.keys(ASSET_MAP).join(', ').padEnd(47)} ║`)
    console.log('╚═══════════════════════════════════════════════════════════════╝\n')
    console.log(`  Starting capital : $${CONFIG.STARTING_CAPITAL}`)
    console.log(`  Bet per trade    : ${(CONFIG.BET_PCT*100).toFixed(0)}% = $${(CONFIG.STARTING_CAPITAL*CONFIG.BET_PCT).toFixed(2)}`)
    console.log(`  Lag threshold    : ${(CONFIG.LAG_THRESHOLD*100).toFixed(0)}¢  (±boost by expiry tier)`)
    console.log(`  Take profit      : +${(CONFIG.TAKE_PROFIT_FRAC*100).toFixed(0)}% of entry  |  Stop loss: -${(CONFIG.STOP_LOSS_FRAC*100).toFixed(0)}%`)
    console.log(`  Expiry window    : up to ${CONFIG.MAX_DAYS_EXPIRY} days  |  Min liquidity: $${CONFIG.MIN_LIQUIDITY}`)
    console.log(`  Monitor rates    : 🔴 1min (ULTRA) 🟠 2min (SHORT) 🟡 5min (MEDIUM) 🟢 15min (LONG)`)
    console.log(`  TP/SL note       : Polymarket has no native stop orders — both are monitored & triggered by bot`)
    console.log(`  Log file         : paper_trades.json\n`)

    if (!CONFIG.PAPER_TRADING) {
        if (!CONFIG.PM_API_KEY) { console.error('❌ PM_API_KEY not set'); process.exit(1) }
        console.log('⚠️  LIVE MODE — aborting in 5s if not killed'); await new Promise(r => setTimeout(r, 5000))
    }

    // ① Connect Binance WS
    connectBinanceWS()

    // ② Fetch initial Binance prices via REST
    log('\n  Fetching initial Binance prices...')
    for (const [asset, cfg] of Object.entries(ASSET_MAP)) {
        try {
            const r = await axios.get('https://api.binance.com/api/v3/ticker/price', {
                params: { symbol: cfg.pair }, timeout: 5000,
            })
            binancePrices[asset] = parseFloat(r.data.price)
        } catch (_) {}
    }
    const priceStr = Object.entries(binancePrices)
        .filter(([,v]) => v !== null)
        .map(([a,v]) => `${a}=$${v.toFixed(v>1?2:4)}`)
        .join('  ')
    log(`  Prices: ${priceStr}`)

    // ③ Discover PM markets (repeat every 15 min)
    await discoverPMMarkets()
    setInterval(discoverPMMarkets, 15 * 60 * 1000)

    // ④ Main scan loop
    log('\n  Bot running. Ctrl+C to stop.\n')
    await runScan()
    setInterval(runScan, CONFIG.SCAN_INTERVAL_MS)

    // ⑤ Portfolio print every 30 min
    setInterval(printPortfolio, 30 * 60 * 1000)

    // ⑥ Auto-save every 5 min
    setInterval(saveTrades, 5 * 60 * 1000)

    // ⑦ Daily summary at UTC midnight
    const schedDaily = () => {
        const next = new Date(); next.setUTCHours(24, 0, 0, 0)
        setTimeout(() => { dailySummary(); schedDaily() }, next.getTime() - Date.now())
    }
    schedDaily()

    // ⑧ Start dummy HTTP server for Render Free Tier (Web Service)
    const express = require('express')
    const app = express()
    app.get('/', (req, res) => res.send('0x8dxd Paper Bot is running!'))
    const port = process.env.PORT || 3000
    app.listen(port, () => console.log(`  🌐 Dummy web server listening on port ${port} (for Render Free Tier)`))
}

main().catch(e => { console.error(e); process.exit(1) })
