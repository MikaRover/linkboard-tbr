# 004 — Respect prefers-reduced-motion app-wide

- **Status**: TODO
- **Commit**: a9a5f6a
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file (app.html), 1 new CSS media-query block

## Problem

There is zero `prefers-reduced-motion` handling anywhere in the app (confirmed:
`grep -n "prefers-reduced-motion" app.html` returns no matches). Every motion in
the product — the splash-screen intro, toast slide-in, hover lifts on stat
cards/buttons, and (after plans 001-003 land) the row-menu scale and batch-bar
slide — plays unconditionally regardless of the visitor's OS-level reduced-motion
setting.

## Target

A single `@media (prefers-reduced-motion: reduce)` block that removes
position/scale movement while preserving opacity-based feedback, per the
category's rule: reduced motion means fewer and gentler animations, not zero.

Concretely, for a visitor with the OS setting on:

- The splash screen's `logoIn` (translateY) and `barFill` (width) motion
  should not visibly move — logo appears via opacity only, bar fills instantly
  instead of animating growth. `splashOut`'s scale(1.04) is dropped, opacity
  fade kept.
- `fadeSlideIn`/`fadeSlideOut` (toasts) and `slideDown` (`.err`/`.alert`)
  translateY movement is dropped; opacity fade is kept.
- Hover lifts (`.stat[onclick]:hover{transform:translateY(-2px);...}`,
  `.btn-sm:hover{transform:translateY(-1px);...}`, `.card:hover`/`.proj-card:hover`
  box-shadow growth, `.compat-pill:hover{transform:translateY(-1px);...}`) drop
  their `transform`, keeping color/shadow feedback.
- (After plan 001) the row-menu's `scale(0.94) translateY(-4px)` → `scale(1)
  translateY(0)` becomes an opacity-only fade (no scale/translate).
- (After plan 003) the batch bars' `translateY(16px)` → `translateY(0)` becomes
  an opacity-only fade (no translate).
- The theme-toggle knob slide (app.html:228, `.theme-switch-knob`) and its
  `translateX(24px)` are left alone — deliberately excluded, since without any
  transform at all the knob would render in the wrong track position rather
  than merely "not animating"; this one conveys actual state, not decoration.

## Repo conventions to follow

This is the first `prefers-reduced-motion` block in the file — there is no
existing pattern to match. Place it as the last rule in the `<style>` block
(immediately before the closing `</style>` at app.html:831) so it reads as the
final, authoritative override layer, consistent with how the "Apple-inspired
design refresh" block near app.html:536 is already the file's last major
override layer for transitions.

## Steps

1. Immediately before `</style>` (app.html:831), add:

   ```css
   @media (prefers-reduced-motion: reduce){
     #app-splash.hide{animation:none;opacity:0;transition:opacity 0.3s ease;}
     .splash-logo-txt{animation:none;opacity:1;transform:none;}
     .splash-bar{animation:none;width:100%;}
     .page{animation:none;}
     #app-toast{animation:none !important;transition:opacity 180ms ease !important;transform:none !important;}
     .err,.alert{animation:none;}
     .stat[onclick]:hover,.btn-sm:hover,.compat-pill:hover{transform:none !important;}
     .row-menu{transform:none !important;}
     .row-menu.open{transform:none !important;}
     .batch-bar{transform:none !important;}
     .batch-bar.bb-show{transform:none !important;}
   }
   ```

   Note `#app-toast` is targeted by id (not by the `fadeSlideIn`/`fadeSlideOut`
   keyframe names) because `showToast()` sets `animation` inline via
   `t.style.cssText`/`t.style.animation` (plan 002) — an inline `style` beats a
   non-`!important` stylesheet rule, so this override must carry `!important`
   to actually win; every other selector above does not need `!important`
   since it's overriding a plain stylesheet rule, not an inline style, but
   `transform:none !important` is used defensively on the hover rules too
   since some of them (e.g. `.stat[onclick]:hover`) live inside the
   `!important`-heavy "Apple-inspired design refresh" block (app.html:536+) and
   would otherwise lose the cascade fight.

## Boundaries

- Do NOT touch `.theme-switch.on .theme-switch-knob{transform:translateX(24px);}`
  (app.html:231) — excluded deliberately, see Target section.
- Do NOT add a JS-side `matchMedia('(prefers-reduced-motion: reduce)')` check —
  this plan is CSS-only; a pure-CSS media query is sufficient for every
  animation in this file since none of them are driven by JS-computed inline
  transform values that would need a script-side branch.
- Do NOT remove any animation entirely for reduced-motion users — every rule
  above keeps opacity-based feedback, only movement/scale is dropped, per the
  category's own rule ("fewer and gentler … not zero").
- This plan should be written and shipped AFTER plans 001-003 (it references
  `.row-menu.open` and `.batch-bar.bb-show`, which do not exist until those
  plans land) — if executing plans out of order, skip the `.row-menu`/
  `.batch-bar` lines here until those plans are in place, or land 001-003 first.

## Verification

- **Mechanical**: re-run the esprima syntax check — this plan touches only CSS,
  so it should be a no-op for the check, but run it anyway since it's part of
  the same file.
- **Feel check**: in Chrome DevTools, open the Rendering tab, set "Emulate CSS
  media feature prefers-reduced-motion" to "reduce", then reload the app.
  Confirm: the splash screen still shows the logo and completes (no infinite
  hang), just without the slide-up/bar-fill motion; trigger a toast and confirm
  it still appears/disappears (opacity fade) without sliding; hover a stat card
  or button and confirm color/shadow feedback remains but it doesn't lift;
  open a row's `⋯` menu and confirm it still shows/hides (opacity only, no
  scale); select a table row and confirm the batch bar still appears (opacity
  only, no slide-up). Then set the emulation back to "No emulation" and confirm
  every animation returns to normal (this block must not leak into the default,
  non-reduced-motion experience).
- **Done when**: with `prefers-reduced-motion: reduce` emulated, no element in
  the app visibly translates or scales, but every affected element's
  presence/absence (opacity) still updates correctly; with it off, behavior is
  unchanged from before this plan.
