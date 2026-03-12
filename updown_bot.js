/**
 * updown_bot.js — 0x8dxd-Style 5-Minute BTC Up/Down Strategy
 * ============================================================
 * STRATEGY (reverse-engineered from 0x8dxd wallet activity):
 *
 *  1. TARGET MARKET : "Bitcoin Up or Down" — rolling 5-min binary markets
 *                     New market spawned every 5 min on Polymarket 24/7.
 *
 *  2. SIGNAL        : Binance 1-minute candle momentum
 *                     → Strong up   = BUY "Up"   token on 5-min market
 *                     → Strong down = BUY "Down"  token on 5-min market
 *
 *  3. POSITION SIZE : Split bet into 3-5 small orders to minimise price
 *                     impact on thin CLOB.  Max 30% of capital per trade.
 *
 *  4. DELTA HEDGE   : Simultaneously open a small opposite-direction
 *                     position on the current 1-HOUR Up/Down market.
 *                     Reduces ruin-risk when momentum reverses mid-window.
 *
 *  5. EXIT - 2 modes
 *     a) SETTLEMENT : Hold to expiry (5 min). Pays $1 per share if correct.
 *                     Used when entry confidence is HIGH (momentum strong).
 *     b) MOMENTUM   : Bot monitors current price every 30s.
 *                     If market price of our token drops ≥ EARLY_EXIT_FRAC
 *                     from entry → sell early to recover partial value.
 *
 *  6. PROFIT LOOP   : Repeat every 5 min, compound capital.
 *
 * RUN:  node updown_bot.js
 * STOP: Ctrl+C  (saves final report to updown_trades.json)
 */

require('dotenv').config()
const WebSocket = require('ws')
const axios     = require('axios')
const fs        = require('fs')
const path      = require('path')

// ─────────────────────────────────────────────────────────────
//  ① CONFIG
// ─────────────────────────────────────────────────────────────
const CONFIG = {
    // ── Capital ──────────────────────────────────────────────
    PAPER_TRADING:      true,    // flip to false for live
    STARTING_CAPITAL:   25.00,  // $25 test capital
    BET_PCT:            0.28,   // 28% of capital per 5-min trade (~$7)
    HEDGE_PCT:          0.06,   // 6% extra on hourly hedge (~$1.50)
    MAX_CONCURRENT:     1,      // only 1 open 5-min position at a time

    // ── Signal ───────────────────────────────────────────────
    // Momentum is measured as the net % move over last N 1-min candles
    MOMENTUM_WINDOW:    3,      // look at last 3 completed 1-min candles
    MOMENTUM_THRESHOLD: 0.0015, // 0.15% net move required to enter (≈$125 on BTC)
    STRONG_MOMENTUM:    0.0035, // 0.35% = high-confidence → hold to settlement
                                //        (below this → early-exit mode)

    // ── Exit ─────────────────────────────────────────────────
    EARLY_EXIT_FRAC:    0.35,   // exit early if token price drops 35% from entry
    MONITOR_INTERVAL:   30,     // check open positions every 30s (seconds)
    HOLD_TO_SETTLE:     true,   // override: always hold to settlement in paper mode

    // ── Polymarket APIs ───────────────────────────────────────
    PM_GAMMA:  'https://gamma-api.polymarket.com',
    PM_CLOB:   'https://clob.polymarket.com',
    TAKER_FEE: 0.018,

    // ── Misc ─────────────────────────────────────────────────
    LOG_FILE: path.join(__dirname, 'updown_trades.json'),
    SCAN_AT_WINDOW_START: true,  // enter only in first 90s of a new 5-min window
    ENTRY_WINDOW_SEC:     90,    // seconds after window start to allow entry
}

// ─────────────────────────────────────────────────────────────
//  ② STATE
// ─────────────────────────────────────────────────────────────
const binance = {
    price:   null,          // latest BTC/USDT tick
    candles: [],            // array of completed 1-min OHLCV objects
    currentCandle: null,    // building candle for current minute
}

const portfolio = {
    capital:       CONFIG.STARTING_CAPITAL,
    start:         CONFIG.STARTING_CAPITAL,
    sessionStart:  new Date(),
    openPositions: [],   // active 5-min + hedge positions
    closedTrades:  [],
}

let scanCount    = 0
let totalSignals = 0

// ─────────────────────────────────────────────────────────────
//  ③ LOGGING
// ─────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString().slice(11, 19)
    console.log(`[${ts}] ${msg}`)
}

