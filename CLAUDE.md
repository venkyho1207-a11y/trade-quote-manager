# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is a Vue 3 + TypeScript + Vite frontend with a Node.js + Express + SQLite backend for Chinese-language foreign-trade operations. The main business modules are implemented: products, suppliers, customers, quotations, and template-driven document generation. Authentication is a single-account login (scrypt password hash + httpOnly session cookie); there are no roles or multi-user permissions yet.

## Common commands

- `npm install` — install frontend and backend dependencies. Native `better-sqlite3` may require the local Node toolchain during installation.
- `npm run dev` — start the Vite client and Express API concurrently. Client: port 5173; API: port 3000.
- `npm run dev:client` — start only Vite. Requests under `/api` proxy to port 3000.
- `npm run dev:server` — start only the API server; SQLite is created at `data/trade-quote.sqlite`.
- `npm run build` — run `vue-tsc` and create the production frontend build in `dist/`.
- `npm start` — start the Express API without Vite.
- `npm run preview` — serve the production frontend build.
- `node --check server/db.cjs && node --check server/index.cjs` — check backend JavaScript syntax.

There is currently no test runner or lint script configured.

## Architecture

- `src/main.ts` creates the Vue application, registers Element Plus and its icons, and loads global styles.
- `src/App.vue` owns the application shell and switches between module pages. Add new top-level modules to `moduleItems` and the conditional page rendering there.
- `src/views/` contains feature pages: `ProductLibrary.vue`, `SupplierLibrary.vue`, `CustomerLibrary.vue`, `QuoteManagement.vue`, `DocumentCenter.vue`, `MyCompany.vue` (seller profile + bank info), `DocumentTemplates.vue` (upload .xlsx + bind fields to cells), and `DocumentGenerate.vue` (fill per-quote extras and export).
- `src/services/api.ts` is the only frontend REST boundary. Keep fetch/error handling there rather than duplicating request code in views.
- `src/types/domain.ts` is the shared frontend domain contract. `src/utils/quoteCalculator.ts` contains the client-side live calculation used while editing a quote.
- `server/db.cjs` creates the SQLite schema through Node 26's built-in `node:sqlite`, enables foreign keys/WAL, seeds a blank database, and performs lightweight quote-item column upgrades for databases created by earlier versions. It exposes a thin adapter that keeps the better-sqlite3-style `prepare().get/all/run` and `transaction()` API used throughout `server/index.cjs`.
- `server/auth.cjs` implements single-account authentication: scrypt+per-user-salt password hashing, random session tokens stored only as SHA-256 hashes, httpOnly `SameSite=Lax` cookies, and per-IP login throttling. `ensureInitialUser()` in `server/index.cjs` creates the first admin from `ADMIN_USER`/`ADMIN_PASSWORD` or a random printed password.
- `server/index.cjs` exposes REST endpoints, validates request bodies with Zod, enforces the session cookie on every `/api` route except `/api/health` and `/api/auth/*` (and on `/uploads`), serves `uploads/`, processes product images with Multer, generates XLSX documents with ExcelJS, and persists all business records through parameterized `node:sqlite` statements. With `SERVE_STATIC=1` it also serves the built `dist/` for single-port production deployment.
- `specs/full_trade_management_design.md` records the frontend/backend/security design and business invariants.
- `src/styles/global.css` contains the application layout and A4 document/print styles.

## Data flow

The frontend loads products, suppliers, customers, and quotes through `src/services/api.ts`. CRUD operations are persisted by the Express API in SQLite. Product images are uploaded to `uploads/` and the returned URL is stored with the product. The quotation editor recalculates recommended EXW/FOB/CIF prices reactively, while the API recalculates and persists the authoritative quote values on save. The last quote line receives the cent-level remainder so item totals equal the quote total.

## Quote invariants

- EXW = cost + packaging fee + domestic freight + profit.
- FOB = cost + packaging fee + domestic freight + customs fee + bank fee + profit.
- CIF = cost + packaging fee + domestic freight + customs fee + bank fee + ocean freight + insurance fee + profit.
- Domestic freight, customs fee, bank fee, ocean freight, and insurance fee are quote-level public costs divided by total product quantity.
- Packaging fee and profit are per-item editable values.
- A salesperson's custom price for the selected trade term overrides the recommended price; all other prices remain calculated.
- Amounts are rounded to cents and the final line receives any remainder. Do not change these formulas or silently introduce a different interpretation for bulk/container mode without asking the user.
- `散货` and `整柜` are persisted and shown in documents. The requested business rules do not define different arithmetic for them, so both use the same quantity allocation logic.

## Security and boundary rules

- Validate external input in `server/index.js` with Zod before database access. Keep IDs and enum values constrained.
- Use parameterized SQLite statements; do not concatenate request values into SQL.
- Product uploads are restricted to JPG/PNG/WebP and 5MB, with generated filenames.
- Helmet, CORS, and the current JSON body limit are configured in the API entrypoint. `CORS_ORIGIN` must be set explicitly for cross-origin deployments; it defaults to same-origin-only because cookie auth forbids wildcard origins.
- Every `/api` route except `/api/health` and `/api/auth/*` requires a valid session; `/uploads` requires one too. `COOKIE_SECURE=1` marks the session cookie `Secure` (required when serving over HTTPS, e.g. behind Cloudflare Tunnel).
- Authentication is single-account with no roles. Do not represent it as multi-user or per-user authorization until a role layer exists at the API boundary.
- User-facing write operations should remain confirmable in the UI; server-side deletes enforce foreign-key business constraints.
