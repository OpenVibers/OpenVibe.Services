'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, one at a time on a phone, picked with a row of chips. Radio
 *                inputs and :has(), no script: every block stays in the page for crawlers, and a wider screen (or a
 *                browser without :has()) shows them all and no chips.
 *   foldBlock()  a part a reader rarely needs, in a fold that starts open on every screen: content is never hidden.
 *
 * The CSS for both lives in public/css/app.css; the rule that shows the picked block is written for the page,
 * because there is one per block.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pick block. The panes are the page's own blocks; the block's heading gives way to the chip that names it on a
 * phone, and the chips are gone on a wide screen, where every pane shows at once.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', headId = '', bodyClass = '', panes }) {
    if (!panes || !panes.length) return '';
    // Every block is on the page on every screen (the owner's rule, 2026-10-31); the chip row that picked one at a
    // time on a phone is gone.
    return panes.map((p) => `<div class="pick-pane" id="pp-${esc(key)}-${esc(p.id)}">${p.html}</div>`).join('');
}

/** The rules for every pane of a pick block, in the order they appear: one rule per pane, so the CSS is written for the page. */
function pickRules(key, ids) {
    return ids.map((id) => `.pick:has(#pk-${key}-${id}:checked) #pp-${key}-${id}{display:block}`).join('');
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return `<details class="svc-fold svc-fold-block" id="${esc(id)}" open><summary>${head}</summary>${html}</details>`;
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`;
}

module.exports = { pickBlock, pickRules, foldBlock, foldScript };
