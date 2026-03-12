/**
 * copytrade_v2.js — Polymarket Copy Trading Bot (Official SDK v5)
 * =============================================================
 * 
 * Target Traders (Leaderboard ROI Top 5):
 * 1. RepTrump:  0x863134d00841b2e200492805a01e1e2f5defaa53
 * 2. Len9311238: 0x78b9ac44a6d7d7a076c14e0ad518b301b63c6b76
 * 3. Theo4:     0x56687bf447db6ffa42ffe2204a05edaa20f55839
 * 4. BetTom42:  0x885783760858e1bd5dd09a3c3f916cfa251ac270
 * 5. alexmulti: 0xd0c042c08f755ff940249f62745e82d356345565
 */

require('dotenv').config();
const { ClobClient } = require('@polymarket/clob-client');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});


// ─────────────────────────────────────────────────────────────────
//  ① CONFIG
// ─────────────────────────────────────────────────────────────────
const CONFIG = {
    PREVIEW_MODE: true, // Set to false to execute real trades (requires API Keys)
    
    // Target Wallets
    TARGETS: [
        { name: 'RepTrump',  address: '0x863134d00841b2e200492805a01e1e2f5defaa53' },
        { name: 'Len9311238', address: '0x78b9ac44a6d7d7a076c14e0ad518b301b63c6b76' },
        { name: 'Theo4',     address: '0x56687bf447db6ffa42ffe2204a05edaa20f55839' },
        { name: 'BetTom42',  address: '0x885783760858e1bd5dd09a3c3f916cfa251ac270' },
        { name: 'alexmulti', address: '0xd0c042c08f755ff940249f62745e82d356345565' }
    ],

    // Polling
    POLL_INTERVAL_MS: 30 * 1000, // Query every 30s
    ACTIVITY_LIMIT: 10,

    // Trading Params
    CAPITAL: parseFloat(process.env.CAPITAL || '100'),
    TRADE_SIZE_USDC: parseFloat(process.env.TRADE_SIZE || '10'),
    
    // API
    CLOB_ENDPOINT: 'https://clob.polymarket.com',
    DATA_API_ENDPOINT: 'https://data-api.polymarket.com',
    CHAIN_ID: 137,

    // Files
    LOG_FILE: path.join(__dirname, 'copytrade_v2_history.json')
};

// ─────────────────────────────────────────────────────────────────
//  ② STATE
// ─────────────────────────────────────────────────────────────────
let seenHashes = new Set();
let tradeHistory = [];
let openPositions = {}; // asset -> { entryPrice, size, side, outcome, title, timestamp }
let stats = {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0
};

if (fs.existsSync(CONFIG.LOG_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(CONFIG.LOG_FILE, 'utf8'));
        tradeHistory = data.history || [];
        seenHashes = new Set(data.seenHashes || []);
        openPositions = data.openPositions || {};
        stats = data.stats || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    } catch (e) {
        console.error('Error loading history:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────
//  ③ DATA FETCHING
// ─────────────────────────────────────────────────────────────────

async function getTraderActivity(address) {
    const url = `${CONFIG.DATA_API_ENDPOINT}/activity?user=${address}&limit=${CONFIG.ACTIVITY_LIMIT}`;
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 8000
        });
        return response.data || [];
    } catch (e) {
        log(`[${address}] API Error: ${e.message}`);
        return [];
    }
}

