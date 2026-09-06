# 001 — Give the row-actions ("⋯") dropdown a real open/close transition

- **Status**: TODO
- **Commit**: a9a5f6a
- **Severity**: HIGH
- **Category**: Physicality & origin / Purpose
- **Estimated scope**: 1 file (app.html), 1 CSS rule pair, 0 JS changes

## Problem

The row-actions kebab menu (`⋯` button on every row of every links table — My Links,
All Links, Project Detail, etc.) toggles via a raw `display:none` / `display:flex`
class swap with zero transition, opacity, or transform. It snaps into existence
instantly with no indication it grew out of the button that opened it. This is
the single most-clicked interactive dropdown in the app (every table row, admin
and builder alike, all day).

Current code, app.html:236-237:

```css
.row-menu{position:absolute;top:calc(100% + 4px);right:0;min-width:140px;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;box-shadow:var(--shadow);padding:4px;display:none;flex-direction:column;z-index:40;}
.row-menu.open{display:flex;}
```

The JS that drives it already toggles a class, not inline style, so no JS change
is needed — app.html:5363-5369:

```js
function toggleRowMenu(e,id){
  e.stopPropagation();
  const menu=document.getElementById('row-menu-'+id);
  const wasOpen=menu.classList.contains('open');
  document.querySelectorAll('.row-menu.open').forEach(m=>m.classList.remove('open'));
  if(!wasOpen)menu.classList.add('open');
}
document.addEventListener('click',()=>{
  document.querySelectorAll('.row-menu.open').forEach(m=>m.classList.remove('open'));
```

## Target

The menu scales and fades in from its top-right corner (where the trigger button
sits), and reverses symmetrically on close:

- `transform-origin: top right` (it hangs below-left of the `⋯` button, which sits
  at its top-right corner — see `.row-menu{position:absolute;top:calc(100% + 4px);right:0;...}`).
- Closed state: `opacity:0; transform:scale(0.94) translateY(-4px);` — never `scale(0)`.
- Open state: `opacity:1; transform:scale(1) translateY(0);`
- Duration/curve: reuse the app's own existing convention from app.html:543
  (`transform .18s cubic-bezier(.2,.8,.2,1)`) — do not invent a new curve.
  Opacity fades slightly faster, matching the same file's existing pairing style
  (e.g. app.html:543's `color .18s ease`): `opacity 140ms ease`.
- `pointer-events:none` while closed so the invisible-but-still-in-the-DOM menu
  can't be clicked or (via mouse) hovered; `pointer-events:auto` while open.

## Repo conventions to follow

This codebase already has a dedicated, deliberate transition system for
interactive chrome — app.html:542-543:

```css
button, .nav, .card, .stat, input, select, .proj-card, .status-tab, a{
  transition: background .22s ease, border-color .22s ease, color .18s ease, box-shadow .25s ease, transform .18s cubic-bezier(.2,.8,.2,1) !important;
}
```

`.row-menu` is a `<div>`, not matched by that selector list, which is why it has
no transition at all today. Reuse the exact same `cubic-bezier(.2,.8,.2,1)` curve
for the transform, matching this existing convention rather than introducing a
new easing token.

## Steps

1. In app.html, replace the two-line `.row-menu` / `.row-menu.open` block at
   lines 236-237 with:

   ```css
   .row-menu{position:absolute;top:calc(100% + 4px);right:0;min-width:140px;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;box-shadow:var(--shadow);padding:4px;display:flex;flex-direction:column;z-index:40;transform-origin:top right;opacity:0;transform:scale(0.94) translateY(-4px);pointer-events:none;transition:opacity 140ms ease,transform 180ms cubic-bezier(.2,.8,.2,1);}
   .row-menu.open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto;}
   ```

   Note `display:none` is dropped entirely (replaced by `display:flex` always,
   with `opacity`/`pointer-events` doing the hiding) — a CSS transition cannot
   animate to/from `display:none`, which is why the menu had no animation before.

2. No JS changes — `toggleRowMenu` and the document-level click-outside handler
   already just add/remove the `.open` class, which is exactly what the new CSS
   keys off of.

## Boundaries

- Do NOT touch `.row-menu button`, `.row-menu-btn`, `.row-menu-wrap`, or the
  `body.light .row-menu` override at app.html:85-86 — those are colors/layout,
  out of scope.
- Do NOT change `toggleRowMenu()` or the click-outside listener.
- Do NOT add a new easing token — reuse `cubic-bezier(.2,.8,.2,1)` verbatim.
- If the cited line numbers have drifted (file edited since this plan was
  written), locate `.row-menu{` and `.row-menu.open{` by content instead of
  line number, and STOP if the current rule doesn't match what's quoted above.

## Verification

- **Mechanical**: run the project's existing esprima-based syntax check on the
  file's last `<script>` block (this change is CSS-only, so the check should
  pass unchanged) — no build step exists otherwise.
- **Feel check**: open any table with row actions (e.g. My Links), click a row's
  `⋯` button. Confirm: the menu grows from its top-right corner (not center),
  fades+scales in over ~180ms, and clicking elsewhere or re-clicking `⋯` fades
  it back out rather than vanishing instantly. Click `⋯` on two different rows
  in quick succession — the first should close smoothly while the second opens
  (no visual glitch from having two `.open` menus at once, since the JS already
  clears all other `.open` classes before adding one). In DevTools Rendering
  panel, toggle `prefers-reduced-motion: reduce` (once plan 004 lands) and
  confirm the menu still shows/hides, just without the scale/slide movement.
- **Done when**: the row menu visibly animates open and closed instead of
  snapping, using the exact values above, with no change to which rows' menus
  can be open simultaneously (still exactly zero or one).
