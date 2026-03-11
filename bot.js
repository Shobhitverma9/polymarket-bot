require("dotenv").config()
const { ethers } = require("ethers")
const axios = require("axios")

const provider = new ethers.WebSocketProvider(process.env.RPC)

// Polymarket exchange contract
const EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"

const ABI = [
    "event OrderFilled(address indexed maker,address indexed taker,uint256 amount,uint256 price)"
]

const contract = new ethers.Contract(EXCHANGE, ABI, provider)

const WHALE_THRESHOLD = Number(process.env.WHALE_THRESHOLD)

let capital = Number(process.env.CAPITAL)
const TRADE_SIZE = Number(process.env.TRADE_SIZE)

let stats = {
    trades: 0,
    whales: 0,
    signals: 0,
    profit: 0
}

let trackedWallets = {}

console.log("Bot started...")
console.log("Capital:", capital)

function recordWallet(wallet, size) {

    if (!trackedWallets[wallet]) {
        trackedWallets[wallet] = { volume: 0, trades: 0 }
    }

    trackedWallets[wallet].volume += size
    trackedWallets[wallet].trades++

}

function isSignalWallet(wallet) {

    if (!trackedWallets[wallet]) return false

    const w = trackedWallets[wallet]

    if (w.trades > 5 && w.volume > 1000) {
        return true
    }

    return false
}

function paperTrade(entryPrice) {

    const exitPrice = entryPrice + 0.08

    const profit = (exitPrice - entryPrice) * TRADE_SIZE

    capital += profit
    stats.profit += profit

    console.log("\nPAPER TRADE EXECUTED")
    console.log("Entry:", entryPrice)
    console.log("Exit:", exitPrice)
    console.log("Profit:", profit.toFixed(2))
    console.log("Capital:", capital.toFixed(2))

}

contract.on("OrderFilled", (maker, taker, amount, price, event) => {

    stats.trades++

    const size = Number(amount) / 1e6
    const tradePrice = Number(price) / 1e6

    recordWallet(maker, size)

    if (size > WHALE_THRESHOLD) {

        stats.whales++

        console.log("\nWHALE TRADE")
        console.log("Wallet:", maker)
        console.log("Size:", size)
        console.log("Price:", tradePrice)

        if (isSignalWallet(maker)) {

            stats.signals++

            console.log("SIGNAL WALLET DETECTED")

            paperTrade(tradePrice)

        }

    }

})

async function scanMarkets() {

    try {

        const res = await axios.get("https://gamma-api.polymarket.com/markets")

        const markets = res.data

        console.log("\nMarkets scanned:", markets.length)

    } catch (e) {

        console.log("market scan error")

    }

}

setInterval(scanMarkets, 60000)

setInterval(() => {

    console.log("\n------ STATS ------")
    console.log("Trades:", stats.trades)
    console.log("Whales:", stats.whales)
    console.log("Signals:", stats.signals)
    console.log("Profit:", stats.profit.toFixed(2))
    console.log("Capital:", capital.toFixed(2))

}, 60000)