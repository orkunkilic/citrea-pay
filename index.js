const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { createWalletClient, http, createPublicClient } = require('viem');
const { mnemonicToAccount } = require('viem/accounts');
const { citreaTestnet } = require('viem/chains');

const { TOKEN_ADDRESSES, SWEEPER_CONTRACT_ADDRESS } = require('./config');
const SWEEPER_ABI = require('./Sweeper.abi.json');

// --- Environment ---
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) throw new Error('MNEMONIC environment variable is not set.');

// --- Wallet & Client ---
const account = mnemonicToAccount(MNEMONIC);
const walletClient = createWalletClient({ account, chain: citreaTestnet, transport: http() });
const publicClient = createPublicClient({ chain: citreaTestnet, transport: http() });

// --- Database ---
const dbPath = path.join(__dirname, 'citrea-pay.db');
const db = new sqlite3.Database(dbPath, err => {
    if (err) console.error('Failed to connect to SQLite database:', err.message);
    else console.log('Connected to SQLite database.');
});
db.run(`
    CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id TEXT UNIQUE NOT NULL,
        amount REAL NOT NULL,
        asset TEXT NOT NULL,
        receiving_address TEXT NOT NULL,
        auth_signature TEXT NOT NULL,
        expiration DATETIME NOT NULL,
        description TEXT,
        fulfilled BOOLEAN DEFAULT 0,
        swept BOOLEAN DEFAULT 0,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
    )
`);
db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

// --- Express App ---
const app = express();
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "connect-src": ["'self'", "https://api.coingecko.com"],
            "script-src": ["'self'", "https://cdn.jsdelivr.net"]
        },
    })
);
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---
app.get('/', (req, res) => res.json({ message: 'Citrea Pay Server is running.' }));

