/**
 * hf.js — the thin client for the write-API in front of this site
 * (see worker/index.js). Loaded on every page.
 *
 * Everything here is deliberately defensive: the site is a static build first,
 * and it has to read exactly the same when /api is down, blocked or not yet
 * deployed. Nothing in here ever throws into the page.
 */
(function () {
  "use strict";

  var PIN_KEY = "hf_pin";
  var WHO_KEY = "hf_who";

  function readStore(key) {
    try {
      return window.localStorage.getItem(key) || "";
    } catch (err) {
      return ""; // private mode — we just won't remember
    }
  }

  function writeStore(key, value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch (err) { /* ignore */ }
  }

  /**
   * Always resolves: { ok, status, body }. Network failures land as status 0.
   * `path` is the full same-origin path, e.g. "/api/pending".
   */
  function request(path, options) {
    if (typeof fetch !== "function") {
      return Promise.resolve({ ok: false, status: 0, body: {} });
    }
    return fetch(path, options).then(
      function (res) {
        return res.text().then(function (text) {
          var body = {};
          try { body = JSON.parse(text) || {}; } catch (err) { /* not JSON */ }
          return { ok: res.ok, status: res.status, body: body };
        });
      },
      function () {
        return { ok: false, status: 0, body: {} };
      }
    );
  }

  function get(path) {
    return request(path, { headers: { accept: "application/json" } });
  }

  function post(path, payload) {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  /** A sentence we are happy to show a human. */
  function message(res) {
    if (!res) return "Something went wrong.";
    if (res.status === 0) return "Couldn’t reach the server — check your connection.";
    if (res.status === 403) return "Wrong PIN";
    if (res.body && res.body.error) return res.body.error;
    return "Something went wrong (" + res.status + ").";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  /**
   * Comparable form of a listing URL: no scheme, no www, no query, no trailing
   * slash. Used to spot a pending submission we already track.
   */
  function normUrl(value) {
    if (!value || typeof value !== "string") return "";
    return value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("#")[0]
      .split("?")[0]
      .replace(/\/+$/, "");
  }

  function whoLabel(who) {
    return who === "evelyn" ? "Evelyn" : "Matt";
  }

  /** "Aug 9" — matches the short dates the build already prints. */
  function dateLabel(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function minsLabel(commute) {
    if (!commute || typeof commute.min !== "number") return "";
    return Math.round(commute.min) + " min";
  }

  var PIN_INPUT_CLASS =
    "h-11 w-24 rounded-xl border border-sand-300 bg-white px-3 text-sm text-sand-800 placeholder:text-sand-400";

  /**
   * The little "Remove" control on a pending card / map popup: a quiet button
   * that opens a PIN box, posts /api/resolve and then gets out of the way.
   * Returns a DOM node so the same code serves the dashboard and a Leaflet
   * popup (which is always light, hence no dark: variants in here).
   */
  function removeControl(item, onRemoved) {
    var wrap = document.createElement("div");
    wrap.className = "hf-remove";
    wrap.innerHTML =
      '<button type="button" class="hf-remove-open inline-flex h-8 items-center rounded-lg px-2 text-xs font-medium text-sand-500 hover:bg-rose-50 hover:text-rose-600">Remove</button>' +
      '<form class="hf-remove-form hidden items-center gap-1.5 pt-1" novalidate>' +
      '<label class="sr-only" for="' + "hf-rm-" + escapeHtml(item.id) + '">PIN</label>' +
      '<input id="hf-rm-' + escapeHtml(item.id) + '" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" class="hf-remove-pin ' + PIN_INPUT_CLASS + '">' +
      '<button type="submit" class="inline-flex h-11 items-center rounded-xl bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700">Remove</button>' +
      '<button type="button" class="hf-remove-cancel inline-flex h-11 items-center rounded-xl px-2 text-xs font-medium text-sand-500 hover:text-sand-700">Cancel</button>' +
      "</form>" +
      '<p class="hf-remove-msg mt-1 hidden text-xs font-medium text-rose-600" role="status"></p>';

    var openBtn = wrap.querySelector(".hf-remove-open");
    var form = wrap.querySelector(".hf-remove-form");
    var pin = wrap.querySelector(".hf-remove-pin");
    var cancel = wrap.querySelector(".hf-remove-cancel");
    var msg = wrap.querySelector(".hf-remove-msg");
    var busy = false;

    function show(open) {
      form.classList.toggle("hidden", !open);
      form.classList.toggle("flex", open);
      // Inline styles rather than a `hidden` class: the button already carries
      // a display utility, and Tailwind's own ordering decides which wins.
      openBtn.style.display = open ? "none" : "";
      // Give the PIN row a line of its own inside a wrapping card footer.
      wrap.style.width = open ? "100%" : "";
      if (open) {
        pin.value = getPin();
        pin.focus();
      }
    }

    openBtn.addEventListener("click", function () { show(true); });
    cancel.addEventListener("click", function () {
      msg.classList.add("hidden");
      show(false);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (busy) return;
      busy = true;
      msg.classList.remove("hidden");
      msg.classList.remove("text-rose-600");
      msg.classList.add("text-sand-500");
      msg.textContent = "Removing…";

      post("/api/resolve", { id: item.id, pin: pin.value }).then(function (res) {
        busy = false;
        if (res.ok) {
          setPin(pin.value);
          if (typeof onRemoved === "function") onRemoved();
          return;
        }
        msg.classList.remove("text-sand-500");
        msg.classList.add("text-rose-600");
        msg.textContent = message(res);
        if (res.status === 403) shake(pin);
      });
    });

    return wrap;
  }

  /** A short nudge on a field that was wrong — no layout shift, no alert(). */
  function shake(el) {
    if (!el) return;
    el.classList.remove("hf-shake");
    // Force a reflow so the animation can restart on a second wrong PIN.
    void el.offsetWidth;
    el.classList.add("hf-shake");
    el.focus();
    el.select && el.select();
  }

  function getPin() { return readStore(PIN_KEY); }
  function setPin(value) { writeStore(PIN_KEY, value); }
  function getWho() { return readStore(WHO_KEY) === "evelyn" ? "evelyn" : "matt"; }
  function setWho(value) { writeStore(WHO_KEY, value === "evelyn" ? "evelyn" : "matt"); }

  /** Pending submissions, newest first. [] whenever the API is unhappy. */
  function pending() {
    return get("/api/pending").then(function (res) {
      if (!res.ok || !Array.isArray(res.body)) return [];
      return res.body.slice().sort(function (a, b) {
        return String(b.ts || "").localeCompare(String(a.ts || ""));
      });
    });
  }

  /** Archived listings as { "<listing-id>": { who, ts, reason } }. */
  function hidden() {
    return get("/api/hidden").then(function (res) {
      var index = {};
      if (!res.ok || !Array.isArray(res.body)) return index;
      res.body.forEach(function (row) {
        if (row && row.listing_id) index[row.listing_id] = row;
      });
      return index;
    });
  }

  // ---------------------------------------------------------------------------
  // Favorites (hearts). Matt and Evelyn each get their own heart per listing,
  // so a listing can be loved by one of them or both. The read is open, only
  // the toggle needs the PIN.
  // ---------------------------------------------------------------------------

  var favPromise = null;

  /**
   * Hearts as { "<listing-id>": { matt: ts|null, evelyn: ts|null } }.
   * Fetched once per page load and shared by every widget on it; resolves to
   * {} whenever /api is unhappy, so callers never need a catch.
   */
  function favorites() {
    if (!favPromise) {
      favPromise = get("/api/favorites").then(function (res) {
        var index = {};
        if (!res.ok || !Array.isArray(res.body)) return index;
        res.body.forEach(function (row) {
          if (!row || !row.listing_id) return;
          if (row.who !== "matt" && row.who !== "evelyn") return;
          var entry = index[row.listing_id];
          if (!entry) entry = index[row.listing_id] = { matt: null, evelyn: null };
          entry[row.who] = row.ts || true;
        });
        return index;
      });
    }
    return favPromise;
  }

  /** Keep the cached index honest after a successful toggle. */
  function favMark(index, listingId, who, on) {
    if (!index || !listingId) return;
    var entry = index[listingId];
    if (on) {
      if (!entry) entry = index[listingId] = { matt: null, evelyn: null };
      entry[who] = new Date().toISOString();
    } else if (entry) {
      entry[who] = null;
      if (!entry.matt && !entry.evelyn) delete index[listingId];
    }
  }

  /** [{ who, label, initial }] for one entry, Matt first. [] when nobody. */
  function favPeople(entry) {
    if (!entry) return [];
    return ["matt", "evelyn"]
      .filter(function (who) { return Boolean(entry[who]); })
      .map(function (who) {
        return { who: who, label: whoLabel(who), initial: who === "evelyn" ? "E" : "M" };
      });
  }

  /**
   * Badge markup for one entry. "compact" collapses to a single ❤ M+E pill for
   * cards and table rows; "full" gives a pill per person for the listing page.
   */
  function favBadges(entry, style) {
    var people = favPeople(entry);
    if (!people.length) return "";
    function pill(visible, spoken, extra) {
      return '<span class="heart-chip' + (extra || "") + '">' +
        '<span aria-hidden="true">&#10084; ' + visible + "</span>" +
        '<span class="sr-only">Favorited by ' + spoken + "</span></span>";
    }
    if (style === "full") {
      return people.map(function (person) {
        return pill(escapeHtml(person.label), escapeHtml(person.label), " heart-chip-lg");
      }).join("");
    }
    return pill(
      people.map(function (person) { return person.initial; }).join("+"),
      people.map(function (person) { return escapeHtml(person.label); }).join(" and ")
    );
  }

  /** Same idea, inline-styled for a Leaflet popup (always a light surface). */
  function favPopupBadges(entry) {
    var people = favPeople(entry);
    if (!people.length) return "";
    return '<p style="margin:0 0 6px;font-size:0.75rem;font-weight:600;color:#a83f5b">' +
      "&#10084; " +
      people.map(function (person) { return escapeHtml(person.label); }).join(" &amp; ") +
      "</p>";
  }

  /** Toggle one heart. Resolves the same { ok, status, body } as post(). */
  function favSet(listingId, who, on, pin) {
    return post("/api/favorite", {
      listing_id: listingId,
      who: who === "evelyn" ? "evelyn" : "matt",
      on: Boolean(on),
      pin: pin
    });
  }

  window.HF = {
    get: get,
    post: post,
    message: message,
    escapeHtml: escapeHtml,
    normUrl: normUrl,
    whoLabel: whoLabel,
    dateLabel: dateLabel,
    minsLabel: minsLabel,
    shake: shake,
    getPin: getPin,
    setPin: setPin,
    getWho: getWho,
    setWho: setWho,
    pending: pending,
    hidden: hidden,
    favorites: favorites,
    favMark: favMark,
    favPeople: favPeople,
    favBadges: favBadges,
    favPopupBadges: favPopupBadges,
    favSet: favSet,
    removeControl: removeControl
  };
})();
