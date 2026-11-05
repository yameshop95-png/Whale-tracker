/* Small neon icons for section headings, legends, and buttons. Decorative: alt is empty. */
(function () {
  const TAB = "/brand/tabs/";
  const SRC = {
    whale: TAB + "whale-alert-48.png",
    gem: TAB + "gem-48.png",
    risk: TAB + "risk-score-48.png",
    flow: TAB + "holder-flow-48.png",
    band: TAB + "smart-band-48.png",
    net: TAB + "network-heatmap-48.png",
    yield: TAB + "yield-calc-48.png"
  };
  function src(name) {
    return SRC[name] || ("/brand/icons/" + name + ".svg");
  }
  function ni(name, px) {
    px = px || 20;
    return '<img class="ni" src="' + src(name) + '" alt="" width="' + px + '" height="' + px + '" decoding="async">';
  }
  function niNode(name, px) {
    const img = document.createElement("img");
    img.className = "ni";
    img.src = src(name);
    img.alt = "";
    img.width = img.height = px || 18;
    img.decoding = "async";
    return img;
  }
  /* Replace an element's contents with an icon plus plain text. */
  function niFill(el, name, text) {
    el.replaceChildren();
    if (name) el.appendChild(niNode(name, 16));
    if (text) el.append(document.createTextNode(text));
  }
  window.ni = ni;
  window.niNode = niNode;
  window.niFill = niFill;
})();
