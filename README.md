# ToolBill

Billing & inventory for an auto tools shop. Runs as an installable app (PWA) on laptop and tablet. Works fully offline after first install.

## What it does

- Product master with auto-generated codes `HT-0042` etc.
- QR + Code-128 labels (QR encodes `{code, name, price}` as JSON — scans self-contained)
- Printable & PDF-downloadable labels (single or bulk, A4 sheet of 30)
- Billing screen: scan QR / type code / search → cart → print 80mm receipt
- No GST on bill (handled elsewhere per your note)
- Amount-paid field recorded silently on each bill (no change display)
- Inventory: stock levels, low-stock highlight, GRN (receive), adjustments, movements log
- Reports: today / month / all-time sales, filter by date, CSV export, top-selling items, reprint any old bill
- Backup / restore: export & import all data as a single JSON file
- Works offline — data stored locally in the browser's IndexedDB

## One-time setup on the shop laptop

The app is just static files. You need to "serve" them once so the browser can install the PWA. Two ways:

### Option A — Run locally (recommended, zero-cost, zero-cloud)

1. Install any static-file server. Easiest: open Command Prompt / Terminal in this `toolbill/` folder and run one of:
   - If Python is installed:
     ```
     python -m http.server 8080
     ```
   - If Node is installed:
     ```
     npx serve -p 8080
     ```
2. Open **Chrome or Edge** and go to <http://localhost:8080/>.
3. In the address bar, click the **install icon** (a little computer-with-arrow icon on the right side) → *Install ToolBill*.
4. ToolBill now appears as its own app with its own icon. Close the browser — you can launch it from the Start Menu / Dock from now on.
5. The service worker caches everything on first load. You can even stop the local server afterwards — the installed app keeps working offline.

> Tip: If you want the app to auto-start the server on boot, create a `.bat` file on Windows with the `python -m http.server 8080` line and put a shortcut in `shell:startup`.

### Option B — Deploy once to the internet (so tablet and laptop share it)

1. Make a free account at <https://vercel.com> or <https://app.netlify.com/drop>.
2. Drag-and-drop this entire `toolbill/` folder onto Netlify Drop, or use `vercel --prod` from the CLI.
3. You'll get a URL like `https://toolbill-xyz.vercel.app`.
4. Open that URL on the **laptop** — click Install from the address bar.
5. Open the same URL on the **tablet** — in Chrome (Android) or Safari (iPad), use *Add to Home Screen* / *Install app*.
6. Once installed on each device, both work offline independently. (They do **not** sync automatically in v1 — each device has its own data.)

## Install on tablet

Android (Chrome/Edge): open the URL → menu → *Install app* or *Add to Home screen*.
iPad (Safari): open the URL → Share button → *Add to Home Screen*.

## Daily use

1. **Products** tab → *+ Add Product* (or *Bulk Add* and paste from Excel). Codes are auto-generated per category.
2. **Labels** tab → filter / select products → *Print selected* or *Download PDF* (A4, 30 labels per page).
3. Billing tab is the main screen:
   - Focus the search bar (it's auto-focused; press `F2` anywhere).
   - **Scan QR** with a 2D scanner → item added.
   - Or type the short code (`HT-0042`) and hit Enter.
   - Or type `5*HT-0042` to add 5 at once.
   - Or type a name substring to pick from dropdown (↑/↓/Enter).
   - Fill in customer name / amount paid / notes (all optional).
   - Press `F9` (or click *Save & Print*). Stock auto-deducts, bill prints.
4. **Inventory** tab: see stock, receive new stock (GRN), adjust.
5. **Reports** tab: sales totals, bill list, reprint, CSV export.

## Hardware notes

- **Barcode scanner**: any USB HID scanner (₹1,500–3,000) works as a keyboard. 1D scanners read Code-128; 2D scanners also read QR. Since QR carries the full JSON, a 2D scanner is the better choice — it also works if price/name drift from the DB.
- **Receipt printer**: any 80mm thermal printer installed in Windows as a printer works. When you press Save & Print, the browser print dialog appears — choose your thermal printer (set paper size to 80mm once and save).
- **Label printer**: same idea — A4 sticker sheets (30 per page) work through any inkjet/laser printer via the PDF. Or use a dedicated label printer.

## Backup (important)

All data lives on this device. If the browser data gets cleared or the laptop dies, data is gone. **Export a backup every week** from Settings → Export backup. Keep the `.json` on a pen-drive, email, or cloud drive. Restore with Import backup.

## File layout

```
toolbill/
├── index.html               App shell (all tabs + modals)
├── styles.css               Custom styles (print CSS, label layout)
├── app.js                   Main app logic
├── db.js                    IndexedDB wrapper
├── sw.js                    Service worker (offline cache)
├── manifest.webmanifest     PWA manifest
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md                This file
```

## Troubleshooting

- **"Install" button doesn't appear**: You must serve over `http://localhost` or `https://`. Opening `index.html` directly via `file://` won't let the PWA install. Use the local-server step above.
- **Service worker doesn't update**: Close and reopen the installed app. Or bump `VERSION` in `sw.js` and reload once online.
- **Scanner adds a newline but not the item**: Most scanners send `Enter` after scanning — that's correct. Make sure the search bar is focused. If it isn't, press `F2`.
- **QR won't scan**: The QR encodes JSON. Any 2D scanner or phone camera reads it. 1D-only laser scanners can't — use the Code-128 barcode on the label instead.
- **Price changed — do I reprint labels?**: Yes, because the QR contains the price (your choice). Short codes and Code-128 stay the same; only the QR needs refreshing if the price on it becomes stale.

## Roadmap (not in v1)

- Multi-device sync (Firestore or similar)
- Payment tracking (cash / UPI / card split)
- Customer ledger / credit
- GST tax-invoice PDF (you said you'll handle separately)
- Auth / PIN lock
