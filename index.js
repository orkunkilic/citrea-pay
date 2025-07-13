const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { createWalletClient, http, createPublicClient, parseAbi } = require('viem');
const { mnemonicToAccount } = require('viem/accounts');
const { citreaTestnet } = require('viem/chains');
const crypto = require('crypto');
require('dotenv').config();

const { TOKEN_ADDRESSES, SWEEPER_CONTRACT_ADDRESS } = require('./config');
const SWEEPER_ABI = require('./Sweeper.abi.json');

// Load environment variables
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
    throw new Error('MNEMONIC environment variable is not set.');
}

// Create account from mnemonic
const account = mnemonicToAccount(MNEMONIC);

console.log('Main account private key:', Buffer.from(account.getHdKey().privateKey).toString('hex'));

// Create viem wallet client
const walletClient = createWalletClient({
    account,
    chain: citreaTestnet,
    transport: http(),
});

// Create public client for read-only operations
const publicClient = createPublicClient({
    chain: citreaTestnet,
    transport: http(),
});

// Initialize SQLite database
const dbPath = path.join(__dirname, 'citrea-pay.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Failed to connect to SQLite database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});

// Example: Create a payments table if it doesn't exist
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

const app = express();

// Security headers
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "connect-src": ["'self'", "https://api.coingecko.com"],
            "script-src": ["'self'", "https://cdn.jsdelivr.net"]
        },
    })
);

// Enable CORS
app.use(cors());

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Compression
app.use(compression());

// Serve static files (if any)
app.use(express.static(path.join(__dirname, 'public')));

// Example route
app.get('/', (req, res) => {
    res.json({ message: 'Citrea Pay Server is running.' });
});