// ─────────────────────────────────────────────────────────────
//  ④ BINANCE — WebSocket + 1-min candle builder
// ─────────────────────────────────────────────────────────────
function connectBinance() {
    // Subscribe to BTC trade stream + kline stream in one connection
    const streams = 'btcusdt@trade/btcusdt@kline_1m'
    const ws = new WebSocket(`wss://data-stream.binance.vision:9443/stream?streams=${streams}`)

    ws.on('open', () => log('✅ Binance WS connected (trade + 1m kline)'))

    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw)
            const stream = msg.stream || ''
            const data   = msg.data

            // Real-time tick price
            if (stream.endsWith('@trade')) {
                binance.price = parseFloat(data.p)
                return
            }

            // 1-min kline
            if (stream.endsWith('@kline_1m')) {
                const k = data.k
                const candle = {
                    open:   parseFloat(k.o),
                    high:   parseFloat(k.h),
                    low:    parseFloat(k.l),
                    close:  parseFloat(k.c),
                    closed: k.x,
                    openTime: k.t,
                }
                binance.currentCandle = candle

                // When candle closes, push to history
                if (k.x) {
                    binance.candles.push({ ...candle })
                    if (binance.candles.length > 30) binance.candles.shift()
                }
            }
        } catch (_) {}
    })

    ws.on('close', () => {
        log('⚠️  Binance WS disconnected — reconnecting in 10s')
        setTimeout(connectBinance, 10_000)
    })
    ws.on('error', e => log(`⚠️  Binance WS error: ${e.message}`))
}

// ─────────────────────────────────────────────────────────────
//  ⑤ MOMENTUM SIGNAL
//  Returns { direction: 'Up'|'Down'|null, strength: 0-1, pct: netMovePct }
// ─────────────────────────────────────────────────────────────
function computeMomentum() {
    const n = CONFIG.MOMENTUM_WINDOW
    if (binance.candles.length < n) {
        log(`  ⏳ Need ${n} completed candles — have ${binance.candles.length}`)
        return { direction: null, strength: 0, pct: 0 }
    }

    const recent = binance.candles.slice(-n)

    // Net % move over window
    const oldest = recent[0].open
    const newest = recent[n - 1].close
    const netPct = (newest - oldest) / oldest   // signed

    // Consistency: how many candles agree with direction?
    const expectedDir = netPct > 0 ? 'Up' : 'Down'
    const agreeing = recent.filter(c =>
        expectedDir === 'Up' ? c.close > c.open : c.close < c.open
    ).length
    const consistency = agreeing / n   // 0.0 → 1.0

    // Composite strength 0-1
    const absPct   = Math.abs(netPct)
    const scaled   = Math.min(absPct / 0.005, 1)   // normalise at 0.5% = full strength
    const strength = (scaled * 0.7 + consistency * 0.3)

    return {
        direction:   absPct >= CONFIG.MOMENTUM_THRESHOLD ? expectedDir : null,
        strength,
        pct:         netPct,
        consistency,
    }
}

// ─────────────────────────────────────────────────────────────
//  ⑥ POLYMARKET — Find current 5-min & hourly markets
// ─────────────────────────────────────────────────────────────

/**
 * Fetches the currently active "Bitcoin Up or Down" 5-minute market.
 * Polymarket creates a new slug like: btc-updown-5m-<unixEpochOfWindowStart>
 * Strategy: find market whose window started in the last 90s AND hasn't expired.
 */
async function findCurrent5MinMarket() {
    try {
        const r = await axios.get(`${CONFIG.PM_GAMMA}/markets`, {
            params: {
                active:  true,
                closed:  false,
                keyword: 'Bitcoin Up or Down',
                limit:   30,
            },
            timeout: 6000,
        })

        const now = Date.now()
        const candidates = []

        for (const m of r.data) {
            if (!m.slug || !m.slug.includes('btc-updown-5m-')) continue
            if (!m.enableOrderBook || !m.clobTokenIds) continue

            const endMs = new Date(m.endDate).getTime()
            if (isNaN(endMs) || endMs < now) continue

            // Window duration ≈ 5 min → start ≈ endMs - 5*60*1000
            const startMs = endMs - 5 * 60 * 1000
            const secIntoWindow = (now - startMs) / 1000

            // Only enter if we're within ENTRY_WINDOW_SEC of the window start
            if (secIntoWindow < 0 || secIntoWindow > CONFIG.ENTRY_WINDOW_SEC) continue

            const secLeft = (endMs - now) / 1000
            candidates.push({ ...m, endMs, startMs, secIntoWindow, secLeft })
        }

        // Return the one with the most time remaining (freshest)
        candidates.sort((a, b) => b.secLeft - a.secLeft)
        return candidates[0] || null
    } catch (e) {
        log(`  ⚠️  5-min market fetch error: ${e.message}`)
        return null
    }
}

