/**
 * copytrade_bot.js — On-Chain Copy-Trade Bot for 0x8dxd
 * =======================================================
 * ARCHITECTURE:
 *   1. Subscribe to Polygon WebSocket → watch "OrderFilled" events
 *      from the Polymarket CTF Exchange contract IN REAL TIME (~1-2s latency)
 *   2. Filter ONLY events where maker = 0x8dxd's wallet
 *   3. Resolve tokenId → Polymarket market + direction via CLOB API
 *   4. De-duplicate split orders (0x8dxd fires 5-8 txns per entry)
 *      — only copy once per conditionId per direction per window
 *   5. Place paper (or live) order at CLOB at our own bet size
 *   6. Monitor & close positions: hold to settlement or early exit
 *
 * LATENCY vs REST polling:
 *   REST API:  7 – 37  seconds (indexing lag)
 *   This bot:  1 –  2  seconds (one Polygon block)
 *
 * RUN:  node copytrade_bot.js
 * STOP: Ctrl+C
 */

require('dotenv').config()
const { ethers } = require('ethers')
const axios      = require('axios')
const fs         = require('fs')
const path       = require('path')

// ─────────────────────────────────────────────────────────────────
//  ① CONFIG
// ─────────────────────────────────────────────────────────────────
const CONFIG = {
    // ── Mode ─────────────────────────────────────────────────────
    PAPER_TRADING:   true,       // flip to false for live CLOB orders

    // ── Target wallet (0x8dxd) ───────────────────────────────────
    TARGET_WALLET:   '0x63ce342161250d705dc0b16df89036c8e5f9ba9a',

    // ── Capital ───────────────────────────────────────────────────
    STARTING_CAPITAL: 25.00,    // $25 testing capital
    BET_USDC:          2.50,    // flat $2.50 per copied trade (10% of capital)
    MIN_BET:           0.50,    // never bet less than $0.50

    // ── De-duplicate window ───────────────────────────────────────
    // If 0x8dxd fires multiple small orders for the same market+direction
    // within DEDUP_MS, we treat them as ONE entry and copy only once.
    DEDUP_MS:        45_000,    // 45 seconds

    // ── Risk Management ───────────────────────────────────────────
    // We enter at whatever price the CLOB shows AFTER 0x8dxd's orders
    // have already slightly moved it. We must still have edge.
    MAX_ENTRY_PRICE:  0.75,    // never pay more than 75¢ for a binary token
    MIN_TIME_LEFT_MS: 90_000,  // skip if market has < 90s left (too late)
    EARLY_EXIT_DROP:  0.40,    // sell early if token drops 40% from our entry
    MONITOR_SECS:     20,      // check open positions every 20s

    // ── Polymarket ────────────────────────────────────────────────
    PM_CLOB:       'https://clob.polymarket.com',
    PM_GAMMA:      'https://gamma-api.polymarket.com',
    TAKER_FEE:     0.018,

    // ── On-chain ─────────────────────────────────────────────────
    // Polymarket CTF Exchange on Polygon
    EXCHANGE_ADDR: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',

    LOG_FILE: path.join(__dirname, 'copytrade_trades.json'),
}

// ─────────────────────────────────────────────────────────────────
//  ② STATE
// ─────────────────────────────────────────────────────────────────
const portfolio = {
    capital:       CONFIG.STARTING_CAPITAL,
    start:         CONFIG.STARTING_CAPITAL,
    sessionStart:  new Date(),
    openPositions: [],
    closedTrades:  [],
}

// De-dup cache: key = `${conditionId}-${direction}`, value = timestamp
const recentEntries = new Map()

// Token → market info cache (avoid refetching same market)
const tokenCache = new Map()  // tokenId → { conditionId, question, direction, endMs }

let totalCopied  = 0
let totalDetected = 0

// ─────────────────────────────────────────────────────────────────
//  ③ LOGGING
// ─────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString().slice(11, 19)
    console.log(`[${ts}] ${msg}`)
}