app.get('/balance', async (req, res) => {
    try {
        const treasuryAddress = walletClient.account.address;
        const treasuryBalance = await publicClient.getBalance({ address: treasuryAddress });
        const tokenBalances = {};
        for (const [asset, tokenAddress] of Object.entries(TOKEN_ADDRESSES)) {
            tokenBalances[asset] = await publicClient.readContract({
                address: tokenAddress,
                abi: [{
                    constant: true,
                    inputs: [{ name: "account", type: "address" }],
                    name: "balanceOf",
                    outputs: [{ name: "", type: "uint256" }],
                    type: "function"
                }],
                functionName: 'balanceOf',
                args: [treasuryAddress]
            });
        }
        db.all(
            `SELECT asset, SUM(amount) AS total_unswept FROM payments WHERE fulfilled = 1 AND swept = 0 GROUP BY asset`,
            [],
            (err, unsweptRows) => {
                if (err) return res.status(500).json({ error: 'Failed to query unswept balances.' });
                const unswept = {};
                unsweptRows.forEach(row => unswept[row.asset] = Number(row.total_unswept) / 1e18);
                db.all(
                    `SELECT asset, SUM(amount) AS total_pending FROM payments WHERE fulfilled = 0 AND expiration > ? GROUP BY asset`,
                    [Date.now()],
                    (err2, pendingRows) => {
                        if (err2) return res.status(500).json({ error: 'Failed to query pending balances.' });
                        const pending = {};
                        pendingRows.forEach(row => pending[row.asset] = Number(row.total_pending) / 1e18);
                        res.json({
                            treasury: {
                                BTC: Number(treasuryBalance) / 1e18,
                                ...Object.fromEntries(
                                    Object.entries(tokenBalances).map(([asset, bal]) => [asset, Number(bal) / 1e18])
                                )
                            },
                            unswept,
                            pending
                        });
                    }
                );
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Failed to get balances.' });
    }
});

app.post('/invoice', async (req, res) => {
    const { amount, asset, description } = req.body;
    if (!amount || !asset) return res.status(400).json({ error: 'Amount and asset are required.' });

    const invoiceId = `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(invoiceId).digest('hex');
    const derivationIndex = parseInt(hash.slice(0, 8), 16) % 1000000;
    const newAccount = mnemonicToAccount(MNEMONIC, { addressIndex: derivationIndex });
    const receivingAddress = newAccount.address;

    const authorization = await walletClient.signAuthorization({
        account: newAccount,
        contractAddress: SWEEPER_CONTRACT_ADDRESS,
    });
    const serializedAuthorization = JSON.stringify(authorization, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
    const expiration = new Date(Date.now() + 15 * 60 * 1000).getTime();

    db.run(
        `INSERT INTO payments (invoice_id, amount, asset, receiving_address, auth_signature, expiration, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [invoiceId, Math.floor(amount * 1e18), asset, receivingAddress, serializedAuthorization, expiration, description || null],
        function(err) {
            if (err) return res.status(500).json({ error: 'Failed to create invoice.' });
            res.json({ invoiceId, amount, asset, receivingAddress, expiration, description: description || null });
        }
    );
});

app.get('/invoice/:invoiceId', (req, res) => {
    db.get(
        `SELECT invoice_id, amount, asset, receiving_address, expiration, description, fulfilled, swept, timestamp
         FROM payments WHERE invoice_id = ?`,
        [req.params.invoiceId],
        (err, row) => {
            if (err) return res.status(500).json({ error: 'Failed to query invoice.' });
            if (!row) return res.status(404).json({ error: 'Invoice not found.' });
            res.json(row);
        }
    );
});

app.delete('/invoice/:invoiceId', (req, res) => {
    db.run(
        `DELETE FROM payments WHERE invoice_id = ?`,
        [req.params.invoiceId],
        function(err) {
            if (err) return res.status(500).json({ error: 'Failed to delete invoice.' });
            if (this.changes === 0) return res.status(404).json({ error: 'Invoice not found.' });
            res.json({ message: 'Invoice deleted successfully.' });
        }
    );
});

app.get('/invoice', (req, res) => {
    const { page = 1, pageSize = 20, asset, fulfilled, swept } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    let filters = [], params = [];
    if (asset) { filters.push('asset = ?'); params.push(asset); }
    if (fulfilled !== undefined) { filters.push('fulfilled = ?'); params.push(fulfilled === 'true' ? 1 : 0); }
    if (swept !== undefined) { filters.push('swept = ?'); params.push(swept === 'true' ? 1 : 0); }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
        SELECT invoice_id, amount / 1e18 AS amount, asset, receiving_address, expiration, description, fulfilled, timestamp
        FROM payments
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
    `;
    params.push(parseInt(pageSize), offset);
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to query invoices.' });
        res.json({ invoices: rows, page: parseInt(page), pageSize: parseInt(pageSize) });
    });
});

// --- Error Handling ---
app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Internal Server Error' });
});

// --- Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- Block Counter ---
function getBlockCounter(cb) {
    db.get(`SELECT value FROM meta WHERE key = 'block_counter'`, (err, row) => {
        cb(row ? Number(row.value) : 12820095);
    });
}
function setBlockCounter(counter) {
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('block_counter', ?)`, [counter]);
}

// --- Block Polling ---
let polling = false;
async function pollBlocks() {
    if (polling) return;
    polling = true;
    try {
        const latestBlock = await publicClient.getBlockNumber();
        getBlockCounter(async (lastBlock) => {
            let fromBlock = lastBlock + 1;
            if (fromBlock > latestBlock) return polling = false;
            for (let blockNum = fromBlock; blockNum <= latestBlock; blockNum++) {
                try {
                    const block = await publicClient.getBlock({ blockNumber: BigInt(blockNum), includeTransactions: true });
                    setBlockCounter(Number(block.number));
                    const now = Date.now();
                    db.all(
                        `SELECT id, invoice_id, receiving_address, amount, asset, fulfilled FROM payments WHERE fulfilled = 0 AND expiration > ?`,
                        [now],
                        async (err, rows) => {
                            if (err || !rows.length) return;
                            const btcMap = new Map(), tokenMaps = {};
                            rows.forEach(row => {
                                const addr = row.receiving_address.toLowerCase();
                                if (row.asset === 'BTC') btcMap.set(addr, row);
                                else {
                                    if (!tokenMaps[row.asset]) tokenMaps[row.asset] = new Map();
                                    tokenMaps[row.asset].set(addr, row);
                                }
                            });
                            for (const tx of block.transactions || []) {
                                if (!tx.to) continue;
                                const toAddr = tx.to.toLowerCase();
                                const btcRow = btcMap.get(toAddr);
                                if (btcRow && BigInt(tx.value) >= BigInt(btcRow.amount)) {
                                    db.run(`UPDATE payments SET fulfilled = 1 WHERE id = ?`, [btcRow.id]);
                                    btcMap.delete(toAddr);
                                }
                            }
                            for (const asset of Object.keys(TOKEN_ADDRESSES)) {
                                const tokenAddress = TOKEN_ADDRESSES[asset];
                                const addressesToCheck = Array.from(tokenMaps[asset]?.keys() || []);
                                if (!addressesToCheck.length) continue;
                                const logs = await publicClient.getLogs({
                                    address: tokenAddress,
                                    abi: [{
                                        anonymous: false,
                                        inputs: [
                                            { indexed: true, name: "from", type: "address" },
                                            { indexed: true, name: "to", type: "address" },
                                            { indexed: false, name: "value", type: "uint256" }
                                        ],
                                        name: "Transfer",
                                        type: "event"
                                    }],
                                    eventName: 'Transfer',
                                    args: { to: addressesToCheck },
                                    fromBlock: BigInt(blockNum),
                                    toBlock: BigInt(blockNum)
                                });
                                for (const log of logs) {
                                    const toAddrHex = log.topics[2];
                                    const toAddr = '0x' + toAddrHex.slice(-40).toLowerCase();
                                    const tokenRow = tokenMaps[asset]?.get(toAddr);
                                    if (!tokenRow) continue;
                                    const value = BigInt(log.data);
                                    if (value >= BigInt(tokenRow.amount)) {
                                        db.run(`UPDATE payments SET fulfilled = 1 WHERE id = ?`, [tokenRow.id]);
                                        tokenMaps[asset].delete(toAddr);
                                    }
                                }
                            }
                        }
                    );
                } catch (err) { }
            }
            polling = false;
        });
    } catch (err) { polling = false; }
}
setInterval(pollBlocks, 2000);

// --- Sweep Logic ---
setInterval(() => {
    db.all(
        `SELECT id, invoice_id, receiving_address, amount, asset, auth_signature, swept FROM payments WHERE fulfilled = 1 AND swept = 0`,
        async (err, rows) => {
            if (err) return;
            for (const row of rows) {
                try {
                    if (row.asset === 'BTC') {
                        const receiverAccount = mnemonicToAccount(MNEMONIC, { addressIndex: parseInt(crypto.createHash('sha256').update(row.invoice_id).digest('hex').slice(0, 8), 16) % 1000000 });
                        const receiverWalletClient = createWalletClient({ account: receiverAccount, chain: citreaTestnet, transport: http() });
                        const gasEstimate = await publicClient.estimateGas({ account: receiverAccount, to: walletClient.account.address, value: 0 });
                        const feeEstimates = await publicClient.estimateFeesPerGas();
                        const maxFeePerGas = feeEstimates.maxFeePerGas;
                        const maxPriorityFeePerGas = feeEstimates.maxPriorityFeePerGas;
                        const gasPrice = feeEstimates.gasPrice;
                        const totalFee = BigInt(gasEstimate) * (maxFeePerGas || gasPrice) + BigInt(gasEstimate) * (maxPriorityFeePerGas || 0n);
                        const amountMinusFee = BigInt(row.amount) - totalFee;
                        if (amountMinusFee <= 0) continue;
                        let txHash, feeMultiplier = 1.05, attempts = 0, maxAttempts = 5, success = false, currentTotalFee = totalFee;
                        while (!success && attempts < maxAttempts) {
                            try {
                                const currentAmountMinusFee = BigInt(row.amount) - currentTotalFee;
                                if (currentAmountMinusFee <= 0) break;
                                txHash = await receiverWalletClient.sendTransaction({
                                    to: walletClient.account.address,
                                    value: currentAmountMinusFee,
                                });
                                success = true;
                            } catch (err) {
                                attempts++;
                                currentTotalFee = BigInt(currentTotalFee * BigInt(Math.floor(feeMultiplier * 100)) / 100n);
                            }
                        }
                        if (!success) continue;
                    } else {
                        await walletClient.writeContract({
                            abi: SWEEPER_ABI,
                            functionName: 'sweep',
                            args: [Object.values(TOKEN_ADDRESSES), walletClient.account.address],
                            authorizationList: [JSON.parse(row.auth_signature, (key, value) =>
                                key === 'nonce' || key === 'expiry' ? BigInt(value) : value
                            )],
                            to: row.receiving_address,
                        });
                    }
                    db.run(`UPDATE payments SET swept = 1 WHERE id = ?`, [row.id]);
                } catch (e) { }
            }
        }
    );
}, 86400000); // Every 24 hours
