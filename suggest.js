// Coin search box with suggestions from the first letter typed (shared by Holder Flow and Smart Bands).
// attachSuggest(input, () => [{ sym, name, logo }], sym => …): ranks ticker prefix, then name prefix, then
// any match; ↑ ↓ Enter Esc, mouse or touch. Enter with no highlighted row picks the best match.
(function () {
  const css = `.sg-wrap{position:relative;display:inline-block;min-width:0}
.sg-list{position:absolute;left:-10px;top:calc(100% + 10px);z-index:50;min-width:260px;max-width:min(360px,calc(100vw - 32px));max-height:340px;overflow-y:auto;
  background:#0b0d12;border:1px solid #232a36;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:4px}
.sg-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px;color:#e5e7eb}
.sg-item.on,.sg-item:hover{background:#141a24}
.sg-item img,.sg-item .sg-ph{width:22px;height:22px;border-radius:50%;flex:0 0 22px;background:#1c222d}
.sg-item b{font-weight:bold;min-width:52px}
.sg-item span{color:#94a3b8;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sg-item mark{background:none;color:#00ff88}
.sg-empty{padding:10px;color:#94a3b8;font-size:13px}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hi = (text, q) => { const i = text.toLowerCase().indexOf(q.toLowerCase()); return i < 0 || !q ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length)); };

  window.attachSuggest = function (input, items, onPick, max = 8) {
    input.removeAttribute("list");
    const wrap = document.createElement("span"); wrap.className = "sg-wrap";
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const list = document.createElement("div"); list.className = "sg-list"; list.hidden = true; list.setAttribute("role", "listbox");
    wrap.appendChild(list);
    input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
    let shown = [], at = -1;
    function rank(q) {
      const Q = q.trim().toUpperCase(); if (!Q) return [];
      const out = [];
      for (const it of items()) {
        const s = it.sym.toUpperCase(), n = String(it.name || "").toUpperCase();
        const r = s === Q ? 0 : s.startsWith(Q) ? 1 : n.startsWith(Q) ? 2 : s.includes(Q) ? 3 : n.includes(Q) ? 4 : -1;
        if (r >= 0) out.push([r, s.length, it]);
      }
      return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].sym.localeCompare(b[2].sym)).slice(0, max).map(x => x[2]);
    }
    function draw() {
      const q = input.value.trim();
      shown = rank(q);
      if (!q) { list.hidden = true; return; }
      list.innerHTML = shown.length ? shown.map((it, i) => `<div class="sg-item${i === at ? " on" : ""}" role="option" data-i="${i}">` +
        (it.logo ? `<img src="${esc(it.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : `<i class="sg-ph"></i>`) +
        `<b>${hi(it.sym, q)}</b><span>${hi(it.name || "", q)}</span></div>`).join("") : `<div class="sg-empty">Không có coin nào khớp “${esc(q)}”.</div>`;
      list.hidden = false;
    }
    function pick(it) { if (!it) return; input.value = it.sym; list.hidden = true; at = -1; input.blur(); onPick(it.sym); }
    input.addEventListener("input", () => { at = -1; draw(); });
    input.addEventListener("focus", () => { if (input.value.trim()) { input.select(); } });
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (list.hidden) draw();
        if (!shown.length) return;
        e.preventDefault();
        at = e.key === "ArrowDown" ? (at + 1) % shown.length : (at - 1 + shown.length) % shown.length;
        draw(); list.querySelector(".sg-item.on")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        const hit = shown[at >= 0 ? at : 0] || rank(input.value)[0];
        if (hit) { e.preventDefault(); pick(hit); }
      }
      else if (e.key === "Escape") { list.hidden = true; at = -1; }
    });
    // pointerdown only keeps the focus in the box; the choice is made on click, while the list is still
    // there, so the click cannot fall through to whatever sits under the list once it closes
    list.addEventListener("pointerdown", e => e.preventDefault());
    list.addEventListener("click", e => { const el = e.target.closest(".sg-item"); if (el) { e.preventDefault(); e.stopPropagation(); pick(shown[+el.dataset.i]); } });
    document.addEventListener("pointerdown", e => { if (!wrap.contains(e.target)) list.hidden = true; });
  };
})();