/**
 * Finds the current active 1-hour "Bitcoin Up or Down" market for hedging.
 */
async function findHourlyMarket() {
    try {
        const r = await axios.get(`${CONFIG.PM_GAMMA}/markets`, {
            params: {
                active:  true,
                closed:  false,
                keyword: 'Bitcoin Up or Down',
                limit:   30,
            },
            timeout: 6000,
        })

        const now = Date.now()

        for (const m of r.data) {
            if (!m.enableOrderBook || !m.clobTokenIds) continue
            if (!m.slug) continue
            // Hourly markets match "bitcoin-up-or-down-march-..." slug pattern
            if (m.slug.includes('btc-updown-5m-')) continue  // skip 5-min

            const endMs = new Date(m.endDate).getTime()
            if (isNaN(endMs) || endMs < now) continue

            const minsLeft = (endMs - now) / 60_000
            if (minsLeft < 5 || minsLeft > 90) continue   // active hourly window

            return { ...m, endMs }
        }
    } catch (_) {}
    return null
}

async function getCLOBBook(tokenId) {
    try {
        const r = await axios.get(`${CONFIG.PM_CLOB}/book`, {
            params: { token_id: tokenId }, timeout: 4000,
        })
        const asks = r.data?.asks || []
        const bids = r.data?.bids || []
        return {
            ask: asks.length ? parseFloat(asks[0].price) : null,
            bid: bids.length ? parseFloat(bids[0].price) : null,
        }
    } catch (_) { return { ask: null, bid: null } }
}

