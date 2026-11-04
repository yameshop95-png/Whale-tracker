// Endless horizontal tickers of ranked coins (same look as Gem Radar's whale tickers), shared by the home
// page, Holder Flow and Smart Bands. Data: market_lists "tops", written by the tops function.
//   loadTops() -> { at, day, hf: {up, down}, whale: {up, down}, sb: {above, checked, below} }
//   renderTicker(box, { label, sub, tone: "up" | "down" | "gold", items: [{ t, main, sub, cls }], onPick })
(function () {
  const css = `.tk-wrap{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.tk{display:flex;align-items:stretch;background:#0b0d12;border:1px solid #1c222d;border-radius:12px;overflow:hidden;min-width:0}
.tk.up{border-color:rgba(0,255,136,.3)} .tk.down{border-color:rgba(255,91,91,.3)} .tk.gold{border-color:rgba(250,204,21,.35)}
.tk-l{flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;padding:8px 14px;font-weight:bold;font-size:13px;white-space:nowrap;min-width:150px}
.tk.up .tk-l{background:rgba(0,255,136,.1);color:#00ff88} .tk.down .tk-l{background:rgba(255,91,91,.1);color:#ff5b5b} .tk.gold .tk-l{background:rgba(250,204,21,.1);color:#facc15}
.tk-l span{font-weight:normal;font-size:11px;color:#94a3b8;margin-top:2px}
.tk-v{flex:1;overflow:hidden;min-width:0;-webkit-mask-image:linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent);mask-image:linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent)}
.tk-t{display:flex;width:max-content;animation:tkmove var(--dur,45s) linear infinite}
.tk:hover .tk-t,.tk:focus-within .tk-t{animation-play-state:paused}
@keyframes tkmove{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.tk-t{animation:none}.tk-v{overflow-x:auto}}
.tk-i{display:flex;align-items:center;gap:8px;padding:10px 18px;white-space:nowrap;cursor:pointer;border:0;border-right:1px solid #141820;font-size:13px;background:none;color:#e5e7eb;font-family:inherit}
.tk-i:hover{background:#141820}
.tk-i img{width:20px;height:20px;border-radius:50%}
.tk-i .rk{color:#64748b;font-size:11px}
.tk-i .s{font-size:11px;color:#94a3b8}
.tk-i .green{color:#00ff88} .tk-i .red{color:#ff5b5b} .tk-i .gold{color:#facc15}
.tk-e{padding:10px 16px;color:#94a3b8;font-size:13px}
@media(max-width:600px){.tk-l{min-width:112px;padding:8px 10px;font-size:12px}.tk-i{padding:9px 12px}}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const SB_URL = "https://gatncbafceuxlimytgjo.supabase.co", SB_KEY = "sb_publishable_GVtdohcs8-YC-Yg4DJL3gg_Kx2AXP4n";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let logos = null;
  async function sb(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY } }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
  // The top 200 list is shared with the page (one download per page view)
  let topP = null;
  window.getTop200 = (fresh = false) => (fresh ? topP = null : 0, topP ??= sb("market_lists?key=eq.top200&select=data").catch(() => { topP = null; return []; }));
  window.loadTops = async function () {
    const [t, top] = await Promise.all([sb("market_lists?key=eq.tops&select=data,updated_at"), logos ? null : getTop200()]);
    if (top) { logos = new Map(); for (const c of top?.[0]?.data ?? []) if (c.id) logos.set(String(c.symbol).toUpperCase(), `https://s2.coinmarketcap.com/static/img/coins/64x64/${+c.id}.png`); }
    return t?.[0]?.data ?? null;
  };
  window.fmtTkUsd = v => { const a = Math.abs(v); return (v < 0 ? "−" : "+") + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(1) + "K" : a.toFixed(0)); };
  window.renderTicker = function (box, o) {
    const items = o.items || [];
    box.innerHTML = `<div class="tk ${o.tone}" role="region" aria-label="${esc(o.label)}"><div class="tk-l">${esc(o.label)}<span>${esc(o.sub || "")}</span></div><div class="tk-v"><div class="tk-t"></div></div></div>`;
    const track = box.querySelector(".tk-t");
    if (!items.length) { track.innerHTML = `<div class="tk-e">${esc(o.empty || "Chưa có dữ liệu.")}</div>`; track.style.animation = "none"; return; }
    const one = (it, i) => `<button class="tk-i" data-t="${esc(it.t)}" title="${esc(it.title || it.t)}"><span class="rk">#${i + 1}</span>${logos?.get(it.t) ? `<img src="${logos.get(it.t)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ""}<b>${esc(it.t)}</b><span class="${it.cls || ""}">${esc(it.main)}</span>${it.sub ? `<span class="s">${esc(it.sub)}</span>` : ""}</button>`;
    const html = items.map(one).join(""), hidden = html.replace(/<button /g, '<button tabindex="-1" aria-hidden="true" ');
    // A short list is repeated until one half of the track holds at least 8 items, so it keeps scrolling
    // without a gap; the second half is the copy that makes the loop seamless
    const reps = Math.max(1, Math.ceil(8 / items.length)), half = html + hidden.repeat(reps - 1);
    track.innerHTML = half + hidden.repeat(reps);
    track.style.setProperty("--dur", Math.max(20, items.length * reps * 5) + "s");
    track.addEventListener("click", e => { const b = e.target.closest(".tk-i"); if (b && o.onPick) o.onPick(b.dataset.t); });
  };
  // The three kinds of list, ready to render
  const dd = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "";
  window.tickerDefs = function (tops) {
    const day = tops?.day;
    const flow = (x, who) => ({ t: x.t, main: fmtTkUsd(x.usd), cls: x.usd > 0 ? "green" : "red", sub: x.pct != null ? `${x.pct > 0 ? "+" : ""}${x.pct.toFixed(2)}% số dư` : "", title: `${x.t}: ${who} ${x.usd > 0 ? "gom" : "xả"} ròng ≈ ${fmtTkUsd(x.usd)} ngày ${dd(day)}` });
    return {
      hfUp: { label: "🟢 Bóng xanh to nhất", sub: `Top 100 ví gom ròng · ${dd(day)}`, tone: "up", items: (tops?.hf?.up ?? []).map(x => flow(x, "top 100 ví")), empty: "Chưa có coin nào top 100 ví gom ròng." },
      hfDown: { label: "🔴 Bóng đỏ to nhất", sub: `Top 100 ví xả ròng · ${dd(day)}`, tone: "down", items: (tops?.hf?.down ?? []).map(x => flow(x, "top 100 ví")), empty: "Chưa có coin nào top 100 ví xả ròng." },
      whUp: { label: "🐋 Cá voi gom mạnh", sub: `Top 50 ví · ${dd(day)}`, tone: "up", items: (tops?.whale?.up ?? []).map(x => flow(x, "cá voi")), empty: "Chưa có dữ liệu." },
      whDown: { label: "🩸 Cá voi xả mạnh", sub: `Top 50 ví · ${dd(day)}`, tone: "down", items: (tops?.whale?.down ?? []).map(x => flow(x, "cá voi")), empty: "Chưa có dữ liệu." },
      sbAbove: { label: "📐 Vượt Realized", sub: `top ${Math.min(10, tops?.sb?.above?.length ?? 0)} / ${tops?.sb?.checked ?? 0} coin đủ dữ liệu`, tone: "gold",
        items: (tops?.sb?.above ?? []).map(x => ({ t: x.t, main: `+${x.pct.toFixed(1)}%`, cls: "gold",
          sub: x.since && (Date.now() - Date.parse(x.since)) / 864e5 <= 7 ? `🆕 vượt ${dd(x.since)}` : (x.real ? "Realized thật" : "trên Realized"),
          title: `${x.t}: giá $${(+x.price).toPrecision(5)} cao hơn Realized${x.real ? "" : " ước tính"} $${(+x.realized).toPrecision(5)}${x.since ? ` · vượt từ ${dd(x.since)}` : ""}` })),
        empty: "Chưa có coin nào nằm trên Realized." },
    };
  };
})();
