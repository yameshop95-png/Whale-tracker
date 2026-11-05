(function () {
  var drawer = document.getElementById("navDrawer");
  var btn = document.getElementById("navBurger");
  if (!drawer || !btn) return;

  function setOpen(on) {
    drawer.classList.toggle("hidden", !on);
    if (on) drawer.removeAttribute("hidden");
    else drawer.setAttribute("hidden", "");
    document.body.classList.toggle("nav-open", on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
  }

  btn.addEventListener("click", function () {
    setOpen(drawer.classList.contains("hidden"));
  });
  var closeBtn = document.getElementById("navDrawerClose");
  if (closeBtn) closeBtn.addEventListener("click", function () { setOpen(false); });
  drawer.addEventListener("click", function (e) {
    if (e.target === drawer) setOpen(false);
  });
  drawer.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("click", function () { setOpen(false); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !drawer.classList.contains("hidden")) setOpen(false);
  });

  var HASHES = { "#defi": 1, "#flowstocks": 1, "#metas": 1, "#rwa": 1 };
  function hereFile() {
    var path = location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || /\/index\.html$/.test(path)) return "/";
    return path.split("/").pop();
  }
  function mark() {
    var file = hereFile();
    var hash = location.hash || "";
    var hashOn = !!HASHES[hash] && file === "/";
    drawer.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var on = false;
      var hashAt = href.indexOf("#");
      if (hashAt === 0 || href.indexOf("/#") === 0) {
        on = href.slice(hashAt) === hash && file === "/";
      } else if (href === "/") {
        on = file === "/" && !hashOn;
      } else {
        on = file === href.replace(/^\//, "");
      }
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  window.addEventListener("hashchange", mark);
  mark();
})();