// ─────────────────────────────────────────────────────────────
//  ⑦ ENTRY — paper or live
// ─────────────────────────────────────────────────────────────
async function enterTrade(market5m, hourlyMarket, direction, momentum) {
    const tokenIds5m = JSON.parse(market5m.clobTokenIds)  // [upToken, downToken]
    const upToken5m   = tokenIds5m[0]
    const downToken5m = tokenIds5m[1]
    const mainTokenId = direction === 'Up' ? upToken5m : downToken5m

    // ── Main bet ───────────────────────────────────────────────
    // Fetch CLOB ask for the direction we're betting
    const book      = await getCLOBBook(mainTokenId)
    const entryAsk  = book.ask
    if (!entryAsk || entryAsk <= 0 || entryAsk >= 1) {
        log(`  ⚠️  No valid CLOB ask for ${direction} token — skip`)
        return
    }

    // Split into N_ORDERS small orders (mimics 0x8dxd multi-order entry)
    const N_ORDERS    = 5
    const totalBet    = Math.min(portfolio.capital * CONFIG.BET_PCT, portfolio.capital - CONFIG.HEDGE_PCT * portfolio.capital - 0.50)
    if (totalBet < 1.0) { log('  ⚠️  Insufficient capital for trade'); return }

    const perOrder    = totalBet / N_ORDERS
    const feeCost5m   = totalBet * CONFIG.TAKER_FEE
    const shares5m    = (totalBet - feeCost5m) / entryAsk
    const stopPrice5m = entryAsk * (1 - CONFIG.EARLY_EXIT_FRAC)

    // High-confidence (strong momentum) → hold to settlement
    // Low-confidence → set earlyExit flag
    const holdToSettle = momentum.strength >= CONFIG.STRONG_MOMENTUM / CONFIG.MOMENTUM_THRESHOLD * CONFIG.MOMENTUM_THRESHOLD

    const pos5m = {
        id:           `5m-${direction}-${Date.now()}`,
        type:         '5MIN',
        conditionId:  market5m.conditionId,
        question:     market5m.question,
        slug:         market5m.slug,
        direction,
        tokenId:      mainTokenId,
        entryAsk,
        stopPrice:    stopPrice5m,
        totalBet,
        perOrder,
        nOrders:      N_ORDERS,
        shares:       shares5m,
        feePaid:      feeCost5m,
        endMs:        market5m.endMs,
        openedAt:     new Date().toISOString(),
        holdToSettle,
        momentum:     { pct: (momentum.pct * 100).toFixed(3) + '%', strength: momentum.strength.toFixed(2), consistency: momentum.consistency.toFixed(2) },
        mode:         'PAPER',
    }

    portfolio.capital  -= totalBet
    portfolio.openPositions.push(pos5m)

    const oppositeDir = direction === 'Up' ? 'Down' : 'Up'
    const opposite5mToken = direction === 'Up' ? downToken5m : upToken5m

    log(`\n  ════════════════════════════════════════════`)
    log(`  📊 SIGNAL #${++totalSignals} — ${direction.toUpperCase()} momentum`)
    log(`     Net move : ${(momentum.pct * 100).toFixed(3)}%  |  Strength: ${(momentum.strength * 100).toFixed(0)}%  |  Consistency: ${(momentum.consistency * 100).toFixed(0)}%`)
    log(`     Binance  : $${binance.price?.toLocaleString(undefined,{maximumFractionDigits:2})}`)
    log(`  📝 MAIN BET: BUY ${direction} @ ${(entryAsk*100).toFixed(1)}¢`)
    log(`     Bet: $${totalBet.toFixed(2)} across ${N_ORDERS} orders (~$${perOrder.toFixed(2)} each) | Shares: ${shares5m.toFixed(2)}`)
    log(`     Early-exit stop: ${(stopPrice5m*100).toFixed(1)}¢  |  Mode: ${holdToSettle ? 'HOLD TO SETTLE' : 'EARLY EXIT ACTIVE'}`)
    log(`     Market: "${market5m.question}"`)
    log(`     Expires in ${market5m.secLeft?.toFixed(0)}s`)

    // ── Delta Hedge ────────────────────────────────────────────
    if (hourlyMarket) {
        const hourlyTokenIds  = JSON.parse(hourlyMarket.clobTokenIds)
        const hedgeTokenId    = direction === 'Up' ? hourlyTokenIds[1] : hourlyTokenIds[0]  // opposite on hourly
        const hedgeBook       = await getCLOBBook(hedgeTokenId)
        const hedgeAsk        = hedgeBook.ask

        if (hedgeAsk && hedgeAsk > 0 && hedgeAsk < 1) {
            const hedgeBet     = Math.min(portfolio.capital * CONFIG.HEDGE_PCT, portfolio.capital * 0.10)
            if (hedgeBet >= 0.50) {
                const hedgeFee    = hedgeBet * CONFIG.TAKER_FEE
                const hedgeShares = (hedgeBet - hedgeFee) / hedgeAsk

                const hedgePos = {
                    id:          `hedge-${oppositeDir}-${Date.now()}`,
                    type:        'HEDGE',
                    conditionId: hourlyMarket.conditionId,
                    question:    hourlyMarket.question,
                    direction:   oppositeDir,
                    tokenId:     hedgeTokenId,
                    entryAsk:    hedgeAsk,
                    hedgeBet,
                    shares:      hedgeShares,
                    feePaid:     hedgeFee,
                    endMs:       hourlyMarket.endMs,
                    openedAt:    new Date().toISOString(),
                    linkedTo:    pos5m.id,
                    mode:        'PAPER',
                }

                portfolio.capital -= hedgeBet
                portfolio.openPositions.push(hedgePos)

                log(`  🛡️  HEDGE: BUY ${oppositeDir} (hourly) @ ${(hedgeAsk*100).toFixed(1)}¢`)
                log(`     Hedge bet: $${hedgeBet.toFixed(2)} | Shares: ${hedgeShares.toFixed(2)}`)
                log(`     Market: "${hourlyMarket.question?.slice(0,60)}"`)
            }
        } else {
            log(`  ⚠️  Hedge: no CLOB data for hourly ${oppositeDir} — skipping hedge`)
        }
    } else {
        log(`  ℹ️  No hourly market found — trading without hedge`)
    }

    log(`  💰 Capital remaining: $${portfolio.capital.toFixed(4)}`)
    log(`  ════════════════════════════════════════════`)
}

