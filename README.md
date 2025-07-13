# Citrea Pay
==================

A simple server to manage BTC and USDT invoices on Citrea using a hierarchical deterministic (HD) wallet structure. Each invoice is associated with a unique sub-account derived from a master mnemonic, allowing for easy tracking and management of payments.

Funds are swept to a main account after payment is confirmed. For USDT payments, a EIP-7702 smart contract is deployed to facilitate the transfer of USDT tokens to the main account.

## Features
- HD Wallet Structure: Each invoice gets a unique sub-account derived from a master mnemonic.
- BTC and USDT Support: Accept payments in both BTC and USDT.
- Automatic Sweeping: Funds are automatically swept to a main account after payment confirmation.
- Lightweight Database: Uses SQLite for easy setup and management.
- RESTful API: Simple API endpoints for creating invoices and checking payment status.
- Web-based PoS: A user-friendly interface for showing QR codes and payment details.
- EIP-681 compatible payment links for easy payments.

## Running the Server
**Prerequisites**
- Node.js (v14 or later)
- npm (v6 or later)
- SQLite

**Installation**
1. Clone the repository:
   ```bash
   git clone https://github.com/orkunkilic/citrea-pay.git
   cd citrea-pay
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure the environment variables:
   ```bash
   cp .env.example .env
   ```

4. Start the server:
   ```bash
   npm start
   ```