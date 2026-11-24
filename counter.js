// counter.js (Wake 235): counts a visit to this page and shows the totals.
// Stores nothing about you on the server: only the page, the day and the count.
(function () {
  var p = location.pathname.replace(/\.html$/, "").replace(/\/index$/, "/").replace(/(.)\/$/, "$1") || "/";
  if (p === "/research.html") p = "/research";
  var day = new Date().toISOString().slice(0, 10), first = true, key = "acton-seen:" + p;
  try { first = localStorage.getItem(key) !== day; localStorage.setItem(key, day); } catch (e) {}
  function fmt(n) { return Number(n || 0).toLocaleString("en-CA"); }
  function show(t) {
    var el = document.getElementById("visit-count");
    if (!el) {
      el = document.createElement("p"); el.id = "visit-count";
      el.style.cssText = "text-align:center;font:13px/1.5 system-ui,sans-serif;opacity:.65;margin:24px auto 18px;padding:0 16px";
      document.body.appendChild(el);
    }
    el.textContent = fmt(t.views) + (t.views == 1 ? " visit" : " visits") + " to this page, " + fmt(t.visitors) + (t.visitors == 1 ? " daily visitor" : " daily visitors") + (t.since ? " (counted since " + t.since + ")" : "");
  }
  fetch("/api/hit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: p, first: first }) })
    .then(function (r) { return r.json(); }).then(function (t) { if (t && t.ok) show(t); }).catch(function () {});
  if (p === "/tools") {
    document.querySelectorAll('a.btn.solid[href^="/"]').forEach(function (a) {
      var h = a.getAttribute("href"); if (h === "/" || a.nextElementSibling && a.nextElementSibling.hasAttribute("data-views")) return;
      var s = document.createElement("span"); s.setAttribute("data-views", h);
      s.style.cssText = "font-size:13px;opacity:.7;margin-left:10px;white-space:nowrap"; a.insertAdjacentElement("afterend", s);
    });
  }
  var slots = document.querySelectorAll("[data-views]");
  if (slots.length) fetch("/api/views").then(function (r) { return r.json(); }).then(function (d) {
    slots.forEach(function (s) { var t = (d.pages || {})[s.getAttribute("data-views")]; s.textContent = t ? fmt(t.views) + (t.views == 1 ? " visit" : " visits") : "new"; });
  }).catch(function () {});
})();