// ─────────────────────────────────────────────────────────────
//  ⑧ POSITION MONITOR — check every 30s for early exit / settlement
// ─────────────────────────────────────────────────────────────
async function monitorPositions() {
    if (portfolio.openPositions.length === 0) return

    const now = Date.now()

    for (const pos of [...portfolio.openPositions]) {
        // ── Settlement check ─────────────────────────────────
        if (now >= pos.endMs) {
            if (pos.type === '5MIN') {
                await settlePosition(pos)
            } else if (pos.type === 'HEDGE') {
                await settleHedge(pos)
            }
            continue
        }

        // ── Early-exit monitoring (5-min positions only) ──────
        if (pos.type !== '5MIN') continue
        if (pos.holdToSettle) continue  // high-confidence → stay

        const book = await getCLOBBook(pos.tokenId)
        const curBid = book.bid  // we'd sell at bid
        if (!curBid) continue

        const secsLeft = (pos.endMs - now) / 1000
        const priceMove = (curBid - pos.entryAsk) / pos.entryAsk

        log(`  👁  ${pos.direction} 5m: entry=${(pos.entryAsk*100).toFixed(1)}¢ now_bid=${(curBid*100).toFixed(1)}¢ (${(priceMove*100).toFixed(1)}%) | ${secsLeft.toFixed(0)}s left`)

        // Exit early if price dropped more than EARLY_EXIT_FRAC from entry
        if (curBid <= pos.stopPrice) {
            log(`  🚨 EARLY EXIT: ${pos.direction} dropped to ${(curBid*100).toFixed(1)}¢ ≤ stop ${(pos.stopPrice*100).toFixed(1)}¢`)
            await closePosition(pos, curBid, 'EARLY_EXIT')
        }
        // Also exit in last 30s if position is profitable (lock gains)
        else if (secsLeft < 30 && curBid > pos.entryAsk * 1.10) {
            log(`  💰 LOCK-IN PROFIT: ${pos.direction} @ ${(curBid*100).toFixed(1)}¢ with ${secsLeft.toFixed(0)}s left`)
            await closePosition(pos, curBid, 'LOCK_PROFIT')
        }
    }
}

// ─────────────────────────────────────────────────────────────
//  ⑨ SETTLEMENT — position resolves at $1 or $0
// ─────────────────────────────────────────────────────────────
async function settlePosition(pos) {
    const stillOpen = portfolio.openPositions.some(p => p.id === pos.id)
    if (!stillOpen) return

    // Use final Binance price to determine settlement outcome
    // Compare with the implied direction from question title
    // We use the 5-min candle close at expiry to judge
    const btcNow = binance.price
    log(`  ⌛ SETTLING ${pos.id}: Binance BTC=$${btcNow?.toLocaleString()}`)

    // Try to get final CLOB price (close to 0 or 1)
    const book = await getCLOBBook(pos.tokenId)
    const finalBid = book.bid

    // If very close to settlement, price is a good proxy for outcome
    // $0.80+ bid → likely paying $1 (we win). < $0.30 → likely $0 (we lose)
    let closePrice
    if (finalBid !== null) {
        closePrice = finalBid
    } else {
        // Fallback: check candle direction for this 5-min window
        const lastCandle = binance.currentCandle
        closePrice = lastCandle && lastCandle.close > lastCandle.open ? 0.85 : 0.15
    }

    await closePosition(pos, closePrice, 'SETTLEMENT')
}

async function settleHedge(pos) {
    const stillOpen = portfolio.openPositions.some(p => p.id === pos.id)
    if (!stillOpen) return

    const book = await getCLOBBook(pos.tokenId)
    const finalBid = book.bid || 0.15
    await closeHedgePosition(pos, finalBid, 'SETTLEMENT')
}

