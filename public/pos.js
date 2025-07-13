document.addEventListener('DOMContentLoaded', () => {
    const API_URL = 'http://localhost:3000'; // This must be the public URL of your backend
    const POLLING_INTERVAL_MS = 5000;

    // DOM Elements
    const container = document.getElementById('payment-container');
    const statusEl = document.getElementById('payment-status');
    const amountEl = document.getElementById('amount-display');
    const addressEl = document.getElementById('receiving-address');
    
    // Tab Elements
    const invoiceTabBtn = document.getElementById('invoice-tab-btn');
    const addressTabBtn = document.getElementById('address-tab-btn');
    const invoiceContent = document.getElementById('invoice-content');
    const addressContent = document.getElementById('address-content');
    const invoiceQrContainer = document.getElementById('invoice-qr-container');
    const addressQrContainer = document.getElementById('address-qr-container');

    let pollInterval;

    // Tab switching logic
    const switchTab = (activeTab) => {
        if (activeTab === 'invoice') {
            invoiceTabBtn.classList.add('active');
            addressTabBtn.classList.remove('active');
            invoiceContent.classList.add('active');
            addressContent.classList.remove('active');
        } else {
            invoiceTabBtn.classList.remove('active');
            addressTabBtn.classList.add('active');
            invoiceContent.classList.remove('active');
            addressContent.classList.add('active');
        }
    };

    invoiceTabBtn.addEventListener('click', () => switchTab('invoice'));
    addressTabBtn.addEventListener('click', () => switchTab('address'));

    const updateStatus = (message, className) => {
        statusEl.textContent = message;
        statusEl.className = `status ${className}`;
    };

    const fetchAndDisplayInvoice = async (invoiceId) => {
        try {
            const response = await fetch(`${API_URL}/invoice/${encodeURIComponent(invoiceId)}`);
            if (!response.ok) {
                throw new Error('Invoice not found or server error.');
            }
            const invoice = await response.json();

            if (container.classList.contains('loading')) {
                container.classList.remove('loading');
            }

            const isExpired = Date.now() > new Date(invoice.expiration).getTime();

            if (invoice.fulfilled) {
                container.innerHTML = `
                    <div style="text-align:center; padding: 40px;">
                        <h1 style="font-size:2.5em; color:green;">✅<br>Payment Received!</h1>
                    </div>
                `;
                clearInterval(pollInterval);
                setTimeout(() => window.close(), 2000);
                return;
            }

            if (isExpired) {
                updateStatus('This invoice has expired.', 'expired');
                invoiceContent.style.opacity = 0.3; // Dim content if expired
                clearInterval(pollInterval);
                return;
            }

            updateStatus('Waiting for payment...', 'pending');

            if (!amountEl.textContent) {
                const displayAmount = parseFloat(invoice.amount / 1e18).toFixed(6).replace(/\.?0+$/, '');
                amountEl.innerHTML = `${displayAmount} <span>${invoice.asset}</span>`;
                addressEl.textContent = invoice.receiving_address;

                // --- Generate QR Codes for both tabs ---
                const customChainId = 5115;
                let paymentUri;
                if (invoice.asset === 'USDT') {
                    const usdtContractAddress = '0x04BD83BDa81D8Ef1816eFFcaB895fC9a3df96006';
                    paymentUri = `ethereum:${usdtContractAddress}@${customChainId}/transfer?address=${invoice.receiving_address}&uint256=${invoice.amount}`;
                } else {
                    paymentUri = `ethereum:${invoice.receiving_address}@${customChainId}?value=${invoice.amount}`;
                }

                // 1. Invoice QR Code (with amount)
                invoiceQrContainer.innerHTML = '';
                new QRCode(invoiceQrContainer, {
                    text: paymentUri,
                    width: 240,
                    height: 240,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.H
                });
                
                // 2. Address-only QR Code
                addressQrContainer.innerHTML = '';
                 new QRCode(addressQrContainer, {
                    text: invoice.receiving_address,
                    width: 240,
                    height: 240,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.H
                });
            }

        } catch (error) {
            console.error("Fetch error:", error);
            updateStatus(error.message, 'error');
            container.classList.remove('loading');
            clearInterval(pollInterval);
        }
    };

    const init = () => {
        const params = new URLSearchParams(window.location.search);
        const invoiceId = params.get('invoice_id');

        if (!invoiceId) {
            updateStatus('No Invoice ID provided.', 'error');
            container.classList.remove('loading');
            return;
        }

        fetchAndDisplayInvoice(invoiceId);
        pollInterval = setInterval(() => fetchAndDisplayInvoice(invoiceId), POLLING_INTERVAL_MS);
    };

    init();
});