/* =============================================================================
 * PubMed 领域文献计量分析 —— 前端主逻辑
 * 原生 JS + ECharts（本地 vendor），零构建、零框架。
 * 对接接口见 CONTRACT.md 第 3 节。
 * ========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 常量

  // 后端接口基址。三种部署形态都能自适应，不需要改代码：
  //   1. 本地开发 / 独立域名       页面在 /            → 前缀为空
  //   2. 挂在服务器的子路径        页面在 /pubmed/      → 前缀 /pubmed
  //   3. 前端放 GitHub Pages 等别处 → 在页面里先设置 window.PUBMED_API_BASE = 'https://api.xxx/pubmed'
  var API_BASE = (function () {
    if (typeof window.PUBMED_API_BASE === 'string' && window.PUBMED_API_BASE) {
      return window.PUBMED_API_BASE.replace(/\/+$/, '');
    }
    var m = location.pathname.match(/^(.*\/)pubmed(\/|$)/);
    return m ? m[1] + 'pubmed' : '';
  })();

  var API = {
    search: API_BASE + '/api/search',
    searchStream: API_BASE + '/api/search/stream',
    demoQueries: API_BASE + '/api/demo/queries',
    demoLoad: API_BASE + '/api/demo/load',
    health: API_BASE + '/api/health',
    streamReview: function (id) { return API_BASE + '/api/stream/review?search_id=' + encodeURIComponent(id); },
    streamSummary: function (id) { return API_BASE + '/api/stream/summary?search_id=' + encodeURIComponent(id); }
  };

  var PUBMED = 'https://pubmed.ncbi.nlm.nih.gov/';

  // 仅在**降级模式**下使用的估算阶段表。
  // 正常路径的阶段由 /api/search/stream 的 start 事件给出，前端不再硬编码，
  // 后端增删阶段时前端零改动；这里只服务于"/api/search 旧接口"的兜底展示。
  var LEGACY_STEPS = [
    '正在检索 PubMed…',
    '正在匹配期刊指标（JCR / 中科院分区）…',
    '正在计算统计与词云…',
    '正在准备结果…'
  ];
  var LEGACY_STEP_INTERVAL = 2400;   // 估算进度推进节奏（毫秒）
  var LEGACY_NOTE = '降级模式：进度为估算值（流式接口不可用，已回退到 /api/search）';

  // 分区配色（与 CSS 变量保持一致）
  var ZONE_COLORS = ['#16365c', '#2f7cb8', '#82b0d3', '#c2d6e6', '#d7dde5', '#9aa8bb'];

  var ARTICLE_LIMIT_MAX = 10000;

  // ---------------------------------------------------------------- 状态

  var state = {
    data: null,              // 最近一次 /api/search 响应
    keyword: '',
    tab: 'by_if',
    zoneMode: 'cas',
    cloudSource: 'cloud',
    sortKey: null,
    sortDir: 'desc',
    textFilter: '',
    wordFilter: '',
    rows: [],                // 当前 tab 的原始行
    charts: {},
    wordcloudOk: null,
    es: { review: null, summary: null },
    streams: {
      review: { raw: '', finished: false, fallback: false, error: '' },
      summary: { raw: '', finished: false, fallback: false, error: '' }
    },
    progressTimer: null,
    progressIdx: 0,
    toastTimer: null,
    lastRequest: null,
    searchToken: 0,           // 丢弃被新检索取代的旧响应
    llmModel: '',             // 来自 /api/health，用于流式等待占位文案
    // 检索阶段进度（真进度 / 降级估算 / 快照加载三种模式）
    search: {
      mode: 'idle',           // 'stream' | 'legacy' | 'snapshot' | 'idle'
      stages: [],             // [{key,label,done,total,shown,state}]
      currentIdx: -1,
      failedKey: '',
      startedAt: 0,
      elapsedTimer: null
    },
    // 综述/概括首块到达前的等待态
    pending: {
      review: { phase: 'idle', startedAt: 0 },   // 'idle' | 'connecting' | 'reading' | 'streaming' | 'closed'
      summary: { phase: 'idle', startedAt: 0 }
    },
    pendingTimer: null
  };

  // ---------------------------------------------------------------- 工具

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(v) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return null;
    return Number(v);
  }

  // 千分位整数
  function fmtInt(v) {
    var n = num(v);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('zh-CN');
  }

  // 影响因子：1–2 位小数
  function fmtIf(v) {
    var n = num(v);
    if (n === null) return '—';
    return n >= 10 ? n.toFixed(1) : n.toFixed(2);
  }

  // 百分比：1 位小数
  function fmtPct(v) {
    var n = num(v);
    if (n === null) return '—';
    return n.toFixed(1) + '%';
  }

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    // 触发过渡
    void el.offsetWidth;
    el.classList.add('is-show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      el.classList.remove('is-show');
      setTimeout(function () { el.hidden = true; }, 220);
    }, 2000);
  }

  // ---------------------------------------------------------------- 轻量 Markdown 渲染
  // 只支持本项目需要的语法：标题 / 有序与无序列表 / 引用 / 粗体 / 斜体 / 行内代码 / 链接 / PMID 引用 / 分隔线

  function inlineMd(text) {
    var s = text;
    // 行内代码
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 粗体、斜体
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // Markdown 链接
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // PMID 内联引用 → 跳 PubMed
    s = s.replace(/\[PMID:\s*(\d+)\]/gi, function (m, pmid) {
      return '<a href="' + PUBMED + pmid + '/" target="_blank" rel="noopener" title="在 PubMed 打开">' +
        '[PMID: ' + pmid + ']</a>';
    });
    return s;
  }

  function renderMarkdown(src) {
    var lines = String(src || '').split(/\r?\n/);
    var html = '';
    var listType = null;

    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      if (!line) { closeList(); continue; }

      var m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        closeList();
        // # 与 ## 都作为卡片内的一级小节标题，### 起降一级
        var lvl = m[1].length <= 2 ? 3 : (m[1].length === 3 ? 4 : 5);
        html += '<h' + lvl + '>' + inlineMd(esc(m[2])) + '</h' + lvl + '>';
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        closeList();
        html += '<hr>';
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        closeList();
        html += '<blockquote>' + inlineMd(esc(m[1])) + '</blockquote>';
      } else if ((m = /^[-*+]\s+(.*)$/.exec(line))) {
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += '<li>' + inlineMd(esc(m[1])) + '</li>';
      } else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += '<li>' + inlineMd(esc(m[1])) + '</li>';
      } else {
        closeList();
        html += '<p>' + inlineMd(esc(line)) + '</p>';
      }
    }
    closeList();
    return html;
  }

  // ---------------------------------------------------------------- 初始化

  function init() {
    var now = new Date().getFullYear();
    $('yearTo').value = now;
    $('yearFrom').value = now - 4;   // 默认近 5 年
    $('limit').value = 2000;

    // 两个流式容器都用 Markdown 渲染（标题/列表/引用）
    $('reviewBody').classList.add('stream-body-md');
    $('summaryBody').classList.add('stream-body-md');

    bindEvents();
    detectWordcloud();
    if (typeof window.echarts === 'undefined') {
      $('health').innerHTML = chip('ECharts 未加载', false);
    }
    loadHealth();
    loadDemoQueries();
  }

  function bindEvents() {
    // 关闭浏览器原生校验（避免 number 的 step/min 约束导致点击按钮静默无响应），
    // 改由 submitSearch() 统一校验并用中文提示。
    $('searchForm').noValidate = true;

    bindQuickChips();

    $('searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      submitSearch();
    });

    $('demoSelect').addEventListener('change', function () {
      var v = this.value;
      if (!v) return;
      $('keyword').value = v;
      var opt = this.options[this.selectedIndex];
      // 只有确实"已缓存"的预置项才走演示模式（本地快照），未预热的走真实检索
      submitSearch(!!(opt && opt.getAttribute('data-cached')));
    });

    $('warnToggle').addEventListener('click', function () {
      var open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    $('errorRetry').addEventListener('click', function () {
      if (state.lastRequest) runSearch(state.lastRequest);
    });

    // 分区口径切换
    $('zoneSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn || btn.classList.contains('is-active')) return;
      each('.seg-btn', $('zoneSeg'), function (b) { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      state.zoneMode = btn.getAttribute('data-mode');
      renderZoneChart();
    });

    // 词云来源切换
    document.querySelectorAll('[data-kw]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('is-active')) return;
        document.querySelectorAll('[data-kw]').forEach(function (b) { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        state.cloudSource = btn.getAttribute('data-kw');
        renderCloudChart();
      });
    });

    // 榜单 Tab
    $('tabSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn || btn.classList.contains('is-active')) return;
      each('.seg-btn', $('tabSeg'), function (b) { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      state.tab = btn.getAttribute('data-tab');
      state.sortKey = null;
      state.sortDir = 'desc';
      loadTableRows();
    });

    // 表头排序
    document.querySelectorAll('#articleTable th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          state.sortKey = key;
          state.sortDir = (key === 'title') ? 'asc' : 'desc';
        }
        renderTable();
      });
    });

    // 过滤框
    $('tableFilter').addEventListener('input', debounce(function () {
      state.textFilter = this.value.trim();
      renderTable();
    }, 180));

    // 复制 / 导出
    $('copyReview').addEventListener('click', copyReview);
    $('exportReview').addEventListener('click', exportReview);

    window.addEventListener('resize', debounce(resizeCharts, 150));
  }

  function each(sel, root, fn) {
    (root || document).querySelectorAll(sel).forEach(fn);
  }

  // 检测 echarts-wordcloud 是否真的注册成功，失败则降级为条形图
  function detectWordcloud() {
    if (typeof window.echarts === 'undefined') { state.wordcloudOk = false; return; }
    var ok = true;
    var origError = console.error, origWarn = console.warn;
    function probe() {
      console.error = console.warn = function () {
        if (String(arguments[0]).indexOf('wordCloud') >= 0) ok = false;
        origWarn.apply(console, arguments);
      };
    }
    try {
      probe();
      var box = document.createElement('div');
      box.style.cssText = 'width:120px;height:120px;position:absolute;left:-9999px;';
      document.body.appendChild(box);
      var inst = echarts.init(box);
      inst.setOption({ series: [{ type: 'wordCloud', data: [{ name: 'test', value: 1 }] }] });
      inst.dispose();
      box.remove();
    } catch (e) {
      ok = false;
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
    state.wordcloudOk = ok;
  }

  // ---------------------------------------------------------------- 后端状态

  function loadHealth() {
    fetch(API.health, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var chips = [];
        var llm = d.llm || {};
        var llmOk = llm.configured !== undefined ? !!llm.configured
          : (llm.is_configured !== undefined ? !!llm.is_configured : !!llm.ok);
        chips.push(chip(llmOk ? '大模型已接入' : '大模型未配置', llmOk));
        state.llmModel = llm.model || '';
        var ji = d.journal_index || {};
        var rows = num(ji.rows);
        if (rows) chips.push(chip('期刊库 ' + fmtInt(rows) + ' 条', true));
        else chips.push(chip('期刊库未加载', false));
        var ncbi = d.ncbi || {};
        if (ncbi.error) chips.push(chip('NCBI 异常', false));
        else if (ncbi.has_api_key === false) chips.push(chip('NCBI 无 Key（3 req/s）', false));
        else chips.push(chip('NCBI 就绪', true));
        $('health').innerHTML = chips.join('');
      })
      .catch(function () { /* 健康检查失败不阻塞主流程 */ });
  }

  function chip(text, ok) {
    return '<span class="chip ' + (ok ? 'ok' : 'off') + '">' + esc(text) + '</span>';
  }

  function loadDemoQueries() {
    fetch(API.demoQueries, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !Array.isArray(d.queries) || !d.queries.length) return;
        var sel = $('demoSelect');
        var quick = $('welcomeQuick');
        var chips = [];
        d.queries.forEach(function (q) {
          var opt = document.createElement('option');
          opt.value = q.keyword || '';
          opt.textContent = (q.label || q.keyword || '') + (q.cached ? '（已缓存）' : '');
          if (q.cached) opt.setAttribute('data-cached', '1');
          sel.appendChild(opt);

          // 引导区的一键试用按钮（与下拉共用同一份后端数据，避免两处硬编码不一致）
          chips.push(
            '<button type="button" class="quick-chip" data-keyword="' + esc(q.keyword || '') +
            '" data-cached="' + (q.cached ? '1' : '') + '">' +
            esc(q.label || q.keyword || '') +
            (q.cached ? '<span class="chip-badge">已缓存</span>' : '') +
            '</button>'
          );
        });
        quick.innerHTML = chips.join('');
        sel.disabled = false;
      })
      .catch(function () { /* 预置关键词拉不到就保持禁用式空选项 */ });
  }

  // 引导区的一键试用：已缓存的关键词走演示模式（本地快照，约 1 秒出结果，断网也可用）
  function bindQuickChips() {
    $('welcomeQuick').addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.quick-chip') : null;
      if (!btn) return;
      var kw = btn.getAttribute('data-keyword') || '';
      if (!kw) return;
      $('keyword').value = kw;
      $('demoSelect').value = kw;
      submitSearch(btn.getAttribute('data-cached') === '1');
    });
  }

  // ---------------------------------------------------------------- 检索

  function submitSearch(isDemo) {
    var keyword = ($('keyword').value || '').trim();
    if (!keyword) {
      $('keyword').focus();
      toast('请先输入研究关键词');
      return;
    }
    // 检测 PubMed 语法误用
    if (/\b(AND|OR|NOT)\b/i.test(keyword)) {
      toast('提示：关键词会自动做 PubMed 检索式扩展，通常无需手写 AND / OR');
    }
    var yf = parseInt($('yearFrom').value, 10);
    var yt = parseInt($('yearTo').value, 10);
    var limit = parseInt($('limit').value, 10);

    if (!yf || !yt) { toast('请填写完整的年份区间'); return; }
    if (yf > yt) { var t = yf; yf = yt; yt = t; $('yearFrom').value = yf; $('yearTo').value = yt; }
    if (!limit || limit < 20) { limit = 20; $('limit').value = 20; }
    if (limit > ARTICLE_LIMIT_MAX) { limit = ARTICLE_LIMIT_MAX; $('limit').value = limit; }

    runSearch({
      keyword: keyword,
      year_from: yf,
      year_to: yt,
      limit: limit,
      use_cache: true,
      demo: !!isDemo
    });
  }

  function runSearch(req) {
    state.lastRequest = req;
    state.keyword = req.keyword;

    closeStreams();
    resetResultUI();

    var body = {
      keyword: req.keyword,
      year_from: req.year_from,
      year_to: req.year_to,
      limit: req.limit,
      use_cache: req.use_cache !== false
    };

    var flow;
    if (req.demo) {
      // 演示模式：直接取本地快照（/api/demo/load），保证"约 1 秒出结果"且断网可用。
      // 快照只按 keyword 取，避免带上表单里的 years/limit 导致缓存键不匹配而 404。
      startProgress({ mode: 'snapshot' });
      flow = postJSON(API.demoLoad, { keyword: req.keyword })
        .then(function (data) {
          syncFormFromSnapshot(data);
          return data;
        })
        .catch(function () {
          // 未预热 / 快照不可用 → 退回真实检索（流式，失败再降级）
          return fetchResult(body);
        });
    } else {
      flow = fetchResult(body);
    }

    var token = ++state.searchToken;   // 连续点两次检索时，旧请求的结果不再覆盖新请求
    flow.then(function (data) {
      if (token !== state.searchToken) return null;
      finishProgress();
      // 让"全部完成"的状态有一帧可见时间，避免快照模式下进度条一闪而过看不清楚
      return delay(260).then(function () { return data; });
    }).then(function (data) {
      if (data == null || token !== state.searchToken) return;
      stopProgress();
      applyResult(data);
    }).catch(function (err) {
      if (token !== state.searchToken) return;
      failProgress();
      stopProgress({ keepVisible: true });
      showError(err);
    });
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // 演示快照的年份区间可能与表单不一致，把表单同步成快照的真实口径，避免"表单说是 A、图里是 B"
  function syncFormFromSnapshot(data) {
    var q = (data && data.query) || {};
    if (q.year_from) $('yearFrom').value = q.year_from;
    if (q.year_to) $('yearTo').value = q.year_to;
  }

  /**
   * 流式检索：POST /api/search/stream，读 SSE 拿真实阶段进度，最后取 result。
   * 传输层不可用时（非 200 / body 不可读 / 浏览器不支持流式读取）返回带 fallback 标记的错误，
   * 由调用方降级到旧接口。
   */
  function fetchResult(body) {
    if (!supportsStreamRead()) {
      return legacySearch(body, '当前浏览器不支持流式读取（ReadableStream）');
    }
    startProgress({ mode: 'stream' });
    return streamSearchRequest(body).catch(function (err) {
      if (!err || !err.fallback) throw err;
      // 先把已有的阶段标成已完成，再切到估算进度，避免残留"卡在中途"的状态
      return legacySearch(body, err.message);
    });
  }

  function legacySearch(body, reason) {
    startLegacyProgress(reason);
    return postJSON(API.search, body);
  }

  function supportsStreamRead() {
    return typeof window.fetch === 'function' &&
      typeof window.ReadableStream !== 'undefined' &&
      typeof window.TextDecoder !== 'undefined' &&
      !!window.Response;
  }

  function streamSearchRequest(body) {
    return fetch(API.searchStream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) {
        var e = new Error('流式接口返回 HTTP ' + resp.status);
        e.fallback = true;
        e.status = resp.status;
        return resp.text().catch(function () { return ''; }).then(function (txt) {
          e.detail = txt ? txt.slice(0, 300) : '';
          throw e;
        });
      }
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        var e2 = new Error('响应体不可读（不支持流式读取）');
        e2.fallback = true;
        throw e2;
      }
      return readSearchStream(resp);
    }).catch(function (err) {
      // fallback = 传输层问题（可降级重试）；searchFailed = 后端明确报错（重试也是白等，直接上抛）
      if (err && (err.fallback || err.searchFailed)) throw err;
      // 连接阶段就失败的（网络错误 / 被中断）同样降级
      var e = new Error('流式连接失败：' + (err && err.message ? err.message : '未知原因'));
      e.fallback = true;
      e.status = 0;
      throw e;
    });
  }

  // 解析 /api/search/stream 并驱动进度；resolve(最终结果) / reject(真实检索错误)
  function readSearchStream(resp) {
    return new Promise(function (resolve, reject) {
      var reader = resp.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buf = '';
      var dataLines = [];
      var settled = false;

      function dispatch() {
        if (!dataLines.length) return;
        var payload = dataLines.join('\n');
        dataLines = [];
        var msg;
        try { msg = JSON.parse(payload); } catch (e) { return; }   // 心跳/非 JSON 一律忽略
        if (!msg || typeof msg !== 'object') return;
        onMessage(msg);
      }

      function onMessage(msg) {
        if (msg.type === 'start') {
          renderStages(msg.stages, msg.keyword);
          return;
        }
        if (msg.type === 'progress') {
          onStageProgress(msg.key, msg.done, msg.total, msg.label);
          return;
        }
        if (msg.type === 'result') {
          if (settled) return;
          settled = true;
          fsDone();
          resolve(msg.data);
          return;
        }
        if (msg.type === 'error') {
          if (settled) return;
          settled = true;
          fsDone();
          var e = new Error(msg.message || '检索失败');
          e.status = 502;
          e.searchFailed = true;    // 后端已明确报错：不要降级重试，直接把原因给用户
          reject(e);
        }
      }

      // 按行缓冲：天然处理"跨 chunk 被切断的 SSE 行"与"多行粘在一个 chunk 里"
      function feed(text) {
        buf += text;
        var idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          var raw = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (raw.charAt(raw.length - 1) === '\r') raw = raw.slice(0, -1);
          if (raw === '') { dispatch(); continue; }        // 事件结束（\n\n）
          if (raw.charAt(0) === ':') continue;             // keepalive 注释行，忽略而不是当解析失败
          if (raw.indexOf('data:') === 0) {
            var v = raw.slice(5);
            if (v.charAt(0) === ' ') v = v.slice(1);
            dataLines.push(v);
          }
          // event: / id: / retry: 等字段本接口不使用，忽略
        }
      }

      function fsDone() {
        try { reader.cancel(); } catch (e) { /* ignore */ }
      }

      function pump() {
        reader.read().then(function (res) {
          if (settled) return;
          if (res.done) {
            buf += decoder.decode();      // 冲掉解码器里残留的多字节字符
            if (buf) { feed('\n'); }
            dispatch();
            if (!settled) {
              settled = true;
              var e = new Error('流式连接提前结束（未收到完整结果）');
              e.fallback = true;
              reject(e);
            }
            return;
          }
          buf += decoder.decode(res.value, { stream: true });
          feed('');
          if (!settled) pump();
        }).catch(function (err) {
          if (settled) return;
          settled = true;
          var e = new Error('读取流式响应失败：' + (err && err.message ? err.message : '未知原因'));
          e.fallback = true;
          reject(e);
        });
      }

      pump();
    });
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        var e = new Error('HTTP ' + r.status);
        e.status = r.status;
        return r.text().then(function (txt) {
          e.detail = txt ? txt.slice(0, 400) : '';
          throw e;
        });
      }
      return r.json();
    }).catch(function (err) {
      if (err.status === undefined) {
        err.status = 0;
        err.message = '网络请求失败（无法连接后端服务）';
      }
      throw err;
    });
  }

  // ---------------------------------------------------------------- 状态切换

  function resetResultUI() {
    $('errorCard').hidden = true;
    $('emptyCard').hidden = true;
    $('results').hidden = true;
    $('welcome').hidden = false;
    $('queryBar').hidden = true;
    $('warnBar').hidden = true;
    resetPending();
    $('summaryBody').innerHTML = '<span class="stream-placeholder">等待检索结果…</span>';
    $('reviewBody').innerHTML = '<span class="stream-placeholder">等待检索结果…</span>';
    $('meshTags').hidden = true;
    $('summaryChip').hidden = true;
    $('reviewChip').hidden = true;
    $('topNote').hidden = true;
    $('tableFilter').value = '';
    $('copyReview').disabled = true;
    $('exportReview').disabled = true;
    state.streams.review = { raw: '', finished: false, fallback: false, error: '' };
    state.streams.summary = { raw: '', finished: false, fallback: false, error: '' };
    state.textFilter = '';
    state.wordFilter = '';
    state.sortKey = null;
    state.sortDir = 'desc';
    state.rows = [];
    document.querySelectorAll('.mesh-tag').forEach(function (t) { t.classList.remove('is-active'); });
  }

  // ---------------------------------------------------------------- 进度显示
  //
  // 三种模式：
  //   stream   —— 真进度，阶段来自 /api/search/stream 的 start 事件
  //   legacy   —— 降级估算，阶段用 LEGACY_STEPS（旧接口兜底）
  //   snapshot —— 演示快照加载，不确定进度条（不知道自己不知道，就不要假装知道）
  //
  // 单调性保证：每个阶段的 shown（已展示百分比）只增不减；整体百分比由
  // (已完成阶段数 + 当前阶段 shown) / 总阶段数 计算，因此也不会倒退。
  // 后端在阶段内换用更细粒度查询时会改变 total（如 openalex 495/495 → 1/495，
  // esearch 1/1 → 0/5），此时重置计数分母，但进度条仍由 shown 守住不回退。

  function startProgress(opts) {
    var mode = (opts && opts.mode) || 'stream';
    $('welcome').hidden = true;
    $('loadingCard').hidden = false;
    $('loadingCard').classList.remove('is-stopped');

    var s = state.search;
    s.mode = mode;
    s.stages = [];
    s.currentIdx = -1;
    s.failedKey = '';
    s.startedAt = Date.now();

    $('overall').classList.remove('is-done', 'is-failed');
    $('overall').classList.toggle('is-indeterminate', mode === 'snapshot');
    setOverall(0, mode === 'snapshot' ? '正在加载演示快照…' : '正在连接后端…');
    $('loadTitle').textContent = mode === 'snapshot' ? '正在加载演示快照' : '正在分析，请稍候';

    if (mode === 'snapshot') {
      // 快照没有阶段，清空列表
      $('steps').innerHTML = '';
      $('overallPct').textContent = '';
    } else if (mode === 'legacy') {
      renderStages(LEGACY_STEPS.map(function (t) { return { key: '', label: t }; }));
    } else {
      $('steps').innerHTML = '<li class="step is-waiting"><span class="step-dot"></span>' +
        '<div class="step-main"><div class="step-line"><span class="step-text">正在获取阶段列表…</span></div></div></li>';
    }

    startElapsed();
    return s;
  }

  function startElapsed() {
    stopElapsed();
    $('loadElapsed').hidden = false;
    paintElapsed();
    state.search.elapsedTimer = setInterval(paintElapsed, 500);
  }

  function paintElapsed() {
    var s = state.search;
    if (!s.startedAt) return;
    var sec = Math.max(0, Math.round((Date.now() - s.startedAt) / 1000));
    $('loadElapsed').textContent = '已用 ' + sec + ' 秒';
  }

  function stopElapsed() {
    if (state.search.elapsedTimer) {
      clearInterval(state.search.elapsedTimer);
      state.search.elapsedTimer = null;
    }
    $('loadElapsed').hidden = true;
  }

  // 用后端给的阶段列表渲染步骤条
  function renderStages(stages, keyword) {
    var list = safeArray(stages).filter(function (st) { return st && (st.key || st.label); });
    if (!list.length) return;
    var s = state.search;
    // 保留已有的进度数据（legacy 切 stream 时同一 key 可复用）
    var old = {};
    s.stages.forEach(function (st) { old[st.key] = st; });

    s.stages = list.map(function (st, i) {
      var key = st.key || ('legacy-' + i);
      var prev = old[key];
      return {
        key: key,
        label: st.label || key,
        done: prev ? prev.done : 0,
        total: prev ? prev.total : 0,
        shown: prev ? prev.shown : 0,
        state: prev ? prev.state : 'waiting'
      };
    });
    if (s.currentIdx >= s.stages.length) s.currentIdx = s.stages.length - 1;

    $('steps').innerHTML = s.stages.map(function (st, i) {
      return '<li class="step" data-key="' + esc(st.key) + '" data-idx="' + i + '">' +
        '<span class="step-dot"></span>' +
        '<div class="step-main">' +
        '<div class="step-line">' +
        '<span class="step-text">' + esc(st.label) + '</span>' +
        '<span class="step-count"></span>' +
        '</div>' +
        '<div class="step-track"><div class="step-fill"></div></div>' +
        '</div></li>';
    }).join('');

    s.stages.forEach(function (st, i) { paintStage(i); });
    paintOverall();
  }

  function stageEl(i) {
    return $('steps').querySelector('.step[data-idx="' + i + '"]');
  }

  function paintStage(i) {
    var s = state.search;
    var st = s.stages[i];
    var el = stageEl(i);
    if (!st || !el) return;

    el.classList.toggle('is-active', st.state === 'active');
    el.classList.toggle('is-done', st.state === 'done');
    el.classList.toggle('is-failed', st.state === 'failed');
    el.classList.toggle('is-waiting', st.state === 'waiting');

    var fill = el.querySelector('.step-fill');
    if (fill) {
      // shown 单调 → 阶段进度条不会回退
      fill.style.width = Math.max(0, Math.min(100, st.shown)) + '%';
    }

    var count = el.querySelector('.step-count');
    if (count) {
      if (st.state === 'failed') {
        count.textContent = '已中断';
        count.classList.remove('is-restart');
      } else if (st.total > 0) {
        count.textContent = fmtInt(st.done) + ' / ' + fmtInt(st.total);
        // 计数已重新开始但进度条仍停在原位（不倒退的代价）→ 用斜体标注一下，避免看起来像卡住
        var restarted = st.restarts > 0 && st.done < st.total && st.shown >= 100;
        count.classList.toggle('is-restart', restarted);
        count.title = restarted
          ? '该阶段换用更细粒度的查询重新计数（进度条按"不倒退"原则保留在此）'
          : '';
      } else if (st.state === 'done') {
        count.textContent = '完成';
        count.classList.remove('is-restart');
      } else {
        count.textContent = '';
        count.classList.remove('is-restart');
      }
    }
  }

  function setOverall(pct, text) {
    var p = Math.max(0, Math.min(100, pct || 0));
    $('overallFill').style.width = p + '%';
    if (text !== undefined) $('overallText').textContent = text;
  }

  function paintOverall() {
    var s = state.search;
    var n = s.stages.length;
    if (!n) return;
    var completed = 0;
    var cur = null;
    for (var i = 0; i < n; i++) {
      var st = s.stages[i];
      if (st.state === 'done') completed++;
      if (st.state === 'active' && !cur) cur = st;
    }
    var frac = cur ? cur.shown / 100 : 0;
    var pct = (completed + frac) / n * 100;
    if (s.mode === 'legacy') {
      setOverall(pct, LEGACY_NOTE);
      $('overallPct').textContent = Math.round(pct) + '%';
      return;
    }
    $('overallPct').textContent = Math.round(pct) + '%';
    if (cur) {
      var idx = s.stages.indexOf(cur) + 1;
      setOverall(pct, '第 ' + idx + '/' + n + ' 阶段 · ' + cur.label);
    } else if (completed >= n) {
      setOverall(100, '全部阶段已完成');
    }
  }

  // 收到一条 progress：更新计数、阶段状态与两条进度条
  function onStageProgress(key, done, total, label) {
    var s = state.search;
    var idx = -1;
    for (var i = 0; i < s.stages.length; i++) {
      if (s.stages[i].key === key) { idx = i; break; }
    }
    if (idx < 0) {
      // 未在 start 里声明的阶段（后端临时新增）→ 插到当前阶段之后，保持执行顺序与展示顺序一致；
      // 若直接追加到末尾，会把它前面的阶段误标成已完成。
      var at = s.currentIdx >= 0 ? s.currentIdx + 1 : s.stages.length;
      s.stages.splice(at, 0, { key: key, label: label || key, done: 0, total: 0, shown: 0, state: 'waiting' });
      renderStages(s.stages);
      idx = at;
    }

    // 推进到新阶段：它之前的所有阶段都视为已完成（后端已走过它们）
    if (idx > s.currentIdx) {
      for (var k = 0; k < idx; k++) {
        if (s.stages[k].state !== 'done') {
          s.stages[k].state = 'done';
          s.stages[k].shown = 100;
          paintStage(k);
        }
      }
      s.currentIdx = idx;
    }

    var st = s.stages[idx];
    if (label && label !== st.label) st.label = label;
    st.state = 'active';

    var d = num(done) || 0;
    var t = num(total) || 0;
    // 计数"重新开始"的两种情形：
    //   ① 分母变了（如 esearch 1/1 → 0/5）——换了一套统计口径；
    //   ② 分母没变但计数明显回跳（如 openalex 797/797 → 17/797）——批量接口额度耗尽后
    //      降级为逐个查询，同一个分母下重新走一遍。
    // 两种情况下计数文本都如实反映后端的新计数；进度条则由 shown（单调）守住，不回退。
    var restart = false;
    if (t !== st.total && st.total > 0) {
      restart = true;
    } else if (t > 0 && t === st.total && d < st.done && st.done >= 3) {
      restart = true;
    }
    if (restart) {
      st.total = t;
      st.done = d;
      st.restarts = (st.restarts || 0) + 1;
    } else {
      st.total = t;
      st.done = Math.max(st.done, d);   // 同一次统计口径下计数只增不减
    }
    var pct = t > 0 ? Math.min(100, d / t * 100) : 0;
    st.shown = Math.max(st.shown, pct);

    paintStage(idx);
    // 阶段 label 可能被后端修正
    var el = stageEl(idx);
    if (el) {
      var txt = el.querySelector('.step-text');
      if (txt) txt.textContent = st.label;
    }
    paintOverall();
  }

  // 全部阶段完成（收到 result）
  function finishProgress() {
    var s = state.search;
    if (s.mode === 'snapshot') {
      var ov = $('overall');
      ov.classList.remove('is-indeterminate');
      setOverall(100, '演示快照已加载');
      $('overallPct').textContent = '100%';
      ov.classList.add('is-done');
      stopElapsed();
      return;
    }
    s.stages.forEach(function (st, i) {
      st.state = 'done';
      st.shown = 100;
      paintStage(i);
    });
    s.currentIdx = s.stages.length;
    $('overall').classList.remove('is-indeterminate');
    $('overall').classList.add('is-done');
    setOverall(100, '全部阶段已完成');
    $('overallPct').textContent = '100%';
    stopElapsed();
  }

  // 失败/中断：把当前阶段标红
  function failProgress() {
    var s = state.search;
    var idx = s.currentIdx;
    if (idx >= 0 && idx < s.stages.length) {
      s.stages[idx].state = 'failed';
      s.failedKey = s.stages[idx].key;
      paintStage(idx);
    }
    $('overall').classList.remove('is-done', 'is-indeterminate');
    $('overall').classList.add('is-failed');
    setOverall(100, '已中断');
    $('overallPct').textContent = '';
    stopElapsed();
  }

  // 降级模式：把阶段表换成估算阶段，并按固定节奏推进
  function startLegacyProgress(reason) {
    var s = startProgress({ mode: 'legacy' });
    if (reason) $('overallText').textContent = LEGACY_NOTE;
    clearInterval(state.progressTimer);
    state.progressTimer = setInterval(function () {
      var i = s.currentIdx;
      if (i < 0) { advanceLegacy(0); return; }
      if (i < s.stages.length - 1) advanceLegacy(i + 1);
    }, LEGACY_STEP_INTERVAL);
    advanceLegacy(0);
  }

  function advanceLegacy(idx) {
    var s = state.search;
    if (idx <= s.currentIdx) return;
    for (var k = 0; k < idx; k++) {
      s.stages[k].state = 'done';
      s.stages[k].shown = 100;
      paintStage(k);
    }
    s.currentIdx = idx;
    var st = s.stages[idx];
    if (!st) return;
    st.state = 'active';
    st.total = 1;
    st.done = 0;
    st.shown = Math.max(st.shown, 12);   // 给一点可见的推进感
    paintStage(idx);
    paintOverall();
  }

  function stopProgress(opts) {
    clearInterval(state.progressTimer);
    state.progressTimer = null;
    if (opts && opts.keepVisible) {
      // 失败时保留阶段条（让用户看到"断在哪一步"），但去掉"还在加载"的骨架
      $('loadingCard').classList.add('is-stopped');
      return;
    }
    $('loadingCard').hidden = true;
    $('loadingCard').classList.remove('is-stopped');
    stopElapsed();
    state.search.mode = 'idle';
    state.search.startedAt = 0;
  }

  function showError(err) {
    var ctx = err.ctx || {};
    $('errorMsg').textContent = (err.message || '未知错误') +
      (err.detail ? '：' + err.detail.replace(/<[^>]*>/g, ' ').slice(0, 200) : '') +
      (err.status ? '（状态码 ' + err.status + '）' : '');

    var advice = [];
    var hits = num(ctx.total_hits);
    if (err.status === 413 || (hits !== null && hits > 200000)) {
      advice.push('关键词过宽' + (hits !== null ? '，命中 ' + fmtInt(hits) + ' 篇' : '') +
        '，建议增加限定词（研究类型 / 物种 / 方法 / 疾病亚型），或缩短年份区间。');
    }
    if (err.status === 0) {
      advice.push('后端服务似乎未启动：请确认已运行 <code>uvicorn app.main:app --port 8000</code> 并能访问 <code>/api/health</code>。');
    }
    if (err.status === 504 || err.status === 408) {
      advice.push('请求超时：把「分析篇数上限」调小（如 500）再试，或等待 NCBI 限流恢复后重试。');
    }
    if (err.status === 502 || err.status === 503) {
      advice.push('上游（NCBI / OpenAlex）暂时不可用，稍等几秒重试通常即可恢复。');
    }
    advice.push('重试前可先用顶部「演示模式」加载预置关键词的本地缓存结果，用于确认是数据问题还是网络问题。');

    $('errorAdvice').innerHTML = advice.map(function (a) { return '<li>' + a + '</li>'; }).join('');
    $('errorCard').hidden = false;
  }

  // ---------------------------------------------------------------- 应用结果

  function applyResult(data) {
    if (!data || typeof data !== 'object') {
      showError({ message: '后端返回内容无法解析', status: 0 });
      return;
    }
    state.data = data;

    renderQueryBar(data);
    renderWarnings(data.warnings);

    var stats = data.stats || {};
    var analyzed = num(stats.analyzed);
    if (!analyzed) {
      $('emptyMsg').textContent = '关键词「' + (data.keyword || state.keyword) + '」在 ' +
        ((data.query && data.query.year_from) || '—') + '–' + ((data.query && data.query.year_to) || '—') +
        ' 年间，命中的文献中没有可分析的记录（命中总数 ' + fmtInt(stats.total_hits) + ' 篇）。';
      $('emptyCard').hidden = false;
      // 空态下隐藏概览/图表/表格，避免出现一片空白卡片；仅保留综述与概括（后端会说明数据不足）
      $('results').hidden = false;
      $('results').classList.add('is-empty');
      $('tableBody').innerHTML = '';
      startStreams(data.search_id);
      return;
    }

    $('results').classList.remove('is-empty');
    $('results').hidden = false;
    renderOverview(stats);
    renderCharts(stats, data.keywords || {});
    renderMeshTags(data.keywords || {});
    loadTableRows();
    startStreams(data.search_id);
  }

  function renderQueryBar(data) {
    var q = data.query || {};
    $('effectiveTerm').textContent = q.effective_term || data.keyword || '—';
    var tq = q.translated_query || '';
    $('translatedQuery').textContent = tq || '（本次检索未返回自动扩展翻译，可能关键词已是精确短语）';
    $('queryBar').hidden = false;
  }

  function renderWarnings(warnings) {
    var list = safeArray(warnings).filter(function (w) { return w && String(w).trim(); });
    var bar = $('warnBar');
    if (!list.length) { bar.hidden = true; return; }
    $('warnTitle').textContent = '数据口径提示（' + list.length + ' 条，点击展开）';
    $('warnList').innerHTML = list.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    $('warnToggle').setAttribute('aria-expanded', 'true');
    bar.hidden = false;
  }

  // ---------------------------------------------------------------- 概览卡片

  function renderOverview(stats) {
    var cov = stats.coverage || {};
    var ifs = stats.impact_factor || {};
    var yr = safeArray(stats.year_range);

    var jcrDist = safeArray(stats.jcr_quartile_distribution);
    var zoneCount = 0, q1 = 0;
    jcrDist.forEach(function (d) {
      var q = String(d.quartile || '');
      if (/^Q[1-4]$/i.test(q)) {
        zoneCount += num(d.count) || 0;
        if (q.toUpperCase() === 'Q1') q1 += num(d.count) || 0;
      }
    });
    var q1Pct = zoneCount ? (q1 / zoneCount * 100) : null;

    var cards = [
      {
        label: 'PubMed 命中总数',
        value: fmtInt(stats.total_hits),
        unit: '篇',
        sub: '关键词在指定年份区间的检索命中量（未截断）'
      },
      {
        label: '实际分析篇数',
        value: fmtInt(stats.analyzed),
        unit: '篇',
        sub: num(stats.total_hits) > num(stats.analyzed)
          ? '按年份配额分层抽样 ' + fmtInt(stats.analyzed) + ' 篇（各年样本量按该年文献量比例分配）'
          : '全部命中均已纳入分析'
      },
      {
        label: '时间跨度',
        value: (yr.length === 2 && yr[0] != null) ? (yr[0] + '–' + yr[1]) : '—',
        unit: '',
        sub: '逐年全量精确计数覆盖的年份区间'
      },
      {
        label: 'JCR 期刊覆盖率',
        value: fmtPct(cov.journal_coverage_pct),
        unit: '',
        sub: fmtInt(cov.journal_matched) + ' / ' + fmtInt(cov.journal_total) +
          ' 篇匹配到期刊指标（含刊名兜底 ' + fmtInt(cov.matched_by_name) + ' 篇）'
      },
      {
        label: '平均影响因子',
        value: fmtIf(ifs.mean),
        unit: '',
        sub: '中位数 ' + fmtIf(ifs.median) + '，最高 ' + fmtIf(ifs.max) +
          '；基于 ' + fmtInt(ifs.counted) + ' 篇有 IF 的文献'
      },
      {
        label: 'Q1 期刊占比',
        value: fmtPct(q1Pct),
        unit: '',
        sub: fmtInt(q1) + ' / ' + fmtInt(zoneCount) + ' 篇有 JCR 分区的文献（不含 N/A 与未匹配）'
      }
    ];

    $('overview').innerHTML = cards.map(function (c) {
      return '<div class="stat-card">' +
        '<div class="stat-label">' + esc(c.label) + '</div>' +
        '<div class="stat-value">' + esc(c.value) +
        (c.unit ? '<span class="unit">' + esc(c.unit) + '</span>' : '') + '</div>' +
        '<div class="stat-sub">' + esc(c.sub) + '</div>' +
        '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- 图表

  var AXIS_BASE = {
    axisLine: { lineStyle: { color: '#d5dce6' } },
    axisTick: { show: false },
    axisLabel: { color: '#6b7b91', fontSize: 11.5 },
    splitLine: { lineStyle: { color: '#eef1f5' } },
    nameTextStyle: { color: '#8291a6', fontSize: 11 }
  };

  function getChart(key, elId) {
    var el = $(elId);
    if (!el) return null;
    if (!state.charts[key]) {
      if (!window.echarts) return null;
      state.charts[key] = echarts.init(el, null, { renderer: 'canvas' });
    }
    return state.charts[key];
  }

  function resizeCharts() {
    Object.keys(state.charts).forEach(function (k) {
      try { state.charts[k].resize(); } catch (e) { /* ignore */ }
    });
  }

  function renderCharts(stats, keywords) {
    renderYearChart(stats);
    renderZoneChart();
    renderIfChart(stats);
    renderCloudChart();
    // 容器刚从 hidden 切到可见，下一帧再 resize 一次确保尺寸正确
    requestAnimationFrame(function () { resizeCharts(); });
  }

  // 1) 年份趋势：柱（文献量）+ 折线（中位 IF，双 Y 轴）
  function renderYearChart(stats) {
    var chart = getChart('year', 'chartYear');
    if (!chart) return;

    var dist = safeArray(stats.year_distribution);
    var trend = safeArray(stats.median_if_trend);
    var medMap = {};
    trend.forEach(function (d) { if (d && d.year != null) medMap[d.year] = num(d.median_if); });

    var years = dist.map(function (d) { return d.year; });
    if (!years.length) {
      years = trend.map(function (d) { return d.year; });
    }
    var countMap = {};
    dist.forEach(function (d) { countMap[d.year] = num(d.count) || 0; });

    if (!years.length) {
      chart.clear();
      chart.setOption(emptyOption('没有可用的年份数据'));
      return;
    }

    var counts = years.map(function (y) { return countMap[y] || 0; });
    var meds = years.map(function (y) {
      var v = medMap[y];
      return (v === null || v === undefined) ? null : v;
    });

    chart.setOption({
      color: ['#2f7cb8', '#b45309'],
      grid: { left: 8, right: 8, top: 38, bottom: 28, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(18,35,61,.94)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(34,96,155,.07)' } },
        formatter: function (ps) {
          var out = '<b>' + ps[0].axisValue + ' 年</b>';
          ps.forEach(function (p) {
            var v = p.value;
            if (v === null || v === undefined) { out += '<br>' + p.marker + p.seriesName + '：—'; return; }
            out += '<br>' + p.marker + p.seriesName + '：' +
              (p.seriesName === '影响因子中位数' ? fmtIf(v) : fmtInt(v) + ' 篇');
          });
          return out;
        }
      },
      legend: {
        bottom: 0, left: 'center', itemWidth: 11, itemHeight: 11, itemGap: 16,
        textStyle: { color: '#52627a', fontSize: 11.5 }
      },
      xAxis: Object.assign({}, AXIS_BASE, {
        type: 'category',
        data: years,
        splitLine: { show: false },
        axisLabel: { color: '#6b7b91', fontSize: 11.5, interval: 'auto', rotate: years.length > 12 ? 40 : 0 }
      }),
      yAxis: [
        Object.assign({}, AXIS_BASE, {
          type: 'value', name: '文献量（篇）', nameGap: 14,
          axisLabel: { color: '#6b7b91', fontSize: 11.5, formatter: function (v) { return v >= 1000 ? (v / 1000) + 'k' : v; } }
        }),
        Object.assign({}, AXIS_BASE, {
          type: 'value', name: '影响因子中位数', nameGap: 12,
          splitLine: { show: false },
          axisLabel: { color: '#b45309', fontSize: 11.5, formatter: function (v) { return fmtIf(v); } }
        })
      ],
      series: [
        {
          name: '文献量', type: 'bar', barMaxWidth: 34,
          data: counts,
          itemStyle: {
            borderRadius: [3, 3, 0, 0],
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#3d8cc4' }, { offset: 1, color: '#22609b' }]
            }
          },
          emphasis: { itemStyle: { color: '#16365c' } }
        },
        {
          name: '影响因子中位数', type: 'line', yAxisIndex: 1,
          data: meds, smooth: true, connectNulls: true,
          symbol: 'circle', symbolSize: 6,
          lineStyle: { width: 2, color: '#b45309' },
          itemStyle: { color: '#b45309', borderColor: '#fff', borderWidth: 1.5 }
        }
      ]
    }, true);
  }

  // 2) 分区分布：环形图，可切 中科院 / JCR
  function renderZoneChart() {
    var chart = getChart('zone', 'chartZone');
    if (!chart || !state.data) return;
    var stats = state.data.stats || {};

    var items;
    if (state.zoneMode === 'jcr') {
      items = safeArray(stats.jcr_quartile_distribution).map(function (d) {
        var q = String(d.quartile || '未匹配');
        var name = /^Q[1-4]$/i.test(q) ? q.toUpperCase() + ' 区' : (q === 'N/A' ? 'N/A（无分区）' : '未匹配');
        return { name: name, value: num(d.count) || 0 };
      });
      $('zoneSub').textContent = '按 JCR 分区统计文献占比（N/A 表示该刊无分区数据）';
    } else {
      items = safeArray(stats.cas_zone_distribution).map(function (d) {
        var z = String(d.zone || '');
        var name = d.label || (/^[1-4]$/.test(z) ? '中科院 ' + z + ' 区' : '未匹配');
        return { name: name, value: num(d.count) || 0 };
      });
      $('zoneSub').textContent = '按中科院大类分区统计文献占比（升级版 2025，官方已停止更新）';
    }
    items = items.filter(function (d) { return d.value > 0; });

    if (!items.length) {
      chart.clear();
      chart.setOption(emptyOption('没有可用的分区数据'));
      return;
    }

    var total = items.reduce(function (a, b) { return a + b.value; }, 0);

    chart.setOption({
      color: ZONE_COLORS,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(18,35,61,.94)', borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        formatter: function (p) {
          return '<b>' + p.name + '</b><br>' + fmtInt(p.value) + ' 篇 · ' +
            (p.value / total * 100).toFixed(1) + '%';
        }
      },
      legend: {
        bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10, itemGap: 12,
        textStyle: { color: '#52627a', fontSize: 11.5 }
      },
      series: [{
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        padAngle: 1.5,
        itemStyle: { borderColor: '#fff', borderWidth: 1.5, borderRadius: 3 },
        label: {
          show: true,
          formatter: function (p) {
            return p.name + '\n' + (p.value / total * 100).toFixed(1) + '%';
          },
          color: '#52627a', fontSize: 11.5, lineHeight: 15
        },
        labelLine: { length: 10, length2: 10, lineStyle: { color: '#ccd5e0' } },
        emphasis: {
          scale: true, scaleSize: 6,
          label: { fontSize: 12.5, color: '#16365c', fontWeight: 600 }
        },
        data: items
      }]
    }, true);
  }

  // 3) 影响因子直方图 + 中位数/均值 markLine
  function renderIfChart(stats) {
    var chart = getChart('ifv', 'chartIf');
    if (!chart) return;

    var ifs = stats.impact_factor || {};
    var hist = safeArray(ifs.histogram);
    if (!hist.length) {
      chart.clear();
      chart.setOption(emptyOption('没有匹配到影响因子的文献'));
      return;
    }

    var buckets = hist.map(function (d) { return d.bucket; });
    var counts = hist.map(function (d) { return num(d.count) || 0; });

    $('ifSub').textContent = '仅统计匹配到 JCR 影响因子的 ' + fmtInt(ifs.counted) +
      ' 篇；中位数 ' + fmtIf(ifs.median) + '，均值 ' + fmtIf(ifs.mean);

    function bucketOf(v) {
      if (v === null || v === undefined || !isFinite(v)) return null;
      for (var i = 0; i < buckets.length; i++) {
        var b = String(buckets[i]);
        var m = /^([\d.]+)\s*[-–~]\s*([\d.]+)$/.exec(b);
        if (m) {
          var lo = parseFloat(m[1]), hi = parseFloat(m[2]);
          if (v >= lo && v < hi) return b;
        } else if (/^([\d.]+)\s*\+$/.test(b)) {
          var lo2 = parseFloat(/^([\d.]+)/.exec(b)[1]);
          if (v >= lo2) return b;
        }
      }
      return buckets[buckets.length - 1];
    }

    var marks = [];
    var medB = bucketOf(num(ifs.median));
    if (medB) {
      marks.push({
        xAxis: medB,
        lineStyle: { color: '#b45309', type: 'dashed', width: 1.6 },
        label: {
          formatter: '中位数 ' + fmtIf(ifs.median), position: 'end', distance: 6, rotate: 0,
          color: '#b45309', fontSize: 11, fontWeight: 600,
          backgroundColor: 'rgba(255,255,255,.85)', padding: [2, 4], borderRadius: 3
        }
      });
    }
    // 均值与中位数可能落在同一分桶，仍然两条都画（标签上下错开，避免相互遮挡）
    var meanB = bucketOf(num(ifs.mean));
    if (meanB) {
      var same = (meanB === medB);
      marks.push({
        xAxis: meanB,
        lineStyle: { color: '#0f766e', type: 'dashed', width: 1.6, opacity: same ? .9 : 1 },
        label: {
          formatter: '均值 ' + fmtIf(ifs.mean), position: 'end', distance: same ? 24 : 6, rotate: 0,
          color: '#0f766e', fontSize: 11, fontWeight: 600,
          backgroundColor: 'rgba(255,255,255,.85)', padding: [2, 4], borderRadius: 3
        }
      });
    }

    chart.setOption({
      color: ['#2f7cb8'],
      grid: { left: 8, right: 14, top: 40, bottom: 6, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(18,35,61,.94)', borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(34,96,155,.07)' } },
        formatter: function (ps) {
          var p = ps[0];
          var total = counts.reduce(function (a, b) { return a + b; }, 0) || 1;
          return '<b>影响因子 ' + p.axisValue + '</b><br>' + fmtInt(p.value) + ' 篇 · ' +
            (p.value / total * 100).toFixed(1) + '%';
        }
      },
      xAxis: Object.assign({}, AXIS_BASE, {
        type: 'category', data: buckets, name: '影响因子区间', nameGap: 26,
        splitLine: { show: false },
        axisLabel: { color: '#6b7b91', fontSize: 11.5 },
        nameLocation: 'middle'
      }),
      yAxis: Object.assign({}, AXIS_BASE, {
        type: 'value', name: '文献量（篇）', nameGap: 12,
        axisLabel: { color: '#6b7b91', fontSize: 11.5, formatter: function (v) { return v >= 1000 ? (v / 1000) + 'k' : v; } }
      }),
      series: [{
        name: '文献量', type: 'bar', barMaxWidth: 56,
        data: counts,
        itemStyle: {
          borderRadius: [3, 3, 0, 0],
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: '#5b9fd0' }, { offset: 1, color: '#22609b' }]
          }
        },
        label: {
          show: true, position: 'top', color: '#6b7b91', fontSize: 11,
          formatter: function (p) { return p.value > 0 ? fmtInt(p.value) : ''; }
        },
        markLine: {
          silent: true, symbol: 'none',
          data: marks
        }
      }]
    }, true);
  }

  // 4) 主题词云（点击筛选表格），webgl 不可用时降级为条形图
  function renderCloudChart() {
    var chart = getChart('cloud', 'chartCloud');
    if (!chart || !state.data) return;
    var kw = state.data.keywords || {};

    var items;
    if (state.cloudSource === 'mesh_major') {
      items = safeArray(kw.mesh_major).map(function (d) {
        return { name: d.term, value: num(d.count) || 0, source: 'mesh' };
      });
    } else {
      items = safeArray(kw.cloud).map(function (d) {
        return { name: d.name, value: num(d.value) || 0, source: d.source || '' };
      });
    }
    items = items.filter(function (d) { return d.name && d.value > 0; });

    if (!items.length) {
      chart.clear();
      chart.setOption(emptyOption('没有可用的主题词数据'));
      return;
    }

    var top = items.slice(0, 70);

    if (state.wordcloudOk === false) {
      // 降级：横向条形图
      var bars = top.slice(0, 22).slice().reverse();
      chart.clear();
      chart.setOption({
        color: ['#22609b'],
        grid: { left: 8, right: 40, top: 10, bottom: 6, containLabel: true },
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' },
          backgroundColor: 'rgba(18,35,61,.94)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
          formatter: function (ps) { return '<b>' + ps[0].name + '</b><br>出现 ' + fmtInt(ps[0].value) + ' 次'; }
        },
        xAxis: Object.assign({}, AXIS_BASE, { type: 'value', axisLabel: { color: '#6b7b91', fontSize: 11 } }),
        yAxis: Object.assign({}, AXIS_BASE, {
          type: 'category', data: bars.map(function (d) { return d.name; }),
          splitLine: { show: false },
          axisLabel: { color: '#52627a', fontSize: 11.5, width: 150, overflow: 'truncate' }
        }),
        series: [{
          type: 'bar', data: bars.map(function (d) { return d.value; }),
          barMaxWidth: 16,
          itemStyle: { borderRadius: [0, 3, 3, 0], color: '#2f7cb8' }
        }]
      });
      return;
    }

    chart.clear();
    chart.setOption({
      tooltip: {
        show: true,
        backgroundColor: 'rgba(18,35,61,.94)', borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        formatter: function (p) {
          var src = p.data.source === 'mesh' ? 'MeSH 主题词' :
            (p.data.source === 'tfidf' ? 'TF-IDF 术语' : (p.data.source === 'phrase' ? '标题短语' : '合并来源'));
          return '<b>' + p.name + '</b><br>词频：' + fmtInt(p.value) +
            '<br><span style="opacity:.75">' + src + ' · 点击可筛选下方文献表</span>';
        }
      },
      series: [{
        type: 'wordCloud',
        shape: 'circle',
        left: 'center', top: 'center',
        width: '96%', height: '92%',
        sizeRange: [13, 56],
        rotationRange: [0, 0],
        rotationStep: 45,
        gridSize: 9,
        drawOutOfBound: false,
        layoutAnimation: true,
        textStyle: {
          fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
          fontWeight: 'normal',
          color: function () {
            var pool = ['#16365c', '#22609b', '#2f7cb8', '#4b8ec4', '#0f766e', '#b45309', '#52627a'];
            return pool[Math.floor(Math.random() * pool.length)];
          }
        },
        emphasis: {
          textStyle: { textShadowBlur: 6, textShadowColor: 'rgba(18,35,61,.28)', color: '#b45309' }
        },
        data: top
      }]
    });

    chart.off('click');
    chart.on('click', function (p) {
      if (p && p.name) applyWordFilter(p.name);
    });
  }

  function emptyOption(text) {
    return {
      title: {
        text: text,
        left: 'center', top: 'middle',
        textStyle: { color: '#98a5b8', fontSize: 13, fontWeight: 'normal' }
      },
      xAxis: { show: false },
      yAxis: { show: false },
      series: []
    };
  }

  // ---------------------------------------------------------------- 主题词标签

  function renderMeshTags(kw) {
    var list = safeArray(kw.mesh_major).slice(0, 16);
    if (!list.length) { $('meshTags').hidden = true; return; }
    $('meshTagItems').innerHTML = list.map(function (d) {
      return '<button type="button" class="mesh-tag" data-term="' + esc(d.term) + '">' +
        esc(d.term) + '<span class="n">' + fmtInt(d.count) + '</span></button>';
    }).join('');
    $('meshTagItems').querySelectorAll('.mesh-tag').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var term = btn.getAttribute('data-term');
        applyWordFilter(state.wordFilter === term ? '' : term);
      });
    });
    $('meshTags').hidden = false;
  }

  function applyWordFilter(term) {
    state.wordFilter = term || '';
    document.querySelectorAll('.mesh-tag').forEach(function (t) {
      t.classList.toggle('is-active', !!term && t.getAttribute('data-term') === term);
    });
    renderTable();
    var el = $('articleTable');
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (term) toast('已筛选主题词：' + term);
  }

  // ---------------------------------------------------------------- 文献表

  function loadTableRows() {
    var top = (state.data && state.data.top100) || {};
    var rows = safeArray(state.tab === 'by_citations' ? top.by_citations : top.by_if);
    state.rows = rows;

    var note = top.note;
    if (note) {
      $('topNoteText').textContent = note;
      $('topNote').hidden = false;
    } else {
      $('topNote').hidden = true;
    }

    var yf = top.year_from, yt = top.year_to;
    var label = state.tab === 'by_citations' ? '按被引次数' : '按期刊影响因子';
    var cnt = state.tab === 'by_citations' ? top.count_by_citations : top.count_by_if;
    $('tableSub').textContent = label + '排序 · 收录年份 ' + (yf || '—') + '–' + (yt || '—') +
      ' · 共 ' + fmtInt(cnt !== undefined ? cnt : rows.length) + ' 条';

    state.sortKey = null;
    state.sortDir = 'desc';
    renderTable();
  }

  function matchesText(r, q) {
    if (!q) return true;
    var hay = [
      r.title, r.journal, r.journal_abbr,
      (safeArray(r.authors)).join(' '),
      (safeArray(r.pubtypes)).join(' '),
      (safeArray(r.mesh_major)).join(' '),
      r.pmid, r.year
    ].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function matchesWord(r, term) {
    if (!term) return true;
    var t = term.toLowerCase();
    var inMesh = safeArray(r.mesh_major).some(function (m) {
      var s = String(m).toLowerCase();
      return s === t || s.indexOf(t) >= 0 || t.indexOf(s) >= 0;
    });
    if (inMesh) return true;
    return String(r.title || '').toLowerCase().indexOf(t) >= 0;
  }

  function sortedRows() {
    var rows = state.rows.filter(function (r) {
      return matchesWord(r, state.wordFilter) && matchesText(r, state.textFilter.toLowerCase());
    });
    if (!state.sortKey) return rows;

    var key = state.sortKey;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (key === 'title') {
        return dir * String(va || '').localeCompare(String(vb || ''), 'zh-Hans-CN');
      }
      // 空值永远排在最后
      var na = num(va), nb = num(vb);
      if (na === null && nb === null) return 0;
      if (na === null) return 1;
      if (nb === null) return -1;
      if (na === nb) {
        // 次级排序：被引次数 → 年份，保持稳定感
        var ca = num(a.citations), cb = num(b.citations);
        if (ca !== null && cb !== null && ca !== cb) return cb - ca;
        return (num(b.year) || 0) - (num(a.year) || 0);
      }
      return dir * (na - nb);
    });
  }

  function highlight(text, q) {
    var s = esc(text);
    if (!q) return s;
    var idx = s.toLowerCase().indexOf(esc(q).toLowerCase());
    if (idx < 0) return s;
    var len = esc(q).length;
    return s.slice(0, idx) + '<mark>' + s.slice(idx, idx + len) + '</mark>' + s.slice(idx + len);
  }

  function renderTable() {
    var rows = sortedRows();
    var tbody = $('tableBody');
    var q = state.textFilter;
    var kw = (state.data && state.data.keyword) || state.keyword;

    // 表头排序指示
    document.querySelectorAll('#articleTable th.sortable').forEach(function (th) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (state.sortKey === th.getAttribute('data-sort')) {
        th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });

    var filters = [];
    if (state.wordFilter) filters.push('主题词「' + state.wordFilter + '」');
    if (q) filters.push('文本「' + q + '」');
    $('tableFilterState').textContent = filters.length
      ? '已筛选：' + filters.join(' + ') + '，命中 ' + rows.length + ' / ' + state.rows.length + ' 条'
      : '共 ' + state.rows.length + ' 条';

    $('tableEmpty').hidden = rows.length > 0;
    tbody.innerHTML = rows.map(function (r, i) {
      var url = r.url || (r.pmid ? PUBMED + r.pmid + '/' : '');
      var title = highlight(r.title || ('PMID ' + r.pmid), q);
      var journal = highlight(r.journal || r.journal_abbr || '—', q);

      var badges = [];
      if (num(r.journal_if) !== null) {
        badges.push('<span class="badge badge-if" title="JCR 2025 影响因子">IF ' + fmtIf(r.journal_if) + '</span>');
      } else if (num(r.proxy_citedness) !== null) {
        badges.push('<span class="badge badge-none" title="OpenAlex 两年平均被引强度，非影响因子">代理 ' + fmtIf(r.proxy_citedness) + '</span>');
      } else {
        badges.push('<span class="badge badge-none">无 IF 数据</span>');
      }
      if (r.jcr_quartile) {
        var quart = String(r.jcr_quartile);
        badges.push('<span class="badge ' + (/^Q1$/i.test(quart) ? 'badge-q1' : '') + '" title="JCR 分区' +
          (r.jcr_rank ? ' ' + esc(r.jcr_rank) : '') + '">' + esc(quart) + '</span>');
      }
      if (num(r.cas_zone) !== null) {
        badges.push('<span class="badge badge-zone" title="' + esc(r.cas_major || '') + ' 大类">中科院 ' + esc(r.cas_zone) + ' 区</span>');
      }
      if (r.cas_top) badges.push('<span class="badge badge-top">Top</span>');

      var meta = [];
      if (r.pmid) meta.push('<span class="pmid">PMID ' + esc(r.pmid) + '</span>');
      if (r.pubdate) meta.push('<span>' + esc(r.pubdate) + '</span>');
      if (safeArray(r.pubtypes).length) meta.push('<span>' + esc(safeArray(r.pubtypes)[0]) + '</span>');
      var ac = num(r.author_count);
      if (ac) meta.push('<span>' + ac + ' 位作者</span>');
      if (!r.has_abstract) meta.push('<span>无摘要</span>');

      var mesh = safeArray(r.mesh_major).slice(0, 3).map(function (t) {
        return '<span class="mesh-hint" title="MeSH 主题词">' + esc(t) + '</span>';
      }).join('');

      return '<tr>' +
        '<td class="col-idx">' + (i + 1) + '</td>' +
        '<td>' + (url
          ? '<a class="cell-title" href="' + esc(url) + '" target="_blank" rel="noopener">' + title + '</a>'
          : '<span class="cell-title">' + title + '</span>') +
        '<div class="cell-meta">' + meta.join('') + '</div>' +
        (mesh ? '<div class="cell-mesh">' + mesh + '</div>' : '') + '</td>' +
        '<td class="col-journal"><div class="journal-name">' + journal + '</div>' +
        '<div class="badges">' + badges.join('') + '</div></td>' +
        '<td class="col-year">' + (r.year || '—') + '</td>' +
        '<td class="col-cite">' + (num(r.citations) !== null ? fmtInt(r.citations) : '—') + '</td>' +
        '</tr>';
    }).join('');

    if (state.rows.length && !rows.length) {
      $('tableEmpty').innerHTML = '没有符合过滤条件的文献。' +
        (state.wordFilter ? '主题词「' + esc(state.wordFilter) + '」在 Top 100 中可能没有直接标注，' : '') +
        '可清空过滤框后重试。';
    } else {
      $('tableEmpty').textContent = '没有符合过滤条件的文献。';
    }

    if (!state.rows.length) {
      $('tableSub').textContent = '「' + (kw || '') + '」在近 5 年内没有可作为榜单依据的文献（缺少 IF 或被引数据）。';
    }
  }

  // ---------------------------------------------------------------- SSE 流式

  function startStreams(searchId) {
    if (!searchId) {
      setStreamError('summary', '后端未返回 search_id，无法启动流式生成');
      setStreamError('review', '后端未返回 search_id，无法启动流式生成');
      return;
    }
    state.es.summary = openStream(API.streamSummary(searchId), 'summary');
    state.es.review = openStream(API.streamReview(searchId), 'review');
  }

  // ---- 首块到达前的等待态：不要留 1.5 秒以上的空白 ----

  function setPending(kind, phase) {
    var p = state.pending[kind];
    if (p.phase === phase) return;
    p.phase = phase;
    if (phase === 'connecting' || phase === 'reading') {
      p.startedAt = Date.now();
      paintPending(kind);
      syncPendingTimer();
    } else {
      syncPendingTimer();
    }
  }

  function paintPending(kind) {
    var p = state.pending[kind];
    if (p.phase !== 'connecting' && p.phase !== 'reading') return;
    var el = kind === 'review' ? $('reviewBody') : $('summaryBody');
    var sec = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));

    // 上下文规模（后端 result.context_chars）。没有这个字段就整个省略，
    // 不编造数字——宁可少说一句，也不要写一个假的"4.2 万字"。
    function ctxWords() {
      var n = state.data && num(state.data.context_chars);
      if (!n) return '';
      return n >= 10000 ? '（约 ' + (n / 10000).toFixed(1) + ' 万字）' : '（约 ' + fmtInt(n) + ' 字）';
    }
    var model = state.llmModel
      ? '<span class="pending-model">' + esc(state.llmModel) + '</span>'
      : '';
    var text = p.phase === 'connecting'
      ? '正在连接大模型' + (model ? '（' + model + '）' : '（已配置）') + '…'
      : '已连接大模型' + (model ? '（' + model + '）' : '') +
        '，正在阅读检索上下文' + ctxWords() + '并组织' +
        (kind === 'review' ? '综述' : '概括') + '…';
    el.innerHTML = '<span class="pending">' +
      '<span class="pending-dots"><i></i><i></i><i></i></span>' +
      '<span>' + text + '</span>' +
      '<span class="pending-time">已用 ' + sec + ' 秒</span>' +
      '</span>';
  }

  // 只要有流还停在"连接/阅读"阶段，就持续刷新秒数（让用户确认程序还活着）
  function syncPendingTimer() {
    var active = false;
    ['review', 'summary'].forEach(function (k) {
      var ph = state.pending[k].phase;
      if (ph === 'connecting' || ph === 'reading') active = true;
    });
    if (active && !state.pendingTimer) {
      state.pendingTimer = setInterval(function () {
        ['review', 'summary'].forEach(function (k) { paintPending(k); });
      }, 500);
    } else if (!active && state.pendingTimer) {
      clearInterval(state.pendingTimer);
      state.pendingTimer = null;
    }
  }

  function clearPending(kind, phase) {
    var p = state.pending[kind];
    p.phase = phase || 'closed';
    syncPendingTimer();
  }

  function resetPending() {
    ['review', 'summary'].forEach(function (k) {
      state.pending[k] = { phase: 'idle', startedAt: 0 };
    });
    if (state.pendingTimer) {
      clearInterval(state.pendingTimer);
      state.pendingTimer = null;
    }
  }

  function openStream(url, kind) {
    if (typeof window.EventSource === 'undefined') {
      setStreamError(kind, '当前浏览器不支持 EventSource，无法接收流式内容');
      return null;
    }
    setPending(kind, 'connecting');
    var es = new EventSource(url);
    var closed = false;

    // 连接建立（SSE 握手完成）→ 立刻把占位换成"正在阅读上下文"
    es.onopen = function () {
      if (closed) return;
      if (state.pending[kind].phase === 'connecting') setPending(kind, 'reading');
    };

    es.onmessage = function (ev) {
      if (closed) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      if (msg.error) {
        closed = true; es.close();
        clearPending(kind);
        setStreamError(kind, msg.error);
        return;
      }
      if (msg.done) {
        closed = true; es.close();   // 必须关闭，否则 EventSource 会自动重连
        clearPending(kind);
        finishStream(kind, msg);
        return;
      }
      if (typeof msg.delta === 'string' && msg.delta) {
        if (state.pending[kind].phase !== 'streaming') clearPending(kind, 'streaming');
        appendStream(kind, msg.delta);
      }
    };

    es.onerror = function () {
      if (closed) return;
      closed = true;
      es.close();                    // 阻断自动重连
      var st = state.streams[kind];
      clearPending(kind);
      if (st.raw) {
        finishStream(kind, { done: true, partial: true });
        setStreamChip(kind, '连接中断，内容可能不完整', true);
      } else {
        setStreamError(kind, '流式连接中断（服务端未返回内容或流已异常关闭）');
      }
    };

    return es;
  }

  function closeStreams() {
    ['review', 'summary'].forEach(function (k) {
      if (state.es[k]) {
        try { state.es[k].close(); } catch (e) { /* ignore */ }
        state.es[k] = null;
      }
    });
    resetPending();
  }

  var pendingRender = { review: false, summary: false };

  function appendStream(kind, delta) {
    var st = state.streams[kind];
    st.raw += delta;
    scheduleRender(kind);
  }

  function scheduleRender(kind) {
    if (pendingRender[kind]) return;
    pendingRender[kind] = true;
    requestAnimationFrame(function () {
      pendingRender[kind] = false;
      paintStream(kind, true);
    });
  }

  function paintStream(kind, streaming) {
    var st = state.streams[kind];
    var el = kind === 'review' ? $('reviewBody') : $('summaryBody');
    var text = st.raw;
    if (!text) {
      if (st.error) {
        el.innerHTML = '<span class="stream-placeholder">' + esc(st.error) + '</span>';
      }
      return;
    }
    var html = renderMarkdown(text);
    if (streaming) html += '<span class="cursor-blink"></span>';
    el.innerHTML = html;

    if (kind === 'review') {
      $('copyReview').disabled = false;
      $('exportReview').disabled = false;
    }
  }

  function finishStream(kind, msg) {
    var st = state.streams[kind];
    st.finished = true;
    st.fallback = !!(msg && msg.fallback);
    paintStream(kind, false);
    if (!st.raw) {
      // 没有内容但收到 done：给一个明确说明
      var el = kind === 'review' ? $('reviewBody') : $('summaryBody');
      el.innerHTML = '<span class="stream-placeholder">' +
        (kind === 'review' ? '本次未生成综述正文（可能数据不足或大模型未返回内容）。' : '本次未生成研究方向概括。') +
        '</span>';
    }
    if (st.fallback) {
      setStreamChip(kind, '已降级为模板化生成（大模型不可用）', true);
    } else if (kind === 'review' && st.raw) {
      setStreamChip(kind, '生成完成 · ' + st.raw.replace(/\s/g, '').length + ' 字', false);
    } else if (kind === 'summary' && st.raw) {
      setStreamChip(kind, '生成完成', false);
    }
  }

  function setStreamError(kind, message) {
    var st = state.streams[kind];
    st.error = message;
    var el = kind === 'review' ? $('reviewBody') : $('summaryBody');
    if (!st.raw) {
      el.innerHTML = '<span class="stream-placeholder">生成失败：' + esc(message) + '</span>';
    }
    setStreamChip(kind, '生成失败：' + String(message).slice(0, 40), true);
  }

  function setStreamChip(kind, text, warn) {
    var el = kind === 'review' ? $('reviewChip') : $('summaryChip');
    el.textContent = text;
    el.classList.toggle('is-warn', !!warn);
    el.hidden = false;
  }

  // ---------------------------------------------------------------- 复制 / 导出

  function buildExportText() {
    var d = state.data || {};
    var q = d.query || {};
    var stats = d.stats || {};
    var lines = [];
    lines.push('# ' + (d.keyword || state.keyword) + ' —— 领域文献计量分析综述');
    lines.push('');
    lines.push('- 检索式：`' + (q.effective_term || d.keyword || '') + '`');
    lines.push('- 年份区间：' + (q.year_from || '') + '–' + (q.year_to || ''));
    lines.push('- PubMed 命中：' + fmtInt(stats.total_hits) + ' 篇；本次分析：' + fmtInt(stats.analyzed) + ' 篇');
    var cov = stats.coverage || {};
    lines.push('- JCR 期刊覆盖率：' + fmtPct(cov.journal_coverage_pct) +
      '（' + fmtInt(cov.journal_matched) + '/' + fmtInt(cov.journal_total) + '）');
    var ifs = stats.impact_factor || {};
    lines.push('- 影响因子：均值 ' + fmtIf(ifs.mean) + '，中位数 ' + fmtIf(ifs.median) + '，最高 ' + fmtIf(ifs.max));
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(state.streams.review.raw || '（未生成综述正文）');
    lines.push('');
    lines.push('> 数据来源：JCR 2025 / 中科院分区升级版 2025 / PubMed E-utilities / OpenAlex。');
    lines.push('> 未匹配期刊指标的文献不参与影响因子统计；命中数超出分析上限时仅分析前 N 篇。');
    return lines.join('\n');
  }

  function copyReview() {
    var text = buildExportText();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('综述全文已复制到剪贴板'); }
      catch (e) { toast('复制失败，请手动选择文本'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('综述全文已复制到剪贴板');
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  function exportReview() {
    var text = buildExportText();
    var kw = (state.data && state.data.keyword) || state.keyword || 'review';
    var stamp = new Date().toISOString().slice(0, 10);
    var filename = 'review_' + String(kw).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '_' + stamp + '.md';
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('已导出 ' + filename);
  }

  // ---------------------------------------------------------------- 启动

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