// ─────────────────────────────────────────────────────────────
//  ⑩ CLOSE POSITION
// ─────────────────────────────────────────────────────────────
async function closePosition(pos, closePrice, reason) {
    portfolio.openPositions = portfolio.openPositions.filter(p => p.id !== pos.id)

    const grossReturn = pos.shares * closePrice
    const exitFee     = grossReturn * CONFIG.TAKER_FEE
    const netReturn   = grossReturn - exitFee
    const pnl         = netReturn - pos.totalBet
    const won         = closePrice >= 0.5

    portfolio.capital += netReturn
    portfolio.closedTrades.push({
        ...pos, closePrice, pnl, won,
        reason, closedAt: new Date().toISOString(),
    })

    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(4)}` : `-$${Math.abs(pnl).toFixed(4)}`
    log(`  ${won ? '✅' : '❌'} CLOSED [${reason}]: ${pos.direction} 5-min`)
    log(`     Entry: ${(pos.entryAsk*100).toFixed(1)}¢ → Exit: ${(closePrice*100).toFixed(1)}¢  P&L: ${pnlStr}`)
    log(`     Shares: ${pos.shares.toFixed(2)} × ${(closePrice).toFixed(3)} = $${grossReturn.toFixed(4)} gross`)
    printPortfolio()
    saveTrades()
}

async function closeHedgePosition(pos, closePrice, reason) {
    portfolio.openPositions = portfolio.openPositions.filter(p => p.id !== pos.id)

    const grossReturn = pos.shares * closePrice
    const exitFee     = grossReturn * CONFIG.TAKER_FEE
    const netReturn   = grossReturn - exitFee
    const pnl         = netReturn - pos.hedgeBet
    const won         = closePrice >= 0.5

    portfolio.capital += netReturn
    portfolio.closedTrades.push({
        ...pos, closePrice, pnl, won,
        reason, closedAt: new Date().toISOString(),
    })

    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(4)}` : `-$${Math.abs(pnl).toFixed(4)}`
    log(`  ${won ? '✅' : '❌'} CLOSED HEDGE [${reason}]: ${pos.direction} hourly`)
    log(`     Entry: ${(pos.entryAsk*100).toFixed(1)}¢ → Exit: ${(closePrice*100).toFixed(1)}¢  P&L: ${pnlStr}`)
    saveTrades()
}

// ─────────────────────────────────────────────────────────────
//  ⑪ MAIN SCAN — runs every 30s, acts only at window opens
// ─────────────────────────────────────────────────────────────
async function runScan() {
    scanCount++
    const now = new Date()
    const secOfMinute = now.getSeconds()
    const minOfHour   = now.getMinutes()
    // 5-min windows: 0-4, 5-9, 10-14, etc.
    const secIntoWindow = ((minOfHour % 5) * 60) + secOfMinute

    if (binance.price === null) {
        log('  ⏳ Waiting for Binance price...')
        return
    }

    log(`\n⟳ Scan #${scanCount} [${now.toISOString().slice(11,19)}] | BTC=$${binance.price?.toFixed(2)} | Capital=$${portfolio.capital.toFixed(4)} | Open: ${portfolio.openPositions.length}`)
    log(`  Window position: ${secIntoWindow}s into current 5-min window (entry allowed ≤ ${CONFIG.ENTRY_WINDOW_SEC}s)`)

    // ── Monitor existing positions ─────────────────────────────
    await monitorPositions()

    // ── Check if we can enter a new trade ─────────────────────
    const has5mOpen = portfolio.openPositions.some(p => p.type === '5MIN')
    if (has5mOpen) {
        log('  ↳ Already have a 5-min position open — holding')
        return
    }

    // Only enter in first ENTRY_WINDOW_SEC of a new 5-min window
    if (secIntoWindow > CONFIG.ENTRY_WINDOW_SEC) {
        log(`  ↳ Entry window closed (${secIntoWindow}s > ${CONFIG.ENTRY_WINDOW_SEC}s) — wait for next window`)
        return
    }

    // ── Compute momentum signal ────────────────────────────────
    const momentum = computeMomentum()
    if (!momentum.direction) {
        log(`  ↳ No signal: net move ${(momentum.pct*100).toFixed(3)}% < threshold ${(CONFIG.MOMENTUM_THRESHOLD*100).toFixed(2)}%`)
        return
    }

    log(`  💡 MOMENTUM: ${momentum.direction.toUpperCase()} | net=${(momentum.pct*100).toFixed(3)}% | strength=${(momentum.strength*100).toFixed(0)}% | consistency=${(momentum.consistency*100).toFixed(0)}%`)

    // ── Fetch markets ─────────────────────────────────────────
    const [market5m, hourlyMarket] = await Promise.all([
        findCurrent5MinMarket(),
        findHourlyMarket(),
    ])

    if (!market5m) {
        log('  ↳ No active 5-min market found in entry window')
        return
    }

    log(`  📋 5-min market: "${market5m.question}" (${market5m.secLeft?.toFixed(0)}s remaining)`)
    if (hourlyMarket) log(`  📋 Hourly market: "${hourlyMarket.question}"`)
    else log(`  ℹ️  No hourly hedge market available`)

    // ── Enter trade ────────────────────────────────────────────
    await enterTrade(market5m, hourlyMarket, momentum.direction, momentum)
}