// ─────────────────────────────────────────────────────────────────
//  ④ TOKEN → MARKET RESOLVER
//  Given a tokenId (on-chain asset address), finds the Polymarket
//  conditionId, question, direction (Up/Down or Yes/No), and expiry.
// ─────────────────────────────────────────────────────────────────
async function resolveToken(tokenId) {
    // Cache hit
    if (tokenCache.has(tokenId)) return tokenCache.get(tokenId)

    try {
        // CLOB endpoint maps token to market
        const r = await axios.get(`${CONFIG.PM_CLOB}/markets/${tokenId}`, { timeout: 5000 })
        const data = r.data

        if (!data || !data.condition_id) {
            // Try gamma lookup by token search
            return await resolveTokenViaGamma(tokenId)
        }

        const conditionId = data.condition_id
        const endMs       = data.end_date_iso
            ? new Date(data.end_date_iso + 'T00:00:00Z').getTime()
            : null

        const result = {
            conditionId,
            question:  data.question        || '',
            endMs:     endMs                || (Date.now() + 5 * 60_000),
            tokenId,
            // Determine direction from outcomes
            direction: data.outcome         || 'Up',
        }

        tokenCache.set(tokenId, result)
        return result
    } catch (_) {
        return await resolveTokenViaGamma(tokenId)
    }
}

async function resolveTokenViaGamma(tokenId) {
    try {
        // Search for market by token id via gamma
        const r = await axios.get(`${CONFIG.PM_GAMMA}/markets`, {
            params: { clob_token_ids: tokenId, limit: 5 },
            timeout: 5000,
        })
        for (const m of (r.data || [])) {
            if (!m.clobTokenIds) continue
            const ids = JSON.parse(m.clobTokenIds)
            const idx = ids.indexOf(tokenId)
            if (idx === -1) continue

            const outcomes = JSON.parse(m.outcomes || '["Up","Down"]')
            const endMs    = new Date(m.endDate).getTime()
            const direction = outcomes[idx] || (idx === 0 ? 'Up' : 'Down')

            const result = {
                conditionId: m.conditionId,
                question:    m.question,
                endMs,
                tokenId,
                direction,
            }
            tokenCache.set(tokenId, result)
            return result
        }
    } catch (_) {}
    return null
}

