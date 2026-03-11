// Quick Polymarket integration test
const axios = require('axios')

const PM_GAMMA = 'https://gamma-api.polymarket.com'
const PM_CLOB  = 'https://clob.polymarket.com'

async function test() {
    console.log('\n🔍 Testing Polymarket Gamma API...')
    const keywords = ['bitcoin', 'ethereum', 'solana', 'xrp']
    const found = []

    const now = Date.now()
    const thirtyDays = 30 * 24 * 3600 * 1000

    for (const kw of keywords) {
        const r = await axios.get(`${PM_GAMMA}/markets`, {
            params: { active: true, closed: false, keyword: kw, limit: 20 },
            timeout: 8000,
        })
        console.log(`\n[${kw.toUpperCase()}] — ${r.data.length} results`)
        for (const m of r.data) {
            if (!m.enableOrderBook || !m.clobTokenIds) continue
            const prices   = JSON.parse(m.outcomePrices || '["0.5","0.5"]')
            const yesPrice = parseFloat(prices[0])
            const endMs    = new Date(m.endDate).getTime()
            const liq      = parseFloat(m.liquidity)
            const match    = yesPrice >= 0.20 && yesPrice <= 0.80 && endMs > now && endMs < now + thirtyDays && liq >= 500
            console.log(`  ${match ? '✅' : '  '} YES=${(yesPrice*100).toFixed(1)}¢  liq=$${liq.toFixed(0)}  end=${m.endDate.slice(0,10)}`)
            console.log(`     Q: ${m.question.slice(0,70)}`)
            if (match) {
                found.push({ kw, m, yesPrice, liq })
                break   // found one for this keyword
            }
        }
    }

    if (found.length === 0) {
        console.log('\n⚠️  No uncertain markets found in 20-80¢ range expiring within 30 days.')
        console.log('   The bot will use MODEL price estimation as fallback.')
        return
    }

    // Test CLOB price fetch on first found market
    const { kw, m } = found[0]
    const tokenIds = JSON.parse(m.clobTokenIds)
    const yesTokenId = tokenIds[0]
    console.log(`\n📊 Testing CLOB order book for ${kw.toUpperCase()} market...`)
    console.log(`   TokenId: ${yesTokenId.slice(0,20)}...`)

    try {
        const book = await axios.get(`${PM_CLOB}/book`, { params: { token_id: yesTokenId }, timeout: 5000 })
        const asks = book.data?.asks || []
        const bids = book.data?.bids || []
        if (asks.length > 0) {
            console.log(`  ✅ Best Ask: ${(parseFloat(asks[0].price)*100).toFixed(2)}¢  (${asks.length} asks)`)
            console.log(`  ✅ Best Bid: ${bids.length > 0 ? (parseFloat(bids[0].price)*100).toFixed(2) : 'N/A'}¢  (${bids.length} bids)`)
        } else {
            console.log('  ⚠️  Order book empty, trying last trade price...')
        }
    } catch (e) {
        console.log(`  ⚠️  Book error: ${e.message}`)
    }

    try {
        const last = await axios.get(`${PM_CLOB}/last-trade-price`, { params: { token_id: yesTokenId }, timeout: 5000 })
        console.log(`  📈 Last Trade: ${last.data?.price ? (parseFloat(last.data.price)*100).toFixed(2) + '¢' : 'N/A'}`)
    } catch (e) {
        console.log(`  ⚠️  Last trade error: ${e.message}`)
    }

    console.log('\n✅ Polymarket integration test complete!')
    console.log(`   Found ${found.length}/${keywords.length} tradeable markets.`)
    console.log('   Bot will use REAL CLOB prices where available, MODEL estimate as fallback.')
}

test().catch(e => { console.error('❌ Test failed:', e.message); process.exit(1) })