// ─────────────────────────────────────────────────────────────
//  ⑫ PORTFOLIO DISPLAY
// ─────────────────────────────────────────────────────────────
function printPortfolio() {
    const pnl    = portfolio.capital - portfolio.start
    const pnlPct = ((portfolio.capital / portfolio.start - 1) * 100).toFixed(2)
    const wins   = portfolio.closedTrades.filter(t => t.won).length
    const losses = portfolio.closedTrades.filter(t => !t.won).length
    const wr     = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '—'
    const elapsed = Math.floor((Date.now() - portfolio.sessionStart.getTime()) / 3_600_000)

    console.log()
    console.log('  ┌─────────────────────────────────────────────────────')
    console.log(`  │  PORTFOLIO  (${CONFIG.PAPER_TRADING ? 'PAPER' : '⚠️  LIVE'})`)
    console.log(`  │  Capital  : $${portfolio.capital.toFixed(4)}  (${pnl >= 0 ? '+' : ''}${pnlPct}%)`)
    console.log(`  │  Trades   : ${wins}W / ${losses}L  (${wr}% win rate)  |  ${portfolio.openPositions.length} open`)
    console.log(`  │  Signals  : ${totalSignals}  |  Scans: ${scanCount}  |  Runtime: ${elapsed}h`)
    console.log(`  │  BTC      : $${binance.price?.toFixed(2)}  |  Candles: ${binance.candles.length}`)
    console.log('  └─────────────────────────────────────────────────────')
    console.log()
}

function saveTrades() {
    const data = {
        savedAt:       new Date().toISOString(),
        mode:          CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE',
        strategy:      '0x8dxd-style 5-Min BTC Up/Down',
        startCap:      portfolio.start,
        currentCap:    portfolio.capital,
        totalPnl:      portfolio.capital - portfolio.start,
        totalSignals,
        scanCount,
        config:        {
            bet_pct:             CONFIG.BET_PCT,
            hedge_pct:           CONFIG.HEDGE_PCT,
            momentum_window:     CONFIG.MOMENTUM_WINDOW,
            momentum_threshold:  CONFIG.MOMENTUM_THRESHOLD,
            strong_momentum:     CONFIG.STRONG_MOMENTUM,
            early_exit_frac:     CONFIG.EARLY_EXIT_FRAC,
        },
        openPositions: portfolio.openPositions,
        closedTrades:  portfolio.closedTrades,
    }
    fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify(data, null, 2))
}

