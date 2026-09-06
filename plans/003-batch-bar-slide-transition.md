# 003 — Slide-up transition for the 5 floating batch-action bars

- **Status**: TODO
- **Commit**: a9a5f6a
- **Severity**: MEDIUM
- **Category**: Physicality & origin
- **Estimated scope**: 1 file (app.html); 1 new CSS class, 1 new JS helper, 5 HTML edits, 9 call-site edits

## Problem

The app has 5 separate bottom-fixed "N selected" action bars, each shown when
rows are checked in a table and hidden otherwise. All 5 currently toggle via a
raw inline `style.display = 'flex' | 'none'` swap — they pop into existence
with no motion, even though each is a spatially-anchored panel sliding in from
the bottom edge of the viewport, which is exactly the kind of entrance that
reads naturally as a slide.

The 5 bars (HTML, each currently starting with inline `display:none;position:fixed;bottom:20px;...`):

- `#batch-bar` — app.html:1097 (All Links page)
- `#pd-batch-bar` — app.html:1300 (Project Detail page)
- `#inv-batch-bar` — app.html:1386 (Invoices page)
- `#chk-batch-bar` — app.html:1473 (Data Checker page)
- `#bl-batch-bar` — app.html:1896 (My Links page)

The 9 JS call sites that currently set `.style.display` directly:

```js
// app.html:3048-3053 (Data Checker)
function onChkSelect(){
  const ids=Array.from(document.querySelectorAll('.chk-cb:checked')).map(c=>c.dataset.id);
  const bar=document.getElementById('chk-batch-bar');
  if(ids.length){bar.style.display='flex';document.getElementById('chk-batch-count').textContent=ids.length+' selected';}
  else bar.style.display='none';
}
function clearChkSelection(){document.querySelectorAll('.chk-cb').forEach(c=>c.checked=false);const el=document.getElementById('chk-select-all');if(el)el.checked=false;document.getElementById('chk-batch-bar').style.display='none';}

// app.html:3270-3277 (Project Detail)
function onPdRowSelect(){
  const ids=Array.from(document.querySelectorAll('.pd-cb:checked')).map(cb=>cb.dataset.id);
  const bar=document.getElementById('pd-batch-bar');
  if(ids.length>0){bar.style.display='flex';document.getElementById('pd-batch-count').textContent=ids.length+' selected';}
  else bar.style.display='none';
}
function clearPdSelection(){document.querySelectorAll('.pd-cb').forEach(cb=>cb.checked=false);if(document.getElementById('pd-select-all'))document.getElementById('pd-select-all').checked=false;document.getElementById('pd-batch-bar').style.display='none';}

// app.html:5391-5398 (My Links)
function updateBlCheckBtn(){
  const n = document.querySelectorAll('.bl-row-check:checked').length;
  const bar = document.getElementById('bl-batch-bar');
  if(bar) bar.style.display = n>0 ? 'flex' : 'none';
  const count = document.getElementById('bl-batch-count');
  if(count) count.textContent = n>0 ? n+' selected' : '';
  const btn = document.getElementById('bl-check-btn');
  if(btn) btn.textContent = n>0 ? `🔍 Check selected (${n})` : '🔍 Check selected';
}

// app.html:5578-5581, 5594 (All Links)
function onRowSelect(){
  const ids=getSelectedIds();
  const bar=document.getElementById('batch-bar');
  if(ids.length>0){bar.style.display='flex';document.getElementById('batch-count').textContent=ids.length+' selected';}
  else bar.style.display='none';
  const all=document.getElementById('select-all');
  const total=document.querySelectorAll('.row-cb').length;
  if(all)all.checked=ids.length===total&&total>0;
}
function clearSelection(){
  document.querySelectorAll('.row-cb').forEach(cb=>cb.checked=false);
  const all=document.getElementById('select-all');
  if(all)all.checked=false;
  document.getElementById('batch-bar').style.display='none';
}

// app.html:5874-5881 (Invoices)
function onInvSelect(){
  const ids=getInvSelectedIds();
  const bar=document.getElementById('inv-batch-bar');
  if(ids.length){bar.style.display='flex';document.getElementById('inv-batch-count').textContent=ids.length+' selected';}
  else bar.style.display='none';
}
function clearInvSelection(){document.querySelectorAll('.inv-cb').forEach(c=>c.checked=false);const el=document.getElementById('inv-select-all');if(el)el.checked=false;document.getElementById('inv-batch-bar').style.display='none';}
```

