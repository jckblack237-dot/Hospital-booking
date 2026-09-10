/**
 * Pick a card up and carry it (Pointer Events; no HTML5 DnD).
 *
 * Coarse pointers lift after a 300 ms hold (a move before that scrolls the
 * list or pages the board natively); fine pointers lift after 8 px. The lifted
 * card lives in a fixed layer and tracks the pointer 1:1 from where it was
 * grabbed; a `.slot` placeholder keeps its place, siblings make room with a
 * 160 ms shift, and the release hands the finger's velocity to two independent
 * springs. Drops stay inside the card's tier group; a foreign list takes the
 * card at the end of its matching group (that is where the server will put it).
 *
 *   createDrag(board, {
 *     canDrag(tokEl) → bool
 *     groupOf(listEl, tier) → the group element in that list for this tier (or null)
 *     listOk(listEl) → bool           the column accepts drops (open session)
 *     page(dir)                       auto-page the board one column
 *     onLift({ tokenId, el, group, index })
 *     onDrop({ tokenId, el, fromGroup, toGroup, fromIndex, index, afterId, beforeId, moved, cancelled })
 *   }) → { destroy(), active(), cancel() }
 */
import { reducedMotion } from '/shared/core.js';
import { spring, releaseVelocity } from '/shared/spring.js';

const HOLD_MS = 300;
const SLOP = 8;
const EDGE = 40;          // px from the board edge that pages
const EDGE_HOLD_MS = 250;
const EDGE_REPEAT_MS = 600;
const SCROLL_ZONE = 48;   // px from a list's top/bottom that scrolls it
const SCROLL_MAX = 12;    // px/frame
const EASE_MOVE = 'cubic-bezier(.77, 0, .175, 1)';
const INTERACTIVE = 'button, a, input, textarea, select, [role="radio"]';

let layer = null;
function dragLayer() {
  if (!layer || !layer.isConnected) {
    layer = document.getElementById('drag-layer') || Object.assign(document.createElement('div'), { id: 'drag-layer' });
    if (!layer.isConnected) document.body.append(layer);
  }
  return layer;
}

const cards = (group, except) => [...group.children].filter((c) => c.classList.contains('tok') && c !== except && !c.dataset.exiting);

/** Untransformed midpoints in client space: a sibling mid-shift (row 10) still counts where it lives, so its current translateY is taken back out. */
function midpoints(group, except) {
  return cards(group, except).map((c) => {
    const r = c.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(c).transform);
    return r.top - m.f + r.height / 2;
  });
}

/** Move the placeholder and let the displaced siblings glide (row 10). Measures the presentation rect first, so a retarget mid-flight has no seam. */
function moveSlot(slot, group, index, reduce) {
  const sibs = cards(group, slot);
  const before = reduce ? null : new Map(sibs.map((c) => [c, c.getBoundingClientRect().top]));
  const ref = sibs[index] ?? null;
  if (ref ? ref.previousElementSibling === slot : group.lastElementChild === slot) return;
  if (!reduce) for (const c of sibs) for (const a of c.getAnimations()) a.cancel();
  if (ref) group.insertBefore(slot, ref); else group.append(slot);
  if (reduce) return;
  for (const c of sibs) {
    const dy = before.get(c) - c.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) c.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 160, easing: EASE_MOVE });
  }
}