// ─────────────────────────────────────────────────────────────
//  ⑬ GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────
function shutdown() {
    console.log('\n\n⛔  Shutting down...')
    printPortfolio()

    const wins    = portfolio.closedTrades.filter(t => t.won).length
    const losses  = portfolio.closedTrades.filter(t => !t.won).length
    const total   = wins + losses
    const totalPnl = portfolio.capital - portfolio.start

    console.log('  ── FINAL REPORT ──')
    console.log(`  Strategy  : 0x8dxd-style 5-Min BTC Up/Down Momentum`)
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

// ─────────────────────────────────────────────────────────────
//  ⑭ MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
    console.clear()
    console.log('╔══════════════════════════════════════════════════════════════════╗')
    console.log(`║  0x8dxd-Style BTC Up/Down Bot  —  ${CONFIG.PAPER_TRADING ? 'PAPER TRADING MODE    ' : '⚠️  LIVE TRADING     '} ║`)
    console.log('║  Strategy : 5-Min Momentum + Delta Hedge                        ║')
    console.log('║  Signal   : Binance 1-min candle momentum                       ║')
    console.log('╚══════════════════════════════════════════════════════════════════╝\n')
    console.log(`  Starting capital   : $${CONFIG.STARTING_CAPITAL}`)
    console.log(`  Bet per trade      : ${(CONFIG.BET_PCT*100).toFixed(0)}% (~$${(CONFIG.STARTING_CAPITAL*CONFIG.BET_PCT).toFixed(2)}) in ${5} split orders`)
    console.log(`  Delta hedge        : ${(CONFIG.HEDGE_PCT*100).toFixed(0)}% (~$${(CONFIG.STARTING_CAPITAL*CONFIG.HEDGE_PCT).toFixed(2)}) on hourly market`)
    console.log(`  Momentum threshold : ${(CONFIG.MOMENTUM_THRESHOLD*100).toFixed(2)}% net 1-min candle move`)
    console.log(`  Strong momentum    : ${(CONFIG.STRONG_MOMENTUM*100).toFixed(2)}% → hold to settlement`)
    console.log(`  Early exit trigger : position drops ${(CONFIG.EARLY_EXIT_FRAC*100).toFixed(0)}% from entry`)
    console.log(`  Entry window       : first ${CONFIG.ENTRY_WINDOW_SEC}s of each 5-min roll`)
    console.log(`  Log file           : updown_trades.json\n`)

    if (!CONFIG.PAPER_TRADING && !process.env.PM_API_KEY) {
        console.error('❌ PM_API_KEY not set — aborting live mode')
        process.exit(1)
    }

    // ① Start Binance WS
    connectBinance()

    // ② Wait 5s for initial price feed
    log('\n  Waiting for Binance price feed...')
    await new Promise(r => setTimeout(r, 5000))

    // ③ Fetch initial REST prices as fallback
    try {
        const r = await axios.get('https://data-api.binance.vision/api/v3/ticker/price', {
            params: { symbol: 'BTCUSDT' }, timeout: 5000,
        })
        if (!binance.price) binance.price = parseFloat(r.data.price)
        log(`  Initial BTC price: $${binance.price}`)
    } catch (_) {}

    // ④ Main scan every 30s
    log('\n  Bot running — scanning every 30s. Ctrl+C to stop.\n')
    await runScan()
    setInterval(runScan, 30_000)

    // ⑤ Portfolio report every 5 min
    setInterval(printPortfolio, 5 * 60_000)

    // ⑥ Auto-save every 2 min
    setInterval(saveTrades, 2 * 60_000)

    // ⑦ HTTP server — keeps Render web service alive + exposes live dashboard
    const express = require('express')
    const app = express()

    app.get('/', (req, res) => {
        const pnl    = portfolio.capital - portfolio.start
        const pnlPct = ((portfolio.capital / portfolio.start - 1) * 100).toFixed(2)
        const wins   = portfolio.closedTrades.filter(t => t.won).length
        const losses = portfolio.closedTrades.filter(t => !t.won).length
        const wr     = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : 0
        const elapsed = Math.floor((Date.now() - portfolio.sessionStart.getTime()) / 3_600_000)
        const momentum = computeMomentum()

        res.json({
            status:       'Online ✅',
            bot:          '0x8dxd-Style 5-Min BTC Up/Down',
            mode:         CONFIG.PAPER_TRADING ? 'PAPER_TRADING' : 'LIVE',
            timestamp:    new Date().toISOString(),
            runtime_hours: elapsed,
            scans_completed: scanCount,
            signals_fired:   totalSignals,
            binance: {
                btc_price:    binance.price,
                candles_ready: binance.candles.length,
                momentum:     {
                    direction:   momentum.direction || 'none',
                    strength_pct: (momentum.strength * 100).toFixed(1),
                    net_move_pct: (momentum.pct * 100).toFixed(3),
                },
            },
            capital: {
                starting:   portfolio.start,
                current:    parseFloat(portfolio.capital.toFixed(4)),
                pnl_usd:    parseFloat(pnl.toFixed(4)),
                pnl_pct:    parseFloat(pnlPct),
            },
            performance: {
                total_trades: wins + losses,
                wins,
                losses,
                win_rate: `${wr}%`,
            },
            open_positions: portfolio.openPositions.map(p => ({
                id:         p.id,
                type:       p.type,
                direction:  p.direction,
                entry_cents: (p.entryAsk * 100).toFixed(1),
                bet_usd:    p.totalBet || p.hedgeBet,
                expires_in: `${Math.max(0, ((p.endMs - Date.now()) / 1000)).toFixed(0)}s`,
            })),
            last_5_trades: portfolio.closedTrades.slice(-5).map(t => ({
                direction: t.direction,
                reason:    t.reason,
                pnl_usd:   parseFloat(t.pnl.toFixed(4)),
                won:       t.won,
                closed_at: t.closedAt,
            })),
        })
    })

    // Cron-job keepalive endpoint — hit this via cron-job.org every 5 min
    app.get('/ping', (req, res) => res.json({ alive: true, ts: Date.now() }))

    const port = process.env.PORT || 3000
    app.listen(port, () => log(`🌐 Dashboard server running on port ${port}  (GET / for status, GET /ping for keepalive)`))
}

main().catch(e => { console.error(e); process.exit(1) })