// ─────────────────────────────────────────────────────────────────
//  ⑤ CLOB BOOK
// ─────────────────────────────────────────────────────────────────
async function getCLOBAsk(tokenId) {
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

// ─────────────────────────────────────────────────────────────────
//  ⑥ COPY ENTRY
// ─────────────────────────────────────────────────────────────────
async function copyTrade(tokenId, detectedPrice, onChainSize) {
    totalDetected++

    // ── Resolve market ────────────────────────────────────────────
    const market = await resolveToken(tokenId)
    if (!market) {
        log(`  ⚠️  Could not resolve tokenId ${tokenId.slice(0,16)}... — skip`)
        return
    }

    log(`\n  📡 DETECTED 0x8dxd trade #${totalDetected}:`)
    log(`     Market   : "${market.question?.slice(0, 70)}"`)
    log(`     Direction: ${market.direction}  |  On-chain price: ${(detectedPrice*100).toFixed(1)}¢  |  Size: $${onChainSize.toFixed(2)}`)

    // ── Time check ────────────────────────────────────────────────
    const msLeft = market.endMs - Date.now()
    if (msLeft < CONFIG.MIN_TIME_LEFT_MS) {
        log(`  ⏭️  Market expires in ${(msLeft/1000).toFixed(0)}s — too late to copy`)
        return
    }

    // ── De-duplicate ──────────────────────────────────────────────
    const dedupKey = `${market.conditionId}-${market.direction}`
    const lastEntry = recentEntries.get(dedupKey)
    if (lastEntry && Date.now() - lastEntry < CONFIG.DEDUP_MS) {
        log(`  🔁 Duplicate: already copied this market+direction within ${CONFIG.DEDUP_MS/1000}s — skip`)
        return
    }

    // ── Check already open ────────────────────────────────────────
    const alreadyOpen = portfolio.openPositions.some(p => p.conditionId === market.conditionId && p.direction === market.direction)
    if (alreadyOpen) {
        log(`  ↩️  Already have open position on this market — skip`)
        return
    }

    // ── Get CLOB ask (our entry will be slightly worse than 0x8dxd's) ──
    const book = await getCLOBAsk(tokenId)
    const ourAsk = book.ask
    if (!ourAsk) {
        log(`  ⚠️  No CLOB ask available — skip`)
        return
    }
    if (ourAsk > CONFIG.MAX_ENTRY_PRICE) {
        log(`  ⛔ CLOB ask ${(ourAsk*100).toFixed(1)}¢ > max ${(CONFIG.MAX_ENTRY_PRICE*100).toFixed(0)}¢ — skip (too expensive after their orders moved price)`)
        return
    }

    // ── Sizing ────────────────────────────────────────────────────
    const betAmt = Math.min(CONFIG.BET_USDC, portfolio.capital * 0.30)
    if (betAmt < CONFIG.MIN_BET) {
        log(`  ⚠️  Insufficient capital ($${portfolio.capital.toFixed(2)}) — skip`)
        return
    }

    const feeCost  = betAmt * CONFIG.TAKER_FEE
    const shares   = (betAmt - feeCost) / ourAsk
    const stopPrice = ourAsk * (1 - CONFIG.EARLY_EXIT_DROP)

    // ── Record entry ───────────────────────────────────────────────
    const pos = {
        id:           `copy-${market.direction}-${Date.now()}`,
        conditionId:  market.conditionId,
        question:     market.question,
        direction:    market.direction,
        tokenId,
        entryAsk:     ourAsk,
        stopPrice,
        betAmt,
        shares,
        feePaid:      feeCost,
        endMs:        market.endMs,
        openedAt:     new Date().toISOString(),
        // Context about 0x8dxd's trade we're copying
        theirPrice:   detectedPrice,
        theirSize:    onChainSize,
        slippage:     ((ourAsk - detectedPrice) * 100).toFixed(2) + '¢',
        mode:         CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE',
    }

    portfolio.capital -= betAmt
    portfolio.openPositions.push(pos)
    recentEntries.set(dedupKey, Date.now())
    totalCopied++

    const minsLeft = (msLeft / 60_000).toFixed(1)
    log(`\n  ╔════════════════════════════════════════════╗`)
    log(`  ║  📋 COPY TRADE #${totalCopied}`)
    log(`  ║  Market    : "${market.question?.slice(0, 55)}"`)
    log(`  ║  Direction : ${market.direction}`)
    log(`  ║  Their ask : ${(detectedPrice*100).toFixed(1)}¢  →  Our ask: ${(ourAsk*100).toFixed(1)}¢ (slippage: +${pos.slippage})`)
    log(`  ║  Bet       : $${betAmt.toFixed(2)}  |  Shares: ${shares.toFixed(3)}`)
    log(`  ║  Stop      : ${(stopPrice*100).toFixed(1)}¢ (-${(CONFIG.EARLY_EXIT_DROP*100).toFixed(0)}%)`)
    log(`  ║  Expires   : ${minsLeft} min  |  Capital left: $${portfolio.capital.toFixed(4)}`)
    log(`  ╚════════════════════════════════════════════╝`)

    saveTrades()
}

// ─────────────────────────────────────────────────────────────────
//  ⑦ POSITION MONITOR — runs every MONITOR_SECS
// ─────────────────────────────────────────────────────────────────
async function monitorPositions() {
    if (portfolio.openPositions.length === 0) return

    const now = Date.now()
    for (const pos of [...portfolio.openPositions]) {
        // Settlement
        if (now >= pos.endMs) {
            log(`  ⌛ SETTLING: ${pos.direction} "${pos.question?.slice(0,50)}"`)
            const book = await getCLOBAsk(pos.tokenId)
            // Near expiry, price is close to 0 or 1 — use it as proxy
            const closePrice = book.bid !== null ? book.bid : (now > pos.endMs + 30_000 ? 0.05 : pos.entryAsk)
            await closeTrade(pos, closePrice, 'SETTLEMENT')
            continue
        }

        // Early exit check
        const book = await getCLOBAsk(pos.tokenId)
        if (!book.bid) continue

        const secsLeft  = ((pos.endMs - now) / 1000).toFixed(0)
        const changePct = ((book.bid - pos.entryAsk) / pos.entryAsk * 100).toFixed(1)
        log(`  👁  ${pos.direction}: entry=${(pos.entryAsk*100).toFixed(1)}¢  bid=${(book.bid*100).toFixed(1)}¢ (${changePct}%)  ${secsLeft}s left`)

        if (book.bid <= pos.stopPrice) {
            log(`  🚨 EARLY EXIT triggered: bid ${(book.bid*100).toFixed(1)}¢ ≤ stop ${(pos.stopPrice*100).toFixed(1)}¢`)
            await closeTrade(pos, book.bid, 'EARLY_EXIT')
        } else if (parseInt(secsLeft) < 20 && book.bid > pos.entryAsk * 1.15) {
            log(`  💰 LOCK-IN PROFIT: ${(book.bid*100).toFixed(1)}¢ with ${secsLeft}s left`)
            await closeTrade(pos, book.bid, 'LOCK_PROFIT')
        }
    }
}

async function closeTrade(pos, closePrice, reason) {
    portfolio.openPositions = portfolio.openPositions.filter(p => p.id !== pos.id)

    const grossReturn = pos.shares * closePrice
    const exitFee     = grossReturn * CONFIG.TAKER_FEE
    const netReturn   = grossReturn - exitFee
    const pnl         = netReturn - pos.betAmt
    const won         = closePrice >= 0.5

    portfolio.capital += netReturn
    portfolio.closedTrades.push({
        ...pos, closePrice, pnl, won,
        reason, closedAt: new Date().toISOString(),
    })

    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(4)}` : `-$${Math.abs(pnl).toFixed(4)}`
    log(`  ${won ? '✅' : '❌'} CLOSED [${reason}]: ${pos.direction}`)
    log(`     Entry: ${(pos.entryAsk*100).toFixed(1)}¢ → Exit: ${(closePrice*100).toFixed(1)}¢  P&L: ${pnlStr}`)
    printPortfolio()
    saveTrades()
}

// ─────────────────────────────────────────────────────────────────
//  ⑧ PORTFOLIO DISPLAY
// ─────────────────────────────────────────────────────────────────
function printPortfolio() {
    const pnl    = portfolio.capital - portfolio.start
    const pnlPct = ((portfolio.capital / portfolio.start - 1) * 100).toFixed(2)
    const wins   = portfolio.closedTrades.filter(t => t.won).length
    const losses = portfolio.closedTrades.filter(t => !t.won).length
    const wr     = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '—'
    const elapsed = Math.floor((Date.now() - portfolio.sessionStart.getTime()) / 3_600_000)

    console.log()
    console.log('  ┌──────────────────────────────────────────────────────')
    console.log(`  │  COPY-TRADE PORTFOLIO  (${CONFIG.PAPER_TRADING ? 'PAPER' : '⚠️  LIVE'})`)
    console.log(`  │  Capital   : $${portfolio.capital.toFixed(4)}  (${pnl >= 0 ? '+' : ''}${pnlPct}%)`)
    console.log(`  │  Trades    : ${wins}W / ${losses}L  (${wr}% win rate)  |  ${portfolio.openPositions.length} open`)
    console.log(`  │  Detected  : ${totalDetected} 0x8dxd events  →  Copied: ${totalCopied}`)
    console.log(`  │  Runtime   : ${elapsed}h`)
    console.log('  └──────────────────────────────────────────────────────')
    console.log()
}

function saveTrades() {
    const data = {
        savedAt:       new Date().toISOString(),
        mode:          CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE',
        strategy:      'On-Chain Copy Trade — 0x8dxd',
        targetWallet:  CONFIG.TARGET_WALLET,
        startCap:      portfolio.start,
        currentCap:    portfolio.capital,
        totalPnl:      portfolio.capital - portfolio.start,
        totalDetected,
        totalCopied,
        openPositions: portfolio.openPositions,
        closedTrades:  portfolio.closedTrades,
    }
    fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify(data, null, 2))
}

// ─────────────────────────────────────────────────────────────────
//  ⑨ ON-CHAIN LISTENER — Polygon WebSocket (lowest latency ~1-2s)
//  Requires RPC env var set to: wss://polygon-mainnet.g.alchemy.com/v2/<key>
//  On Render: add RPC to Environment Variables in the Render dashboard.
// ─────────────────────────────────────────────────────────────────

// ABI + event topic for OrderFilled
const iface = new ethers.Interface([
    `event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        uint256          makerAssetId,
        uint256          takerAssetId,
        uint256          makerAmountFilled,
        uint256          takerAmountFilled,
        uint8            side
    )`,
])
const EVENT_TOPIC = iface.getEvent('OrderFilled').topicHash

let wsProvider   = null
let wsRetries    = 0

function getRpcUrl() {
    const raw = (process.env.RPC || '').trim()
    if (!raw) {
        log('❌ FATAL: RPC env var is not set!')
        log('   On Render: go to Environment → add RPC=wss://polygon-mainnet.g.alchemy.com/v2/<your-key>')
        log('   Locally: add RPC=wss://... to your .env file')
        process.exit(1)
    }
    log(`   RPC URL: ${raw.slice(0, 55)}...`)
    return raw
}

async function connectPolygon() {
    const rpcUrl = getRpcUrl()
    log('🔌 Connecting to Polygon WebSocket...')

    try {
        wsProvider = new ethers.WebSocketProvider(rpcUrl)

        // Wait up to 8s for socket to open — catch immediate failures
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(), 8000)
            wsProvider.websocket.on('open',  ()  => { clearTimeout(t); resolve() })
            wsProvider.websocket.on('error', (e) => { clearTimeout(t); reject(e) })
        })

        wsRetries = 0
        log('✅ Polygon WebSocket connected')

        wsProvider.websocket.on('close', code => {
            log(`⚠️  WS closed (${code}) — reconnecting...`)
            _scheduleWsReconnect()
        })
        wsProvider.on('error', e => log(`⚠️  WS provider error: ${e.message}`))

        // ── Listen for OrderFilled ────────────────────────────────
        const contract    = new ethers.Contract(CONFIG.EXCHANGE_ADDR, iface, wsProvider)
        const targetLower = CONFIG.TARGET_WALLET.toLowerCase()

        contract.on('OrderFilled', async (
            orderHash, maker, taker,
            makerAssetId, takerAssetId,
            makerAmountFilled, takerAmountFilled,
            side, event
        ) => {
            try {
                if (maker.toLowerCase() !== targetLower) return

                const isBuy = Number(side) === 0
                if (!isBuy) { log(`  📤 0x8dxd SELL — skip`); return }

                const makerAmt      = Number(makerAmountFilled) / 1e6
                const takerAmt      = Number(takerAmountFilled) / 1e6
                const detectedPrice = takerAmt > 0 ? makerAmt / takerAmt : 0
                const tokenId       = makerAssetId.toString()

                log(`\n  🔔 0x8dxd ON-CHAIN BUY!`)
                log(`     TokenId : ${tokenId.slice(0, 22)}...`)
                log(`     USDC: $${makerAmt.toFixed(3)} | Shares: ${takerAmt.toFixed(3)} | Price: ${(detectedPrice*100).toFixed(2)}¢`)
                log(`     TxHash  : ${event.log?.transactionHash?.slice(0, 20)}...`)

                copyTrade(tokenId, detectedPrice, makerAmt).catch(e =>
                    log(`  ⚠️  copyTrade error: ${e.message}`)
                )
            } catch (e) {
                log(`  ⚠️  Event parse error: ${e.message}`)
            }
        })

        log(`✅ Listening for OrderFilled from ${CONFIG.TARGET_WALLET}`)

    } catch (e) {
        log(`❌ WS connect failed: ${e.message}`)
        _scheduleWsReconnect()
    }
}

function _scheduleWsReconnect() {
    wsRetries++
    const delay = Math.min(5_000 * wsRetries, 60_000)
    log(`🔄 Reconnect attempt ${wsRetries} in ${delay / 1000}s`)
    try { if (wsProvider) wsProvider.destroy() } catch (_) {}
    wsProvider = null
    setTimeout(() => connectPolygon().catch(e => log(`⚠️  Reconnect err: ${e.message}`)), delay)
}


// ─────────────────────────────────────────────────────────────────
//  ⑩ GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────
function shutdown() {
    console.log('\n\n⛔  Shutting down...')
    printPortfolio()

    const wins    = portfolio.closedTrades.filter(t => t.won).length
    const losses  = portfolio.closedTrades.filter(t => !t.won).length
    const total   = wins + losses
    const totalPnl = portfolio.capital - portfolio.start

    console.log('  ── FINAL REPORT ──')
    console.log(`  Strategy  : On-Chain Copy Trade → 0x8dxd`)
    console.log(`  Detected  : ${totalDetected} trades  →  Copied: ${totalCopied}`)
    console.log(`  Results   : ${total} trades  (${wins}W / ${losses}L = ${total > 0 ? (wins/total*100).toFixed(1) : '0'}% win rate)`)
    console.log(`  Start     : $${portfolio.start.toFixed(2)}`)
    console.log(`  End       : $${portfolio.capital.toFixed(2)}`)
    console.log(`  P&L       : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)}`)

    saveTrades()
    process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// ─────────────────────────────────────────────────────────────────
//  ⑪ MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
    console.clear()
    console.log('╔══════════════════════════════════════════════════════════════════╗')
    console.log(`║  On-Chain Copy-Trade Bot — following 0x8dxd              ║`)
    console.log(`║  ${CONFIG.PAPER_TRADING ? 'PAPER TRADING MODE                                       ' : '⚠️  LIVE TRADING MODE (real $!)                      '} ║`)
    console.log('╚══════════════════════════════════════════════════════════════════╝\n')
    console.log(`  Target wallet : ${CONFIG.TARGET_WALLET}`)
    console.log(`  Capital       : $${CONFIG.STARTING_CAPITAL}`)
    console.log(`  Bet per trade : $${CONFIG.BET_USDC} flat (max 30% of remaining capital)`)
    console.log(`  Dedup window  : ${CONFIG.DEDUP_MS/1000}s — prevents copying each split order`)
    console.log(`  Max entry     : ${(CONFIG.MAX_ENTRY_PRICE*100).toFixed(0)}¢ — skip if CLOB is too expensive after their orders`)
    console.log(`  Early exit    : ${(CONFIG.EARLY_EXIT_DROP*100).toFixed(0)}% drop from entry triggers sell`)
    console.log(`  Min time left : ${CONFIG.MIN_TIME_LEFT_MS/1000}s — don't copy stale markets`)
    console.log(`  Log file      : copytrade_trades.json\n`)

    // ① Connect to Polygon WebSocket (lowest latency, ~1-2s)
    await connectPolygon()

    // ② Position monitor loop
    log('\n  Bot live — waiting for 0x8dxd trades on-chain...\n')
    setInterval(async () => {
        await monitorPositions().catch(e => log(`  ⚠️  Monitor error: ${e.message}`))
    }, CONFIG.MONITOR_SECS * 1_000)

    // ③ Portfolio heartbeat every 5 min
    setInterval(printPortfolio, 5 * 60_000)

    // ④ Auto-save every 2 min
    setInterval(saveTrades, 2 * 60_000)

    // ⑤ Clean up stale dedup entries every 5 min
    setInterval(() => {
        const cutoff = Date.now() - CONFIG.DEDUP_MS * 2
        for (const [k, t] of recentEntries) {
            if (t < cutoff) recentEntries.delete(k)
        }
    }, 5 * 60_000)

    // ⑥ HTTP server — keeps Render web service alive + exposes live dashboard
    const express = require('express')
    const app = express()

    app.get('/', (req, res) => {
        const pnl    = portfolio.capital - portfolio.start
        const pnlPct = ((portfolio.capital / portfolio.start - 1) * 100).toFixed(2)
        const wins   = portfolio.closedTrades.filter(t => t.won).length
        const losses = portfolio.closedTrades.filter(t => !t.won).length
        const wr     = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : 0
        const elapsed = Math.floor((Date.now() - portfolio.sessionStart.getTime()) / 3_600_000)

        res.json({
            status:        'Online ✅',
            bot:           'On-Chain Copy-Trade — 0x8dxd',
            mode:          CONFIG.PAPER_TRADING ? 'PAPER_TRADING' : 'LIVE',
            target_wallet: CONFIG.TARGET_WALLET,
            timestamp:     new Date().toISOString(),
            runtime_hours: elapsed,
            chain_listener: {
                watching:        CONFIG.TARGET_WALLET,
                exchange:        CONFIG.EXCHANGE_ADDR,
                trades_detected: totalDetected,
                trades_copied:   totalCopied,
                dedup_cache_size: recentEntries.size,
                token_cache_size: tokenCache.size,
            },
            capital: {
                starting: portfolio.start,
                current:  parseFloat(portfolio.capital.toFixed(4)),
                pnl_usd:  parseFloat(pnl.toFixed(4)),
                pnl_pct:  parseFloat(pnlPct),
            },
            performance: {
                total_trades: wins + losses,
                wins,
                losses,
                win_rate: `${wr}%`,
            },
            open_positions: portfolio.openPositions.map(p => ({
                id:          p.id,
                direction:   p.direction,
                entry_cents: (p.entryAsk * 100).toFixed(1),
                their_price: (p.theirPrice * 100).toFixed(1) + '¢',
                slippage:    p.slippage,
                bet_usd:     p.betAmt,
                expires_in:  `${Math.max(0, ((p.endMs - Date.now()) / 1000)).toFixed(0)}s`,
            })),
            last_5_trades: portfolio.closedTrades.slice(-5).map(t => ({
                direction: t.direction,
                reason:    t.reason,
                pnl_usd:   parseFloat(t.pnl.toFixed(4)),
                slippage:  t.slippage,
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