export function createDrag(board, hooks) {
  let pending = null;   // pointerdown seen, not lifted yet
  let d = null;         // the live drag
  let raf = 0;

  const preventTouch = (e) => { if (d) e.preventDefault(); };

  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.hold);
    pending = null;
  }

  function onDown(e) {
    if (d && d.settling) { relift(e); return; }
    if (d || pending) return;                                     // one pointer at a time
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest('.tok');
    if (!el || !board.contains(el) || e.target.closest(INTERACTIVE)) return;
    if (el.hasAttribute('data-pending') || el.hasAttribute('data-exiting') || !hooks.canDrag(el)) return;
    pending = { el, id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, hold: null };
    if (e.pointerType !== 'mouse') pending.hold = setTimeout(() => { if (pending) lift(pending.el, pending.x, pending.y, pending.id); }, HOLD_MS);
  }
  function onMove(e) {
    if (d) { if (e.pointerId === d.id && !d.settling) track(e.clientX, e.clientY); return; }
    if (!pending || e.pointerId !== pending.id) return;
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (dist <= SLOP) return;
    if (pending.type === 'mouse') { const p = pending; pending = null; lift(p.el, e.clientX, e.clientY, e.pointerId); track(e.clientX, e.clientY); }
    else clearPending();                                          // the finger is scrolling; the browser has it
  }
  function onUp(e) {
    if (d) { if (e.pointerId === d.id && !d.settling) release(); return; }
    if (pending && e.pointerId === pending.id) clearPending();
  }
  function onKey(e) {
    if (e.key === 'Escape' && d && !d.settling) { e.preventDefault(); e.stopPropagation(); cancel(); }
  }

  function lift(el, cx, cy, pointerId) {
    const group = el.parentElement;
    if (!group) return;
    const rect = el.getBoundingClientRect();
    const index = Math.max(0, cards(group).indexOf(el));
    const slot = document.createElement('div');
    slot.className = `slot${el.classList.contains('away') ? ' away' : ''}`;
    slot.dataset.key = el.dataset.key;   // the keyed patcher keeps an exiting node with this key exactly where it is
    slot.dataset.exiting = '1';
    slot.style.height = `${rect.height}px`;
    group.insertBefore(slot, el);
    d = {
      id: pointerId, el, slot, tokenId: el.dataset.key, rect, group, fromGroup: group, index, fromIndex: index,
      tier: el.classList.contains('away') ? 'away' : 'present',
      gx: cx - rect.left, gy: cy - rect.top, x: rect.left, y: rect.top, px: cx, py: cy,
      samples: [{ x: cx, y: cy, t: performance.now() }], list: group.closest('.list'), edge: null, edgeAt: 0, settling: false, sx: null, sy: null,
      reduce: reducedMotion(),
    };
    el.dataset.dragged = '';
    delete el.dataset.pressed;
    Object.assign(el.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', transform: 'translate(0px, 0px)' });
    dragLayer().append(el);
    el.classList.add('lifted');
    try { el.setPointerCapture(pointerId); } catch { /* the pointer is already gone */ }
    board.classList.add('dragging');
    document.body.dataset.dragging = '';
    document.addEventListener('touchmove', preventTouch, { passive: false });
    navigator.vibrate?.(10);
    hooks.onLift?.({ tokenId: d.tokenId, el, group, index });
    raf = requestAnimationFrame(loop);
  }

  /** A pointerdown on a card still springing home takes it back from where it is (§8.4); no hold. */
  function relift(e) {
    const el = e.target.closest('.tok');
    if (!el || el !== d.el) return;
    d.sx?.cancel(); d.sy?.cancel(); d.sx = d.sy = null;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    d.x = d.rect.left + m.e; d.y = d.rect.top + m.f;
    d.gx = e.clientX - d.x; d.gy = e.clientY - d.y;
    d.id = e.pointerId; d.settling = false; d.cancelled = false;
    d.samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    el.classList.add('lifted'); el.classList.remove('settling');
    el.style.pointerEvents = '';
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
    raf = requestAnimationFrame(loop);
  }

  function track(cx, cy) {
    d.px = cx; d.py = cy;
    d.x = cx - d.gx; d.y = cy - d.gy;
    d.el.style.transform = `translate(${d.x - d.rect.left}px, ${d.y - d.rect.top}px)`;
    d.samples.push({ x: cx, y: cy, t: performance.now() });
    if (d.samples.length > 5) d.samples.shift();
    retarget();
  }

  /** Where the card would land: the list under the pointer, the matching tier group, the index by midpoints. */
  function retarget() {
    const under = document.elementFromPoint(d.px, d.py);
    const list = under?.closest('.col .list') ?? null;
    const ok = list && hooks.listOk(list);
    d.el.classList.toggle('no-drop', !ok);
    for (const l of board.querySelectorAll('.list.drop-target')) if (l !== list || !ok || list === d.list) l.classList.remove('drop-target');
    if (!ok) return;
    if (list !== d.group.closest('.list')) {
      const group = hooks.groupOf(list, d.tier);
      if (!group) return;
      if (group.hidden) { group.hidden = false; d.unhid = group; }
      if (list !== d.list) list.classList.add('drop-target');
      // A foreign queue takes the card at its tail — the honest placement, it is where /reassign puts it.
      moveSlot(d.slot, group, cards(group, d.slot).length, d.reduce);
      d.group = group; d.index = cards(group, d.slot).length;
      return;
    }
    const mids = midpoints(d.group, d.slot);
    const centre = d.y + d.rect.height / 2;
    let index = 0;
    for (const m of mids) if (m < centre) index++;
    index = Math.max(0, Math.min(mids.length, index));
    if (index !== d.index) { moveSlot(d.slot, d.group, index, d.reduce); d.index = index; }
  }

  /** Auto-scroll the list and auto-page the board from the last pointer position, every frame. */
  function loop(t) {
    if (!d || d.settling) { raf = 0; return; }
    const list = d.group.closest('.list');
    if (list) {
      const r = list.getBoundingClientRect();
      let dy = 0;
      if (d.py < r.top + SCROLL_ZONE) dy = -Math.ceil(((r.top + SCROLL_ZONE - d.py) / SCROLL_ZONE) * SCROLL_MAX);
      else if (d.py > r.bottom - SCROLL_ZONE) dy = Math.ceil(((d.py - (r.bottom - SCROLL_ZONE)) / SCROLL_ZONE) * SCROLL_MAX);
      if (dy) { const before = list.scrollTop; list.scrollTop += dy; if (list.scrollTop !== before) retarget(); }
    }
    const b = board.getBoundingClientRect();
    const edge = d.px < b.left + EDGE ? -1 : d.px > b.right - EDGE ? 1 : 0;
    if (edge !== d.edge) { d.edge = edge; d.edgeAt = t + EDGE_HOLD_MS; }
    else if (edge && t >= d.edgeAt) { d.edgeAt = t + EDGE_REPEAT_MS; hooks.page?.(edge); }
    raf = requestAnimationFrame(loop);
  }

  function cancel() {
    if (!d || d.settling) return;
    d.cancelled = true;
    const from = d.fromGroup;
    if (from.isConnected) { moveSlot(d.slot, from, d.fromIndex, d.reduce); d.group = from; d.index = d.fromIndex; }
    release();
  }

  /** Spring to the slot from the current transform with the release velocity (row 11); the slot is chosen from where the card is, not where it was going. */
  function release() {
    cancelAnimationFrame(raf); raf = 0;
    d.settling = true;
    const el = d.el;
    el.classList.remove('lifted', 'no-drop');
    el.classList.add('settling');
    el.style.pointerEvents = 'auto';
    for (const l of board.querySelectorAll('.list.drop-target')) l.classList.remove('drop-target');
    try { el.releasePointerCapture(d.id); } catch { /* already released */ }
    const target = d.slot.getBoundingClientRect();
    const tx = target.left - d.rect.left;
    const ty = target.top - d.rect.top;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const { vx, vy } = releaseVelocity(d.samples);
    if (d.reduce) { settle(); return; }
    let x = m.e; let y = m.f;
    const paint = () => { el.style.transform = `translate(${x}px, ${y}px)`; };
    let left = 2;
    const done = () => { if (--left === 0) settle(); };
    d.sx = spring({ from: m.e, to: tx, velocity: vx, onUpdate: (v) => { x = v; paint(); }, onSettle: done });
    d.sy = spring({ from: m.f, to: ty, velocity: vy, onUpdate: (v) => { y = v; paint(); }, onSettle: done });
  }

  function settle() {
    const { el, slot, tokenId, fromGroup, fromIndex, cancelled } = d;
    const group = slot.parentElement;
    const moved = !cancelled && (group !== fromGroup || d.index !== fromIndex);
    el.classList.remove('settling');
    Object.assign(el.style, { position: '', left: '', top: '', width: '', height: '', margin: '', transform: '', pointerEvents: '' });
    if (group) group.insertBefore(el, slot);
    slot.remove();
    if (d.unhid && !cards(d.unhid).length) d.unhid.hidden = true;
    const sibs = group ? cards(group, el) : [];
    const at = group ? [...group.children].filter((c) => c.classList.contains('tok') && !c.dataset.exiting).indexOf(el) : -1;
    const afterId = at > 0 ? sibs[at - 1]?.dataset.key ?? null : null;
    const beforeId = at >= 0 ? sibs[at]?.dataset.key ?? null : null;
    board.classList.remove('dragging');
    delete document.body.dataset.dragging;
    document.removeEventListener('touchmove', preventTouch);
    const drop = { tokenId, el, fromGroup, toGroup: group, fromIndex, index: at, afterId, beforeId, moved, cancelled: !!cancelled };
    d = null;
    // The click that follows the pointerup must not expand the card.
    setTimeout(() => delete el.dataset.dragged, 0);
    hooks.onDrop?.(drop);
  }

  document.addEventListener('pointerdown', onDown);  // on document: a settling card lives in the drag layer, not the board
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', onKey, true);

  return {
    active: () => !!d,
    cancel,
    destroy() {
      clearPending();
      if (d) { d.sx?.cancel(); d.sy?.cancel(); d.cancelled = true; d.settling = false; d.group = d.fromGroup; settleNow(); }
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(raf);
    },
  };

  function settleNow() { cancelAnimationFrame(raf); raf = 0; if (d) settle(); }
}
