# Card Flip HQ

Card Flip HQ is a standalone, browser-based dashboard for tracking a Pokémon trading card resale business. It runs entirely in the browser: no login, server, payment credentials, or external pricing integration is required.

## Launch

Open `index.html` in a current desktop or mobile browser. For the most reliable local development experience, serve this folder with any static-file server (for example, VS Code Live Server), then open the displayed local URL. No package install or build step is needed.

All app files are self-contained:

- `index.html` — page structure and forms
- `styles.css` — responsive dashboard styling
- `app.js` — navigation, UI, validation, data operations, and exports
- `storage.js` — versioned localStorage persistence and backup import/export
- `calculations.js` — cents-based financial calculations and dashboard metrics

## What it does

- Dashboard for cash, inventory cost, sales, operating expenses, realized profit, recent activity, and monthly results.
- Deal calculator with editable estimated marketplace assumptions and BUY / NEGOTIATE / PASS guidance.
- Inventory records for individual cards and lots, including sale, return, write-off, filtering, sorting, and search.
- Deal watchlist for prospective purchases; it does not scrape or claim live marketplace availability.
- Sales and expense ledger for purchases, sales, fees, refunds, travel, supplies, owner contributions, and withdrawals.
- Growth metrics including inventory cash tied up, sell-through, average profit, holding time, and monthly actual performance.
- JSON backups with validation, merge/replace choices, duplicate detection, and CSV exports for inventory and transactions.

## eBay integration (optional)

Everything above still works by simply opening `index.html`. The eBay features additionally need the small local server (Node 20.12+, no npm packages):

```
copy .env.example .env      # then fill it in
npm start                   # open http://localhost:3000
npm test                    # unit tests against a mock eBay (NOT the real eBay Sandbox)
```

New files: `server/` (OAuth, encrypted token storage, eBay Sell Inventory/Account/Fulfillment/Media/Taxonomy calls, photo storage, listing builder, duplicate ledger), `ebay-ui.js`, `ebay.css`, `test/`. `app.js` and `index.html` only received small hook calls.

Setup:
1. Create a keyset at developer.ebay.com (start with Sandbox) and a RuName whose accept URL is `http://localhost:3000/api/ebay/callback` (use an https tunnel URL if eBay rejects http).
2. In `.env` set `EBAY_ENV`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, `TOKEN_ENCRYPTION_KEY` (generate with the command in `.env.example`).
3. Settings > eBay Integration > Connect eBay Account. You log in on eBay's own page; Aura Exchange never sees your password.
4. In eBay Seller Hub opt in to Business Policies and create shipping, payment and return policies; then press "Load my eBay setup", pick them, create an inventory location if none exists, and save.
5. For real listings: use production keys, set `EBAY_ENV=production`, restart, and reconnect.

How listing works: Add to eBay > add front/back photos of the actual card > review preview and profit > "Create eBay draft offer" (an UNPUBLISHED offer; eBay does not show these as Seller Hub drafts) > tick the approval box > Publish. A listing is shown as "Active on eBay" only after eBay confirms it. Photos are stored in `server-data/photos/` (not in JSON backups; back that folder up too). Status sync is manual ("Sync status"); a sold listing never changes your inventory automatically, use "Record sale...".

## Accounting model

Amounts are stored as integer USD cents where practical and displayed as USD. The app deliberately distinguishes cash flow, inventory assets, and profit.

| Event | Cash | Inventory at cost | Realized profit |
| --- | --- | --- | --- |
| Inventory purchase | decreases by amount paid | increases by recorded/allocated cost | unchanged |
| Sale | increases by sale receipt less settled selling costs | decreases by cost of goods sold | revenue − COGS − actual selling expenses |
| Unsold inventory | no profit effect | remains an asset at recorded cost | unchanged |
| Owner contribution | increases | unchanged | unchanged |
| Owner withdrawal | decreases | unchanged | unchanged |
| Refund / returned sale | records actual cash/fee effect | restored only when goods are returned and available | reconciled from the transaction details |

Acquisition cost is never treated as an operating expense at purchase *and* deducted again at sale. A mixed lot can remain one record or be allocated across component records. Allocated costs must reconcile to the original lot cost, so a lot and its components are not counted twice.

### Deal-calculator definitions

`Maximum offer = estimated gross sales − estimated selling fees − shipping/other selling costs − purchase costs other than offer − contingency reserve − target profit`

The calculator prevents a fixed fee from also being charged as a percentage for the same fee category. Platform defaults are editable estimates, not authoritative or current marketplace fee schedules. Recommendations are only as reliable as the user-entered estimates, condition assessment, and risk reserve.

ROI is calculated consistently from the applicable invested/acquisition cost and disclosed in the interface. Estimated values, target prices, and unsold inventory values are not labeled as realized profit.

## Data, privacy, and backups

Data is stored only in this browser's `localStorage` under the isolated `cardFlipHQ.v1` namespace. It is browser- and device-specific; it does not synchronize automatically, and clearing browser site data can remove it. Export JSON backups regularly and keep them somewhere safe.

The app does not request or store bank credentials, passwords, or payment-card numbers. Listing URLs and notes are treated as plain text and are not rendered as executable HTML.

Before destructive actions, the app asks for confirmation. Import validation completes before saved data is changed. Choose **merge** to keep existing records (duplicates are detected) or **replace** only when the incoming backup should become the full dataset. If validation fails, the existing dataset remains unchanged.

## Testing guide

Use a fresh browser profile or **Settings & Backups → Clear data** (after exporting a backup) for these checks.

1. Set starting capital to **$400.00**.
2. Add an inventory purchase costing **$100.00**. Confirm available cash is **$300.00**, inventory at cost is **$100.00**, and realized profit is **$0.00**.
3. Record the full item as sold for **$160.00**, with **$20.00** platform fees and **$5.00** shipping/packaging. Confirm:
   - sales revenue is $160.00;
   - inventory cost falls to $0.00;
   - realized profit is **$35.00** (`160 − 20 − 5 − 100`);
   - ending cash is **$435.00** (`400 − 100 + 160 − 20 − 5`).
4. Add an owner contribution and verify cash/contributed capital changes without increasing sales or profit. Add an owner withdrawal and verify it is not an operating expense.
5. Test an invalid amount, invalid date, or required blank field; verify a helpful validation message appears and no partial record is created.
6. Save a calculator result to the watchlist, edit it, sort it, and verify status changes persist after refresh.
7. Test a return/refund: confirm revenue and cash adjust, and inventory is restored only when the item is actually returned for resale.
8. Export inventory and transactions as CSV and open each file in a spreadsheet; verify headers, amounts, and quoted text are usable.
9. Export a JSON backup, refresh the page, then import the backup. Confirm records, settings, and totals match. Try malformed JSON and an unsupported schema version; confirm import is rejected without overwriting existing records.
10. Check desktop and narrow mobile layouts, keyboard navigation, all navigation tabs, form submission, sorting/search/filtering, editing, and deletion confirmations.

## Limitations

Card Flip HQ does not determine card authenticity, condition, tax obligations, live market prices, or current marketplace fees. It is a bookkeeping and decision-support tool, not legal, tax, investment, or appraisal advice. Review estimates and exported backups regularly.
