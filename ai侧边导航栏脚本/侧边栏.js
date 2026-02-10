// ==UserScript==
// @name         AI对话侧边导航栏 - GPT/Gemini通用（增量渲染/弱引用/限量渲染）
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  GPT/Gemini 通用：侧边目录/书签/搜索/导出。性能：不再强引用消息节点（避免越聊越卡），新消息只“增量追加”列表，列表渲染限量，点击再定位滚动。
// @author       RenZhe0228
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/564212/AI%E5%AF%B9%E8%AF%9D%E4%BE%A7%E8%BE%B9%E5%AF%BC%E8%88%AA%E6%A0%8F%20-%20ChatGPT%E4%B8%93%E7%94%A8%EF%BC%88%E5%A2%9E%E9%87%8F%E6%B8%B2%E6%9F%93%E5%BC%B1%E5%BC%95%E7%94%A8%E9%99%90%E9%87%8F%E6%B8%B2%E6%9F%93%EF%BC%89.user.js
// @updateURL https://update.greasyfork.org/scripts/564212/AI%E5%AF%B9%E8%AF%9D%E4%BE%A7%E8%BE%B9%E5%AF%BC%E8%88%AA%E6%A0%8F%20-%20ChatGPT%E4%B8%93%E7%94%A8%EF%BC%88%E5%A2%9E%E9%87%8F%E6%B8%B2%E6%9F%93%E5%BC%B1%E5%BC%95%E7%94%A8%E9%99%90%E9%87%8F%E6%B8%B2%E6%9F%93%EF%BC%89.meta.js
// ==/UserScript==

