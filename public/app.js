document.addEventListener('DOMContentLoaded', () => {
    const API_URL = 'http://localhost:3000';
    const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

    // --- DOM Elements ---
    const els = {
        invoiceForm: document.getElementById('create-invoice-form'),
        assetSelect: document.getElementById('asset'),
        amountInput: document.getElementById('amount'),
        isUsdCheckbox: document.getElementById('is-usd'),
        usdCheckboxWrapper: document.getElementById('usd-checkbox-wrapper'),
        errorMessage: document.getElementById('error-message'),
        invoicesTableBody: document.querySelector('#invoices-table tbody'),
        detailsModal: document.getElementById('invoice-modal'),
        closeDetailsModalBtn: document.getElementById('invoice-modal').querySelector('.close-button'),
        createModal: document.getElementById('create-invoice-modal'),
        openCreateModalBtn: document.getElementById('open-create-invoice-modal-btn'),
        closeCreateModalBtn: document.getElementById('create-invoice-modal').querySelector('.close-button'),
        statusFilter: document.getElementById('status-filter'),
        assetFilter: document.getElementById('asset-filter'),
        balancesTableBody: document.querySelector('#balances-table tbody')
    };

    // --- Modal Logic ---
    els.openCreateModalBtn.onclick = () => els.createModal.style.display = 'block';
    els.closeDetailsModalBtn.onclick = () => els.detailsModal.style.display = 'none';
    els.closeCreateModalBtn.onclick = () => els.createModal.style.display = 'none';
    window.onclick = (e) => {
        if (e.target === els.detailsModal) els.detailsModal.style.display = 'none';
        if (e.target === els.createModal) els.createModal.style.display = 'none';
    };

    // --- UI Helpers ---
    function updateAmountInputs() {
        const asset = els.assetSelect.value;
        if (asset === 'USDT') {
            els.usdCheckboxWrapper.classList.add('hidden');
            els.amountInput.placeholder = 'Enter amount in USDT';
        } else {
            els.usdCheckboxWrapper.classList.remove('hidden');
            els.amountInput.placeholder = els.isUsdCheckbox.checked ? 'Enter amount in USD' : 'Enter amount in BTC';
        }
    }

    els.assetSelect.addEventListener('change', updateAmountInputs);
    els.isUsdCheckbox.addEventListener('change', updateAmountInputs);

    // --- Invoice Creation ---
    els.invoiceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        els.errorMessage.textContent = '';
        const asset = els.assetSelect.value;
        const amount = parseFloat(els.amountInput.value);
        const isUsd = els.isUsdCheckbox.checked;
        const description = document.getElementById('description').value;

        if (!amount || amount <= 0) {
            els.errorMessage.textContent = 'Please enter a valid amount.';
            return;
        }

        let finalAmount = amount;
        try {
            if (asset !== 'USDT' && isUsd) {
                const res = await fetch(COINGECKO_API);
                if (!res.ok) throw new Error('Could not fetch BTC price for conversion.');
                const btcPrice = (await res.json()).bitcoin.usd;
                finalAmount = amount / btcPrice;
            }

            const invoiceRes = await fetch(`${API_URL}/invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: finalAmount, asset, description }),
            });

            if (!invoiceRes.ok) {
                const errorData = await invoiceRes.json();
                throw new Error(errorData.message || 'Failed to create invoice.');
            }

            const invoiceData = await invoiceRes.json();
            els.createModal.style.display = 'none';
            fetchInvoices();
            els.invoiceForm.reset();
            updateAmountInputs();
            window.open(`/pos.html?invoice_id=${invoiceData.invoiceId}`, '_blank');
        } catch (err) {
            console.error('Error creating invoice:', err);
            els.errorMessage.textContent = `Failed to create invoice. ${err.message}`;
        }
    });

    // --- Invoice Fetching & Rendering ---
    async function fetchInvoices() {
        try {
            const res = await fetch(`${API_URL}/invoice`);
            const { invoices } = await res.json();
            const status = els.statusFilter.value;
            const asset = els.assetFilter.value;

            const filtered = invoices.filter(inv => {
                let statusMatch = true;
                if (status === 'pending') statusMatch = !inv.fulfilled && Date.now() <= inv.expiration;
                else if (status === 'paid') statusMatch = inv.fulfilled;
                else if (status === 'cancelled') statusMatch = !inv.fulfilled && Date.now() > inv.expiration;
                let assetMatch = !asset || inv.asset === asset;
                return statusMatch && assetMatch;
            });

            renderInvoices(filtered);
        } catch (err) {
            console.error('Error fetching invoices:', err);
        }
    }

    function renderInvoices(invoices) {
        els.invoicesTableBody.innerHTML = '';
        invoices.forEach(inv => {
            const now = Date.now();
            const isExpired = now > inv.expiration;
            const formattedDate = new Date(inv.timestamp).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const displayAmount = parseFloat(inv.amount.toPrecision(6));
            els.invoicesTableBody.insertAdjacentHTML('beforeend', `
                <tr>
                    <td>${inv.invoice_id}</td>
                    <td>${displayAmount}</td>
                    <td>${inv.asset}</td>
                    <td><span class="status-${inv.fulfilled ? 'paid' : 'unpaid'}">${inv.fulfilled ? 'Paid' : 'Unpaid'}</span></td>
                    <td>${formattedDate}</td>
                    <td>${inv.fulfilled ? '' : (isExpired ? '<span style="color:red;">Expired</span>' : new Date(inv.expiration).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</td>
                    <td><button class="view-btn" data-id="${inv.invoice_id}">View</button></td>
                    <td>${!inv.fulfilled && !isExpired ? `<button class="cancel-btn" data-id="${inv.invoice_id}">Cancel</button>` : ''}</td>
                </tr>
            `);
        });
    }

    els.invoicesTableBody.addEventListener('click', async (e) => {
        const btn = e.target;
        if (btn.classList.contains('view-btn')) openModalWithInvoice(btn.dataset.id);
        if (btn.classList.contains('cancel-btn')) {
            if (confirm('Are you sure you want to cancel this invoice?')) {
                try {
                    await fetch(`${API_URL}/invoice/${btn.dataset.id}`, { method: 'DELETE' });
                    fetchInvoices();
                } catch (err) {
                    console.error('Error cancelling invoice:', err);
                    alert('Failed to cancel invoice.');
                }
            }
        }
    });

    async function openModalWithInvoice(invoiceId) {
        try {
            const res = await fetch(`${API_URL}/invoice/${invoiceId}`);
            const invoice = await res.json();
            const modalBody = els.detailsModal.querySelector('.modal-body');
            const customChainId = 5115;
            let paymentUri, displayAmount;

            if (invoice.asset === 'USDT') {
                const usdtContract = '0x04BD83BDa81D8Ef1816eFFcaB895fC9a3df96006';
                paymentUri = `ethereum:${usdtContract}@${customChainId}/transfer?address=${invoice.receiving_address}&uint256=${Math.floor(invoice.amount * 1e6)}`;
                displayAmount = Number(invoice.amount / 1e18).toPrecision(6).replace(/\.?0+$/,"");
            } else {
                paymentUri = `ethereum:${invoice.receiving_address}@${customChainId}?value=${Math.floor(invoice.amount * 1e18)}`;
                displayAmount = (Number(invoice.amount) / 1e18).toPrecision(6).replace(/\.?0+$/,"");
            }

            const statusText = invoice.fulfilled ? 'Paid' : (Date.now() > invoice.expiration ? 'Expired' : 'Unpaid');
            const statusClass = invoice.fulfilled ? 'paid' : (Date.now() > invoice.expiration ? 'expired' : 'unpaid');

            modalBody.innerHTML = `
                <p><strong>Status:</strong> <span class="status-${statusClass}">${statusText}</span></p>
                <div id="qr-code"></div>
                <h4>Pay ${displayAmount} ${invoice.asset}</h4>
                <p>To: <code id="address">${invoice.receiving_address}</code> <button id="copy-address-btn">Copy</button></p>
                <p>Expires: ${new Date(invoice.expiration).toLocaleString()}</p>
                ${invoice.swept ? '<p style="color: green;">Funds Swept</p>' : ''}
            `;

            new QRCode(modalBody.querySelector('#qr-code'), {
                text: paymentUri,
                width: 220,
                height: 220,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.H
            });

            els.detailsModal.style.display = 'block';
            const copyBtn = els.detailsModal.querySelector('#copy-address-btn');
            if (copyBtn) {
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(invoice.receiving_address).catch(console.error);
                };
            }
        } catch (err) {
            console.error('Error fetching invoice details:', err);
        }
    }

    // --- Balances ---
    async function fetchBalances() {
        try {
            const res = await fetch(`${API_URL}/balance`);
            const data = await res.json();
            const assets = new Set([
                ...Object.keys(data.treasury || {}),
                ...Object.keys(data.unswept || {})
            ]);

            // Fetch BTC price in USD for display
            let btcUsd = 0;
            try {
                const btcRes = await fetch(COINGECKO_API);
                if (btcRes.ok) {
                    btcUsd = (await btcRes.json()).bitcoin.usd;
                }
            } catch (err) {
                console.error('Error fetching BTC price:', err);
            }

            // Update BTC row
            document.getElementById('balance-asset-btc').textContent = 'BTC';
            let treasuryBTC = data.treasury?.BTC ?? 0;
            let unsweptBTC = data.unswept?.BTC ?? 0;
            let totalBTC = treasuryBTC + unsweptBTC;
            let pendingBTC = data.pending?.BTC ?? 0;
            let treasuryBTCDisplay = treasuryBTC.toPrecision(6).replace(/\.?0+$/,"");
            let unsweptBTCDisplay = unsweptBTC.toPrecision(6).replace(/\.?0+$/,"");
            let totalBTCDisplay = totalBTC.toPrecision(6).replace(/\.?0+$/,"");
            let pendingBTCDisplay = pendingBTC.toPrecision(6).replace(/\.?0+$/,"");
            if (btcUsd) {
                treasuryBTCDisplay += ` ($${(treasuryBTC * btcUsd).toFixed(2)})`;
                unsweptBTCDisplay += ` ($${(unsweptBTC * btcUsd).toFixed(2)})`;
                totalBTCDisplay += ` ($${(totalBTC * btcUsd).toFixed(2)})`;
                pendingBTCDisplay += ` ($${(pendingBTC * btcUsd).toFixed(2)})`;
            }
            document.getElementById('balance-treasury-btc').textContent = treasuryBTCDisplay;
            document.getElementById('balance-unswept-btc').textContent = unsweptBTCDisplay;
            document.getElementById('balance-total-btc').textContent = totalBTCDisplay;
            document.getElementById('balance-pending-btc').textContent = pendingBTCDisplay;

            // Update USDT row
            document.getElementById('balance-asset-usdt').textContent = 'USDT';
            let treasuryUSDT = data.treasury?.USDT ?? 0;
            let unsweptUSDT = data.unswept?.USDT ?? 0;
            let totalUSDT = treasuryUSDT + unsweptUSDT;
            let pendingUSDT = data.pending?.USDT ?? 0;
            let treasuryUSDTDisplay = treasuryUSDT.toPrecision(6).replace(/\.?0+$/,"");
            let unsweptUSDTDisplay = unsweptUSDT.toPrecision(6).replace(/\.?0+$/,"");
            let totalUSDTDisplay = totalUSDT.toPrecision(6).replace(/\.?0+$/,"");
            let pendingUSDTDisplay = pendingUSDT.toPrecision(6).replace(/\.?0+$/,"");
            document.getElementById('balance-treasury-usdt').textContent = treasuryUSDTDisplay;
            document.getElementById('balance-unswept-usdt').textContent = unsweptUSDTDisplay;
            document.getElementById('balance-total-usdt').textContent = totalUSDTDisplay;
            document.getElementById('balance-pending-usdt').textContent = pendingUSDTDisplay;

            // Remove extra asset rows
            els.balancesTableBody.querySelectorAll('tr:not(:nth-child(1)):not(:nth-child(2))').forEach(tr => tr.remove());

            // Add other assets
            assets.forEach(asset => {
                if (asset === 'BTC' || asset === 'USDT') return;
                const treasury = data.treasury?.[asset] ?? 0;
                const unswept = data.unswept?.[asset] ?? 0;
                const total = treasury + unswept;
                const pending = data.pending?.[asset] ?? 0;
                els.balancesTableBody.insertAdjacentHTML('beforeend', `
                    <tr>
                        <td>${asset}</td>
                        <td>${treasury.toPrecision(6).replace(/\.?0+$/,"")}</td>
                        <td>${unswept.toPrecision(6).replace(/\.?0+$/,"")}</td>
                        <td>${total.toPrecision(6).replace(/\.?0+$/,"")}</td>
                        <td>${pending.toPrecision(6).replace(/\.?0+$/,"")}</td>
                    </tr>
                `);
            });
        } catch (err) {
            console.error('Error fetching balances:', err);
        }
    }

    // --- Initial Setup ---
    updateAmountInputs();
    fetchInvoices();
    fetchBalances();
    setInterval(fetchInvoices, 2000);
    setInterval(fetchBalances, 5000);
    els.statusFilter.addEventListener('change', fetchInvoices);
    els.assetFilter.addEventListener('change', fetchInvoices);
});