app.post('/invoice', async (req, res) => {
    // Extract amount, asset, and decscription from request body
    const { amount, asset, description } = req.body;

    // Validate input
    if (!amount || !asset) {
        return res.status(400).json({ error: 'Amount and asset are required.' });
    }

    // Generate invoice details
    const invoiceId = `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Derive new receiving address from wallet
    // Derive a new receiving address from the existing mnemonic using a new index
    // Use invoiceId hash to generate a unique index
    const hash = crypto.createHash('sha256').update(invoiceId).digest('hex');
    const derivationIndex = parseInt(hash.slice(0, 8), 16) % 1000000; // Limit index to a reasonable range
    const newAccount = mnemonicToAccount(MNEMONIC, { addressIndex: derivationIndex });
    const receivingAddress = newAccount.address;

    // Create EIP-7702 compliant auth signature
    const authorization = await walletClient.signAuthorization({
        account: newAccount,
        contractAddress: SWEEPER_CONTRACT_ADDRESS,
    });
    // Serialize authorization to JSON string for DB storage
    const serializedAuthorization = JSON.stringify(authorization, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
    console.log('Authorization:', serializedAuthorization);

    // Set expiration time (15 minutes from now) as SQLite-compatible string
    const expiration = new Date(Date.now() + 15 * 60 * 1000).getTime();

    // Store invoice in database
    const stmt = db.prepare(`
        INSERT INTO payments (invoice_id, amount, asset, receiving_address, auth_signature, expiration, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(invoiceId, Math.floor(amount * 1e18), asset, receivingAddress, serializedAuthorization, expiration, description || null, function(err) {
        if (err) {
            console.error('Failed to create invoice:', err.message);
            return res.status(500).json({ error: 'Failed to create invoice.' });
        }
    });
    stmt.finalize();

    // Return invoice details
    res.json({
        invoiceId,
        amount,
        asset,
        receivingAddress,
        expiration,
        description: description || null
    });
});

app.get('/invoice/:invoiceId', (req, res) => {
    const { invoiceId } = req.params;
    db.get(
        `SELECT invoice_id, amount, asset, receiving_address, expiration, description, fulfilled, swept, timestamp
         FROM payments WHERE invoice_id = ?`,
        [invoiceId],
        (err, row) => {
            if (err) {
                console.error('Error querying invoice by id:', err.message);
                return res.status(500).json({ error: 'Failed to query invoice.' });
            }
            if (!row) {
                return res.status(404).json({ error: 'Invoice not found.' });
            }
            res.json(row);
        }
    );
});

app.delete('/invoice/:invoiceId', (req, res) => {
    const { invoiceId } = req.params;
    db.run(
        `DELETE FROM payments WHERE invoice_id = ?`,
        [invoiceId],
        function(err) {
            if (err) {
                console.error('Error deleting invoice:', err.message);
                return res.status(500).json({ error: 'Failed to delete invoice.' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Invoice not found.' });
            }
            res.json({ message: 'Invoice deleted successfully.' });
        }
    );
});

app.get('/invoice', (req, res) => {
    const { page = 1, pageSize = 20, asset, fulfilled, swept } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    let filters = [];
    let params = [];

    // Filter by asset if provided
    if (asset) {
        filters.push('asset = ?');
        params.push(asset);
    }
    if (fulfilled !== undefined) {
        filters.push('fulfilled = ?');
        params.push(fulfilled === 'true' ? 1 : 0);
    }
    if (swept !== undefined) {
        filters.push('swept = ?');
        params.push(swept === 'true' ? 1 : 0);
    }

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
        if (err) {
            console.error('Error querying invoices:', err.message);
            return res.status(500).json({ error: 'Failed to query invoices.' });
        }
        res.json({ invoices: rows, page: parseInt(page), pageSize: parseInt(pageSize) });
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
setInterval(() => {
    const now = new Date();
    db.all(
        `SELECT id, invoice_id, receiving_address, amount, asset, fulfilled FROM payments WHERE fulfilled = 0 AND expiration > ?`,
        [now.getTime()],
        async (err, rows) => {
            if (err) {
                console.error('Error querying unpaid invoices:', err.message);
                return;
            }
            
            for (const row of rows) {
                try {
                    let balance = 0;
                    if (row.asset === 'BTC') {
                        balance = await publicClient.getBalance({
                            address: row.receiving_address,
                        });
                    } else {
                        balance = await publicClient.readContract({
                            address: TOKEN_ADDRESSES[row.asset],
                            abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
                            functionName: 'balanceOf',
                            args: [row.receiving_address],
                        });
                    }
                    
                    // If balance = amount, mark invoice as fulfilled
                    if (balance >= row.amount) {
                        db.run(
                            `UPDATE payments SET fulfilled = 1 WHERE id = ?`,
                            [row.id],
                            (updateErr) => {
                                if (updateErr) {
                                    console.error(`Failed to update invoice ${row.invoice_id}:`, updateErr.message);
                                } else {
                                    console.log(`Invoice ${row.invoice_id} marked as fulfilled.`);
                                }
                            }
                        );
                    }
                } catch (e) {
                    console.error(`Error checking balance for invoice ${row.invoice_id}:`, e.message);
                }
            }
        }
    );
}, 2000);
 
setInterval(() => {
    db.all(
        `SELECT id, invoice_id, receiving_address, amount, asset, auth_signature, swept FROM payments WHERE fulfilled = 1 AND swept = 0`,
        async (err, rows) => {
            if (err) {
                console.error('Error querying paid and unswept invoices:', err.message);
                return;
            }
            for (const row of rows) {
                try {
                    // Call EIP-7702 sweep function to transfer funds to treasury
                    if (row.asset === 'BTC') {
                        // For BTC, sweep directly using receiver's private key derived from mnemonic
                        const receiverAccount = mnemonicToAccount(MNEMONIC, { addressIndex: parseInt(crypto.createHash('sha256').update(row.invoice_id).digest('hex').slice(0, 8), 16) % 1000000 });
                        const receiverWalletClient = createWalletClient({
                            account: receiverAccount,
                            chain: citreaTestnet,
                            transport: http(),
                        });
                        // Estimate gas fee for BTC transfer
                        const gasEstimate = await publicClient.estimateGas({
                            account: receiverAccount,
                            to: walletClient.account.address,
                            value: 0,
                        });
                        const feeEstimates = await publicClient.estimateFeesPerGas();

                        const maxFeePerGas = feeEstimates.maxFeePerGas;
                        const maxPriorityFeePerGas = feeEstimates.maxPriorityFeePerGas;
                        const gasPrice = feeEstimates.gasPrice;
                        console.log(`Gas Estimate: ${gasEstimate}, MaxFeePerGas: ${maxFeePerGas}, MaxPriorityFeePerGas: ${maxPriorityFeePerGas}, GasPrice: ${gasPrice}`);

                        const totalFee = BigInt(gasEstimate) * (maxFeePerGas || gasPrice) + BigInt(gasEstimate) * (maxPriorityFeePerGas || 0n);
                        console.log(`Total Estimated Fee: ${totalFee} wei`);
                        console.log(`Amount to Sweep: ${row.amount} wei`);
                        const amountMinusFee = BigInt(row.amount) - totalFee;
                        
                        // Ensure amountMinusFee is positive
                        if (amountMinusFee <= 0) {
                            console.error(`Invoice ${row.invoice_id}: Amount too low after fee deduction.`);
                            continue;
                        }
                        let txHash;
                        let feeMultiplier = 1.05; // 5% bump
                        let attempts = 0;
                        let maxAttempts = 5;
                        let success = false;
                        let currentTotalFee = totalFee;

                        while (!success && attempts < maxAttempts) {
                            try {
                                const currentAmountMinusFee = BigInt(row.amount) - currentTotalFee;
                                if (currentAmountMinusFee <= 0) {
                                    console.error(`Invoice ${row.invoice_id}: Amount too low after fee deduction (attempt ${attempts + 1}).`);
                                    break;
                                }
                                txHash = await receiverWalletClient.sendTransaction({
                                    to: walletClient.account.address,
                                    value: currentAmountMinusFee,
                                });
                                success = true;
                            } catch (err) {
                                attempts++;
                                currentTotalFee = BigInt(currentTotalFee * BigInt(Math.floor(feeMultiplier * 100)) / 100n);
                                console.error(`Sweep attempt ${attempts} failed for invoice ${row.invoice_id}: ${err.message}. Bumping fee and retrying.`);
                            }
                        }

                        if (!success) {
                            console.error(`Failed to sweep invoice ${row.invoice_id} after ${maxAttempts} attempts.`);
                            continue;
                        }

                        console.log(`Swept invoice ${row.invoice_id} to treasury. TxHash: ${txHash}`);
                    } else {
                        // For tokens, fallback to EIP-7702 sweep call
                        const txHash = await walletClient.writeContract({
                            abi: SWEEPER_ABI,
                            functionName: 'sweep',
                            args: [
                                Object.values(TOKEN_ADDRESSES),
                                walletClient.account.address
                            ],
                            authorizationList: [JSON.parse(row.auth_signature, (key, value) =>
                                key === 'nonce' || key === 'expiry' ? BigInt(value) : value
                            )],
                            to: row.receiving_address,
                        });
                        console.log(`Swept invoice ${row.invoice_id} to treasury. TxHash: ${txHash}`);
                    }

                    // Mark as swept in DB
                    db.run(
                        `UPDATE payments SET swept = 1 WHERE id = ?`,
                        [row.id],
                        (updateErr) => {
                            if (updateErr) {
                                console.error(`Failed to mark invoice ${row.invoice_id} as swept:`, updateErr.message);
                            } else {
                                console.log(`Invoice ${row.invoice_id} marked as swept.`);
                            }
                        }
                    );
                } catch (e) {
                    console.error(`Error sweeping invoice ${row.invoice_id}:`, e.message);
                }
            }
        }
    );
}, 4000);

