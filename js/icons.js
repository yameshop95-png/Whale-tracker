/* Small neon icons for section headings, legends, and buttons. Decorative: alt is empty. */
(function () {
  const TAB = "/brand/tabs/";
  const SRC = {
    whale: TAB + "whale-alert-128.png",
    gem: TAB + "gem-128.png",
    risk: TAB + "risk-score-128.png",
    flow: TAB + "holder-flow-128.png",
    band: TAB + "smart-band-128.png",
    net: TAB + "network-heatmap-128.png",
    yield: TAB + "yield-calc-128.png"
  };
  function src(name) {
    return SRC[name] || ("/brand/icons/" + name + ".svg");
  }
  function ni(name, px) {
    px = px || 28;
    return '<img class="ni" src="' + src(name) + '" alt="" width="' + px + '" height="' + px + '" decoding="async">';
  }
  function niNode(name, px) {
    const img = document.createElement("img");
    img.className = "ni";
    img.src = src(name);
    img.alt = "";
    img.width = img.height = px || 28;
    img.decoding = "async";
    return img;
  }
  /* Replace an element's contents with an icon plus plain text. */
  function niFill(el, name, text) {
    el.replaceChildren();
    if (name) el.appendChild(niNode(name, 22));
    if (text) el.append(document.createTextNode(text));
  }
  window.ni = ni;
  window.niNode = niNode;
  window.niFill = niFill;
})();
