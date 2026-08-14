/**
 * map-app.js — the map-first homepage.
 *
 * Data: the inline #map-config feed (baked at build) is the fallback; GET
 * /api/data is preferred because a sweep can push fresher data between
 * deploys. The live layer (pending, hidden, favorites) arrives afterwards via
 * HF and never blocks the first paint.
 *
 * Filters mirror the /list/ page and filter the markers; tapping a marker
 * opens the detail panel with the whole listing story.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    var host = document.getElementById("home-map");
    var configEl = document.getElementById("map-config");
    if (!host || !configEl || typeof L === "undefined") return;

    var feed;
    try { feed = JSON.parse(configEl.textContent); } catch (err) { return; }

    fetch("/api/data")
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (fresh) {
        if (fresh && Array.isArray(fresh.listings)) feed = fresh;
        start();
      });

    var BAND_COLORS = {
      "in-budget": "#059669",
      "stretch": "#d97706",
      "over": "#78716c",
      "unknown": "#64748b"
    };
    var WORK_COLOR = "#2563eb";
    var HOME_COLOR = "#7c3aed";
    var STORE_KEY = "home-finder-map";
    var GROUPS = ["band", "kind", "state", "rating", "new", "fav"];

    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function start() {
      var map = L.map(host, {
        preferCanvas: true,
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 90,
        zoomAnimation: true,
        markerZoomAnimation: true
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      }).addTo(map);

      var panel = document.getElementById("panel");
      var panelBody = document.getElementById("panel-body");
      var panelClose = document.getElementById("panel-close");
      var countEl = document.getElementById("map-count");
      var chips = Array.prototype.slice.call(document.querySelectorAll("[data-group]"));

      var listings = feed.listings.filter(function (l) {
        return typeof l.lat === "number" && typeof l.lon === "number";
      });
      var byId = {};
      listings.forEach(function (l) { byId[l.id] = l; });

      var markers = {};      // id -> circleMarker (created once, added/removed on filter)
      var favIndex = {};     // id -> { matt, evelyn }
      var favsLoaded = false;
      var hiddenIds = {};    // id -> true once /api/hidden lands
      var selectedId = null;
      // With the canvas renderer a marker click also reaches the map; this
      // flag keeps that second event from instantly closing the panel.
      var suppressMapClick = false;

      var active = { band: [], kind: [], state: [], rating: [], new: [], fav: [] };
      try {
        var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
        if (saved) GROUPS.forEach(function (g) {
          if (Array.isArray(saved[g])) active[g] = saved[g];
        });
      } catch (err) { /* ignore */ }

      // ----- markers ---------------------------------------------------------

      function baseStyle(l) {
        var fav = favIndex[l.id];
        return {
          radius: l.id === selectedId ? 12 : fav ? 10 : 8,
          color: l.id === selectedId ? "#a95c34" : "#ffffff",
          weight: l.id === selectedId ? 3 : fav ? 3 : 2,
          opacity: l.isGone ? 0.5 : 1,
          fillColor: BAND_COLORS[l.band] || BAND_COLORS.unknown,
          fillOpacity: l.isGone ? 0.35 : 0.95
        };
      }

      listings.forEach(function (l) {
        var marker = L.circleMarker([l.lat, l.lon], baseStyle(l));
        marker.on("click", function () {
          suppressMapClick = true;
          select(l.id);
        });
        marker.on("mouseover", function () {
          if (l.id !== selectedId) marker.setRadius(11);
          marker.bindTooltip(
            (l.rentLabel || "Rent TBD") + " · " + l.title,
            { direction: "top", offset: [0, -10], opacity: 0.95 }
          ).openTooltip();
        });
        marker.on("mouseout", function () {
          marker.setStyle(baseStyle(l));
          marker.setRadius(baseStyle(l).radius);
          marker.closeTooltip();
        });
        markers[l.id] = marker;
      });

      // Work & family anchors.
      [["work", WORK_COLOR, "💼", "Work"], ["home", HOME_COLOR, "🏠", "Family"]].forEach(function (row) {
        var anchor = feed.anchors && feed.anchors[row[0]];
        if (!anchor || anchor.lat == null) return;
        L.marker([anchor.lat, anchor.lon], {
          icon: L.divIcon({
            className: "",
            html: '<span class="anchor-pin" style="background:' + row[1] + '">' + row[2] + "</span>",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -16]
          }),
          title: anchor.label,
          alt: row[3] + ": " + anchor.label,
          zIndexOffset: 1000
        }).addTo(map).bindPopup("<strong>" + row[3] + "</strong><br>" + esc(anchor.label));
      });

      // ----- filtering -------------------------------------------------------

      function matches(l) {
        if (hiddenIds[l.id]) return false;
        if (active.band.length && active.band.indexOf(l.band) === -1) return false;
        if (active.kind.length && active.kind.indexOf(l.kind) === -1) return false;
        if (active.state.length && active.state.indexOf(l.state) === -1) return false;
        if (active.rating.length && (l.rating || 0) < 4) return false;
        if (active.new.length && !l.isNew) return false;
        if (active.fav.length && favsLoaded && !favIndex[l.id]) return false;
        return true;
      }

      function anyFilterActive() {
        return GROUPS.some(function (g) { return active[g].length > 0; });
      }

      function applyFilters(fit) {
        var visible = 0;
        var bounds = [];
        listings.forEach(function (l) {
          var show = matches(l);
          var marker = markers[l.id];
          if (show && !map.hasLayer(marker)) marker.addTo(map);
          if (!show && map.hasLayer(marker)) map.removeLayer(marker);
          if (show) { visible++; bounds.push([l.lat, l.lon]); }
        });
        if (countEl) {
          countEl.textContent = anyFilterActive()
            ? visible + " of " + listings.length
            : listings.length + " listings";
        }
        if (selectedId && !matches(byId[selectedId] || {})) closePanel();
        chips.forEach(function (chip) {
          var group = chip.getAttribute("data-group");
          if (group === "all") {
            chip.setAttribute("aria-pressed", anyFilterActive() ? "false" : "true");
            return;
          }
          var on = active[group] && active[group].indexOf(chip.getAttribute("data-value")) !== -1;
          chip.setAttribute("aria-pressed", on ? "true" : "false");
        });
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify(active)); } catch (err) { /* ignore */ }
        if (fit && bounds.length) {
          if (feed.anchors) ["work", "home"].forEach(function (key) {
            var a = feed.anchors[key];
            if (a && a.lat != null) bounds.push([a.lat, a.lon]);
          });
          map.fitBounds(bounds, { padding: [30, 30] });
        }
      }

      chips.forEach(function (chip) {
        chip.addEventListener("click", function () {
          var group = chip.getAttribute("data-group");
          if (group === "all") {
            active = { band: [], kind: [], state: [], rating: [], new: [], fav: [] };
          } else {
            var list = active[group];
            var at = list.indexOf(chip.getAttribute("data-value"));
            if (at === -1) list.push(chip.getAttribute("data-value")); else list.splice(at, 1);
          }
          applyFilters(false);
        });
      });

      // ----- detail panel ----------------------------------------------------

      function stars(rating) {
        var out = "";
        for (var i = 0; i < 5; i++) {
          out += i < rating
            ? '<span aria-hidden="true">★</span>'
            : '<span aria-hidden="true" class="text-sand-300 dark:text-sand-700">★</span>';
        }
        return '<span class="text-amber-500" aria-label="Rated ' + rating + ' of 5">' + out + "</span>";
      }

      function chipHtml(text, cls) {
        return '<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold ' + cls + '">' + text + "</span>";
      }

      function bulletList(items, dotCls) {
        return items.map(function (item) {
          return '<li class="flex gap-2 text-sm leading-relaxed text-sand-700 dark:text-sand-200">' +
            '<span class="mt-[0.45em] h-1.5 w-1.5 shrink-0 rounded-full ' + dotCls + '" aria-hidden="true"></span>' +
            "<span>" + esc(item) + "</span></li>";
        }).join("");
      }

      function factCell(label, value) {
        return '<div class="bg-white px-3 py-2.5 dark:bg-sand-900">' +
          '<dt class="text-[0.6875rem] font-medium text-sand-500 dark:text-sand-400">' + label + "</dt>" +
          '<dd class="mt-0.5 text-sm font-medium text-sand-800 dark:text-sand-100">' +
          (value ? esc(value) : '<span class="text-sand-400 dark:text-sand-500">Not listed</span>') +
          "</dd></div>";
      }

      function panelHtml(l) {
        var fav = favIndex[l.id];
        var pills = [];
        if (l.isNew && !l.isGone) pills.push(chipHtml("New", "border-teal-500/40 bg-teal-100/70 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200"));
        pills.push('<span class="band-pill inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold">' + esc(l.bandLabel) + "</span>");
        if (l.tierLabel) pills.push(chipHtml(esc(l.tierLabel), "border-sand-200 bg-sand-100 text-sand-600 dark:border-sand-700 dark:bg-sand-800 dark:text-sand-300"));
        pills.push(chipHtml(esc(l.kind === "townhouse" ? "Townhouse" : "Apartment"), "border-sand-200 bg-sand-100 text-sand-600 dark:border-sand-700 dark:bg-sand-800 dark:text-sand-300"));
        if (l.isGone) pills.push(chipHtml("No longer listed", "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"));
        else if (l.verificationLabel) pills.push(chipHtml(esc(l.verificationLabel),
          l.verificationTone === "good"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
            : "border-sand-200 bg-sand-100 text-sand-600 dark:border-sand-700 dark:bg-sand-800 dark:text-sand-300"));
        if (fav && window.HF) pills.push(HF.favBadges(fav, "full"));

        var gallery = l.gallery || [];
        var hero = gallery[0] || l.img;
        var specs = [];
        if (l.bedsLabel) specs.push(l.bedsLabel === "Studio" ? "Studio" : l.bedsLabel + " bd");
        if (l.bathsLabel) specs.push(l.bathsLabel + " ba");
        if (l.sqftLabel) specs.push(l.sqftLabel);

        return '<article class="band-' + esc(l.band) + '">' +

          (hero
            ? '<img id="panel-hero" src="' + esc(hero) + '" alt="Photo of ' + esc(l.title) + '" class="aspect-[16/10] w-full bg-sand-100 object-cover dark:bg-sand-800">'
            : '<div class="photo-placeholder flex aspect-[16/10] w-full items-center justify-center text-xs font-medium text-sand-500 dark:text-sand-400">No photo yet</div>') +

          (gallery.length > 1
            ? '<div id="panel-thumbs" class="grid grid-cols-5 gap-1.5 px-3 pt-2" role="group" aria-label="Photos">' +
              gallery.map(function (src, i) {
                return '<button type="button" data-src="' + esc(src) + '" aria-pressed="' + (i === 0 ? "true" : "false") + '" class="overflow-hidden rounded-md border-2 aria-pressed:border-clay-600 ' + (i === 0 ? "border-clay-600" : "border-transparent") + '">' +
                  '<img src="' + esc(src) + '" alt="Photo ' + (i + 1) + '" loading="lazy" class="aspect-[4/3] w-full object-cover"></button>';
              }).join("") + "</div>"
            : "") +

          '<div class="flex flex-col gap-3 p-4">' +

            '<header>' +
              '<h2 class="font-serif text-xl font-semibold leading-tight text-sand-900 dark:text-sand-50">' + esc(l.title) + "</h2>" +
              '<p class="mt-0.5 text-xs text-sand-500 dark:text-sand-400">' +
                (l.subtitle ? esc(l.subtitle) + " &middot; " : "") + esc(l.place) + "</p>" +
              '<div class="mt-2 flex flex-wrap items-center gap-1.5">' + pills.join("") + "</div>" +
            "</header>" +

            '<div class="flex items-end justify-between gap-3 rounded-xl border border-sand-200 bg-white p-3 dark:border-sand-800 dark:bg-sand-900">' +
              "<div>" +
                '<p class="font-serif text-3xl font-semibold leading-none tabular-nums text-sand-900 dark:text-sand-50">' + (l.rentLabel || "Rent TBD") + "</p>" +
                '<p class="mt-1 text-xs text-sand-500 dark:text-sand-400">' +
                  (l.overByLabel
                    ? '<span class="font-semibold ' + (l.band === "stretch" ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400") + '">' + esc(l.overByLabel) + " over budget</span>"
                    : l.rentLabel ? "per month" : "call to ask") + "</p>" +
              "</div>" +
              '<p class="text-base leading-none">' + stars(l.rating || 0) + "</p>" +
            "</div>" +

            (specs.length ? '<p class="text-sm text-sand-600 dark:text-sand-300">' + specs.join(" &middot; ") + "</p>" : "") +

            '<div class="grid grid-cols-2 gap-2">' +
              '<div class="rounded-xl border border-sand-200 bg-white p-3 dark:border-sand-800 dark:bg-sand-900">' +
                '<p class="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-sand-500 dark:text-sand-400"><span class="h-2 w-2 rounded-full bg-route-work" aria-hidden="true"></span> Work</p>' +
                '<p class="mt-1 text-sm font-semibold tabular-nums ' + (l.workSlow ? "text-rose-600 dark:text-rose-400" : "text-sand-900 dark:text-sand-50") + '">' + (l.workLabel || "—") + "</p>" +
              "</div>" +
              '<div class="rounded-xl border border-sand-200 bg-white p-3 dark:border-sand-800 dark:bg-sand-900">' +
                '<p class="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-sand-500 dark:text-sand-400"><span class="h-2 w-2 rounded-full bg-route-home" aria-hidden="true"></span> Family</p>' +
                '<p class="mt-1 text-sm font-semibold tabular-nums text-sand-900 dark:text-sand-50">' + (l.homeLabel || "—") + "</p>" +
              "</div>" +
            "</div>" +

            '<dl class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-sand-200 bg-sand-200 dark:border-sand-800 dark:bg-sand-800">' +
              factCell("Available", l.available) +
              factCell("Lease", l.lease) +
              factCell("Move-in cost", l.moveIn) +
              factCell("Added", l.addedLabel) +
            "</dl>" +

            (l.pros && l.pros.length
              ? '<section class="rounded-xl border border-emerald-200/70 bg-emerald-50/50 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/25">' +
                '<h3 class="font-serif text-sm font-semibold text-emerald-800 dark:text-emerald-300">What we like</h3>' +
                '<ul class="mt-1.5 space-y-1">' + bulletList(l.pros, "bg-emerald-500") + "</ul></section>"
              : "") +

            (l.cons && l.cons.length
              ? '<section class="rounded-xl border border-amber-200/70 bg-amber-50/50 p-3 dark:border-amber-900/60 dark:bg-amber-950/25">' +
                '<h3 class="font-serif text-sm font-semibold text-amber-800 dark:text-amber-300">Watch out for</h3>' +
                '<ul class="mt-1.5 space-y-1">' + bulletList(l.cons, "bg-amber-500") + "</ul></section>"
              : "") +

            (l.notes
              ? '<section class="rounded-xl border border-sand-200 bg-white p-3 dark:border-sand-800 dark:bg-sand-900">' +
                '<h3 class="font-serif text-sm font-semibold text-sand-900 dark:text-sand-50">Notes</h3>' +
                '<p class="mt-1 text-sm leading-relaxed text-sand-600 dark:text-sand-300">' + esc(l.notes) + "</p></section>"
              : "") +

            '<div class="flex flex-wrap gap-2 pb-2 pt-1">' +
              '<a href="/listing/' + encodeURIComponent(l.id) + '/" class="tap grow gap-2 rounded-xl bg-clay-600 px-4 text-sm font-semibold text-white hover:bg-clay-700">Full page &rarr;</a>' +
              (l.url
                ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" class="tap grow gap-2 rounded-xl border border-sand-300 bg-white px-4 text-sm font-semibold text-sand-700 hover:border-clay-400 hover:text-clay-700 dark:border-sand-700 dark:bg-sand-900 dark:text-sand-200 dark:hover:text-clay-300">Original listing &#8599;</a>'
                : "") +
            "</div>" +

          "</div></article>";
      }

      function openPanel(l) {
        panelBody.innerHTML = panelHtml(l);
        panelBody.scrollTop = 0;
        panel.classList.remove("translate-x-full");
        panel.setAttribute("aria-hidden", "false");

        var heroEl = document.getElementById("panel-hero");
        var thumbs = document.getElementById("panel-thumbs");
        if (thumbs && heroEl) {
          Array.prototype.forEach.call(thumbs.querySelectorAll("button"), function (button) {
            button.addEventListener("click", function () {
              heroEl.src = button.getAttribute("data-src");
              Array.prototype.forEach.call(thumbs.querySelectorAll("button"), function (other) {
                var on = other === button;
                other.setAttribute("aria-pressed", on ? "true" : "false");
                other.classList.toggle("border-clay-600", on);
                other.classList.toggle("border-transparent", !on);
              });
            });
          });
        }
      }

      function closePanel() {
        panel.classList.add("translate-x-full");
        panel.setAttribute("aria-hidden", "true");
        var prev = selectedId;
        selectedId = null;
        if (prev && markers[prev]) markers[prev].setStyle(baseStyle(byId[prev]));
        if (history.replaceState) history.replaceState(null, "", location.pathname + location.search);
      }

      /** Pan so the marker sits centred in the part of the map the panel doesn't cover. */
      function panIntoView(latlng) {
        var panelWidth = window.innerWidth >= 640 ? panel.offsetWidth : 0;
        var target = map.latLngToContainerPoint(latlng);
        var want = L.point((map.getSize().x - panelWidth) / 2, map.getSize().y / 2);
        map.panBy(target.subtract(want), { animate: true, duration: 0.45, easeLinearity: 0.3 });
      }

      function select(id) {
        var l = byId[id];
        if (!l) return;
        var prev = selectedId;
        selectedId = id;
        if (prev && markers[prev]) markers[prev].setStyle(baseStyle(byId[prev]));
        markers[id].setStyle(baseStyle(l));
        markers[id].bringToFront();
        openPanel(l);
        var latlng = L.latLng(l.lat, l.lon);
        if (map.getZoom() < 12) {
          // Fly to a centre shifted right, so the marker lands in the middle
          // of the part of the map the panel doesn't cover.
          var pw = window.innerWidth >= 640 ? panel.offsetWidth : 0;
          var centre = map.unproject(map.project(latlng, 13).add(L.point(pw / 2, 0)), 13);
          map.flyTo(centre, 13, { duration: 0.6 });
        } else {
          panIntoView(latlng);
        }
        if (history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(id));
      }

      panelClose.addEventListener("click", closePanel);
      map.on("click", function () {
        if (suppressMapClick) { suppressMapClick = false; return; }
        if (selectedId) closePanel();
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && selectedId) closePanel();
      });

      // ----- first paint -----------------------------------------------------

      applyFilters(true);

      var fromHash = decodeURIComponent((location.hash || "").slice(1));
      if (fromHash && byId[fromHash]) select(fromHash);

      // ----- live layer (never blocks the map) -------------------------------

      if (!window.HF) return;

      HF.hidden().then(function (index) {
        var changed = false;
        Object.keys(index).forEach(function (id) {
          if (byId[id]) { hiddenIds[id] = true; changed = true; }
        });
        if (changed) applyFilters(false);
      });

      HF.favorites().then(function (index) {
        favIndex = index || {};
        favsLoaded = true;
        Object.keys(favIndex).forEach(function (id) {
          if (markers[id]) markers[id].setStyle(baseStyle(byId[id]));
        });
        applyFilters(false);
        if (selectedId) openPanel(byId[selectedId]); // repaint hearts
      });

      var known = feed.knownUrls || [];
      HF.pending().then(function (items) {
        items.forEach(function (item) {
          if (!Array.isArray(item.coords)) return;
          var key = HF.normUrl(item.url);
          if (key && known.indexOf(key) !== -1) return;

          var marker = L.marker(item.coords, {
            icon: L.divIcon({
              className: "",
              html: '<span class="pending-pin" style="width:18px;height:18px"></span>',
              iconSize: [18, 18],
              iconAnchor: [9, 9],
              popupAnchor: [0, -10]
            }),
            title: item.name || item.address || "Pending listing",
            alt: "Pending: " + (item.name || item.address || "new listing"),
            zIndexOffset: 500
          }).addTo(map);

          var node = document.createElement("div");
          var place = [item.town, item.state].filter(Boolean).join(", ");
          node.innerHTML =
            '<p style="font-weight:600;font-size:0.95rem;margin:0 0 2px">' + esc(item.name || item.address || place || "New listing") + "</p>" +
            '<p style="margin:0 0 6px;font-size:0.75rem;color:#0f766e;font-weight:600">⏳ Pending triage &middot; added by ' +
              esc(HF.whoLabel(item.who)) + "</p>" +
            '<p style="margin:0 0 6px;font-size:0.9rem"><strong>' +
              (typeof item.rent === "number" ? "$" + item.rent.toLocaleString("en-US") : "Rent TBD") + "</strong></p>" +
            '<p style="margin:0 0 2px;font-size:0.78rem"><span style="color:' + WORK_COLOR + '">●</span> Work: ' + (HF.minsLabel(item.commute_work) || "unknown") + "</p>" +
            '<p style="margin:0 0 8px;font-size:0.78rem"><span style="color:' + HOME_COLOR + '">●</span> Family: ' + (HF.minsLabel(item.commute_home) || "unknown") + "</p>" +
            (item.url ? '<a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer" style="font-weight:600;color:#a95c34">Open the listing →</a>' : "");
          node.appendChild(HF.removeControl(item, function () { map.removeLayer(marker); }));
          marker.bindPopup(node, { minWidth: 200 });
        });
      });
    }
  });
})();
