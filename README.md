# Zomato Partner Order Helper

A Chrome extension for Zomato restaurant partners that surfaces all active orders in one side panel so you don't have to tab-hop between **Preparing** and **Ready** — and plays an audible chime the moment a delivery rider is assigned.

## What it does

- **Unified live view** of every active order grouped by state (Preparing, Ready).
- **Customer-facing details at a glance**: name, address with Maps link, items with customisations, OTP, payment status, customer instructions.
- **Live distance & ETA** parsed from the address (e.g. `4.0 km · 14 min`).
- **Prominent rider strip** per card — name, phone (tap-to-call), and a ticking "Arriving in X" countdown driven by the rider pickup ETA. Red banner if no rider assigned yet.
- **🔔 Audible alert** the moment a rider gets assigned (mute toggle in the header).
- **Live countdown timer** to handover, with overdue state in red.
- **Recently viewed** orders (Delivered / Picked-up / History) reappear in a dedicated section when you click them on the dashboard.

## How it works

- Polls `/merchant-api/orders/get-all` every 30 seconds for active states (NEW, ACCEPTED, PREPARING, READY).
- Auto-fetches `/merchant-api/orders/order-details?tab_id=…` for each known order so cards fully populate without you clicking.
- Subscribes to the dashboard's own Redux store for sub-second live updates.

## Install (development)

1. Clone or download this folder.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
3. Open `https://www.zomato.com/partners/onlineordering/orders/`. The panel appears top-right; press `×` to hide and the vertical "Order Helper" tab on the right edge to bring it back.

## Privacy

No data ever leaves your browser. See [PRIVACY.md](./PRIVACY.md) for the full policy.

## File layout

```
manifest.json    Chrome MV3 manifest
background.js    minimal service worker (placeholder)
content.js       panel rendering + REST polling + state management
inject.js        main-world script: store bridge + fetch/XHR interceptor
panel.css        styling
icons/           16/48/128 PNGs
```
