# Repository Guidelines

## Project Structure & Module Organization
This Next.js app keeps routed pages in `pages/` (`index.js` for the landing view, `upload.js` for CSV ingestion and verification). Shared services sit under `lib/`, with `supabaseClient.js` centralizing Supabase access and env var checks. Static assets can live in `public/` (create if needed), and configuration like `next.config.js` stays at the repo root alongside `package.json`.

## Build, Test, and Development Commands
- `npm run dev` — launches the hot-reloading dev server at `http://localhost:3000`.
- `npm run build` — produces an optimized production build; run before deploys to catch type or bundling issues.
- `npm run start` — serves the last production build; use to mimic deployed behavior.

## Coding Style & Naming Conventions
JavaScript files follow ES modules with functional React components. Use 2-space indentation, camelCase for helpers (`normDigits`), and PascalCase for components (`UploadPage`). Keep data constants in `ALL_CAPS` and colocate helper functions near their usage. Prefer early returns over deeply nested branches, and add targeted inline comments (`// ---------- section ----------`) to flag logical phases. Run Prettier before committing; match the existing quoting (double quotes) shown in `pages/` and `lib/`.

## Testing Guidelines
There is no automated test harness yet; validate changes by exercising `npm run dev` and uploading representative CSVs covering UPC-only, ATF-only, and mixed rows. When adding logic, write lightweight utility tests with your preferred runner (Vitest or Jest) under a new `__tests__/` directory and wire the command into `package.json` as `npm test`. Aim for high-confidence coverage on data normalization and matching functions.

## Commit & Pull Request Guidelines
Commits in history are short and imperative (`Update upload.js`). Continue that pattern: scope-limited, present-tense summaries with optional file or feature tags (`Add supabase retry helper`). For PRs, include the problem statement, summary of changes, manual verification notes (screenshots for UI changes, CSV samples for parsing tweaks), and any Supabase schema updates. Link Supabase migrations or Notion tickets where relevant, and ensure reviewers know which env vars or seeds to refresh.

## Environment & Data Access
Populate `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in your `.env.local`; the client warns if they are missing. Avoid hardcoding secrets—use Supabase dashboard keys for local development only. Keep sample CSVs redacted of live customer data; store anonymized fixtures under `fixtures/` when needed.
