# ToolBill

Billing & inventory for an auto tools shop. Installable PWA that runs on laptop and tablet — fully offline after first install.

Repo: <https://github.com/kiran-1505/billingsoftware>

## What it does

- Product master with auto-generated codes like `HT-0042`, `PT-0013`
- QR + Code-128 labels on every product. QR content is a human-readable, single-line string: `HT-0001|Hydraulic Jack 2 Ton|₹1800` — phone scanners show all three fields in plain text
- Printable & PDF-downloadable labels (single or bulk, A4 sheet of 30)
- Billing screen: scan QR / type short code / typed quantity (e.g. `5*HT-0042`) / fuzzy name search
- Live-editable quantity **and** price in the cart (price input fits up to 7 digits). Editing price on the cart affects **this bill only** — the master price in Products is unchanged
- Product code hidden from the Current Bill view (internal reference only, not shown to customers)
- **Total in words** printed on every bill — e.g. *Two Thousand Five Hundred Rupees Only*
- Toast on every scan shows the name + price the cashier is about to charge
- No GST on the bill (handle GST separately)
- "Amount paid (after bargain)" field on the bill panel — recorded on the bill; no on-screen diff
- Inventory: stock levels, low-stock highlight, GRN (receive stock), manual adjustments, movements log
- Reports: today / month / all-time sales, date-range filter, CSV export, top-selling items, reprint any old bill
- Backup / restore: export & import all data as a single JSON file
- Works offline — all data stored locally in the browser's IndexedDB

## Install on shop laptop + tablet

The recommended path is: deploy once to Netlify (free), then "Install app" on each device. After that the app opens from the Start Menu / home screen with one click and works offline.

### Step 1 — Deploy once

1. Push the repo to GitHub. Connect the repo to Netlify — it auto-deploys on every push.
2. You get a URL like `https://random-name-123.netlify.app`. That's your app.
3. Optional: Site settings → rename to something like `toolbill-yourshop.netlify.app`.

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

Then open <http://localhost:8080/> in Chrome and Install from the address bar. This works only on that laptop — the tablet can't reach `localhost`.

## Updating the app after code changes

Every time you push new code to GitHub, Netlify redeploys automatically. To get the update on installed devices:

1. **Bump the version** in `sw.js` before pushing — change `toolbill-v6` to `toolbill-v7` (or any higher number). This is the only manual step required per deploy.
2. Push to GitHub → Netlify redeploys.
3. On any device running the installed PWA, a blue **"🎉 New version available — Update now"** banner will appear in the bottom-right corner.
4. Click **Update now** — the app reloads instantly with the latest version.

> **Why bump the version?** The service worker caches all files under a version key. Changing the version tells every installed PWA that a new cache exists, triggering the update banner automatically.

## Important caveats

- **Data is per-device, not synced.** The laptop and tablet each keep their own separate database. Pick one device as "the truth" (usually the billing counter laptop) and only bill from there.
- **Back up weekly.** Settings → *Export backup* → save the JSON to a pen-drive or email it. If the browser data gets cleared (Windows update, disk repair, factory reset), everything is gone without a backup.

## Daily use

1. **Products** tab → *+ Add Product* (or *Bulk Add* and paste from Excel). Codes are auto-generated per category. **Manage Categories** button opens the category manager where you can add, rename, or delete (trash icon) categories.
2. **Labels** tab → filter / search / select products → *Print selected* or *Download PDF* (A4, 30 labels per page).
3. **Billing / Sell** tab is the main screen:
   - Click the **ToolBill** logo at any time to return to the Sell tab (acts as home button). Also press `F2` anywhere.
   - Search bar is auto-focused on the Sell tab.
   - **Barcode scanner:** plug in any USB HID scanner — it works automatically anywhere on the page without needing to click the search box first. The app detects the scanner's fast keystroke pattern, switches to Sell, and adds the item instantly.
   - Scan QR or Code-128 → item added, toast shows name + price.
   - Type the short code (`HT-0042`) and hit Enter.
   - Type `5*HT-0042` to add 5 at once.
   - Type a name fragment → pick from dropdown (↑/↓/Enter).
   - Click qty or price in the cart to edit inline (price supports up to 7 digits for high-value items).
   - Remove a cart item using the 🗑 trash icon on the right.
   - Fill in customer name / amount paid / notes (all optional).
   - Press `F9` (or *Save & Print*). Stock auto-deducts, bill prints with total amount in words.
4. **Inventory** tab: see stock levels, receive new stock (GRN), adjust.
5. **Reports** tab: sales totals, bill list, reprint, CSV export, top items. Use date range filters — year field accepts 4 digits only.

## Hardware

- **Barcode scanner**: any USB HID scanner (₹1,500–3,000) — acts as a keyboard, no drivers needed, works automatically. 1D laser scanners read Code-128; 2D imagers also read QR. A 2D imager is better because the QR carries code + name + price for visual verification.
- **Receipt printer**: any 80mm thermal printer installed as a Windows/macOS printer. When you press Save & Print, the browser print dialog appears — pick your thermal printer, set paper size to 80mm once, save.
- **Label printer**: A4 sticker sheets (30 labels per page) via any inkjet/laser printer using the PDF. Or use a dedicated Zebra-style label printer.

## File layout

```
toolbill/
├── index.html               App shell (all tabs + modals)
├── styles.css               Custom styles (modern UI, print CSS, label layout)
├── app.js                   Main app logic (billing, products, labels, inventory, reports)
├── db.js                    IndexedDB wrapper
├── sw.js                    Service worker (offline cache + auto-update)
├── manifest.webmanifest     PWA manifest
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── .gitignore
└── README.md                This file
```

## Troubleshooting

- **"Install" button doesn't appear**: You must serve over `http://localhost` or `https://`. Opening `index.html` directly via `file://` won't let the PWA install. Use the Netlify deploy or the local-server path above.
- **Update banner not appearing after redeploy**: Make sure you bumped the `VERSION` in `sw.js` before pushing. If needed: open the app in a browser tab → DevTools → Application → Service Workers → *Unregister* → reload.
- **Scanner not adding items**: The app detects USB/Bluetooth HID scanners globally — no need to focus the search box. If a scan isn't registering, check that you are not actively typing in another input field at that moment.
- **QR won't scan**: The QR is 2D. A 1D-only laser scanner can't read it — use the Code-128 barcode on the label instead, or switch to a 2D imager.
- **Price changed — do I reprint labels?** Only if you want the label's printed QR to show the new price to anyone phone-scanning it. For billing inside the app, no reprint needed — the app always pulls the current price from the database.
- **GPG sign error on first commit**: run `git config commit.gpgsign false` inside the repo.

## Roadmap

- Multi-device sync (Firestore or similar) — so laptop + tablet share one database
- Payment tracking (cash / UPI / card split)
- Customer ledger / credit
- GST tax-invoice PDF
- PIN lock / auth for cashier vs. owner roles
- Camera-based QR scanning (phone/webcam without a hardware scanner)
