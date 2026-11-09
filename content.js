// MD Capture content script.
// Triggers:
//   - URL fragment contains "mdcapture" (optionally "mdcapture=scroll")
//   - Message {type: "mdcapture"} from the toolbar button
// Behaviour is fully generic (no per-site rules): before capturing, the
// script waits until the rendered page settles (load complete, DOM quiet,
// visible text length stable). Generic bot-verification interstitials
// ("Just a moment", "Verify you are human", ...) are NEVER captured;
// the script keeps watching until real content replaces them, and gives
// up without saving if they do not clear within INTERSTITIAL_WAIT_MS.
// Duplicate saves of the same URL within DEDUPE_MS are suppressed
// (a reload with the fragment still attached must not re-fire); the
// toolbar button bypasses the suppression for an explicit re-capture.
// Output: POSTs a bundle {markdown, article_markdown, meta, html} to the
// local collector at http://127.0.0.1:8765/save. If the collector is not
// reachable, falls back to downloading the Markdown file.
(function () {
  "use strict";

  var COLLECTOR = "http://127.0.0.1:8765/save";
  var INTERSTITIAL_WAIT_MS = 120000; // max time to wait out a bot check
  var DEDUPE_MS = 30000;             // suppress repeat saves of one URL
  var started = false;
  var capturedKey = "";              // URL (no fragment) saved in this document

  // ---------- generic page helpers ----------

  function absolutize(clone) {
    clone.querySelectorAll("a[href]").forEach(function (a) {
      try { a.setAttribute("href", new URL(a.getAttribute("href"), location.href).href); } catch (e) {}
    });
    clone.querySelectorAll("img[src]").forEach(function (img) {
      try { img.setAttribute("src", new URL(img.getAttribute("src"), location.href).href); } catch (e) {}
      var srcset = img.getAttribute("srcset");
      if (srcset) {
        var parts = srcset.split(",").map(function (p) {
          var bits = p.trim().split(/\s+/);
          try { bits[0] = new URL(bits[0], location.href).href; } catch (e) {}
          return bits.join(" ");
        });
        img.setAttribute("srcset", parts.join(", "));
      }
    });
  }

  function stripNoise(clone) {
    clone.querySelectorAll(
      "script, style, noscript, iframe, object, embed, svg, canvas, video, audio, template"
    ).forEach(function (el) { el.remove(); });
  }

  function makeTurndown() {
    var td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      linkStyle: "inlined",
      bulletListMarker: "-",
      emDelimiter: "_"
    });
    td.addRule("tables", {
      filter: "table",
      replacement: function (content, node) {
        var rows = [];
        node.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr").forEach(function (tr) {
          var cells = [];
          tr.querySelectorAll(":scope > th, :scope > td").forEach(function (c) {
            cells.push(c.textContent.trim().replace(/\s+/g, " ").replace(/\|/g, "\\|"));
          });
          if (cells.length) rows.push(cells);
        });
        if (!rows.length) return "";
        var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
        var out = rows.map(function (r) {
          while (r.length < width) r.push("");
          return "| " + r.join(" | ") + " |";
        });
        var sep = "| " + Array(width).fill("---").join(" | ") + " |";
        return "\n\n" + out[0] + "\n" + sep + "\n" + out.slice(1).join("\n") + "\n\n";
      }
    });
    return td;
  }

  function visibleTextLength() {
    return document.body ? document.body.innerText.length : 0;
  }

  // Generic interstitial class: bot-verification / security-check pages.
  // Matches page *type*, never a specific site.
  function looksInterstitial() {
    var title = document.title || "";
    if (/just a moment|security verification|attention required|checking your browser|are you human|しばらくお待ちください|人間であることを確認/i.test(title)) return true;
    // Challenge-platform scaffolding present in the DOM (the interstitial
    // page itself, not an embedded captcha widget on a real page).
    if (document.querySelector(
      "#challenge-form, #challenge-running, #cf-challenge-running, " +
      'iframe[src*="challenges.cloudflare.com"], ' +
      'script[src*="challenge-platform"]')) return true;
    var text = document.body ? document.body.innerText : "";
    if (text.length < 1500 &&
        /verify you are human|security verification|verifies you are not a bot|checking your browser|あなたが人間であることを確認|ロボットではないことを確認/i.test(text)) return true;
    return false;
  }

  // Wait until the page settles: load complete + DOM quiet for 1.2s +
  // visible text length stable across two samples. Hard cap maxMs.
  // `done` fires exactly once: the safety timeout is cancelled when the
  // settle check wins (previously both paths fired, saving the page
  // twice ~maxMs apart).
  function whenSettled(done, maxMs) {
    var deadline = Date.now() + (maxMs || 12000);
    var lastLen = -1;
    var stableCount = 0;
    var timer = null;
    var finished = false;
    var observer = new MutationObserver(function () { schedule(); });
    function finish() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      clearTimeout(safety);
      observer.disconnect();
      done();
    }
    function schedule() {
      if (finished) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 1200);
    }
    function check() {
      if (finished) return;
      var len = visibleTextLength();
      if (len === lastLen) { stableCount++; } else { stableCount = 0; lastLen = len; }
      var settled = document.readyState === "complete" && stableCount >= 1;
      if (settled || Date.now() > deadline) {
        finish();
      } else {
        schedule();
      }
    }
    if (document.readyState === "complete") { schedule(); }
    else { window.addEventListener("load", schedule, { once: true }); setTimeout(schedule, 3000); }
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    var safety = setTimeout(finish, (maxMs || 12000) + 2000);
  }

  function collectMeta(extra) {
    var meta = {
      url: location.href,
      title: document.title || "",
      captured_at: new Date().toISOString(),
      description: "",
      canonical: "",
      meta_tags: {},
      json_ld: [],
      links: [],
      images: [],
      counts: {}
    };
    if (extra) { for (var k in extra) meta[k] = extra[k]; }
    document.querySelectorAll("meta").forEach(function (m) {
      var key = m.getAttribute("property") || m.getAttribute("name");
      var val = m.getAttribute("content");
      if (key && val) {
        meta.meta_tags[key] = val;
        if (key === "description" || key === "og:description") meta.description = val;
      }
    });
    var canon = document.querySelector('link[rel="canonical"]');
    if (canon) meta.canonical = canon.href;
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      var raw = s.textContent.trim();
      if (!raw) return;
      try { meta.json_ld.push(JSON.parse(raw)); } catch (e) { meta.json_ld.push(raw); }
    });
    var seenLinks = {};
    document.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.href;
      if (!href || seenLinks[href]) return;
      seenLinks[href] = true;
      meta.links.push({ text: (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200), href: href });
    });
    document.querySelectorAll("img[src]").forEach(function (img) {
      meta.images.push({ alt: img.getAttribute("alt") || "", src: img.src });
    });
    meta.counts = {
      links: meta.links.length,
      images: meta.images.length,
      tables: document.querySelectorAll("table").length,
      headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length
    };
    return meta;
  }

  function scrollThroughPage(done) {
    var y = 0;
    var timer = setInterval(function () {
      var max = Math.max(document.body ? document.body.scrollHeight : 0,
                         document.documentElement.scrollHeight);
      y += Math.floor(window.innerHeight * 0.9);
      window.scrollTo(0, y);
      if (y >= max || y >= 60000) {
        clearInterval(timer);
        window.scrollTo(0, 0);
        setTimeout(done, 400);
      }
    }, 180);
  }

  function badge(text, ok) {
    var el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;" +
      "background:" + (ok ? "#137333" : "#b3261e") + ";color:#fff;padding:8px 12px;" +
      "border-radius:6px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    document.documentElement.appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  function downloadFallback(md) {
    var blob = new Blob([md], { type: "text/markdown" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (document.title || "page").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) + ".md";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- capture ----------

  function doCapture(withScroll, flags, force) {
    var run = function () {
      // Final guards, checked at save time (not when the wait started):
      // never save a bot-verification page, and never save the same URL
      // twice in quick succession (reload with the fragment attached,
      // double-fired triggers). The toolbar button passes force=true.
      if (looksInterstitial()) return;
      var key = location.href.split("#")[0];
      if (!force) {
        if (capturedKey === key) return;
        try {
          var last = JSON.parse(sessionStorage.getItem("mdcapture:last") || "null");
          if (last && last.url === key && Date.now() - last.at < DEDUPE_MS) return;
        } catch (e) { /* sessionStorage unavailable: in-document guard still applies */ }
      }
      capturedKey = key;
      try {
        sessionStorage.setItem("mdcapture:last", JSON.stringify({ url: key, at: Date.now() }));
      } catch (e) {}
      try {
        var html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
        var meta = collectMeta(flags);

        var td = makeTurndown();
        var bodyClone = document.body ? document.body.cloneNode(true) : document.documentElement.cloneNode(true);
        absolutize(bodyClone);
        stripNoise(bodyClone);
        var markdown = td.turndown(bodyClone);

        var articleMarkdown = "";
        try {
          var docClone = document.cloneNode(true);
          var parsed = new Readability(docClone).parse();
          if (parsed && parsed.content) {
            articleMarkdown = td.turndown(parsed.content);
            meta.article = { title: parsed.title || "", excerpt: parsed.excerpt || "",
                             length: (parsed.textContent || "").length };
          }
        } catch (e) { /* Readability is best effort */ }

        var payload = {
          url: location.href,
          host: location.hostname,
          path: location.pathname,
          title: document.title || "",
          markdown: markdown,
          article_markdown: articleMarkdown,
          meta: meta,
          html: html
        };

        fetch(COLLECTOR, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (res) {
          if (!res.ok) throw new Error("collector " + res.status);
          badge("MD captured (" + Math.round(markdown.length / 1024) + " KB)", true);
        }).catch(function () {
          downloadFallback(markdown);
          badge("Collector unreachable, downloaded .md instead", false);
        });
      } catch (e) {
        badge("MD capture failed: " + e.message, false);
      }
      if (location.hash.indexOf("mdcapture") !== -1) {
        history.replaceState(null, "", location.pathname + location.search);
      }
    };
    if (withScroll) scrollThroughPage(run); else run();
  }

  function start(withScroll, force) {
    if (started) return;
    started = true;
    var beginAt = Date.now();
    (function attempt() {
      if (looksInterstitial()) {
        // Verification page: save nothing. Keep re-checking until real
        // content replaces it (same-document swap), a navigation loads
        // a new document (which re-triggers automatically), or the wait
        // budget runs out -- in which case give up without saving.
        if (Date.now() - beginAt > INTERSTITIAL_WAIT_MS) {
          badge("Bot verification did not clear; nothing captured", false);
          return;
        }
        setTimeout(attempt, 1000);
        return;
      }
      whenSettled(function () {
        if (looksInterstitial()) { setTimeout(attempt, 1000); return; }
        doCapture(withScroll, { settle_ms: Date.now() - beginAt }, force);
      }, 12000);
    })();
  }

  if (location.hash.indexOf("mdcapture") !== -1) {
    setTimeout(function () { start(location.hash.indexOf("scroll") !== -1, false); }, 300);
  }
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "mdcapture") {
      started = false;
      start(false, true);
    }
  });
})();