## Target

All 5 bars slide up 16px and fade in when shown, and reverse on hide — driven by
one shared CSS class + one shared JS helper, not 5 separate implementations:

- Hidden state: `opacity:0; transform:translateY(16px);`
- Shown state: `opacity:1; transform:translateY(0);`
- `visibility:hidden` while closed (transitioned with a `0s` delay that only
  takes effect on the way OUT, via `transition-delay`) so a hidden bar's
  buttons are not keyboard-focusable or announced to screen readers — `display`
  cannot be used here since it would block the transition entirely (the same
  reason plan 001 removes `display:none` from `.row-menu`).
- Duration/curve: reuse the app's own convention — `opacity 200ms ease,
  transform 200ms cubic-bezier(.2,.8,.2,1)` (same transform curve as
  app.html:543; opacity duration matches this file's `.err`/`.alert` entrance
  family, e.g. app.html:111's `slideDown 0.2s ease`).

## Repo conventions to follow

Same transform curve as plan 001 and as the file's own global convention at
app.html:543 (`cubic-bezier(.2,.8,.2,1)`) — every new curve this audit
introduces should be this one; do not add a third curve to the file.

## Steps

1. Add one shared CSS class, right after the `.row-menu` rules touched by plan
   001 (or anywhere in the `<style>` block — placement doesn't matter, CSS is
   order-independent for non-conflicting selectors):

   ```css
   .batch-bar{display:flex;opacity:0;transform:translateY(16px);visibility:hidden;transition:opacity 200ms ease,transform 200ms cubic-bezier(.2,.8,.2,1),visibility 0s linear 200ms;}
   .batch-bar.bb-show{opacity:1;transform:translateY(0);visibility:visible;transition:opacity 200ms ease,transform 200ms cubic-bezier(.2,.8,.2,1),visibility 0s linear 0s;}
   ```

2. Add one shared JS helper near `showToast` or any other small DOM utility
   (e.g. right before `function toggleRowMenu`):

   ```js
   // Shows/hides one of the floating "N selected" batch-action bars with a
   // slide+fade transition instead of an instant display swap. Used by all 5
   // selection toolbars (All Links, Project Detail, Invoices, Data Checker, My Links).
   function toggleBatchBar(id, show){
     const bar=document.getElementById(id);
     if(bar) bar.classList.toggle('bb-show', !!show);
   }
   ```

3. In each of the 5 HTML `<div id="...-batch-bar" style="display:none;...">`
   tags (app.html:1097, 1300, 1386, 1473, 1896), remove the leading
   `display:none;` from the inline `style` attribute and add `class="batch-bar"`
   to the tag. Example for app.html:1097 — before:

   ```html
   <div id="batch-bar" style="display:none;position:fixed;bottom:20px;left:240px;right:20px;z-index:999;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:12px 18px;align-items:center;gap:10px;flex-wrap:wrap;box-shadow:0 4px 24px rgba(0,0,0,0.5);">
   ```

   after:

   ```html
   <div id="batch-bar" class="batch-bar" style="position:fixed;bottom:20px;left:240px;right:20px;z-index:999;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:12px 18px;align-items:center;gap:10px;flex-wrap:wrap;box-shadow:0 4px 24px rgba(0,0,0,0.5);">
   ```

   Apply the identical pattern (drop `display:none;`, add `class="batch-bar"`)
   to the other 4 bars at app.html:1300, 1386, 1473, 1896. `chk-batch-bar`
   (app.html:1473) has no `flex-wrap:wrap` in its inline style unlike the other
   4 — leave that difference exactly as-is, only touch `display:none` and add
   the class.

4. Replace each of the 9 `bar.style.display = ...` / `.style.display='none'`
   statements with a call to `toggleBatchBar(id, show)`:

   - app.html:3049-3050 (`onChkSelect`): replace
     `if(ids.length){bar.style.display='flex';document.getElementById('chk-batch-count').textContent=ids.length+' selected';} else bar.style.display='none';`
     with
     `toggleBatchBar('chk-batch-bar', ids.length>0); if(ids.length) document.getElementById('chk-batch-count').textContent=ids.length+' selected';`
   - app.html:3053 (`clearChkSelection`): replace the trailing
     `document.getElementById('chk-batch-bar').style.display='none';`
     with `toggleBatchBar('chk-batch-bar', false);`
   - app.html:3273-3274 (`onPdRowSelect`): replace
     `if(ids.length>0){bar.style.display='flex';document.getElementById('pd-batch-count').textContent=ids.length+' selected';} else bar.style.display='none';`
     with
     `toggleBatchBar('pd-batch-bar', ids.length>0); if(ids.length>0) document.getElementById('pd-batch-count').textContent=ids.length+' selected';`
   - app.html:3277 (`clearPdSelection`): replace
     `document.getElementById('pd-batch-bar').style.display='none';`
     with `toggleBatchBar('pd-batch-bar', false);`
   - app.html:5394 (`updateBlCheckBtn`): replace
     `if(bar) bar.style.display = n>0 ? 'flex' : 'none';`
     with `toggleBatchBar('bl-batch-bar', n>0);` (the `bar` local var becomes
     unused by this line — leave the rest of the function, including the `bar`
     declaration, untouched since nothing else needs to change)
   - app.html:5580-5581 (`onRowSelect`): replace
     `if(ids.length>0){bar.style.display='flex';document.getElementById('batch-count').textContent=ids.length+' selected';} else bar.style.display='none';`
     with
     `toggleBatchBar('batch-bar', ids.length>0); if(ids.length>0) document.getElementById('batch-count').textContent=ids.length+' selected';`
   - app.html:5594 (`clearSelection`): replace
     `document.getElementById('batch-bar').style.display='none';`
     with `toggleBatchBar('batch-bar', false);`
   - app.html:5877-5878 (`onInvSelect`): replace
     `if(ids.length){bar.style.display='flex';document.getElementById('inv-batch-count').textContent=ids.length+' selected';} else bar.style.display='none';`
     with
     `toggleBatchBar('inv-batch-bar', ids.length>0); if(ids.length) document.getElementById('inv-batch-count').textContent=ids.length+' selected';`
   - app.html:5881 (`clearInvSelection`): replace
     `document.getElementById('inv-batch-bar').style.display='none';`
     with `toggleBatchBar('inv-batch-bar', false);`

   In each function, the now-possibly-unused `const bar=document.getElementById(...)`
   local variable can be left in place even where it's no longer read — do not
   spend a step deleting now-dead locals, that's out of scope for an animation
   plan.

## Boundaries

- Do NOT change bar contents, button labels, colors, or the count text logic
  beyond what's needed to keep it working after the `style.display` removal.
- Do NOT consolidate the 5 bars into one shared component — they stay 5
  separate DOM elements; only the show/hide mechanism is shared.
- Do NOT touch any bar other than the 5 named here.
- If any cited line's current code doesn't match what's quoted (drift since
  this plan was written), STOP and report instead of improvising — find the
  correct current location by function name instead of line number, but do not
  guess at surrounding logic that isn't shown here.

## Verification

- **Mechanical**: re-run the esprima syntax check on the last `<script>` block
  after all 9 call-site edits — must pass.
- **Feel check**: on each of the 5 pages (All Links, Project Detail, Invoices,
  Data Checker, My Links), select a row's checkbox and confirm its bar slides
  up from the bottom edge and fades in over ~200ms (not an instant pop), then
  uncheck everything (or click "Clear") and confirm it slides back down and
  fades out rather than vanishing. Confirm the bar's buttons are not reachable
  by Tab key while hidden (click into the page, press Tab repeatedly, confirm
  focus never lands on a hidden bar's buttons) — this is the `visibility`
  behavior working correctly. Confirm selecting/deselecting rapidly (e.g.
  clicking a checkbox on and off quickly) doesn't leave the bar in a
  half-transitioned or stuck state.
- **Done when**: all 5 bars slide+fade in/out instead of snapping, using the
  shared `.batch-bar`/`.bb-show` class and `toggleBatchBar()` helper, and no
  bar's buttons are focusable while hidden.
