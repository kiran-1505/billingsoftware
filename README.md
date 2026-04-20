# ToolBill

Billing & inventory for an auto tools shop. Installable PWA that runs on laptop and tablet — fully offline after first install.

Repo: <https://github.com/kiran-1505/billingsoftware>

## What it does

- Product master with auto-generated codes like `HT-0042`, `PT-0013`
- QR + Code-128 labels on every product. QR content is a human-readable, single-line string: `HT-0001|Hydraulic Jack 2 Ton|₹1800` — phone scanners show all three fields in plain text
- Printable & PDF-downloadable labels (single or bulk, A4 sheet of 30)
- Billing screen: scan QR / type short code / typed quantity (e.g. `5*HT-0042`) / fuzzy name search
- Live-editable quantity **and** price in the cart for bargaining. Editing price on the cart affects **this bill only** — the master price in Products is unchanged
- Toast on every scan shows the name + price the cashier is about to charge
- No GST on the bill (you said you'll handle GST separately)
- "Amount paid (after bargain)" field on the bill panel — recorded silently on the bill record; no on-screen diff
- Inventory: stock levels, low-stock highlight, GRN (receive stock), manual adjustments, movements log
- Reports: today / month / all-time sales, date-range filter, CSV export, top-selling items, reprint any old bill
- Backup / restore: export & import all data as a single JSON file
- Works offline — all data stored locally in the browser's IndexedDB

## Install on shop laptop + tablet (one-click every day)

The recommended path is: deploy once to Netlify (free), then "Install app" on each device. After that the app opens from the Start Menu / home screen with one click and works offline.

### Step 1 — Deploy once

1. Go to <https://app.netlify.com/drop> (sign up free with Google/GitHub — 30 seconds).
2. Drag the `toolbill/` folder onto the drop zone.
3. You get a URL like `https://random-name-123.netlify.app`. That's your app.
4. Optional: Site settings → rename to something like `toolbill-yourshop.netlify.app`.

Redo this step only when you change the code.

### Step 2 — Install on the laptop

1. On the shop laptop, open **Chrome** or **Edge** and go to the Netlify URL.
2. Click the **install icon** in the address bar → *Install ToolBill* (or: menu ⋮ → *Install ToolBill...*).
3. Right-click it in the Start Menu / Dock → **Pin to taskbar / Keep in Dock**.
4. One-click launch forever after. First launch with internet caches everything for offline use.

### Step 3 — Install on the tablet

- **Android tablet (Chrome):** open the URL → menu ⋮ → *Install app* (or *Add to Home screen*).
- **iPad (Safari only — iOS ignores PWA install in Chrome):** open the URL → Share button → *Add to Home Screen*.

### Step 4 — Verify offline works

On each device, after install, toggle Wi-Fi off and reopen the app. It should work exactly the same. That's the sign the service worker cached everything.

### Alternative: local-only (no cloud)

You can also run it on the laptop alone without deploying. From Terminal:

```bash
cd ~/Documents/toolbill
python3 -m http.server 8080
```

Then open <http://localhost:8080/> in Chrome and Install from the address bar. This works only on that laptop — the tablet can't reach `localhost`. Add the server command to a startup `.command` / `.bat` if you go this route.

## Important caveats for your client

- **Data is per-device, not synced.** The laptop and tablet each keep their own separate database. Pick one device as "the truth" (usually the billing counter laptop) and only bill from there.
- **Back up weekly.** Settings → *Export backup* → save the JSON to a pen-drive or email it. If the browser data gets cleared (Windows update, disk repair, factory reset), everything is gone without a backup.
- **Updating the app:** redeploy the `toolbill/` folder to Netlify. The service worker auto-updates the installed apps on next launch (sometimes takes one reopen to take effect).

## Daily use

1. **Products** tab → *+ Add Product* (or *Bulk Add* and paste from Excel). Codes are auto-generated per category. Categories: `HT` Hand Tools, `PT` Power Tools, `FS` Fasteners, `LB` Lubricants, `CH` Chemicals, `AB` Abrasives, `EL` Electrical, `AS` Auto Spares, `GN` General.
2. **Labels** tab → filter / search / select products → *Print selected* or *Download PDF* (A4, 30 labels per page).
3. **Billing** tab is the main screen:
   - Search bar is auto-focused (press `F2` anywhere to jump back to it).
   - Scan QR or Code-128 → item added, toast shows name + price.
   - Type the short code (`HT-0042`) and hit Enter.
   - Type `5*HT-0042` to add 5 at once.
   - Type a name fragment → pick from dropdown (↑/↓/Enter).
   - Click the qty or price in the cart to edit either for bargaining.
   - Fill in customer name / amount paid / notes (all optional).
   - Press `F9` (or click *Save & Print*). Stock auto-deducts, bill prints.
4. **Inventory** tab: see stock levels, receive new stock (GRN), adjust.
5. **Reports** tab: sales totals, bill list, reprint, CSV export, top items.

## Hardware

- **Barcode scanner**: any USB HID scanner (₹1,500–3,000) — acts as a keyboard. 1D laser scanners read Code-128; 2D imagers also read QR. A 2D imager is better because the QR carries code + name + price, so it works for visual verification too.
- **Receipt printer**: any 80mm thermal printer installed as a Windows/macOS printer. When you press Save & Print, the browser print dialog appears — pick your thermal printer, set paper size to 80mm once, save.
- **Label printer**: A4 sticker sheets (30 labels per page) via any inkjet/laser printer using the PDF. Or use a dedicated Zebra-style label printer.

## File layout

```
toolbill/
├── index.html               App shell (all tabs + modals)
├── styles.css               Custom styles (print CSS, label layout)
├── app.js                   Main app logic (billing, products, labels, inventory, reports)
├── db.js                    IndexedDB wrapper
├── sw.js                    Service worker (offline cache)
├── manifest.webmanifest     PWA manifest
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── .gitignore
└── README.md                This file
```

## Troubleshooting

- **"Install" button doesn't appear**: You must serve over `http://localhost` or `https://`. Opening `index.html` directly via `file://` won't let the PWA install. Use the Netlify deploy or the local-server path above.
- **Service worker doesn't update after redeploy**: close and reopen the installed app. If needed: open the app in a browser tab → DevTools → Application → Service Workers → *Unregister* → reload.
- **Scanner adds a newline but not the item**: most scanners send `Enter` after scanning — that's correct. Make sure the billing search bar is focused. If it isn't, press `F2`.
- **QR won't scan**: the QR is 2D. A 1D-only laser scanner can't read it — use the Code-128 barcode on the label instead, or switch to a 2D imager.
- **Price changed — do I reprint labels?** Only if you want the label's printed QR to show the new price to anyone phone-scanning it. For billing inside the app, no reprint needed — the app always pulls the current price from the database; the QR's embedded price is ignored on scan.
- **GPG sign error on first commit**: run `git config commit.gpgsign false` inside the repo (or install `pinentry-mac` and configure `gpg-agent`).

## Roadmap (not in v1)

- Multi-device sync (Firestore or similar) — so laptop + tablet share one database
- Payment tracking (cash / UPI / card split)
- Customer ledger / credit
- GST tax-invoice PDF (you're handling separately)
- PIN lock / auth for cashier vs. owner roles