(function () {
  "use strict";
  if (window.__AI_TOC_MULTI__) return;
  window.__AI_TOC_MULTI__ = true;

  const detectSite = () => {
    const host = location.hostname;
    if (host.includes("gemini.google.com")) return "gemini";
    return "gpt";
  };

  const SITE = detectSite();
  const NS = SITE;

  const CFG = {
    symbol: "⌬",
    minW: 220,
    maxW: 560,
    minH: 220,
    maxH: 760,
    defaultH: 520,
    len: 18,
    MAX_CACHE: 3000, // 缓存上限（用于目录/搜索/复制目录）
    MAX_RENDER: 1200, // 列表渲染上限（只渲染最近 N 条，避免 DOM 太大）
    IDLE_TIMEOUT: 800,
  };

  const SITE_CONFIG = {
    gpt: {
      userSelector: 'div[data-message-author-role="user"]',
      allSelector: "div[data-message-author-role]",
      roleOf(el) {
        const role =
          el && el.getAttribute
            ? el.getAttribute("data-message-author-role")
            : "";
        return role === "user" ? "user" : "ai";
      },
    },
    gemini: {
      userSelector: [
        "user-query",
        '[data-test-id="user-message"]',
        ".user-query-bubble",
        'div[data-message-author-role="user"]',
      ].join(","),
      allSelector: [
        "user-query",
        "model-response",
        '[data-test-id="user-message"]',
        '[data-test-id="model-response"]',
        "div[data-message-author-role]",
      ].join(","),
      roleOf(el) {
        if (!el || !el.matches) return "ai";
        if (
          el.matches(
            'user-query,[data-test-id="user-message"],.user-query-bubble,div[data-message-author-role="user"]',
          )
        ) {
          return "user";
        }
        const role = el.getAttribute
          ? el.getAttribute("data-message-author-role")
          : "";
        return role === "user" ? "user" : "ai";
      },
    },
  };

  const Utils = {
    debounce(fn, delay) {
      let timer;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
      };
    },
    storage: {
      get(key, def) {
        const k = `ai-toc-${NS}-${key}`;
        try {
          if (typeof GM_getValue !== "undefined") return GM_getValue(k, def);
          const raw = localStorage.getItem(k);
          return raw ? JSON.parse(raw) : def;
        } catch {
          return def;
        }
      },
      set(key, val) {
        const k = `ai-toc-${NS}-${key}`;
        try {
          if (typeof GM_setValue !== "undefined") return GM_setValue(k, val);
          localStorage.setItem(k, JSON.stringify(val));
        } catch {}
      },
    },
    toast(msg) {
      const div = document.createElement("div");
      div.style.cssText =
        "position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;padding:8px 14px;border-radius:18px;z-index:10001;font-size:13px;backdrop-filter:blur(4px);pointer-events:none;transition:opacity .25s;";
      div.textContent = msg;
      document.body.appendChild(div);
      setTimeout(() => {
        div.style.opacity = "0";
        setTimeout(() => div.remove(), 260);
      }, 1400);
    },
    fastText(el) {
      const t = el && el.textContent ? el.textContent : "";
      return t.replace(/\s+\n/g, "\n").replace(/\n+/g, "\n").trim();
    },
    hash32(str) {
      // FNV-1a
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    },
    escSel(s) {
      // CSS.escape 不是所有环境都有，兜底
      if (window.CSS && CSS.escape) return CSS.escape(s);
      return String(s).replace(/["\\#.:()[\]=>~+*^$|]/g, "\\$&");
    },
  };

  class SideNavMulti {
    constructor() {
      this.site = SITE;
      this.siteConfig = SITE_CONFIG[this.site] || SITE_CONFIG.gpt;
      this.themes = ["light", "dark"];

      this.cache = {
        items: [], // { key, kind, val, weak, hash, txt, lower, preview }
        keySet: new Set(),
        key2item: new Map(),
        node2key: new WeakMap(),
        autoInc: 1,
      };

      this.state = {
        marks: new Set(Utils.storage.get("bookmarks", [])),
        isCollapsed: Utils.storage.get("collapsed", false),
        isWide: Utils.storage.get("wide", false),
        pos: Utils.storage.get("pos", { x: -1, y: 100 }),
        size: Utils.storage.get("size", { w: null, h: null }),
        theme: Utils.storage.get("theme", "light"),
        keyword: "",
        reduceFx: Utils.storage.get("reduceFx", true), // 默认减特效：更稳
        isDragging: false,
        isResizing: false,
        offset: { x: 0, y: 0 },
        resizeStart: { x: 0, y: 0, w: 0, h: 0 },
      };

      this.dom = {};
      this.chatRoot = null;
      this.observer = null;

      this._dragRAF = 0;
      this._resizeRAF = 0;
      this._pendingXY = null;
      this._pendingResizeXY = null;

      this._renderScheduled = false;
      this._renderedCount = 0; // 已渲染到 cache.items 的哪个位置（用于增量追加）
    }

    init() {
      this.injectCSS();
      this.renderShell();
      this.bindEvents();
      this.hookHistory();
      this.resetForRoute();
    }

    getSelectors() {
      return this.siteConfig.userSelector;
    }

    getAllMessageSelectors() {
      return this.siteConfig.allSelector;
    }

    findChatRoot() {
      const main = document.querySelector("main");
      if (!main) return document.body;

      // 尽量把 observer 绑在“消息流容器”附近，减少无关变动
      const anyMsg = main.querySelector(this.getAllMessageSelectors());
      if (anyMsg) {
        const near =
          anyMsg.closest('[role="log"]') ||
          anyMsg.closest("section") ||
          anyMsg.parentElement?.parentElement;
        return near || main;
      }
      return main;
    }

    injectCSS() {
      const css = `
#ai-toc{
  --at-bg: rgba(255,255,255,.90); --at-bd:#d4d4d8; --at-txt:#111827;
  --at-h-bg:rgba(245,245,245,.88); --at-h-txt:#111827; --at-act:#111827; --at-shd:0 6px 22px rgba(0,0,0,.12);
  --at-s-off:#9ca3af; --at-s-on:#111827;
}
#ai-toc.theme-dark{
  --at-bg: rgba(17,17,17,.88)!important; --at-bd:#3f3f46!important; --at-txt:#f5f5f5!important;
  --at-h-bg:rgba(24,24,27,.84)!important; --at-h-txt:#fafafa!important; --at-act:#e5e7eb!important;
  --at-shd:0 8px 24px rgba(0,0,0,.45)!important; --at-s-off:#71717a!important; --at-s-on:#fafafa!important;
}
#ai-toc{
  position:fixed; z-index:9999; display:flex; flex-direction:column;
  background:var(--at-bg); border:1px solid var(--at-bd); color:var(--at-txt);
  border-radius:12px; box-shadow:var(--at-shd);
  font-family:system-ui,sans-serif;
  transition:width .22s ease, height .22s ease, opacity .2s ease, background .22s ease, box-shadow .22s ease, border-color .22s ease, transform .12s ease;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  will-change: transform, width, height;
  contain: content;
}
#ai-toc.fx-off{ backdrop-filter:none !important; -webkit-backdrop-filter:none !important; box-shadow:none !important; }
#ai-toc.resizing{
  transition:none !important;
  backdrop-filter:none !important;
  -webkit-backdrop-filter:none !important;
}
#ai-head,#ai-foot{
  padding:10px 12px; cursor:move; display:flex; justify-content:space-between; align-items:center;
  flex-shrink:0; user-select:none;
}
#ai-head{ border-bottom:1px solid var(--at-bd); background:var(--at-h-bg); border-radius:12px 12px 0 0; }
#ai-foot{ border-top:1px solid var(--at-bd); border-radius:0 0 12px 12px; font-size:12px; }
.ai-title{ font-weight:700; font-size:16px; color:var(--at-h-txt); }
.ai-ctrls{ display:flex; gap:8px; align-items:center; }
.ai-btn{ cursor:pointer; opacity:.65; transition:.15s; font-size:14px; }
.ai-btn:hover{ opacity:1; transform:scale(1.06); color:var(--at-act); }

#ai-search{
  margin:8px; padding:4px 8px; border:1px solid var(--at-bd); border-radius:6px;
  background:transparent; color:var(--at-txt); font-size:12px; outline:none; flex-shrink:0;
}
#ai-search:focus{ border-color:var(--at-act); }

#ai-body{ flex:1; overflow-y:auto; padding:4px 0; scrollbar-width:thin; min-height:0; scroll-behavior:smooth; }
#ai-body::-webkit-scrollbar{ width:4px; }
#ai-body::-webkit-scrollbar-thumb{ background:var(--at-bd); border-radius:8px; }
#ai-resizer{
  position:absolute; right:3px; bottom:3px; width:14px; height:14px; cursor:nwse-resize;
  opacity:.55; border-radius:3px; z-index:2;
  background:linear-gradient(135deg, transparent 0 38%, var(--at-act) 38% 46%, transparent 46% 62%, var(--at-act) 62% 70%, transparent 70% 100%);
}
#ai-resizer:hover{ opacity:.9; }

.ai-item{
  padding:6px 10px 6px 2px; cursor:pointer; display:flex; align-items:center;
  border-left:3px solid transparent; transition:.12s;
}
.ai-item:hover{ background:rgba(0,0,0,.05); border-left-color:var(--at-act); padding-left:8px; }
.ai-item.mark{ background:rgba(0,0,0,.03); border-left-color:var(--at-s-on); font-weight:600; }
.ai-star{ width:22px; text-align:center; color:var(--at-s-off); font-size:12px; }
.ai-item.mark .ai-star{ color:var(--at-s-on); text-shadow:0 0 4px var(--at-s-on); }
.ai-txt{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; pointer-events:none; font-size:12px; }

.ai-wide{ width:${CFG.maxW}px !important; }
.ai-norm{ width:${CFG.minW}px !important; }
.ai-hide #ai-body,.ai-hide #ai-search,.ai-hide #ai-foot{ display:none; }
.ai-hide{ width:auto !important; height:auto !important; }
      `;
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    }

    renderShell() {
      const mk = (tag, cls, props = {}) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        for (const [k, v] of Object.entries(props)) el[k] = v;
        return el;
      };

      this.dom.root = mk("div", "", { id: "ai-toc" });
      if (this.state.isCollapsed) this.dom.root.classList.add("ai-hide");
      if (this.state.theme === "dark")
        this.dom.root.classList.add("theme-dark");
      if (this.state.reduceFx) this.dom.root.classList.add("fx-off");

      const initialW = Math.max(
        CFG.minW,
        Math.min(
          CFG.maxW,
          this.state.size?.w || (this.state.isWide ? CFG.maxW : CFG.minW),
        ),
      );
      const initialH = Math.max(
        CFG.minH,
        Math.min(CFG.maxH, this.state.size?.h || CFG.defaultH),
      );
      this.dom.root.style.width = initialW + "px";
      this.dom.root.style.height = initialH + "px";

      const head = mk("div", "", { id: "ai-head" });
      const title = mk("div", "ai-title", { textContent: CFG.symbol });

      const ctrls = mk("div", "ai-ctrls");
      const btnFx = mk("span", "ai-btn", {
        textContent: "⚡",
        title: "切换性能模式（关特效更省）",
      });
      this.dom.btnTheme = mk("span", "ai-btn", {
        textContent: this.state.theme === "dark" ? "☾" : "☼",
        title: "切换深色/浅色",
      });
      const btnWide = mk("span", "ai-btn", {
        textContent: "↔",
        title: "切换宽度",
      });
      this.dom.btnFold = mk("span", "ai-btn", {
        textContent: this.state.isCollapsed ? "◀" : "▼",
        title: "折叠/展开",
      });

      ctrls.append(btnFx, this.dom.btnTheme, btnWide, this.dom.btnFold);
      head.append(title, ctrls);

      this.dom.search = mk("input", "", {
        id: "ai-search",
        placeholder: "搜索对话...",
        type: "text",
      });
      this.dom.body = mk("div", "", { id: "ai-body" });

      const foot = mk("div", "", { id: "ai-foot" });
      const jumpCtrls = mk("div", "ai-ctrls");
      const btnTop = mk("span", "ai-btn", { textContent: "⬆", title: "顶部" });
      const btnBot = mk("span", "ai-btn", { textContent: "⬇", title: "底部" });
      jumpCtrls.append(btnTop, btnBot);

      const exportBtn = mk("span", "ai-btn", {
        textContent: "复制",
        title: "左键：复制目录\nShift+左键：导出完整对话",
      });
      foot.append(jumpCtrls, exportBtn);

      this.dom.resizer = mk("div", "", {
        id: "ai-resizer",
        title: "拖动调整宽高",
      });

      this.dom.root.append(
        head,
        this.dom.search,
        this.dom.body,
        foot,
        this.dom.resizer,
      );
      document.body.appendChild(this.dom.root);

      if (this.state.pos.x !== -1) {
        this.dom.root.style.left = this.state.pos.x + "px";
        this.dom.root.style.top = this.state.pos.y + "px";
        this.dom.root.style.right = "auto";
      } else {
        this.dom.root.style.top = "100px";
        this.dom.root.style.right = "20px";
      }

      btnFx.onclick = () => this.toggleFx();
      this.dom.btnTheme.onclick = () => this.switchTheme();
      btnWide.onclick = () => this.toggleWidth();
      this.dom.btnFold.onclick = () => this.toggleCollapse();
      btnTop.onclick = () =>
        this.dom.body.scrollTo({ top: 0, behavior: "smooth" });
      btnBot.onclick = () =>
        this.dom.body.scrollTo({
          top: this.dom.body.scrollHeight,
          behavior: "smooth",
        });
      exportBtn.onclick = (e) => this.handleExport(e);

      this.renderEmpty("等待对话...");
    }

    bindEvents() {
      this.dom.search.oninput = (e) => {
        this.state.keyword = (e.target.value || "").toLowerCase();
        this.renderListFull(); // 搜索时全量重建（基于缓存，不扫 DOM）
      };

      // 列表事件委托：避免每个 item 都绑 handler
      this.dom.body.addEventListener("click", (e) => {
        const star = e.target.closest(".ai-star");
        const itemEl = e.target.closest(".ai-item");
        if (!itemEl) return;

        const key = itemEl.dataset.key;
        if (!key) return;

        if (star) {
          if (this.state.marks.has(key)) {
            this.state.marks.delete(key);
            itemEl.classList.remove("mark");
          } else {
            this.state.marks.add(key);
            itemEl.classList.add("mark");
          }
          Utils.storage.set("bookmarks", Array.from(this.state.marks));
          return;
        }

        this.scrollToKey(key);
      });

      this.dom.body.addEventListener("contextmenu", (e) => {
        const itemEl = e.target.closest(".ai-item");
        if (!itemEl) return;
        e.preventDefault();
        const key = itemEl.dataset.key;
        const it = this.cache.key2item.get(key);
        if (!it) return;
        navigator.clipboard
          .writeText(it.txt || "")
          .then(() => Utils.toast("已复制内容"));
      });

      const startDrag = (e) => {
        if (
          e.target.closest(".ai-btn") ||
          e.target.closest("#ai-search") ||
          e.target.closest("#ai-resizer")
        )
          return;
        this.state.isDragging = true;
        this.state.offset.x = e.clientX - this.dom.root.offsetLeft;
        this.state.offset.y = e.clientY - this.dom.root.offsetTop;
        e.currentTarget.style.cursor = "grabbing";
      };

      const startResize = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.state.isResizing = true;
        this.dom.root.classList.add("resizing");
        this.state.resizeStart = {
          x: e.clientX,
          y: e.clientY,
          w: this.dom.root.offsetWidth,
          h: this.dom.root.offsetHeight,
        };
      };

      const head = this.dom.root.querySelector("#ai-head");
      const foot = this.dom.root.querySelector("#ai-foot");
      head.onmousedown = startDrag;
      foot.onmousedown = startDrag;
      if (this.dom.resizer) this.dom.resizer.onmousedown = startResize;

      document.addEventListener(
        "mousemove",
        (e) => {
          if (this.state.isDragging) {
            this._pendingXY = { x: e.clientX, y: e.clientY };
            if (!this._dragRAF) {
              this._dragRAF = requestAnimationFrame(() => {
                this._dragRAF = 0;
                const p = this._pendingXY;
                if (!p) return;
                this.dom.root.style.left = p.x - this.state.offset.x + "px";
                this.dom.root.style.top = p.y - this.state.offset.y + "px";
                this.dom.root.style.right = "auto";
              });
            }
          }

          if (this.state.isResizing) {
            this._pendingResizeXY = { x: e.clientX, y: e.clientY };
            if (!this._resizeRAF) {
              this._resizeRAF = requestAnimationFrame(() => {
                this._resizeRAF = 0;
                const p = this._pendingResizeXY;
                if (!p) return;

                const dx = p.x - this.state.resizeStart.x;
                const dy = p.y - this.state.resizeStart.y;

                const vwMax = Math.max(CFG.minW, window.innerWidth - 16);
                const vhMax = Math.max(CFG.minH, window.innerHeight - 16);

                const maxW = Math.min(CFG.maxW, vwMax);
                const maxH = Math.min(CFG.maxH, vhMax);

                const nextW = Math.max(
                  CFG.minW,
                  Math.min(maxW, this.state.resizeStart.w + dx),
                );
                const nextH = Math.max(
                  CFG.minH,
                  Math.min(maxH, this.state.resizeStart.h + dy),
                );

                this.dom.root.style.width = nextW + "px";
                this.dom.root.style.height = nextH + "px";
              });
            }
          }
        },
        { passive: true },
      );

      document.addEventListener("mouseup", () => {
        if (this.state.isDragging) {
          this.state.isDragging = false;
          head.style.cursor = "move";
          foot.style.cursor = "move";
          Utils.storage.set("pos", {
            x: this.dom.root.offsetLeft,
            y: this.dom.root.offsetTop,
          });
        }

        if (this.state.isResizing) {
          this.state.isResizing = false;
          this.dom.root.classList.remove("resizing");
          const w = this.dom.root.offsetWidth;
          const h = this.dom.root.offsetHeight;
          this.state.size = { w, h };
          this.state.isWide = w > (CFG.minW + CFG.maxW) / 2;
          Utils.storage.set("size", this.state.size);
          Utils.storage.set("wide", this.state.isWide);
          this.renderListFull();
        }
      });
    }

    hookHistory() {
      const fire = () => window.dispatchEvent(new Event("ai-toc:route"));
      const _push = history.pushState;
      history.pushState = function () {
        _push.apply(this, arguments);
        fire();
      };
      const _rep = history.replaceState;
      history.replaceState = function () {
        _rep.apply(this, arguments);
        fire();
      };
      window.addEventListener("popstate", fire);

      window.addEventListener(
        "ai-toc:route",
        Utils.debounce(() => {
          this.resetForRoute();
        }, 200),
      );
    }

    resetForRoute() {
      this.detachObserver();
      this.cache.items = [];
      this.cache.keySet = new Set();
      this.cache.key2item = new Map();
      this.cache.node2key = new WeakMap();
      this.cache.autoInc = 1;
      this._renderedCount = 0;

      this.chatRoot = this.findChatRoot();
      this.attachObserver();
      this.fullRescan();
    }

    attachObserver() {
      const root = this.chatRoot || document.body;
      const selectors = this.getSelectors();

      const onMutations = (mutations) => {
        let anyNew = false;
        for (const m of mutations) {
          if (!m.addedNodes || m.addedNodes.length === 0) continue;

          for (const n of m.addedNodes) {
            if (!n || n.nodeType !== 1) continue;

            if (n.matches && n.matches(selectors)) {
              if (this.registerMessageNode(n)) anyNew = true;
              continue;
            }

            // 只在新增子树内找，避免扫全页面
            const found = n.querySelectorAll
              ? n.querySelectorAll(selectors)
              : null;
            if (found && found.length) {
              for (const fn of found) {
                if (this.registerMessageNode(fn)) anyNew = true;
              }
            }
          }
        }
        if (anyNew) this.scheduleRender();
      };

      this.observer = new MutationObserver(onMutations);
      this.observer.observe(root, { childList: true, subtree: true });
    }

    detachObserver() {
      if (this.observer) {
        try {
          this.observer.disconnect();
        } catch {}
      }
      this.observer = null;
    }

    makeKeyAndAnchor(node, txt) {
      const wrap =
        node.closest("[data-message-id]") || node.closest("article") || node;
      const mid = wrap.getAttribute && wrap.getAttribute("data-message-id");
      if (mid) return { key: `mid:${mid}`, kind: "mid", val: mid, weak: null };

      const wid = wrap.id;
      if (wid) return { key: `id:${wid}`, kind: "id", val: wid, weak: null };

      // 没有稳定 id：用 hash + 递增，并用 WeakRef 防止强引用导致内存涨
      const h = Utils.hash32(txt);
      const key = `h:${h}:${this.cache.autoInc++}`;
      const weak = typeof WeakRef !== "undefined" ? new WeakRef(wrap) : null;
      return { key, kind: "weak", val: h, weak };
    }

    normalizeUserText(txt) {
      if (!txt) return "";
      return txt
        .replace(/^\s*you said[:：]?\s*/i, "")
        .replace(/^\s*你说[:：]?\s*/i, "")
        .trim();
    }

    hasAttachment(node) {
      const wrap =
        node.closest("[data-message-id]") || node.closest("article") || node;
      if (!wrap || !wrap.querySelector) return false;

      const selector = [
        "img",
        "figure img",
        '[role="img"]',
        '[data-test-id*="attachment"]',
        '[class*="attachment"]',
        '[class*="thumbnail"]',
        '[class*="image-preview"]',
        'a[href^="blob:"]',
      ].join(",");

      return !!wrap.querySelector(selector);
    }

    registerMessageNode(node) {
      if (this.cache.node2key.has(node)) return false;

      const raw = Utils.fastText(node);
      let txt = this.normalizeUserText(raw);

      if (!txt && this.hasAttachment(node)) {
        txt = "附件提问";
      }

      if (!txt) return false;

      let { key, kind, val, weak } = this.makeKeyAndAnchor(node, txt);

      // 极少数冲突：加后缀
      if (this.cache.keySet.has(key)) {
        let k = 2;
        while (this.cache.keySet.has(`${key}-${k}`)) k++;
        key = `${key}-${k}`;
      }

      const lower = txt.toLowerCase();
      const preview = txt;

      const it = {
        key,
        kind,
        val,
        weak,
        hash: Utils.hash32(txt),
        txt,
        lower,
        preview,
      };

      this.cache.items.push(it);
      this.cache.keySet.add(key);
      this.cache.key2item.set(key, it);
      this.cache.node2key.set(node, key);

      // 缓存限额：丢最早的，避免越聊越大
      if (this.cache.items.length > CFG.MAX_CACHE) {
        const drop = this.cache.items.shift();
        if (drop) {
          this.cache.keySet.delete(drop.key);
          this.cache.key2item.delete(drop.key);
          if (this.state.marks.has(drop.key)) {
            this.state.marks.delete(drop.key);
            Utils.storage.set("bookmarks", Array.from(this.state.marks));
          }
          // 渲染游标也要回退
          this._renderedCount = Math.max(0, this._renderedCount - 1);
        }
      }

      return true;
    }

    fullRescan() {
      const root = this.chatRoot || this.findChatRoot();
      const nodes = root
        ? Array.from(root.querySelectorAll(this.getSelectors()))
        : [];
      for (const n of nodes) this.registerMessageNode(n);
      this.renderListFull(true);
    }

    renderEmpty(text) {
      this.dom.body.textContent = "";
      const empty = document.createElement("div");
      empty.className = "ai-txt";
      empty.style.cssText = "padding:10px;text-align:center;opacity:.8;";
      empty.textContent = text;
      this.dom.body.appendChild(empty);
      this._renderedCount = this.cache.items.length;
    }

    buildItemEl(it) {
      const item = document.createElement("div");
      item.className =
        "ai-item" + (this.state.marks.has(it.key) ? " mark" : "");
      item.title = it.txt;
      item.dataset.key = it.key;

      const star = document.createElement("span");
      star.className = "ai-star";
      star.textContent = "★";

      const label = document.createElement("span");
      label.className = "ai-txt";
      label.textContent = it.txt;

      item.append(star, label);
      return item;
    }

    // 全量重建列表（仅基于缓存，不扫 DOM）
    renderListFull(force = false) {
      const kw = this.state.keyword;
      const items = this.cache.items;

      if (!items.length) {
        this.renderEmpty("等待对话...");
        return;
      }

      this.dom.body.textContent = "";

      const frag = document.createDocumentFragment();
      const start = Math.max(0, items.length - CFG.MAX_RENDER);
      let shown = 0;

      for (let i = start; i < items.length; i++) {
        const it = items[i];
        if (kw && !it.lower.includes(kw)) continue;
        frag.appendChild(this.buildItemEl(it));
        shown++;
      }

      if (!shown) {
        this.renderEmpty(kw ? "未匹配到内容" : "等待对话...");
        return;
      }

      this.dom.body.appendChild(frag);
      this._renderedCount = items.length; // 视为已经渲染到尾部
    }

    // 无搜索关键字时：只追加新项，避免每次 O(n) 重建
    appendNewItems() {
      const items = this.cache.items;
      if (!items.length) return;

      // 如果当前在搜索模式，直接全量刷新
      if (this.state.keyword) {
        this.renderListFull();
        return;
      }

      // body 里可能还是 empty 占位
      const firstIsEmpty =
        this.dom.body.firstElementChild &&
        this.dom.body.firstElementChild.classList.contains("ai-txt");
      if (firstIsEmpty) this.dom.body.textContent = "";

      const frag = document.createDocumentFragment();

      for (let i = this._renderedCount; i < items.length; i++) {
        frag.appendChild(this.buildItemEl(items[i]));
      }

      if (frag.childNodes.length) {
        this.dom.body.appendChild(frag);
      }

      this._renderedCount = items.length;

      // 渲染限额：只保留最近 MAX_RENDER 个 DOM 节点
      const children = this.dom.body.children;
      const overflow = children.length - CFG.MAX_RENDER;
      if (overflow > 0) {
        for (let i = 0; i < overflow; i++) {
          if (this.dom.body.firstElementChild)
            this.dom.body.removeChild(this.dom.body.firstElementChild);
        }
      }
    }

    scheduleRender() {
      if (this._renderScheduled) return;
      this._renderScheduled = true;

      const run = () => {
        this._renderScheduled = false;
        this.appendNewItems();
      };

      if ("requestIdleCallback" in window) {
        requestIdleCallback(run, { timeout: CFG.IDLE_TIMEOUT });
      } else {
        setTimeout(run, 120);
      }
    }

    scrollToKey(key) {
      const it = this.cache.key2item.get(key);
      if (!it) return;

      let target = null;

      if (it.kind === "mid") {
        target = document.querySelector(
          `[data-message-id="${Utils.escSel(it.val)}"]`,
        );
      } else if (it.kind === "id") {
        target = document.getElementById(it.val);
      } else if (it.weak && it.weak.deref) {
        target = it.weak.deref();
      }

      // 兜底：按 hash 在当前 DOM 里找最接近的用户消息（慢，但只在点击时触发）
      if (!target) {
        const root =
          this.chatRoot || document.querySelector("main") || document.body;
        const nodes = root.querySelectorAll(this.getSelectors());
        for (const n of nodes) {
          const t = Utils.fastText(n);
          if (!t) continue;
          if (Utils.hash32(t) === it.hash) {
            target = n;
            break;
          }
        }
      }

      if (target && target.scrollIntoView) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    toggleFx() {
      this.state.reduceFx = !this.state.reduceFx;
      this.dom.root.classList.toggle("fx-off", this.state.reduceFx);
      Utils.storage.set("reduceFx", this.state.reduceFx);
      Utils.toast(this.state.reduceFx ? "⚡ 性能模式：开" : "⚡ 性能模式：关");
    }

    switchTheme() {
      const next = this.state.theme === "dark" ? "light" : "dark";

      this.dom.root.classList.toggle("theme-dark", next === "dark");

      this.state.theme = next;
      if (this.dom.btnTheme)
        this.dom.btnTheme.textContent = next === "dark" ? "☾" : "☀";
      Utils.storage.set("theme", next);
      Utils.toast(next === "dark" ? "已切换到深色" : "已切换到浅色");
    }

    toggleCollapse() {
      this.state.isCollapsed = !this.state.isCollapsed;
      this.dom.root.classList.toggle("ai-hide");
      this.dom.btnFold.textContent = this.state.isCollapsed ? "◀" : "▼";
      Utils.storage.set("collapsed", this.state.isCollapsed);
    }

    toggleWidth() {
      this.state.isWide = !this.state.isWide;
      const targetW = this.state.isWide ? CFG.maxW : CFG.minW;
      const currH = this.dom.root.offsetHeight || CFG.defaultH;
      this.dom.root.style.width = targetW + "px";
      this.dom.root.style.height = currH + "px";
      this.state.size = { w: targetW, h: currH };
      Utils.storage.set("size", this.state.size);
      Utils.storage.set("wide", this.state.isWide);
    }

    handleExport(e) {
      e.stopPropagation();
      if (e.shiftKey) {
        const log = this.getChatLog();
        if (!log) return Utils.toast("未检测到有效对话");
        navigator.clipboard
          .writeText(log)
          .then(() => Utils.toast("完整对话已复制"));
      } else {
        const kw = this.state.keyword;
        const list = this.cache.items
          .filter((x) => !kw || x.lower.includes(kw))
          .map((x) => x.txt)
          .join("\n");
        navigator.clipboard
          .writeText(list || "")
          .then(() => Utils.toast("目录已复制"));
      }
    }

    getChatLog() {
      const root =
        this.chatRoot || document.querySelector("main") || document.body;
      const blocks = root.querySelectorAll(this.getAllMessageSelectors());
      if (!blocks.length) return null;

      const log = [`=== 导出对话 (${new Date().toLocaleString()}) ===\n`];
      blocks.forEach((b) => {
        const role = this.siteConfig.roleOf ? this.siteConfig.roleOf(b) : "ai";
        const t = Utils.fastText(b);
        if (!t) return;
        log.push(
          `${role === "user" ? "【User】" : "【AI】"}\n${t}\n-------------------`,
        );
      });
      return log.join("\n\n");
    }
  }

  const app = new SideNavMulti();
  const boot = () => app.init();
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  )
    boot();
  else window.addEventListener("DOMContentLoaded", boot, { once: true });
})();
