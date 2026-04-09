<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/opendexter-plugin</h1>

<p align="center">
  <strong>OpenDexter plugin for OpenClaw — search, price-check, and pay for x402 APIs with automatic USDC settlement.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/opendexter-plugin"><img src="https://img.shields.io/npm/v/@dexterai/opendexter-plugin.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://clawhub.ai/skills/opendexter"><img src="https://img.shields.io/badge/ClawHub-opendexter-blue" alt="ClawHub"></a>
  <a href="https://dexter.cash/opendexter"><img src="https://img.shields.io/badge/Marketplace-OpenDexter-success" alt="Marketplace"></a>
</p>

---

## What It Does

Gives any OpenClaw agent access to the x402 API marketplace. The agent can discover paid APIs, preview pricing, and call endpoints with automatic USDC payment — no API keys or subscriptions needed for the endpoints themselves.

| Tool | Purpose |
|------|---------|
| `x402_search` | Search the OpenDexter marketplace for paid APIs |
| `x402_check` | Probe an endpoint for pricing without paying |
| `x402_fetch` | Call any x402 API with automatic payment |
| `x402_pay` | Alias for `x402_fetch` |
| `x402_wallet` | Show wallet configuration and status |

Payments work across **Solana, Base, Polygon, Arbitrum, Optimism, and Avalanche**. The plugin auto-selects the best-funded chain.

---

## Install

### From ClawHub

```bash
openclaw plugins install @dexterai/opendexter-plugin
```

### From npm

```bash
npm install @dexterai/opendexter-plugin
```

---

## Configuration

Set wallet keys in the OpenClaw plugin config or as environment variables:

| Config Key | Env Var | Description |
|-----------|---------|-------------|
| `svmPrivateKey` | `SVM_PRIVATE_KEY` | Solana wallet (base58) |
| `evmPrivateKey` | `EVM_PRIVATE_KEY` | EVM wallet (hex, 0x...) |
| `defaultNetwork` | `DEFAULT_NETWORK` | Preferred chain (default: auto) |
| `maxPaymentUSDC` | `MAX_PAYMENT_USDC` | Per-call spending limit (default: $0.50) |
| `facilitatorUrl` | `FACILITATOR_URL` | Settlement processor (default: https://x402.dexter.cash) |
| `marketplaceUrl` | `MARKETPLACE_URL` | Marketplace API endpoint |

At minimum, configure one wallet key (Solana or EVM) and fund it with USDC.

---

## How It Works

```
User: "Find me a sentiment analysis API"
  → x402_search("sentiment analysis")
  → Shows results with prices and quality scores

User: "How much does that one cost?"
  → x402_check(url)
  → Shows per-chain pricing

User: "Call it"
  → x402_fetch(url, params)
  → Signs USDC payment, calls endpoint, returns data + receipt
```

Settlement goes through the [Dexter facilitator](https://x402.dexter.cash) — zero fees, zero gas for the caller.

---

## Pinata Agent Template

This plugin powers the [OpenDexter Agent](https://agents.pinata.cloud) template for Pinata. Deploy a fully configured x402 agent in one click.

---

## Built By

[Dexter Intelligence](https://dexter.cash) — the payment, discovery, and monetization layer for the agent economy.
