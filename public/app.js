document.addEventListener('DOMContentLoaded', () => {
    const API_URL = 'http://localhost:3000';
    const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

    // Form elements
    const invoiceForm = document.getElementById('create-invoice-form');
    const assetSelect = document.getElementById('asset');
    const amountInput = document.getElementById('amount');
    const isUsdCheckbox = document.getElementById('is-usd');
    const usdCheckboxWrapper = document.getElementById('usd-checkbox-wrapper');
    const errorMessage = document.getElementById('error-message');

    // Table elements
    const invoicesTableBody = document.querySelector('#invoices-table tbody');

    // --- MODAL HANDLING ---
    // Invoice Details Modal
    const detailsModal = document.getElementById('invoice-modal');
    const closeDetailsModalBtn = detailsModal.querySelector('.close-button');

    // Create Invoice Modal
    const createModal = document.getElementById('create-invoice-modal');
    const openCreateModalBtn = document.getElementById('open-create-invoice-modal-btn');
    const closeCreateModalBtn = createModal.querySelector('.close-button');

    // Open/Close logic
    openCreateModalBtn.onclick = () => createModal.style.display = 'block';
    closeDetailsModalBtn.onclick = () => detailsModal.style.display = 'none';
    closeCreateModalBtn.onclick = () => createModal.style.display = 'none';

    window.onclick = (event) => {
        if (event.target == detailsModal) {
            detailsModal.style.display = 'none';
        }
        if (event.target == createModal) {
            createModal.style.display = 'none';
        }
    };


    // Function to update input visibility based on selected asset
    const updateAmountInputs = () => {
        const selectedAsset = assetSelect.value;
        if (selectedAsset === 'USDT') {
            usdCheckboxWrapper.classList.add('hidden');
            amountInput.placeholder = 'Enter amount in USDT';
        } else {
            usdCheckboxWrapper.classList.remove('hidden');
            amountInput.placeholder = isUsdCheckbox.checked ? 'Enter amount in USD' : 'Enter amount in BTC';
        }
    };
    
    assetSelect.addEventListener('change', updateAmountInputs);
    isUsdCheckbox.addEventListener('change', updateAmountInputs);


    // Handle invoice creation form submission
    invoiceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessage.textContent = ''; 

        const asset = assetSelect.value;
        const amount = parseFloat(amountInput.value);
        const isUsd = isUsdCheckbox.checked;
        const description = document.getElementById('description').value;

        if (!amount || amount <= 0) {
            errorMessage.textContent = 'Please enter a valid amount.';
            return;
        }

        let finalAmount;

        try {
            if (asset === 'USDT') {
                finalAmount = amount;
            } else { 
                if (isUsd) {
                    const response = await fetch(COINGECKO_API);
                    if (!response.ok) throw new Error('Could not fetch BTC price for conversion.');
                    const data = await response.json();
                    const btcPrice = data.bitcoin.usd;
                    finalAmount = amount / btcPrice;
                } else {
                    finalAmount = amount;
                }
            }

            const invoice = await fetch(`${API_URL}/invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: finalAmount, asset, description }),
            });

            if (!invoice.ok) {
                const errorData = await invoice.json();
                throw new Error(errorData.message || 'Failed to create invoice.');
            }

            const invoiceData = await invoice.json();
            console.log('Invoice created:', invoiceData);

            // On success, close the modal and refresh the list
            createModal.style.display = 'none';
            fetchInvoices(); 
            invoiceForm.reset();
            updateAmountInputs();

            // open new tab /pos.html?invoice_id=<invoiceId>
            window.open(`/pos.html?invoice_id=${invoiceData.invoiceId}`, '_blank');
        } catch (error) {
            console.error('Error creating invoice:', error);
            errorMessage.textContent = `Failed to create invoice. ${error.message}`;
        }
    });

    // --- Data Fetching and Rendering Functions (remain mostly the same) ---

    // --- Filtering UI Elements ---
    const statusFilter = document.getElementById('status-filter');
    const assetFilter = document.getElementById('asset-filter');

    // --- Fetch and Filter Invoices ---
    const fetchInvoices = async () => {
        try {
            const response = await fetch(`${API_URL}/invoice`);
            const data = await response.json();
            let invoices = data.invoices;

            // Apply filters
            const statusValue = statusFilter.value;
            const assetValue = assetFilter.value;

            invoices = invoices.filter(invoice => {
                // Status filter
                let statusMatch = true;
                if (statusValue === 'pending') {
                    statusMatch = !invoice.fulfilled && Date.now() <= invoice.expiration;
                } else if (statusValue === 'paid') {
                    statusMatch = invoice.fulfilled;
                } else if (statusValue === 'cancelled') {
                    statusMatch = !invoice.fulfilled && Date.now() > invoice.expiration;
                }
                // Asset filter
                let assetMatch = !assetValue || invoice.asset === assetValue;

                return statusMatch && assetMatch;
            });

            renderInvoices(invoices);
        } catch (error) {
            console.error('Error fetching invoices:', error);
        }
    };

    // Re-fetch invoices when filters change
    statusFilter.addEventListener('change', fetchInvoices);
    assetFilter.addEventListener('change', fetchInvoices);

    const renderInvoices = (invoices) => {
        invoicesTableBody.innerHTML = '';
        invoices.forEach(invoice => {
            const row = document.createElement('tr');
            const formattedDate = new Date(invoice.timestamp).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            const displayAmount = parseFloat(invoice.amount.toPrecision(6));
            const now = Date.now();
            const isExpired = now > invoice.expiration;
            row.innerHTML = `
                <td>${invoice.invoice_id}</td>
                <td>${displayAmount}</td>
                <td>${invoice.asset}</td>
                <td><span class="status-${invoice.fulfilled ? 'paid' : 'unpaid'}">${invoice.fulfilled ? 'Paid' : 'Unpaid'}</span></td>
                <td>${formattedDate}</td>
                <td>${
                    (invoice.fulfilled)
                        ? ''
                        : (isExpired
                            ? '<span style="color:red;">Expired</span>'
                            : new Date(invoice.expiration).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            }))
                }</td>
                <td><button class="view-btn" data-id="${invoice.invoice_id}">View</button></td>
                <td>${!invoice.fulfilled && !isExpired ? `<button class="cancel-btn" data-id="${invoice.invoice_id}">Cancel</button>` : ''}</td>
            `;
            invoicesTableBody.appendChild(row);
        });
    };

    invoicesTableBody.addEventListener('click', async (e) => {
        if (e.target.classList.contains('view-btn')) {
            const invoiceId = e.target.dataset.id;
            openModalWithInvoice(invoiceId);
        }

        if (e.target.classList.contains('cancel-btn')) {
            const invoiceId = e.target.dataset.id;
            if (confirm('Are you sure you want to cancel this invoice?')) {
                try {
                    await fetch(`${API_URL}/invoice/${invoiceId}`, { method: 'DELETE' });
                    fetchInvoices();
                } catch (error) {
                    console.error('Error cancelling invoice:', error);
                    alert('Failed to cancel invoice.');
                }
            }
        }
    });

    const openModalWithInvoice = async (invoiceId) => {
        try {
            const response = await fetch(`${API_URL}/invoice/${invoiceId}`);
            const invoice = await response.json();
            const modalBody = detailsModal.querySelector('.modal-body');

            let paymentUri;
            const displayAmount = parseFloat((invoice.amount)/1e18).toPrecision(6).replace(/\.?0+$/,"");

            const customChainId = 5115;
            if (invoice.asset === 'USDT') {
                const usdtContractAddress = '0x04BD83BDa81D8Ef1816eFFcaB895fC9a3df96006';
                const usdtAmountInSmallestUnit = Math.floor(invoice.amount * 1e6);
                paymentUri = `ethereum:${usdtContractAddress}@${customChainId}/transfer?address=${invoice.receiving_address}&uint256=${usdtAmountInSmallestUnit}`;
            } else {
                const btcAmountInSmallestUnit = Math.floor(invoice.amount * 1e18);
                paymentUri = `ethereum:${invoice.receiving_address}@${customChainId}?value=${btcAmountInSmallestUnit}`;
            }

            const statusText = invoice.fulfilled
                ? 'Paid'
                : (Date.now() > invoice.expiration ? 'Expired' : 'Unpaid');
            const statusClass = invoice.fulfilled
                ? 'paid'
                : (Date.now() > invoice.expiration ? 'expired' : 'unpaid');
            
            modalBody.innerHTML = `
                <p>
                <strong>Status:</strong> 
                <span class="status-${statusClass}">${statusText}</span>
                </p>
                <div id="qr-code"></div>
                <h4>Pay ${displayAmount} ${invoice.asset}</h4>
                <p>To: <code id="address">${invoice.receiving_address}</code> <button id="copy-address-btn">Copy</button></p>
                <p>Expires: ${new Date(invoice.expiration).toLocaleString()}</p>
                 ${invoice.swept ? '<p style="color: green;">Funds Swept</p>' : ''}
            `;

            const qrCodeContainer = modalBody.querySelector('#qr-code');
            qrCodeContainer.innerHTML = '';
            new QRCode(qrCodeContainer, {
                text: paymentUri,
                width: 220,
                height: 220,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.H
            });
            
            detailsModal.style.display = 'block';

            // Add copy address event listener after button is rendered
            const copyAddressButton = detailsModal.querySelector('#copy-address-btn');
            if (copyAddressButton) {
                copyAddressButton.addEventListener('click', () => {
                    const address = detailsModal.querySelector('#address').textContent;
                    navigator.clipboard.writeText(address)
                        .catch(err => {
                            console.error('Error copying address:', err);
                        });
                });
            }
        } catch (error) {
            console.error('Error fetching invoice details:', error);
        }
    };

    
    // Initial setup
    updateAmountInputs();
    fetchInvoices();
    setInterval(fetchInvoices, 2000);
});