# 002 — Give toast notifications a symmetric exit animation

- **Status**: TODO
- **Commit**: a9a5f6a
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens / Missed opportunity
- **Estimated scope**: 1 file (app.html), 1 function (`showToast`)

## Problem

`showToast()` (app.html:6544-6556) is called on nearly every save/delete/check
action app-wide (add link, bulk check, invoice update, reject, etc.) — one of
the highest-frequency pieces of feedback in the whole product. It fades+slides
in via a keyframe animation, but has **no exit animation at all**: after 3
seconds it is removed from the DOM outright, so it just vanishes/teleports
instead of leaving the way it arrived. It's also removed with zero fade if a
second toast interrupts the first one before its timer fires.

Current code, app.html:6544-6556:

```js
function showToast(msg, type='ok'){
  const existing = document.getElementById('app-toast');
  if(existing) existing.remove();
  const t = document.createElement('div');
  t.id = 'app-toast';
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;animation:fadeSlideIn 0.2s ease;box-shadow:0 4px 20px rgba(0,0,0,0.3);
    background:${type==='ok'?'rgba(0,196,174,0.15)':type==='warn'?'rgba(240,165,0,0.15)':'rgba(255,95,95,0.15)'};
    border:1px solid ${type==='ok'?'rgba(0,196,174,0.4)':type==='warn'?'rgba(240,165,0,0.4)':'rgba(255,95,95,0.4)'};
    color:${type==='ok'?'var(--teal)':type==='warn'?'var(--yellow)':'var(--red)'};`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 3000);
}
```

The existing `fadeSlideIn` keyframe (app.html:96) is:

```css
@keyframes fadeSlideIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
```

## Target

- Entry keeps using `fadeSlideIn` (already animates only `opacity`/`transform` —
  correct properties, no change needed there), but a still-visible toast that
  gets interrupted by a new one should fade out first rather than being ripped
  out instantly.
- On the normal 3-second timeout, the toast fades+slides out symmetrically
  (reverse of the entrance: `opacity:1,translateY(0)` → `opacity:0,translateY(8px)`)
  over 180ms before removal — never removed with a hard cut.
- Reuse the same `0.2s`-class duration family already used for the entrance
  (this file's existing toast/alert entrances are all in the 120-200ms range —
  app.html:96-98's `fadeSlideIn`/`fadeIn`/`slideDown` keyframes — so exiting
  toasts should feel like they belong to the same family, not a new one).

## Repo conventions to follow

This file already defines paired enter animations as keyframes (`fadeSlideIn`,
`fadeIn`, `slideDown` at app.html:96-98) but never a matching exit — this is the
first exit animation in the file. Add one keyframe, `fadeSlideOut`, named and
shaped as the mirror of `fadeSlideIn`, right next to it (app.html:96), so future
toasts/alerts can reuse it the same way.

## Steps

1. In app.html, right after the existing `@keyframes fadeSlideIn{...}` at line 96,
   add:

   ```css
   @keyframes fadeSlideOut{from{opacity:1;transform:translateY(0);}to{opacity:0;transform:translateY(8px);}}
   ```

2. Replace `showToast()` (app.html:6544-6556) with a version that (a) fades out
   an existing toast instead of yanking it, and (b) fades the current toast out
   before removing it at the end of its life:

   ```js
   function showToast(msg, type='ok'){
     const existing = document.getElementById('app-toast');
     if(existing){
       existing.id = '';
       existing.style.animation = 'fadeSlideOut 180ms ease forwards';
       setTimeout(()=>existing.remove(), 180);
     }
     const t = document.createElement('div');
     t.id = 'app-toast';
     t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;animation:fadeSlideIn 0.2s ease;box-shadow:0 4px 20px rgba(0,0,0,0.3);
       background:${type==='ok'?'rgba(0,196,174,0.15)':type==='warn'?'rgba(240,165,0,0.15)':'rgba(255,95,95,0.15)'};
       border:1px solid ${type==='ok'?'rgba(0,196,174,0.4)':type==='warn'?'rgba(240,165,0,0.4)':'rgba(255,95,95,0.4)'};
       color:${type==='ok'?'var(--teal)':type==='warn'?'var(--yellow)':'var(--red)'};`;
     t.textContent = msg;
     document.body.appendChild(t);
     setTimeout(()=>{
       if(t.id!=='app-toast')return; // already replaced by a newer toast
       t.style.animation = 'fadeSlideOut 180ms ease forwards';
       setTimeout(()=>t.remove(), 180);
     }, 3000);
   }
   ```

   The `existing.id = ''` step (and the `if(t.id!=='app-toast')return;` guard in
   the timeout) exists so a toast that's mid-fade-out from being interrupted
   doesn't also get double-removed by its own original 3-second timer firing
   later — clearing its id makes that stale timer's guard check fail safely.

## Boundaries

- Do NOT change toast positioning, colors, duration-before-exit (3000ms), or
  the three `type` variants' styling.
- Do NOT change any other caller of `showToast()` — the function signature is
  unchanged.
- Do NOT touch the `.err`/`.alert` elements' own `slideDown` animation
  (app.html:111,192,327) — out of scope for this plan.
- If `showToast`'s current body doesn't match what's quoted above (file drifted
  since this plan was written), STOP and report instead of improvising.

## Verification

- **Mechanical**: re-run the esprima syntax check used for every ship in this
  repo (extract the last `<script>` block, neutralize `?.`/`??`, parse) — must
  still pass after the `showToast` rewrite.
- **Feel check**: trigger any toast (e.g. save a link). Confirm it fades+slides
  in as before, then — after ~3s — fades+slides back out over ~180ms instead of
  disappearing instantly. Trigger two toasts back-to-back within ~1s of each
  other (e.g. two quick saves) and confirm the first visibly fades out (not
  yanked) as the second fades in, and that no stray toast is left behind or
  double-removed (check DevTools Elements panel — `#app-toast` should not throw
  a "not found" error in the console from a duplicate `.remove()` call).
- **Done when**: every toast — whether it times out naturally or gets
  interrupted by a new one — visibly fades out before leaving the DOM, and the
  console shows no errors from double-removal.
