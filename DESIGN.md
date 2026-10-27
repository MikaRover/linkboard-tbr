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
7. **Frequency decides motion.** Page switches and nav (dozens a day, also from the keyboard) get a 120ms opacity settle only; menus/modals/toasts get 150–240ms ease-out; exits are faster than entries. Buttons press to `scale(.97)`.
8. **No glass, no emoji icons.** Every panel is opaque (`backdrop-filter` is disabled globally); labels carry words, not emoji.

## Design system v2 layer
The last block in `app.html`'s `<style>` ("Design system v2") is the source of truth when older rules above it disagree. Add new component rules there, not to the older stacked sections.

## Tokens (existing)
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #08090a | #fbfbfd | page |
| `--bg2` | #0d0e11 | #ffffff | cards, sidebar |
| `--bg3` | #141517 | #f5f5f7 | rows hover, inputs |
| `--bg4` | #1a1b1e | #ececee | pressed / chips |
| `--border` / `--border2` | white 8% / 12% | #e5e5ea / #d2d2d7 | 1px lines |
| `--text` / `--text2` / `--text3` | #f7f8f8 / #8a8f98 / white 50% | #1d1d1f / #6e6e73 / #737378 | primary / secondary / hint |
| `--accent2` | #0a84ff | #0071e3 | primary action, active nav |
| `--teal` | #32d74b | #248a3d | live, success |
| `--yellow` | #f2b73e | #b25000 | pending |
| `--red` | #f4795b | #d70015 | error, needs change |
| `--radius` / `--radius-lg` | 12px / 18px | same | cards / large panels |
| `--radius-sm` / `--radius-ctl` | 6px / 8px | same | chips / controls, nav pill |
| `--ease-out` / `--ease-in-out` | `cubic-bezier(.23,1,.32,1)` / `(.77,0,.175,1)` | same | enter / on-screen movement |
| `--dur-1` / `--dur-2` / `--dur-3` | 120 / 180 / 240ms | same | press, hover / menus / modals |
| `--space-1…8` | 4 · 8 · 12 · 16 · 20 · 24 · 32px | same | spacing scale |
| `--elev` | `0 8px 24px` black 32% | black 10% | the only shadow: menus, modals, toasts, batch bars |
| `--nav-active` | white 8% | black 6% | neutral selected-nav pill |

Type: system stack (`-apple-system, SF Pro, Inter`), mono for domains/URLs (`--font-mono`). Scale: 11 label · 12 table · 13 control · 14 body · 18 section · 24 page title · 32 big number. Tracking −0.011em body, tighter on large numbers.
Radii in use: 6 (chips) · 8 (controls) · 10–12 (cards) · 980 (pills). Keep to this set.

## Components
- **Table:** header 12px sentence case `--text2`, no band; 44–48px rows, hover `--bg3`, status as `.badge` pill, numbers right-aligned tabular.
- **Nav:** neutral `--nav-active` pill, text goes to ink, only the icon takes the accent. Items are keyboard-reachable (tabindex + Enter/Space).
- **Labels:** sentence case everywhere (stat labels, section labels, nav groups). No tracked uppercase.
- **Badge / pill:** dot + label, tinted background at 12–14% of the status colour, no border.
- **Card:** `--bg2`, 1px `--border`, radius 12, padding 16–20, no shadow.
- **Button:** primary = solid `--accent2`, radius 980, no hover glow (darken 6% instead); secondary = transparent + 1px border; destructive = red text + red border.
- **Input / select:** `--bg3`, 1px border, radius 8, focus = 2px `--accent2` ring at 40%.
- **Modal / menu / toast:** the only elevated surfaces; opaque `--bg2`, one shadow `--elev`. Menus scale .96→1 from their trigger corner; modals scale from centre (240ms in, 140ms out); toast = opaque card with a status dot, holds on hover.
- **Banner (approval, duplicates, credits):** its own row above the content, never inside the page header.

## Cleanup backlog (from the 2026-10-27 audit)
Done: dashboard "Open pending" label, approval banner on its own row, all text ≥ 11px, AI-credit toast.
Done 2026-10-27 (v2 pass): ambient glows and gradients removed, glass removed, batch-bar offsets follow the sidebar and go edge-to-edge under 860px, header actions wrap on phones, status hex in inline styles → tokens, emoji stripped from labels/toasts, splash shortened (~1.1s).
Open:
1. Remove duplicate CSS: `.sidebar` (defined twice), `.compat-tooltip` (three times), `.page-top` (twice) — keep the last, delete the rest, then re-check.
2. Remaining hard-coded greys/rgba inside inline styles → tokens.
3. Data-encoded emoji (link-check values `✅/❌/⚠️` stored in Firestore) still parsed by `includes()`; migrate to a status field before removing.
4. Nav and other `<div onclick>` (70) should become real `<button>`s.
5. Empty DR/Traffic show "—" on freshly imported links; add an "Enrich" action next to Import.
6. Consistent loading + empty states per page (several show a bare "Loading").
