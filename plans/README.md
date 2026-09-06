# Animation audit — LinkBoard (app.html)

Audited with the `improve-animations` skill on 2026-09-06, commit `a9a5f6a`.
Scope: all inline CSS + the app's one large inline `<script>` in `app.html` —
transitions, loading states, hover/click feedback, page/tab switches, modal
open/close, toast notifications.

## Already right (no finding needed)

- **Global button/nav/card/stat hover+press feedback** (app.html:542-543,
  556-557, 573-574) — a deliberate, property-specific `!important` transition
  (`background .22s ease, border-color .22s ease, color .18s ease, box-shadow
  .25s ease, transform .18s cubic-bezier(.2,.8,.2,1)`) already covers most
  buttons/cards/nav items with reasonable durations and a real easing curve,
  plus subtle press-scale (0.97-0.98). This is the convention every plan below
  extends rather than replaces.
- **Page/tab navigation** (`gotoPage()`, `.page.active` toggle) — no animation,
  which is correct: this fires dozens/hundreds of times per session for an
  admin working all day, squarely in the "tens of times a day → remove or
  drastically reduce" frequency bucket. Do not add motion here.
- **Theme toggle knob** (app.html:228, `cubic-bezier(0.34,1.56,0.64,1)` overshoot)
  — a deliberate, rare (once-per-session), playful bounce on a physical
  toggle-knob metaphor. Appropriate as-is.
- **Splash screen intro** (app.html:29-39) — well-crafted custom cubic-beziers,
  plays once per session. Fine as-is aside from needing a reduced-motion
  fallback (folded into plan 004).

## Findings selected for plans

| # | Severity | Category | Location | Finding | Plan |
| --- | --- | --- | --- | --- | --- |
| 1 | HIGH | Physicality & origin | `.row-menu` dropdown, app.html:236-237 | The "⋯" row-actions menu — the most-clicked dropdown in the app — snaps open/closed with zero transition. | [001-row-menu-transition.md](001-row-menu-transition.md) |
| 2 | MEDIUM | Cohesion / missed opportunity | `showToast()`, app.html:6544-6556 | Toasts (fired on nearly every save/delete/check, app-wide) fade in but vanish instantly with no exit animation, and get hard-removed if interrupted. | [002-toast-exit-animation.md](002-toast-exit-animation.md) |
| 3 | MEDIUM | Physicality & origin | 5 floating batch-action bars (app.html:1097, 1300, 1386, 1473, 1896) | Every bottom-fixed "N selected" toolbar pops in/out via raw `display` swaps instead of sliding from the edge it's anchored to. | [003-batch-bar-slide-transition.md](003-batch-bar-slide-transition.md) |
| 4 | MEDIUM | Accessibility | Whole `<style>` block | Zero `prefers-reduced-motion` handling anywhere in the app. | [004-reduced-motion.md](004-reduced-motion.md) |

## Findings noted but not planned (low leverage, deferred)

- **LOW / performance** — `.compat-pill` (app.html:433) and `.cat-badge`
  (app.html:416), both used only in the Add Link / Quick Add compatibility-pill
  flow (low frequency), use `transition:all 0.15s` instead of an explicit
  property list, and duplicate the app's own `cubic-bezier(.2,.8,.2,1)`
  convention instead of reusing it. Real, but cosmetic-only on a rarely-seen
  surface — not planned this round.

## Missed opportunities (additive, not corrective)

- A link row's Status `<select>` changing (e.g. Pending → Live) teleports the
  row's badge/color state with no transition — a brief background-color fade
  on the row would reinforce that its state just changed.
- A row just added via "Add link" or a completed CSV import appears in its
  table with no entrance cue — a subtle fade-in for the just-inserted row would
  help confirm "yes, that's the one."
- The Double-Check queue and Pending-links widgets are to-do lists that shrink
  as items resolve (✓ Checked / ✕ Reject) — the row currently just disappears
  on next re-render with no exit transition, wasting a natural "done" moment.

Not planned this round — each needs markup-level change (per-row insertion/
removal tracking) beyond a pure CSS/transition fix, so they're bigger and
riskier than the 4 plans above for a live production app.

## Execution order & status

| # | Plan | Status | Depends on |
| --- | --- | --- | --- |
| 1 | [001-row-menu-transition.md](001-row-menu-transition.md) | DONE | — |
| 2 | [002-toast-exit-animation.md](002-toast-exit-animation.md) | DONE | — |
| 3 | [003-batch-bar-slide-transition.md](003-batch-bar-slide-transition.md) | DONE | — |
| 4 | [004-reduced-motion.md](004-reduced-motion.md) | DONE | 001, 003 (references `.row-menu.open` / `.batch-bar.bb-show`) |

Plans 1-3 are independent of each other and were implemented in any order;
plan 4 was implemented last since it references selectors introduced by 1 and 3.
