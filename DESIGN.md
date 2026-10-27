# LinkBoard design system

Flat, minimal, macOS-style. Data first: dense tables, calm surfaces, one accent. (Standing rule: no glow, no decorative shadows.)
This file documents the tokens the app already uses in `app.html` and the target state for the cleanup. Source of truth for values: `:root` (dark) and `body.light` (light) in `app.html`.

## Principles
1. **Data over chrome.** Tables, numbers and statuses carry the page; surfaces stay quiet.
2. **Flat.** Separation comes from 1px borders and tone steps (`--bg` → `--bg4`), not glow, gradients or big shadows. Floating layers (menus, modals, toasts) may use one soft shadow.
3. **One accent.** `--accent2` (blue) = actions. Green = live/success, amber = pending, red = needs attention. Colour only ever means status or action.
4. **Legible.** Minimum text size 11px (labels), 12–13px for table cells, 14px body. No 9–10px.
5. **Responsive.** Works from 375px up: sidebar collapses, tables scroll inside their card, fixed bars never use hard-coded left offsets.
6. **Reduced motion respected.** Motion only on `transform`/`opacity`, 120–250ms, nothing blocks input.

## Tokens (existing)
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #08090a | #fbfbfd | page |
| `--bg2` | #0d0e11 | #ffffff | cards, sidebar |
| `--bg3` | #141517 | #f5f5f7 | rows hover, inputs |
| `--bg4` | #1a1b1e | #ececee | pressed / chips |
| `--border` / `--border2` | white 8% / 12% | #e5e5ea / #d2d2d7 | 1px lines |
| `--text` / `--text2` / `--text3` | #f7f8f8 / #8a8f98 / white 40% | #1d1d1f / #6e6e73 / #86868b | primary / secondary / hint |
| `--accent2` | #0a84ff | #0071e3 | primary action, active nav |
| `--teal` | #32d74b | #248a3d | live, success |
| `--yellow` | #f2b73e | #b25000 | pending |
| `--red` | #f4795b | #d70015 | error, needs change |
| `--radius` / `--radius-lg` | 12px / 18px | same | cards / large panels |

Type: system stack (`-apple-system, SF Pro, Inter`), mono for domains/URLs (`--font-mono`). Scale: 11 label · 12 table · 13 control · 14 body · 18 section · 24 page title · 32 big number. Tracking −0.011em body, tighter on large numbers.
Radii in use: 6 (chips) · 8 (controls) · 10–12 (cards) · 980 (pills). Keep to this set.

## Components
- **Table:** sticky header (uppercase 11px, `--text3`), 44–48px rows, hover `--bg3`, status as `.badge` pill, numbers right-aligned tabular.
- **Badge / pill:** dot + label, tinted background at 12–14% of the status colour, no border.
- **Card:** `--bg2`, 1px `--border`, radius 12, padding 16–20, no shadow.
- **Button:** primary = solid `--accent2`, radius 980, no hover glow (darken 6% instead); secondary = transparent + 1px border; destructive = red text + red border.
- **Input / select:** `--bg3`, 1px border, radius 8, focus = 2px `--accent2` ring at 40%.
- **Modal / menu / toast:** the only elevated surfaces; one shadow `0 8px 24px rgba(0,0,0,.25)`; entry fade + 4px translate, 160ms.
- **Banner (approval, duplicates, credits):** its own row above the content, never inside the page header.

## Cleanup backlog (from the 2026-10-27 audit)
Done: dashboard "Open pending" label, approval banner on its own row, all text ≥ 11px, AI-credit toast.
Open:
1. Remove ambient glow: `body::before` washes and the two `.content` radial gradients (dark + light); remove blue hover glow on `.btn-sm`, `box-shadow` glows on splash bar.
2. Remove duplicate CSS: `.sidebar` (defined twice), `.compat-tooltip` (three times), `.page-top` (twice) — keep the last, delete the rest, then re-check.
3. Responsive: more than two breakpoints (≤1300, ≤860 today); make `batch-bar` offsets follow the sidebar width; collapse the sidebar under 860px; make wide tables scroll inside the card.
4. Replace hard-coded greys/hex inside inline styles with tokens.
5. Empty DR/Traffic show "—" on freshly imported links; add an "Enrich" action next to Import.
6. Consistent loading + empty states per page (several show a bare "Loading").
