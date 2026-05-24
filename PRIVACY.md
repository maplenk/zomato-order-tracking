# Privacy Policy — Zomato Partner Order Helper

_Last updated: 2026-05-24_

## What this extension does

The extension reads order data **only from the Zomato Partner dashboard pages you visit** (`https://www.zomato.com/partners/*`) and shows it back to you in a side panel. It does this by:

1. Observing network responses the Zomato dashboard already fetches in your browser.
2. Reading the same Redux store the Zomato dashboard's own UI reads from.
3. Calling the Zomato endpoint `/merchant-api/orders/order-details` to populate order details, using your existing logged-in session.

## What data is accessed

Active and recently viewed order data, including customer name, address, contact information, items, payment status, OTP, and rider details. This is the same data already displayed on the Zomato Partner dashboard.

## What we do with the data

**Nothing leaves your browser.** The extension:

- Does not send any data to the extension author or any third party.
- Does not contain any analytics, tracking, telemetry, or error-reporting service.
- Does not use any remote code or external scripts.
- Stores only two small preferences locally: your mute setting (`localStorage`) and a list of order IDs whose rider assignment you've already been notified about (`sessionStorage`).

All order data lives only in your tab's memory and is discarded when the tab closes.

## Permissions

- `host_permissions: https://www.zomato.com/partners/*` — scoped strictly to the partner dashboard. The extension does not run on any other Zomato page.

## Contact

If you have any questions about this policy, please open an issue on the project repository or contact the extension author through the Chrome Web Store listing.