async function getTokenPrice(tokenID) {
    const url = `${CONFIG.CLOB_ENDPOINT}/book?token_id=${tokenID}`;
    try {
        const response = await axios.get(url);
        // Mid price as an estimate of current value
        const bids = response.data.bids || [];
        const asks = response.data.asks || [];
        if (bids.length > 0 && asks.length > 0) {
            return (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2;
        } else if (bids.length > 0) {
            return parseFloat(bids[0].price);
        } else if (asks.length > 0) {
            return parseFloat(asks[0].price);
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────
//  ④ BOT LOGIC
// ─────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}

function updateStats() {
    console.clear();
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log(`║  Polymarket Copy-Trade Bot v2 — Following Leaderboard Top 5    ║`);
    console.log(`║  Mode: ${CONFIG.PREVIEW_MODE ? '👀 PREVIEW ONLY (No Real Trades)' : '⚠️  LIVE TRADING ENABLED   '}              ║`);
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log(`\n  --- TRADING STATS ---`);
    console.log(`  Trades: ${stats.trades} | Wins: ${stats.wins} | Losses: ${stats.losses}`);
    console.log(`  Win Rate: ${stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : 0}%`);
    console.log(`  Total P&L: $${stats.pnl.toFixed(2)} USDC\n`);
    
    const openCount = Object.keys(openPositions).length;
    console.log(`  --- OPEN POSITIONS (${openCount}) ---`);
    for (const asset in openPositions) {
        const pos = openPositions[asset];
        console.log(`  • ${pos.title.slice(0, 40)}... | ${pos.side} ${pos.outcome} | Entry: ${(pos.entryPrice * 100).toFixed(1)}¢`);
    }
    console.log(`\n  ----------------------`);
    log(`Next poll in ${CONFIG.POLL_INTERVAL_MS / 1000}s...`);
}

async function monitorPositions() {
    for (const asset in openPositions) {
        const pos = openPositions[asset];
        const currentPrice = await getTokenPrice(asset);

        if (currentPrice !== null) {
            // Check for settlement (Price hits 1.0 or 0.0)
            let settled = false;
            let profit = 0;
            let won = false;

            if (currentPrice >= 0.99) {
                settled = true;
                won = (pos.side === 'BUY'); // If we bought and it hit $1, we won
            } else if (currentPrice <= 0.01) {
                settled = true;
                won = (pos.side === 'SELL' || pos.side === 'REDEEM'); 
            }

            if (settled) {
                if (won) {
                    profit = (1.0 - pos.entryPrice) * (CONFIG.TRADE_SIZE_USDC / pos.entryPrice);
                    stats.wins++;
                    log(`\n🎉 TRADE WON: ${pos.title}`);
                } else {
                    profit = -CONFIG.TRADE_SIZE_USDC;
                    stats.losses++;
                    log(`\n💀 TRADE LOST: ${pos.title}`);
                }

                stats.pnl += profit;
                tradeHistory.push({
                    ...pos,
                    exitPrice: currentPrice,
                    profit: profit,
                    settledAt: new Date().toISOString()
                });

                delete openPositions[asset];
                saveState();
            }
        }
    }
}

async function mirrorTrade(trader, activity) {
    const hash = activity.transactionHash;
    const asset = activity.asset;

    if (seenHashes.has(hash)) return;

    // Filter for trades only
    if (activity.type !== 'TRADE') {
        seenHashes.add(hash);
        return;
    }

    // Don't double-copy same asset if already open
    if (openPositions[asset]) {
        seenHashes.add(hash);
        return;
    }

    log(`\n🚨 NEW TRADE DETECTED: [${trader.name}]`);
    log(`   Market: ${activity.title}`);
    log(`   Action: ${activity.side} ${activity.outcome}`);
    log(`   Price : ${(activity.price * 100).toFixed(1)}¢`);
    
    const ourSize = CONFIG.TRADE_SIZE_USDC;
    
    if (CONFIG.PREVIEW_MODE) {
        log(`   👀 PREVIEW MODE: Mimicking mirror with $${ourSize}`);
    } else {
        log(`   🚀 LIVE MODE: Mirroring with $${ourSize}... (Implementation Pending SDK)`);
    }

    // Open Paper/Live Position
    openPositions[asset] = {
        timestamp: new Date().toISOString(),
        trader: trader.name,
        market: activity.title,
        side: activity.side,
        outcome: activity.outcome,
        entryPrice: activity.price,
        asset: asset,
        title: activity.title
    };

    stats.trades++;
    seenHashes.add(hash);
    saveState();
    updateStats();
}

function saveState() {
    const data = {
        lastUpdated: new Date().toISOString(),
        seenHashes: Array.from(seenHashes),
        history: tradeHistory,
        openPositions: openPositions,
        stats: stats
    };
    fs.writeFileSync(CONFIG.LOG_FILE, JSON.stringify(data, null, 2));
}

async function poll() {
    for (const trader of CONFIG.TARGETS) {
        const activities = await getTraderActivity(trader.address);
        for (const act of activities.reverse()) {
            await mirrorTrade(trader, act);
        }
    }
    await monitorPositions();
    updateStats();
}

// ─────────────────────────────────────────────────────────────────
//  ⑤ MAIN
// ─────────────────────────────────────────────────────────────────

async function main() {
    // ① Start Polling Loop
    setInterval(poll, CONFIG.POLL_INTERVAL_MS);
    poll(); // Initial run

    // ② Start Dashboard Server
    const app = express();


    app.get('/', (req, res) => {
        try {
            log('DEBUG: Dashboard request received');
            const data = {
                status: 'Online ✅',
                bot: 'Polymarket Copy-Trade Bot v2',
                mode: CONFIG.PREVIEW_MODE ? 'PREVIEW_ONLY' : 'LIVE_TRADING',
                timestamp: new Date().toISOString()
            };

            // Config
            data.config = {
                targets: (CONFIG.TARGETS || []).map(t => t.name),
                poll_interval: `${(CONFIG.POLL_INTERVAL_MS || 30000) / 1000}s`,
                trade_size_usdc: CONFIG.TRADE_SIZE_USDC || 0
            };

            // Stats
            const s = stats || {};
            const trades = s.trades || 0;
            const wins = s.wins || 0;
            const pnl = s.pnl || 0;
            data.stats = {
                total_trades: trades,
                wins: wins,
                losses: s.losses || 0,
                win_rate: trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : '0%',
                pnl_usdc: parseFloat(pnl.toFixed(2))
            };

            // Open Positions
            data.open_positions = Object.values(openPositions || {}).map(p => {
                const ep = p.entryPrice || 0;
                const ts = p.timestamp || Date.now();
                return {
                    trader: p.trader || 'Unknown',
                    market: (p.market || 'Unknown').slice(0, 50),
                    side: p.side || 'N/A',
                    outcome: p.outcome || 'N/A',
                    entry_price: (ep * 100).toFixed(1) + '¢',
                    time_open: Math.floor((Date.now() - new Date(ts).getTime()) / 60000) + ' min'
                };
            });

            // History
            data.recent_closed_trades = (tradeHistory || [])
                .filter(t => t && t.profit !== undefined)
                .slice(-5)
                .map(t => {
                    const prof = t.profit || 0;
                    return {
                        market: (t.market || 'Unknown').slice(0, 50),
                        outcome: t.outcome || 'N/A',
                        profit_usdc: parseFloat(prof.toFixed(2)),
                        won: prof > 0,
                        closed_at: t.settledAt || 'Unknown'
                    };
                });

            res.json(data);
            log('DEBUG: Dashboard response sent');
        } catch (error) {
            log(`DASHBOARD ERROR: ${error.message}`);
            console.error(error);
            res.status(500).json({ error: error.message, stack: error.stack });
        }
    });



    app.get('/ping', (req, res) => res.json({ alive: true, ts: Date.now() }));

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        log(`🌐 Dashboard server running on port ${port} (GET / for status)`);
    });
}

main().catch(console.error);


