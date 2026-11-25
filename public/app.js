'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const E = v => (v === null || v === undefined) ? '—' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = (v, d) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(d === undefined ? 2 : d);
  const PC = (v, d) => {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '<span class="flat">—</span>';
    const n = Number(v), c = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
    return '<span class="' + c + '">' + (n > 0 ? '+' : '') + n.toFixed(d === undefined ? 2 : d) + '%</span>';
  };
  const AMT = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : (Number(v) >= 1e8 ? (Number(v) / 1e8).toFixed(2) + '亿' : (Number(v) / 1e4).toFixed(0) + '万');
  const CAP = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(1) + '亿';
  const YI = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : (Number(v) / 1e8).toFixed(2) + '亿';
  const tag = (t, cls) => '<span class="tag ' + (cls || '') + '">' + E(t) + '</span>';
  const src = s => '<span class="src">来源：' + E(s) + '</span>';
  /* 板块角标：非主板股票在名称左上角标记（主板不显示）。判定与 lib/datasource.js boardOf 一致 */
  const BOARD_BADGE = { cy: { c: '创', n: '创业板' }, kc: { c: '科', n: '科创板' }, bj: { c: '北', n: '北交所' } };
  const boardKey = code => {
    const c = String(code || '').replace(/\D/g, '');
    if (/^(600|601|603|605|000|001|002|003)/.test(c)) return '';   // 主板：不标记
    if (/^(300|301)/.test(c)) return 'cy';
    if (/^(688|689)/.test(c)) return 'kc';
    if (/^(8|4|920)/.test(c)) return 'bj';
    return '';
  };
  const boardBadge = code => {
    const b = BOARD_BADGE[boardKey(code)];
    return b ? '<i class="bdg bdg-' + boardKey(code) + '" title="' + b.n + '">' + b.c + '</i>' : '';
  };
  /* 纯文本角标：用于 echarts 坐标轴标签等无法嵌 HTML 的场景 */
  const boardText = code => { const b = BOARD_BADGE[boardKey(code)]; return b ? '【' + b.c + '】' : ''; };
  const boardOfCode = code => { const k = boardKey(code); return k ? BOARD_BADGE[k].n : '主板'; };
  /* 可点击股票名：统一带 data-stock-code，点击弹K线。cls 保留原样式类。非主板附板块角标 */
  const sn = (code, name, cls) => '<span class="stock-link ' + (cls || '') + '" data-stock-code="' + E(code) + '" title="点击查看K线 / 周K / 筹码峰">' + boardBadge(code) + E(name) + '</span>';
  const TICK = m => m.quoteTick || m.universeTick || (m.now ? m.now.slice(11, 16) : '—');
  const fmtDate = v => { const s = String(v || '').replace(/\D/g, ''); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : (v || '—'); };

  /* ── K线涨跌停/炸板配色（可在弹窗内自定义，存 localStorage） ── */
  const KL_COLOR_KEY = 'stockhy_kline_colors_v1';
  const KL_COLOR_DEFAULT = { up: '#d92b2b', down: '#0f9960', limitUp: '#c2185b', limitDown: '#00695c', broken: '#f08c00' };
  const KL_COLOR_META = [
    { k: 'up', label: '阳线（收涨）' }, { k: 'down', label: '阴线（收跌）' },
    { k: 'limitUp', label: '涨停' }, { k: 'limitDown', label: '跌停' }, { k: 'broken', label: '炸板' }
  ];
  function klLoadColors() {
    try {
      const s = JSON.parse(localStorage.getItem(KL_COLOR_KEY) || 'null');
      const o = {};
      KL_COLOR_META.forEach(m => {
        const v = s && s[m.k];
        o[m.k] = /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : KL_COLOR_DEFAULT[m.k];
      });
      return o;
    } catch (e) { return Object.assign({}, KL_COLOR_DEFAULT); }
  }
  function klSaveColors() {
    try { localStorage.setItem(KL_COLOR_KEY, JSON.stringify(S.klColors)); } catch (e) { /* 隐私模式下忽略 */ }
  }
  /* ── 连板天梯「晋级标记」显示开关（细粒度）：首板种子★晋级角标、历史优势组合彩色边框各自独立，存 localStorage ── */
  const LADDER_MARKS_KEY = 'stockhy_ladder_marks_v2';
  const LADDER_MARKS_DEFAULT = { seed: false, edge: true };
  function ladderMarksLoad() {
    try {
      const o = JSON.parse(localStorage.getItem(LADDER_MARKS_KEY) || 'null');
      if (o && typeof o === 'object') return { seed: o.seed !== false, edge: o.edge !== false };
      // 兼容旧版单一开关：v1 存 '0' 表示两类全关
      if (localStorage.getItem('stockhy_ladder_marks_v1') === '0') return { seed: false, edge: false };
    } catch (e) { /* 隐私模式下忽略 */ }
    return Object.assign({}, LADDER_MARKS_DEFAULT);
  }
  function ladderMarksSave() {
    try { localStorage.setItem(LADDER_MARKS_KEY, JSON.stringify(S.ladderMarks)); } catch (e) { /* 隐私模式下忽略 */ }
  }
  /* ── 历史优势组合统计窗口（交易日数）：默认 60 个交易日，用户可切 15/30/60/90 ── */
  const EDGE_DAYS_KEY = 'stockhy_edge_days_v1';
  const EDGE_DAYS_OPTIONS = [15, 30, 60, 90];
  function edgeDaysLoad() {
    const n = Number(localStorage.getItem(EDGE_DAYS_KEY));
    return EDGE_DAYS_OPTIONS.indexOf(n) >= 0 ? n : 60;
  }
  function edgeDaysSave() {
    try { localStorage.setItem(EDGE_DAYS_KEY, String(S.edgeDays)); } catch (e) { /* 隐私模式下忽略 */ }
  }
  /* ── 自选股（localStorage，仅存代码+名称，行情一律实时拉取） ── */
  const WATCH_KEY = 'stockhy_watchlist_v1';
  function watchLoad() {
    try {
      const a = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
      if (!Array.isArray(a)) return [];
      return a.filter(x => x && /^\d{6}$/.test(String(x.code || '')))
        .map(x => ({ code: String(x.code), name: String(x.name || x.code) }))
        .slice(0, 200);
    } catch (e) { return []; }
  }
  function watchSave() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(S.watch.list)); } catch (e) { /* 隐私模式下忽略 */ }
    const b = $('badgeWatch'); if (b) b.textContent = S.watch.list.length;
  }
  /* 涨跌幅上限：主板10% / 创业板+科创板20% / 北交所30% / ST 5% */
  function klLimitRate(code, name) {
    const c = String(code || ''), nm = String(name || '').toUpperCase();
    if (nm.indexOf('ST') >= 0) return 0.05;
    if (/^(30|688|689)/.test(c)) return 0.20;
    if (/^(4|8|920)/.test(c)) return 0.30;
    return 0.10;
  }
  /* 从 OHLC + 前收推算单根K线类型：limitUp / limitDown / broken / null
     封板按收盘价判定；炸板=盘中触及涨停(或跌停)价但收盘未封住。
     0.3% 容差覆盖前复权与四舍五入误差。仅日K使用（周K无涨跌停制度）。 */
  function klBarKind(rows, i, code, name) {
    if (i <= 0) return null;
    const b = rows[i], prev = rows[i - 1];
    if (!b || !prev || !prev.close || b.close === null || b.high === null || b.low === null) return null;
    const rate = klLimitRate(code, name), tol = 0.003;
    const upPct = b.close / prev.close - 1;
    const hiPct = b.high / prev.close - 1;
    const loPct = b.low / prev.close - 1;
    if (upPct >= rate - tol) return 'limitUp';
    if (upPct <= -(rate - tol)) return 'limitDown';
    if (hiPct >= rate - tol || loPct <= -(rate - tol)) return 'broken';
    return null;
  }

  /* 「连不上本地服务」与「上游数据源不可用」是两类完全不同的故障，提示不能混为一谈 */
  const SERVICE_HINT = '本地服务未响应：请确认 A股实时复盘系统已启动（双击项目目录 start.bat，或在项目目录运行 node server.js）；默认端口 8899，被占用时会自动顺延，请以控制台输出的「本机访问」地址为准。';
  function isConnError(e) {
    return e instanceof TypeError ||
      /Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET/i.test(String((e && e.message) || e));
  }

  /* ── 模块显示配置：顶部导航只展示勾选的模块，持久化到 localStorage ── */
  const MODULE_CFG_KEY = 'stockhy_visible_modules_v1';
  const NEW_MODULE_IDS = ['ddx']; // 后加模块：老用户已存配置里没有时默认补上，避免升级后看不到
  const MODULES = [
    { id: 'watchlist', label: '自选股' },
    { id: 'review', label: '复盘计划' },
    { id: 'picks', label: '短线个股推荐' },
    { id: 'live', label: '实时机会' },
    { id: 'lowbuy', label: '连板低吸机会' },
    { id: 'relay', label: '明日接力推荐' },
    { id: 'ai', label: 'AI 分析推荐' },
    { id: 'pullback', label: '涨停回踩支撑' },
    { id: 'support', label: '支撑位反转' },
    { id: 'ddx', label: 'DDX首红精选' },
    { id: 'dragon', label: '明日龙头' },
    { id: 'auction', label: '集合竞价首板' },
    { id: 'predict', label: '9:25首板预测' },
    { id: 'enlighten', label: '龙场悟道' }
  ];
  const MODULE_IDS = MODULES.map(m => m.id);
  function moduleCfgLoad() {
    const all = MODULE_IDS.slice();
    try {
      const raw = localStorage.getItem(MODULE_CFG_KEY);
      if (raw === null) return all;                    // 未配置过：默认全部显示
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return all;
      const picked = arr.filter(k => MODULE_IDS.indexOf(k) >= 0);
      if (!picked.length) return all;                  // 配置为空则回退默认，避免无模块可用
      // 新模块在老配置里缺失时补到对应位置，保持 MODULES 顺序
      NEW_MODULE_IDS.forEach(id => { if (picked.indexOf(id) < 0) picked.push(id); });
      picked.sort((a, b) => MODULE_IDS.indexOf(a) - MODULE_IDS.indexOf(b));
      return picked;
    } catch (e) { return all; }
  }
  function moduleCfgSave(ids) {
    try { localStorage.setItem(MODULE_CFG_KEY, JSON.stringify(ids)); } catch (e) { /* 隐私模式下忽略 */ }
  }

  const S = {
    data: null, prevPrices: {}, tab: 'review', boards: new Set(['全部']),
    visibleModules: moduleCfgLoad(),
    freq: 15, tick: 0, timer: null, boardsList: null,
    dirty: {}, refreshing: false, refreshSeq: 0, edgeDaysPending: null,
    collapsed: new Set(), expanded: new Set(), chartsReady: !!window.echarts,
    lastFilters: '', aiCfgOpen: false, aiText: '', aiTextTime: '',
    pull: null, pullLoading: false, pullAt: 0, pullSelected: null,
    pullFilters: '', pullError: null, pullMethodOpen: false, pullOfflineTimer: null, pullDays: 8,
    support: null, supportLoading: false, supportError: null, supportAt: 0, supportMethodOpen: false,
    supportOpts: { scan: 600, window: 60, minDraw: 4, bandPct: 3, smallYang: 3, lookback: 6, shape: '全部', board: '全部', sort: 'pop' },
    srFilters: '', srPending: false, srLoadingNote: '',
    srSamples: { key: '', rows: [], offset: 0, total: null, loading: false, done: false, error: '' },
    ddx: null, ddxLoading: false, ddxError: null, ddxAt: 0, ddxMethodOpen: false,
    ddxOpts: { scan: 900, window: 60, ddxMin: 1, bodyMax: 5, turnMin: 5, board: '全部', smooth: false, sort: 'pop', popOnly: true },
    ddxFilters: '', ddxPending: false,
    ddxSamples: { key: '', rows: [], offset: 0, total: null, loading: false, done: false, error: '' },
    bt: null, btLoading: false, btError: null, btOpen: false,
    btDate: 'all', btWindow: 5, btMethodOpen: false,
    dg: null, dgLoading: false, dgError: null, dgAt: 0, dgSelected: null, dgFilters: '',
    dgMethodOpen: false, dgValidationOpen: false,
    dgHist: null, dgHistDate: null, dgHistOpen: false, dgHistLoading: false, dgHistError: null,
    dgHistSelected: null, dgHistMethodOpen: false,
    dgOpts: { days: 12, showAll: 0, sort: 'score', sortDir: 'desc', role: '全部', limit: 60 },
    dgOfflineTimer: null, edgeStats: null, edgeDays: edgeDaysLoad(), edgeDaysLoading: false,
    auction: null, auctionLoading: false, auctionError: null, auctionAt: 0,
    auctionOpts: { days: 10 }, auctionMethodOpen: false,
    ladderDate: null, ladderData: null, ladderDates: [], ladderLoading: false, ladderKind: 'zt',
    ladderMarks: ladderMarksLoad(),
    predict: null, predictLoading: false, predictOpts: { date: '' }, predictMethodOpen: false,
    news: null, newsLoading: false, newsError: null, newsAt: 0, newsSince: null,
    newsInterval: 30, newsWindow: 72, newsPaused: false, newsFilter: 'all',
    newsKeyword: '', newsMethodOpen: false, newsShowAll: false,
    newsTimer: null, newsTickTimer: null, newsNextAt: 0, newsCodes: '',
    en: null, enLoading: false, enError: null, enOpts: { days: 8 },
    chart: { open: false, code: null, name: null, period: 'minute', data: null, loading: false, error: null, view: null, geom: null, lockIdx: null, docked: false },
    watch: { list: watchLoad(), quotes: {}, sel: null, at: 0 },
    klColors: klLoadColors(), klPanelOpen: false
  };
  // 消息面三个源只在「明日龙头」模块启用后才调用，未调用前不计入主看板在线率分母
  const NEWS_KEYS = ['emAnn', 'sinaFlash', 'emFlash'];
  const activeHealth = m => (m.health || []).filter(h => !h.standby && (NEWS_KEYS.indexOf(h.key) < 0 || !!h.lastTry));

  /* ─────────────── 初始化与事件 ─────────────── */
  function init() {
    $('btnRefresh').onclick = () => refresh(true);
    $('btnApply').onclick = () => { refresh(true); S.tick = 0; };
    $('btnReset').onclick = resetFilters;
    $('btnToggleFilter').onclick = () => {
      const b = $('filterBody'), hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      $('btnToggleFilter').textContent = hidden ? '收起' : '展开';
    };
    $('freq').onchange = e => { S.freq = Number(e.target.value); S.tick = 0; startTimer(); };
    $('boardChips').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const val = b.dataset.board;
      if (val === '全部') S.boards = new Set(['全部']);
      else {
        S.boards.delete('全部');
        if (S.boards.has(val)) { S.boards.delete(val); if (!S.boards.size) S.boards.add('全部'); }
        else S.boards.add(val);
      }
      [...$('boardChips').children].forEach(c => c.classList.toggle('active', S.boards.has(c.dataset.board)));
      if (S.tab === 'support' && S.srFilters !== srFilterSignature()) loadSupportReversal(false);
      if (S.tab === 'ddx' && S.ddxFilters !== ddxFilterSignature()) loadDdxFirstRed(false);
    };
    $('capQuick').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      $('capMin').value = b.dataset.min || ''; $('capMax').value = b.dataset.max || '';
      [...$('capQuick').children].forEach(c => c.classList.toggle('active', c === b));
      if (S.tab === 'support' && S.srFilters !== srFilterSignature()) loadSupportReversal(false);
      if (S.tab === 'ddx' && S.ddxFilters !== ddxFilterSignature()) loadDdxFirstRed(false);
    };
    $('tabs').onclick = e => {
      const t = e.target.closest('.tab'); if (!t) return;
      switchTab(t.dataset.tab);
    };
    $('btnModuleCfg').onclick = openModuleCfg;
    $('mcClose').onclick = closeModuleCfg;
    $('moduleCfgMask').onclick = e => { if (e.target === $('moduleCfgMask')) closeModuleCfg(); };
    $('mcAll').onclick = () => { [...$('mcList').querySelectorAll('input')].forEach(i => { i.checked = true; }); };
    $('mcInvert').onclick = () => { [...$('mcList').querySelectorAll('input')].forEach(i => { i.checked = !i.checked; }); };
    $('mcSave').onclick = saveModuleCfg;
    ['sectorSelect', 'boardsMin', 'sortSel', 'excludeST'].forEach(id => {
      $(id).addEventListener('change', () => refresh(true));
    });
    ['capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'keyword'].forEach(id => {
      $(id).addEventListener('keydown', e => { if (e.key === 'Enter') refresh(true); });
    });
    ['capMin', 'capMax'].forEach(id => {
      $(id).addEventListener('change', () => {
        if (S.tab === 'support' && S.srFilters !== srFilterSignature()) loadSupportReversal(false);
      if (S.tab === 'ddx' && S.ddxFilters !== ddxFilterSignature()) loadDdxFirstRed(false);
      });
    });
    // 历史优势组合统计窗口（两处卡片共用同一委托）
    document.addEventListener('change', e => {
      const sel = e.target && e.target.closest && e.target.closest('[data-edge-days]');
      if (sel) changeEdgeDays(sel.value);
    });
    // 全局股票名点击委托：打开个股K线弹窗
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-stock-code]');
      if (el) { e.preventDefault(); e.stopPropagation(); openStockChart(el.dataset.stockCode, S.tab === 'watchlist' && !!S.chart.docked); return; }
      if (e.target.closest('#smClose') || e.target.id === 'stockModal') closeStockChart();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('moduleCfgMask').style.display !== 'none') closeModuleCfg();
      else if (S.chart.open) closeStockChart();
    });
    if ($('smClose')) $('smClose').onclick = closeStockChart;
    if ($('smStar')) $('smStar').onclick = () => {
      const c = S.chart && S.chart.code, nm = S.chart && S.chart.name;
      if (!c) return;
      watchToggle(c, nm || c);
    };
    initStockSearch();
    [...document.querySelectorAll('.sm-tab')].forEach(b => {
      b.onclick = () => {
        if (!S.chart.data || b.dataset.period === S.chart.period) return;
        S.chart.period = b.dataset.period; S.chart.view = null; S.chart.lockIdx = null;
        // 切走分时即退出"历史某日"查看，回到当日分时数据
        if (b.dataset.period !== 'minute') S.chart.histDate = null;
        if (S.chart.period !== 'minute') stopMinuteTimer();
        renderStockChart();
      };
    });
    loadBoards();
    initLadderDates();
    applyModuleCfg();
    const qs = new URLSearchParams(location.search);
    const initTab = qs.get('tab');
    if (initTab && ['watchlist', 'review', 'picks', 'live', 'lowbuy', 'relay', 'ai', 'pullback', 'support', 'ddx', 'dragon', 'auction', 'predict', 'enlighten'].indexOf(initTab) >= 0) switchTab(initTab);
    // 深链：?stock=000001&period=week 直接打开个股K线弹窗
    const initStock = qs.get('stock');
    if (/^\d{6}$/.test(initStock || '')) {
      openStockChart(initStock);
      const initPeriod = qs.get('period');
      if (initPeriod === 'day' || initPeriod === 'week' || initPeriod === 'minute' || initPeriod === 'multiDay') S.chart.period = initPeriod;
      const z = Number(qs.get('zoom'));
      if (z >= 6 && z <= 1000) S.chart._initZoom = Math.round(z);
      const d = qs.get('day');
      if (/^\d{8}$/.test(d || '')) S.chart._initLock = d;
      if (qs.get('colors') === '1') S.klPanelOpen = true;
    }
    refresh(true);
    startTimer();
  }

  // 交易时段由后端按北京时间 + 周末判定（meta.state），比浏览器本地时间可靠。
  // 非交易时段自动暂停刷新，但「立即刷新」始终可用；从非交易切回交易时自动恢复一次。
  const TRADING_STATES = ['盘中', '集合竞价'];
  function isTradingNow() {
    const st = S.data && S.data.meta && S.data.meta.state;
    if (st) return TRADING_STATES.indexOf(st) >= 0;
    // 首屏尚无 meta.state 时，用北京时间（UTC+8）按交易日历机械兜底
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
    return (hm >= 915 && hm <= 1130) || (hm >= 1300 && hm <= 1500);
  }
  function refreshCountdown() {
    const el = $('countdown');
    if (!el) return;
    if (S.freq <= 0) { el.textContent = '已暂停'; el.title = '自动刷新已手动关闭'; return; }
    if (!isTradingNow()) {
      const st = (S.data && S.data.meta && S.data.meta.state) || '非交易时段';
      el.textContent = '已暂停（' + st + '）';
      el.title = st + '，行情不再变动，自动刷新已暂停；可点「立即刷新」手动拉取。';
      return;
    }
    el.textContent = Math.max(0, S.freq - S.tick) + ' 秒';
    el.title = '每 ' + S.freq + ' 秒自动刷新；非交易时段自动暂停';
  }
  function startTimer() {
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(() => {
      if (S.freq <= 0 || !isTradingNow()) { refreshCountdown(); return; }
      S.tick++;
      if (S.tick >= S.freq) { S.tick = 0; refresh(false); }
      refreshCountdown();
    }, 1000);
    S.tick = 0;
    refreshCountdown();
  }

  function resetFilters() {
    S.boards = new Set(['全部']);
    [...$('boardChips').children].forEach(c => c.classList.toggle('active', c.dataset.board === '全部'));
    ['capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'keyword'].forEach(id => $(id).value = '');
    $('sectorSelect').value = ''; $('boardsMin').value = ''; $('sortSel').value = 'score'; $('excludeST').checked = true;
    [...$('capQuick').children].forEach(c => c.classList.remove('active'));
    refresh(true);
  }

  async function loadBoards() {
    try {
      const j = await fetch('/api/boards').then(r => r.json());
      S.boardsList = j;
      const sel = $('sectorSelect');
      const groups = [
        ['行业板块', j.industry || []],
        ['概念板块', j.concept || []]
      ];
      let html = '<option value="">全板块</option>';
      groups.forEach(([label, list]) => {
        html += '<optgroup label="' + E(label) + '">';
        list.slice(0, 200).forEach(b => {
          html += '<option value="' + E(b.node) + '">' + E(b.name) + '（' + (b.pct > 0 ? '+' : '') + N(b.pct) + '%）</option>';
        });
        html += '</optgroup>';
      });
      sel.innerHTML = html;
    } catch (e) { /* 板块列表失败不阻塞主流程 */ }
  }

  function collectFilters() {
    const b = S.boards.has('全部') ? '全部' : [...S.boards].join(',');
    return {
      board: b,
      capMin: $('capMin').value, capMax: $('capMax').value,
      pctMin: $('pctMin').value, pctMax: $('pctMax').value,
      turnoverMin: $('turnoverMin').value, turnoverMax: $('turnoverMax').value,
      boardsMin: $('boardsMin').value,
      sector: $('sectorSelect').value,
      keyword: $('keyword').value.trim(),
      excludeST: $('excludeST').checked ? '1' : '0',
      sort: $('sortSel').value,
      limit: '80'
    };
  }

  function pricesOf(d) {
    const m = {};
    if (!d) return m;
    const scan = arr => (arr || []).forEach(x => { if (x && x.code && x.price !== null && x.price !== undefined) m[x.code] = Number(x.price); });
    scan(d.picks); scan(d.lowbuy);
    if (d.opportunities) { scan(d.opportunities.zt); scan(d.opportunities.qs); scan(d.opportunities.zb); scan(d.opportunities.dt); }
    return m;
  }
  function flashCls(code, price) {
    const p = S.prevPrices[code];
    if (p === undefined || price === null || price === undefined || !Number.isFinite(Number(price))) return '';
    const n = Number(price);
    return n > p ? 'flash-up' : (n < p ? 'flash-down' : '');
  }

  async function refresh(force) {
    if (S.refreshing && !force) return;             // 定时轮询不与在途请求叠加
    const seq = ++S.refreshSeq;
    S.refreshing = true;
    const f = collectFilters();
    const q = new URLSearchParams();
    Object.keys(f).forEach(k => { if (f[k] !== '' && f[k] !== undefined) q.set(k, f[k]); });
    q.set('edgeDays', String(S.edgeDays));
    if (force) q.set('force', '1');
    $('btnRefresh').disabled = true;
    try {
      const r = await fetch('/api/dashboard?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (seq !== S.refreshSeq) return;              // 旧响应不得覆盖新数据
      S.prevPrices = pricesOf(S.data);
      S.data = j;
      if (j.edgeStats && (!j.edgeStats.window || Number(j.edgeStats.window.requestedDays) === S.edgeDays)) S.edgeStats = j.edgeStats;
      S.lastFilters = describeFilters(f);
      render();
      // 新模块走独立 API：仅在该 tab 可见、筛选变化或超过 60 秒时才重新扫描，避免拖累 15 秒主看板刷新
      if (S.tab === 'pullback' && Date.now() - S.pullAt > 12000 &&
        (S.pullFilters !== S.lastFilters || Date.now() - S.pullAt > 60000)) loadPullback(false);
      if (S.tab === 'dragon' && Date.now() - S.dgAt > 12000 &&
        (S.dgFilters !== S.lastFilters || Date.now() - S.dgAt > 60000)) loadDragon(false);
      // 支撑位反转：板块 / 市值筛选作用于服务端候选池，条件变了必须重新回测
      if (S.tab === 'support' && S.srFilters !== srFilterSignature(f)) loadSupportReversal(false);
      // DDX首红精选：板块 / 市值筛选同样作用于候选池
      if (S.tab === 'ddx' && S.ddxFilters !== ddxFilterSignature(f)) loadDdxFirstRed(false);
      if (S.watch.list.length) refreshWatchQuotes(false);
      $('loading').classList.add('hide');
      $('alertBox').style.display = 'none';
    } catch (e) {
      $('loading').classList.add('hide');
      $('alertBox').style.display = '';
      $('alertBox').textContent = '数据加载失败：' + e.message + '。' +
        (isConnError(e)
          ? SERVICE_HINT + ' 可点击「立即刷新」重试。'
          : '可点击「立即刷新」重试；若上游接口临时不可用，系统会在恢复后自动重新拉取。');
    } finally {
      if (seq === S.refreshSeq) S.refreshing = false;
      $('btnRefresh').disabled = false;
      S.tick = 0;
      refreshCountdown(); // 交易状态变化后，立即同步「下次刷新」显示
    }
  }

  function describeFilters(f) {
    const out = [];
    out.push('市场=' + (f.board || '全部'));
    if (f.capMin || f.capMax) out.push('流通市值=' + (f.capMin || '0') + '~' + (f.capMax || '∞') + '亿');
    if (f.sector) out.push('板块=' + (S.data && S.data.meta ? S.data.meta.sectorLabel : f.sector));
    if (f.pctMin || f.pctMax) out.push('涨幅=' + (f.pctMin || '-∞') + '~' + (f.pctMax || '∞') + '%');
    if (f.turnoverMin || f.turnoverMax) out.push('换手=' + (f.turnoverMin || '0') + '~' + (f.turnoverMax || '∞') + '%');
    if (f.boardsMin) out.push('连板≥' + f.boardsMin);
    if (f.keyword) out.push('关键字=' + f.keyword);
    if (f.excludeST === '1') out.push('排除ST');
    return out.join(' · ');
  }

  /* 模块显示配置：只展示勾选的 tab 与对应 pane；当前模块被隐藏时自动切到第一个可见模块 */
  function applyModuleCfg() {
    const vis = S.visibleModules;
    if (!vis.length) return;
    [...$('tabs').children].forEach(c => {
      if (c.dataset.tab) c.style.display = vis.indexOf(c.dataset.tab) >= 0 ? '' : 'none';
    });
    MODULE_IDS.forEach(k => {
      const pane = $('pane-' + k);
      if (pane) pane.style.display = vis.indexOf(k) >= 0 ? '' : 'none';
    });
    if (vis.indexOf(S.tab) < 0) switchTab(vis[0]);
  }
  function openModuleCfg() {
    $('mcList').innerHTML = MODULES.map(m =>
      '<label class="mc-item"><input type="checkbox" data-mod="' + m.id + '"' +
      (S.visibleModules.indexOf(m.id) >= 0 ? ' checked' : '') + '><span>' + E(m.label) + '</span></label>'
    ).join('');
    $('mcList').onchange = () => {
      const n = $('mcList').querySelectorAll('input:checked').length;
      $('mcHint').textContent = '已选 ' + n + ' / ' + MODULES.length + ' 个模块';
    };
    $('mcHint').textContent = '已选 ' + S.visibleModules.length + ' / ' + MODULES.length + ' 个模块';
    $('moduleCfgMask').style.display = 'flex';
    syncBodyScrollLock();
  }
  function closeModuleCfg() { $('moduleCfgMask').style.display = 'none'; syncBodyScrollLock(); }
  function saveModuleCfg() {
    const picked = [...$('mcList').querySelectorAll('input:checked')].map(i => i.dataset.mod);
    if (!picked.length) { $('mcHint').textContent = '至少保留一个模块'; return; }
    S.visibleModules = picked;
    moduleCfgSave(picked);
    applyModuleCfg();
    closeModuleCfg();
  }

  function switchTab(t) {
    if (MODULE_IDS.indexOf(t) < 0 || S.visibleModules.indexOf(t) < 0) return;
    // 切模块时清掉遗留的背景滚动锁；非停靠的全屏弹窗随切换关闭，避免旧状态把新模块锁死
    if (S.chart && S.chart.open && !S.chart.docked) closeStockChart();
    syncBodyScrollLock();
    S.tab = t;
    [...$('tabs').children].forEach(c => c.classList.toggle('active', c.dataset.tab === t));
    ['watchlist', 'review', 'picks', 'live', 'lowbuy', 'relay', 'ai', 'pullback', 'support', 'ddx', 'dragon', 'auction', 'predict', 'enlighten'].forEach(k => $('pane-' + k).classList.toggle('active', k === t));
    // 停靠在自选股右栏的分时详情，切走后无需继续轮询/重绘
    if (t !== 'watchlist' && S.chart && S.chart.docked && S.chart.open) stopMinuteTimer();
    renderPane(t);
    if (t === 'watchlist') {
      renderWatchlist(); refreshWatchQuotes(true);
      if (S.chart && S.chart.open && S.chart.docked && S.chart.period === 'minute') syncMinuteTimer();
    }
    if (t === 'pullback' && !S.pull && !S.pullLoading) loadPullback(false);
    if (t === 'support' && !S.supportLoading &&
      (!S.support || S.srFilters !== srFilterSignature())) loadSupportReversal(false);
    if (t === 'ddx' && !S.ddxLoading && (!S.ddx || S.ddxFilters !== ddxFilterSignature())) loadDdxFirstRed(false);
    if (t === 'dragon') {
      const histParam = new URLSearchParams(location.search).get('hist');
      if (histParam && /^\d{8}$/.test(histParam)) {
        S.dgHistOpen = true;
        loadDragonHistory(histParam, false);
      } else if (!S.dg && !S.dgLoading) loadDragon(false);
      if (!S.dgHistOpen) setTimeout(startNewsMonitor, 0);
    } else stopNewsMonitor();
    if (t === 'enlighten' && !S.en && !S.enLoading) loadEnlightenment(false);
    if (t === 'auction' && !S.auction && !S.auctionLoading) loadAuction(false);
    if (t === 'predict' && !S.predict && !S.predictLoading) loadPredict(false);
    setTimeout(() => { Object.values(S.charts || {}).forEach(c => { try { c.resize(); } catch (e) { } }); }, 60);
  }

  /* ─────────────── 渲染入口 ─────────────── */
  // 主看板每轮只重建当前可见模块；隐藏模块标脏，切过去时再补渲染。
  const PANE_RENDERERS = {
    review: renderReview, picks: renderPicks, live: renderLive,
    lowbuy: renderLowBuy, relay: renderRelay, ai: renderAI
  };
  function renderPane(tab) {
    const fn = PANE_RENDERERS[tab];
    if (fn && S.data) { fn(S.data); S.dirty[tab] = false; }
  }
  function render() {
    const d = S.data, m = d.meta, ov = d.overview;
    renderMeta(m, ov);
    renderKPI(m, ov);
    renderGlobal(d);
    renderConclusion(m, ov);
    renderFooter(d);
    const current = PANE_RENDERERS[S.tab];
    if (current) current(d);
    else Object.keys(PANE_RENDERERS).forEach(k => { S.dirty[k] = true; });
    $('filterSummary').textContent = '当前：' + S.lastFilters;
    $('badgeWatch').textContent = S.watch.list.length;
    $('badgePicks').textContent = (d.picks || []).length;
    $('badgeLive').textContent = ov.limitUp + ' 涨停';
    $('badgeLow').textContent = (d.lowbuy || []).length;
    $('badgeRelay').textContent = ((d.relay && d.relay.list) || []).length;
    $('badgeAI').textContent = m.aiConfigured ? '已接模型' : '本地';
    if (S.pull) $('badgePull').textContent = (S.pull.list || []).length;
    if (S.support) $('badgeSupport').textContent = ((S.support.result && S.support.result.list) || []).length || '—';
    if (S.ddx) $('badgeDdx').textContent = ((S.ddx.result && S.ddx.result.list) || []).length || '—';
    if (S.en) $('badgeEn').textContent = (S.en.best ? String(S.en.best.name).slice(0, 6) : '已回测');
    if (S.auction) $('badgeAuction').textContent = (S.auction.list || []).length || '—';
    if (S.predict) $('badgePredict').textContent = (S.predict.summary && S.predict.summary.focus) || '—';
  }

  function renderMeta(m, ov) {
    $('tradeState').textContent = m.state;
    $('tradeState').title = m.note + '；' + m.caveat;
    $('dataTime').textContent = (m.quoteTick || m.universeTick || m.now.slice(11, 19)) + ' / ' + (m.poolDate || '—');
    $('dataTime').title = '腾讯实时快照：' + (m.quoteTick || '—') + '；新浪全市场快照：' + (m.universeTick || '—') + '；涨停池交易日：' + (m.poolDate || '—') + '；服务端生成：' + m.generatedAt;
    const hs = activeHealth(m), ok = hs.filter(h => h.ok).length;
    const pill = $('healthPill');
    pill.textContent = ok + '/' + hs.length + ' 在线';
    pill.style.color = ok === hs.length ? 'var(--down)' : (ok === 0 ? 'var(--up)' : 'var(--warn)');
  }

  /* ─────────────── 全球主流行情条 ─────────────── */
  function renderGlobal(d) {
    const el = $('globalStrip');
    if (!el) return;
    const g = d.globalMarkets || {};
    const rows = g.rows || [];
    if (!rows.length) { el.style.display = 'none'; return; }
    const groups = [['港股', '🇭🇰 港股'], ['日韩', '🇯🇵🇰🇷 日韩'], ['美股', '🇺🇸 美股'], ['商品', '🛢 国际商品']];
    const cell = x => {
      const c = x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : 'flat';
      const sign = x.pct > 0 ? '+' : '';
      return '<div class="gcell" title="' + E(x.ticktime || '') + '">' +
        '<div class="gname">' + E(x.name) + '</div>' +
        '<div class="gprice ' + c + '">' + N(x.price) + '</div>' +
        '<div class="gpct ' + c + '">' + sign + N(x.pct) + '%</div></div>';
    };
    let html = '<div class="global-head"><b>全球主流行情</b>' +
      '<span class="small muted">' + E(g.source || '腾讯证券') + ' · ' + E(g.asOf ? new Date(g.asOf).toLocaleTimeString('zh-CN', { hour12: false }) : '') + ' 更新</span></div>' +
      '<div class="global-groups">';
    groups.forEach(([key, label]) => {
      const list = rows.filter(r => r.group === key);
      if (!list.length) return;
      html += '<div class="ggroup"><div class="ggroup-label">' + label + '</div><div class="ggroup-cells">' + list.map(cell).join('') + '</div></div>';
    });
    html += '</div><div class="small muted global-note">' + E(g.note || '') + '</div>';
    el.innerHTML = html;
    el.style.display = '';
  }

  function renderKPI(m, ov) {
    const idx = ov.indices || [];
    const cells = idx.slice(0, 4).map(i => {
      const c = i.pct > 0 ? 'up' : i.pct < 0 ? 'down' : 'flat';
      return '<div class="kpi"><span class="lbl">' + E(i.name) + '</span><div class="big ' + c + ' num">' + N(i.price) + '</div><div class="sub ' + c + '">' + (i.pct > 0 ? '+' : '') + N(i.pct) + '%</div></div>';
    });
    const extra = [
      { lbl: '涨停 / 跌停', big: '<span class="up">' + ov.limitUp + '</span> / <span class="down">' + ov.limitDown + '</span>', sub: '炸板 ' + ov.broken + ' 家 · 率 ' + N(ov.breakRate, 1) + '%', cls: '' },
      { lbl: '最高连板', big: ov.maxBoard + ' 板', sub: ov.gap ? '梯队有断层' : '梯队无断层', cls: 'up' },
      { lbl: '涨跌家数', big: '<span class="up">' + ov.up + '</span> / <span class="down">' + ov.down + '</span>', sub: '广度 ' + N(ov.breadth, 1) + '%', cls: '' },
      { lbl: '市场档位', big: ov.tier, sub: '情绪：' + ov.emotion, cls: ov.tier === '进攻' ? 'up' : (ov.tier === '防守' ? 'down' : '') }
    ];
    extra.forEach(x => cells.push('<div class="kpi"><span class="lbl">' + x.lbl + '</span><div class="big ' + x.cls + '">' + x.big + '</div><div class="sub">' + E(x.sub) + '</div></div>'));
    $('kpiStrip').innerHTML = cells.join('');
  }

  function renderConclusion(m, ov) {
    const lead = '当前市场判定为「' + ov.tier + '」档，情绪「' + ov.emotion + '」：' + ov.tierNote + '。' + ov.emotionNote + '。';
    const tags = [
      tag('数据时点 ' + TICK(m), 'blue'),
      tag('交易日 ' + (m.poolDate || '—'), 'blue'),
      tag(m.state, 'blue'),
      tag('全市场 ' + ov.universeCount + ' 只', ''),
      tag('强势股池 ' + (ov.strongStocks || 0) + ' 只', ''),
      tag('数据源 ' + activeHealth(m).filter(h => h.ok).length + '/' + activeHealth(m).length + ' 在线', activeHealth(m).every(h => h.ok) ? 'green' : 'warn')
    ];
    $('conclusionCard').style.display = '';
    $('conclusionCard').innerHTML = '<div class="lead">' + E(lead) + '<div class="small muted" style="font-weight:400;margin-top:5px">' + E(m.note) + '；本页所有数字为行情快照，盘中可能存在秒级延迟。</div></div><div class="tags">' + tags.join('') + '</div>';
  }

  /* ─────────────── 图表 ─────────────── */
  function fallbackBars(items) {
    const max = Math.max(1, ...items.map(x => Math.abs(x.value)));
    return '<div style="padding:8px">' + items.map(x =>
      '<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11.5px"><span>' + E(x.name) + '</span><b>' + E(x.label !== undefined ? x.label : x.value) + '</b></div>' +
      '<div class="bar-bg"><div class="bar-fill" style="width:' + (Math.abs(x.value) / max * 100).toFixed(1) + '%;background:' + (x.color || '#2f6fd0') + '"></div></div></div>'
    ).join('') + '</div>';
  }
  function safeChart(id, option, fbItems) {
    const el = $(id); if (!el) return;
    if (!window.echarts) { el.innerHTML = fbItems ? fallbackBars(fbItems) : '<div class="empty">图表库未加载（不影响数据表格）</div>'; return; }
    try {
      let inst = window.echarts.getInstanceByDom(el);
      if (!inst) inst = window.echarts.init(el);
      inst.setOption(option, true);
    } catch (e) { el.innerHTML = fbItems ? fallbackBars(fbItems) : '<div class="empty">图表渲染失败</div>'; }
  }
  const AXIS = { axisLine: { lineStyle: { color: '#dbe3ec' } }, axisLabel: { color: '#6b7a8c', fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } };

  /* ─────────────── 复盘计划 ─────────────── */
  function renderReview(d) {
    const ov = d.overview, rv = d.review, m = d.meta;
    const facts = rv.facts.map(f => '<div class="fact"><div class="fl">' + E(f.label) + '</div><div class="fv">' + E(f.value) + '<div class="fn">' + E(f.note) + '</div></div></div>').join('');

    // 东方财富式「连板天梯」：按板级从高到低分层，每层列出该板个股卡片
    const ladderItems = Object.keys(ov.ladder).sort((a, b) => b - a).map(b => ({
      name: b + '板', value: ov.ladder[b], label: ov.ladder[b] + ' 家', color: '#d92b2b'
    }));
    const space = ov.spaceBoard.length ? ov.spaceBoard.map(x => boardBadge(x.code) + E(x.name) + '(' + E(x.code) + ') ' + x.boards + '板 · ' + E(x.industry)).join('；') : '无';
    // 天梯数据源：若用户选了历史日期，用 /api/ladder 返回的该日涨停池；否则用当日实时池
    const ladderIsHistory = !!(S.ladderDate && S.ladderData && S.ladderData.date === S.ladderDate);
    // 防御性去重：东财上游偶发返回同一只票的重复行，按 code 去重避免天梯里重复显示
    const uniqByCode = arr => { const s = new Set(); return (arr || []).filter(x => { if (!x || s.has(x.code)) return false; s.add(x.code); return true; }); };
    const ztAll = uniqByCode(ladderIsHistory ? (S.ladderData.zt || []) : ((d.opportunities && d.opportunities.zt) || []));
    const byBoard = new Map();
    ztAll.forEach(x => { const b = Number(x.boards) || 1; if (!byBoard.has(b)) byBoard.set(b, []); byBoard.get(b).push(x); });
    const boardOfCell = b => b >= 5 ? 'em-tier-5' : b === 4 ? 'em-tier-4' : b === 3 ? 'em-tier-3' : b === 2 ? 'em-tier-2' : 'em-tier-1';
    // 板块地位：同行业涨停股内，按「连板高度 + 封单强度 + 累计涨停次数 + 首封时间」机械判定
    const sectorMap = new Map();
    ztAll.forEach(x => { const k = x.industry || '未分类'; if (!sectorMap.has(k)) sectorMap.set(k, []); sectorMap.get(k).push(x); });
    const sectorRole = new Map();
    sectorMap.forEach((list, ind) => {
      const bOf = x => Number(x.boards) || 1, sOf = x => Number(x.sealFundRatio) || 0;
      const cOf = x => Number(x.statCount) || bOf(x);
      const maxB = Math.max(...list.map(bOf)), maxS = Math.max(...list.map(sOf)), maxC = Math.max(...list.map(cOf));
      list.forEach(x => {
        let role = '', reason = '';
        if (list.length === 1) { role = '独苗'; reason = '行业内当日仅此 1 只涨停，无板块效应'; }
        else if (bOf(x) === maxB && maxB >= 2 && sOf(x) === maxS) { role = '板块龙头'; reason = '行业内连板最高 ' + bOf(x) + ' 板且封单比最强 ' + N(maxS) + '%'; }
        else if (cOf(x) === maxC && maxC > bOf(x) && cOf(x) >= 3) { role = '反包核心'; reason = '累计 ' + x.statDays + ' 天 ' + cOf(x) + ' 板，为行业内累计涨停最多'; }
        else if (bOf(x) === maxB && maxB >= 2) { role = '题材龙'; reason = '行业内连板最高 ' + bOf(x) + ' 板，但封单比非最强'; }
        else if (sOf(x) === maxS && maxS > 0) { role = '封单核心'; reason = '行业内封单比最强 ' + N(maxS) + '%（' + bOf(x) + ' 板）'; }
        else if (bOf(x) >= 2) { role = '板块跟风'; reason = bOf(x) + ' 板，低于行业最高 ' + maxB + ' 板'; }
        else { role = '首板跟随'; reason = '首板，行业共 ' + list.length + ' 只涨停'; }
        sectorRole.set(x.code, { role, reason, count: list.length, maxB });
      });
    });
    const roleCls = r => r === '板块龙头' ? 'lead' : r === '反包核心' || r === '题材龙' || r === '封单核心' ? 'core' : r === '独苗' ? 'solo' : '';
    const stockCell = x => {
      const seal = Number(x.sealFundRatio) || 0, br = Number(x.brokenCount) || 0;
      const clsPct = seal >= 1 ? 'em-seal strong' : seal >= 0.3 ? 'em-seal mid' : 'em-seal weak';
      const sealCls = br === 0 ? 'em-br none' : br <= 2 ? 'em-br some' : 'em-br many';
      const sr = sectorRole.get(x.code) || { role: '', reason: '' };
      const edge = dgEdgeOf(x.dragonEdge);
      // 历史回放的标记由 /api/ladder 按「截至该日」的窗口重新计算，不使用今日回测结果
      const seed = x.seedMark || null;
      let cardCls = 'em-stock', corner = '', style = '';
      // 两类★晋级角标/彩色边框统一受「显示晋级标记」开关控制；title 文字信息无论开关都保留
      if (S.ladderMarks.edge && edge) {
        cardCls += ' dg-edge edge-' + E(edge.cls);
        corner = ' data-edge-corner="★ ' + E(edge.label) + ' ' + E(edge.rate) + '"';
        style = ' style="' + dgEdgeStyle(edge) + '"';
      }
      if (S.ladderMarks.seed && seed && (seed.tier === 'seed' || seed.tier === 'watch')) {
        cardCls += ' fs-mark fs-' + E(seed.tier);
        corner = ' data-seed-corner="★ 晋级 ' + E(seed.prob) + '%"';
        style = ' style="--fs:' + E(seed.color) + ';--fs-bg:' + E(seed.bg) + '"';
      }
      const ttl = x.name + '(' + x.code + ') · ' + (x.industry || '—') + '\n板块地位：' + sr.role + '（' + sr.reason + '）' +
        (edge ? '\n历史优势组合：' + dgEdgeTitle(edge) : '') +
        (seed ? '\n首板种子：' + seed.label + '，历史晋级 ' + seed.prob + '% / 成龙 ' + seed.dragonProb +
          '%（命中 ' + seed.score + ' 项：' + seed.reasons.join('、') + '）' : '');
      return '<div class="' + cardCls + '"' + corner + style + ' title="' + E(ttl) + '">' +
        '<div class="em-stock-head"><b>' + sn(x.code, x.name) + '</b><span class="em-code">' + E(x.code) + '</span></div>' +
        '<div class="em-stock-ind">' + E(x.industry || '—') +
        (sr.role ? '<span class="em-role ' + roleCls(sr.role) + '">' + E(sr.role) + '</span>' : '') + '</div>' +
        '<div class="em-stock-meta"><span>首封 ' + E(x.firstSeal || '—') + '</span>' +
        '<span class="' + clsPct + '">封 ' + N(seal) + '%</span></div>' +
        '<div class="em-stock-meta"><span class="' + sealCls + '">' + (br === 0 ? '零炸板' : '炸板 ' + br + ' 次') + '</span>' +
        '<span>换手 ' + N(x.turnover) + '%</span></div></div>';
    };
    const tiersHtml = [...byBoard.keys()].sort((a, b) => b - a).map(b => {
      const list = byBoard.get(b).slice().sort((a, c) =>
        (Number(c.sealFundRatio) || 0) - (Number(a.sealFundRatio) || 0) ||
        String(a.firstSeal || '').localeCompare(String(c.firstSeal || '')));
      return '<div class="em-tier ' + boardOfCell(b) + '"><div class="em-tier-head">' +
        '<span class="em-tier-badge">' + b + '板</span><span class="em-tier-count">' + list.length + ' 家</span>' +
        (b === Number(ov.maxBoard) && b >= 2 ? '<span class="em-tier-mark">空间板</span>' : '') +
        '</div><div class="em-stocks">' + list.map(stockCell).join('') + '</div></div>';
    }).join('');

    /* ── 跌停天梯：按东财跌停池 days 字段（连续跌停天数）分层，连跌越多层级越高；
          同时按东财行业归属统计跌停家数，标注跌停最集中的板块（题材映射无稳定来源，不臆造）。
          组内按封单额/流通市值降序，封单强度仍作排序与卡片展示依据 ── */
    const dtAll = uniqByCode(ladderIsHistory ? (S.ladderData.dt || []) : (d.limitDownPool || []));
    // 行业跌停家数统计，找出家数最多的板块（可能并列）
    const dtIndustry = new Map();
    dtAll.forEach(x => { const k = x.industry || '未分类'; dtIndustry.set(k, (dtIndustry.get(k) || 0) + 1); });
    const dtMaxCount = dtIndustry.size ? Math.max(...dtIndustry.values()) : 0;
    const dtTopIndustries = [...dtIndustry.entries()].filter(([, n]) => n === dtMaxCount).map(([k]) => k);
    // 连续跌停天数分层：days 越大层级越高；字段缺失按 1（首日跌停）兜底
    const dtByDays = new Map();
    dtAll.forEach(x => {
      const dd = Math.max(1, Number(x.downDays) || 1);
      if (!dtByDays.has(dd)) dtByDays.set(dd, []);
      dtByDays.get(dd).push(x);
    });
    const dtMaxDays = dtByDays.size ? Math.max(...dtByDays.keys()) : 0;
    const dtDayCls = dd => 'dt-day-' + Math.min(dd, 3);
    const dtCell = x => {
      const seal = Number(x.sealFundRatio) || 0;
      const ind = x.industry || '未分类';
      const dd = Math.max(1, Number(x.downDays) || 1);
      const hot = dtMaxCount >= 2 && dtTopIndustries.indexOf(ind) >= 0;
      const ttl = x.name + '(' + x.code + ') · ' + ind + '\n连续跌停 ' + dd + ' 天 · 封单比 ' + N(seal) + '%（封单额 / 流通市值）' +
        '\n最后封板 ' + (x.lastSeal || '—') + ' · 撬板 ' + (Number(x.brokenCount) || 0) + ' 次 · 换手 ' + N(x.turnover) + '%' +
        (hot ? '\n⚠ 所属板块为当日跌停最集中板块（' + ind + ' ' + dtMaxCount + ' 家）' : '');
      return '<div class="em-stock dt-stock' + (hot ? ' dt-hot' : '') + '" title="' + E(ttl) + '">' +
        '<div class="em-stock-head"><b>' + sn(x.code, x.name) + '</b><span class="em-code">' + E(x.code) + '</span></div>' +
        '<div class="em-stock-ind">' + E(ind) +
        (hot ? '<span class="dt-hot-tag">最多跌停 ' + dtMaxCount + ' 家</span>' : '') + '</div>' +
        '<div class="em-stock-meta"><span>封 ' + N(seal) + '%</span>' +
        '<span>' + (Number(x.brokenCount) > 0 ? '撬板 ' + x.brokenCount + ' 次' : '未撬板') + '</span></div>' +
        '<div class="em-stock-meta"><span>末封 ' + E(x.lastSeal || '—') + '</span>' +
        '<span>换手 ' + N(x.turnover) + '%</span></div></div>';
    };
    const dtTiersHtml = [...dtByDays.keys()].sort((a, b) => b - a).map(dd => {
      const list = dtByDays.get(dd).slice()
        .sort((a, c) => (Number(c.sealFundRatio) || 0) - (Number(a.sealFundRatio) || 0));
      return '<div class="em-tier dt-tier ' + dtDayCls(dd) + '"><div class="em-tier-head">' +
        '<span class="em-tier-badge">' + dd + '连跌</span><span class="em-tier-count">' + list.length + ' 家</span>' +
        (dd === dtMaxDays && dd >= 2 ? '<span class="dt-tier-mark">连续跌停最深</span>' : '') +
        '</div><div class="em-stocks">' + list.map(dtCell).join('') + '</div></div>';
    }).join('');
    const dtSummary = dtAll.length
      ? '<div class="dt-summary">' + tag('跌停 ' + dtAll.length + ' 家', 'green') +
        (dtMaxDays >= 2 ? tag('最长 ' + dtMaxDays + ' 连跌', 'warn') : '') +
        (dtTopIndustries.length
          ? tag('最多跌停板块：' + dtTopIndustries.join(' / ') + ' ' + dtMaxCount + ' 家', 'warn')
          : '') +
        '<span class="small muted">按东财行业归属统计（无稳定题材映射，不臆造）</span></div>'
      : '';

    const dragonRow = t => (t.dragons && t.dragons.length
      ? '<div class="theme-dragons">' + t.dragons.map(d => {
          const dragonTip = E(d.code + ' · ' + d.boards + ' 板 · 封单比 ' + (d.sealRatio === null ? '—' : N(d.sealRatio) + '%') + ' · 首封 ' + (d.firstSeal || '—') + ' · 按连板高度→封单比→首封时间机械排名');
          return '<span class="th-dragon d' + d.rank + '">' +
            '<b>' + E(d.label) + '</b>' +
            // 股票名带 data-stock-code，走全站事件委托打开分时/日K；title 合并排名依据与点击提示
            '<span class="stock-link" data-stock-code="' + E(d.code) + '" title="' + dragonTip + '｜点击查看分时图">' + boardBadge(d.code) + E(d.name) + '</span>' +
            '<span class="th-dragon-b">' + d.boards + '板</span></span>';
        }).join('') + '</div>'
      : '');
    const themes = (rv.topThemes || []).map(t =>
      '<div class="info-card theme-card"><h4>' + E(t.name) + ' <span class="mini-tag">' + t.count + ' 只涨停</span></h4>' +
      '<div class="theme-meta">' + tag('最高 ' + t.maxBoard + ' 板', 'red') + tag(t.stage, 'purple') + tag('预期：' + t.outlook, t.outlookScore >= 3 ? 'red' : 'warn') + (t.gap ? tag('梯队断层', 'warn') : '') + '</div>' +
      dragonRow(t) +
      '<p><b>阶段依据：</b>' + E(t.stageBasis) + '</p>' +
      '<p style="margin-top:5px"><b>持续性：</b>' + E(t.outlookBasis) + '</p>' +
      (t.boardRef ? '<p style="margin-top:5px"><b>板块参照：</b>' + E(t.boardRef.name) + ' ' + (t.boardRef.pct > 0 ? '+' : '') + N(t.boardRef.pct) + '%，领涨 ' + E(t.boardRef.leaderName) + '（新浪财经板块行情）</p>' : '') +
      '</div>'
    ).join('');

    /* 概念主线：按新浪概念板块成分股重新分组，与上方行业分组并列对比（同一套生命周期规则） */
    const cts = d.conceptThemes || [];
    const conceptThemesHtml = cts.length
      ? cts.map(t =>
          '<div class="info-card theme-card theme-card-concept"><h4>' + E(t.name) + ' <span class="mini-tag concept-tag">概念</span><span class="mini-tag">' + t.count + ' 只涨停</span></h4>' +
          '<div class="theme-meta">' + tag('最高 ' + t.maxBoard + ' 板', 'red') + tag(t.stage, 'purple') + tag('预期：' + t.outlook, t.outlookScore >= 3 ? 'red' : 'warn') + (t.gap ? tag('梯队断层', 'warn') : '') + '</div>' +
          dragonRow(t) +
          '<p><b>阶段依据：</b>' + E(t.stageBasis) + '</p>' +
          '<p style="margin-top:5px"><b>持续性：</b>' + E(t.outlookBasis) + '</p>' +
          '<p style="margin-top:5px"><b>概念成分：</b>' + E((t.memberNames || []).join('、')) + '（跨行业，按新浪概念板块成分归组）</p>' +
          (t.boardRef ? '<p style="margin-top:5px"><b>板块参照：</b>' + E(t.boardRef.name) + ' ' + (t.boardRef.pct > 0 ? '+' : '') + N(t.boardRef.pct) + '%（新浪财经板块行情）</p>' : '') +
          '</div>'
        ).join('')
      : '<div class="empty">当日涨幅居前的概念板块中，未出现 ≥2 只成分股同时涨停（概念主线证据不足）</div>';
    const conceptSectionHtml =
      '<div class="concept-theme-head"><h4>概念主线 <span class="small muted" style="font-weight:400">· 按新浪概念板块成分归组，跨行业，与上方行业口径并列对比</span></h4></div>' +
      '<div class="review-theme-list review-theme-concept">' + conceptThemesHtml + '</div>';

    const focus = (rv.focus || []).map((f, i) => '<div class="info-card"><h4>' + tag('焦点 ' + (i + 1), 'blue') + ' ' + E(f.title) + '</h4><p>' + E(f.text) + '</p></div>').join('');

    const planRows = (rv.playbook || []).map(p =>
      '<div class="plan-row"><div class="col"><span class="cl">触发条件</span>' + E(p.condition) + '</div>' +
      '<div class="col"><span class="cl">对应动作</span>' + E(p.action) + '</div>' +
      '<div class="col"><span class="cl">风险 / 反例</span>' + E(p.risk) + '</div></div>'
    ).join('');

    const risks = (rv.risks || []).map(r => '<li>' + E(r) + '</li>').join('');

    // 昨日连板天梯今日晋级情况（已发生事实）
    const pl = d.prevLadder || {};
    const plSummary = pl.summary || {};
    const plTiers = (pl.tiers || []).map(t =>
      '<div class="pl-tier"><div class="pl-tier-head"><span class="pl-badge">' + E(t.boards) + '板</span>' +
      '<span class="pl-cnt">昨 ' + E(t.total) + ' 家</span><span class="pl-rate">晋级 ' + E(t.promoted) + ' / ' + E(t.rate) + '%</span>' +
      '<span class="pl-avg ' + (t.avgPct > 0 ? 'up' : t.avgPct < 0 ? 'down' : '') + '">今日均涨 ' + (t.avgPct > 0 ? '+' : '') + N(t.avgPct) + '%</span>' +
      (t.limitDown ? tag('跌停 ' + t.limitDown, 'green') : '') + '</div>' +
      '<div class="pl-stocks">' + t.stocks.map(x =>
        '<span class="pl-stock ' + x.cls + '" data-stock-code="' + E(x.code) + '" title="' + E(x.code + ' · ' + (x.industry || '—') + ' · 昨' + x.prevBoards + '板 → 今' + (x.currBoards ? x.currBoards + '板' : x.status)) + '｜点击查看分时 / 日K">' +
        boardBadge(x.code) + E(x.name) + '<b>' + (x.pct === null ? '—' : (x.pct > 0 ? '+' : '') + N(x.pct) + '%') + '</b>' +
        '<i>' + E(x.status) + '</i></span>').join('') + '</div></div>').join('');
    // 资金方向 + 行业板块 / 概念板块分析（数据：新浪资金流 + 新浪板块行情）
    const ff = d.fundFlow || {}, ffBoards = ff.boards || [];
    const amtYi = v => (Number(v) / 1e8).toFixed(2);
    // 上游（腾讯源按涨跌幅）返回顺序不保证按净流入，这里显式按 net 降序，避免「净流入 Top」错显示净流出。
    const ffSorted = ffBoards.slice().sort((a, b) => (Number(b.net) || 0) - (Number(a.net) || 0));
    const fundTop = ffSorted.slice(0, 8), fundBottom = ffSorted.slice(-6).reverse();
    const fundRow = x => '<div class="ff-row"><span class="ff-name">' + E(x.name) + '</span>' +
      '<span class="ff-pct ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + (x.pct > 0 ? '+' : '') + N(x.pct) + '%</span>' +
      '<span class="ff-net ' + (x.net > 0 ? 'up' : 'down') + '">' + (x.net > 0 ? '+' : '') + amtYi(x.net) + ' 亿</span></div>';
    const bk = d.boards || {}, indBoards = bk.industry || [], conBoards = bk.concept || [];
    const boardRows = list => list.slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0)).slice(0, 8).map(x =>
      '<div class="bk-row"><span class="bk-name">' + E(x.name) + '</span>' +
      '<span class="bk-pct ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + (x.pct > 0 ? '+' : '') + N(x.pct) + '%</span>' +
      '<span class="bk-lead">' + (x.leaderName ? boardBadge(x.leaderCode) + E(x.leaderName) + ' ' + (x.leaderPct > 0 ? '+' : '') + N(x.leaderPct) + '%' : '—') + '</span>' +
      '<span class="bk-mem">' + E(x.members || 0) + ' 只</span></div>').join('');
    const fundHtml = '<div class="sec"><div class="sec-head"><h3>二、资金方向 · 板块与概念分析</h3>' +
      src((ff.source || '资金流向') + ' / 新浪财经行业·概念板块行情，' + (m.poolDate || '—') + ' ' + TICK(m)) + '</div>' +
      '<div class="grid2">' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">主力资金方向（行业净流入 Top / 净流出 Top）</h4>' +
      (ffBoards.length
        ? '<div class="ff-grid"><div><div class="ff-col-head up">净流入前 8</div>' + fundTop.map(fundRow).join('') + '</div>' +
          '<div><div class="ff-col-head down">净流出前 6</div>' + fundBottom.map(fundRow).join('') + '</div></div>' +
          '<div class="note-box">行业净流入合计 <b class="' + (ff.totalNet > 0 ? 'up' : 'down') + '">' + (ff.totalNet === null ? '—' : amtYi(ff.totalNet) + ' 亿') +
          '</b>；净流入行业 ' + E(ff.upBoards) + ' 个 / 净流出 ' + E(ff.downBoards) + ' 个。' +
          '<br>口径：' + (ff.source && ff.source.indexOf('腾讯') >= 0
            ? '腾讯证券板块资金流（zljlr 主力净流入，盘中实时），正为净流入、负为净流出。'
            : '新浪按特大单/大单/中单/小单划分，netamount = 流入−流出；正为净买入、负为净流出。') +
          '仅代表当日成交单的方向统计，不等于资金长期意图。</div>'
        : '<div class="empty">' + E(ff.reason || '资金流数据暂不可用') + '</div>') + '</div>' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">板块涨幅与领涨股</h4>' +
      '<div class="ff-col-head">行业板块 Top 8</div><div class="bk-list">' + (boardRows(indBoards) || '<div class="empty">无行业板块数据</div>') + '</div>' +
      '<div class="ff-col-head" style="margin-top:10px">概念板块 Top 8</div><div class="bk-list">' + (boardRows(conBoards) || '<div class="empty">无概念板块数据</div>') + '</div>' +
      (ff.concept && ff.concept.length
        ? '<div class="ff-col-head" style="margin-top:10px">概念资金方向 Top 6</div>' +
          '<div class="ff-grid">' +
          '<div>' + ff.concept.slice().sort((a, b) => b.net - a.net).slice(0, 6).map(fundRow).join('') + '</div>' +
          '<div>' + ff.concept.slice().sort((a, b) => a.net - b.net).slice(0, 6).map(fundRow).join('') + '</div></div>'
        : '') +
      '</div></div>' +
      '<div class="note-box">板块涨跌幅与领涨股为新浪财经公开板块行情；资金流主源为腾讯证券、新浪为备用（新浪接口近期不稳定）。涨停题材分组见上一节「盘面结构与状态诊断」内的「主线题材与生命周期」。资金流与板块行情均为公开接口的当日快照，<b>不构成投资建议</b>。</div></div>';

    const prevLadderHtml = '<div class="sec"><div class="sec-head"><h3>昨日连板天梯 · 今日晋级情况</h3>' +
      src('东方财富历史涨停池 ' + (pl.prevDate || '—') + ' → 今日涨停池 ' + (pl.currDate || '—') + ' + 腾讯证券实时快照') + '</div>' +
      (pl.available && (pl.tiers || []).length
        ? '<div class="card pad"><div class="pl-summary">' +
          tag('昨日连板 ' + (plSummary.total || 0), 'blue') +
          tag('晋级 ' + (plSummary.promoted || 0) + ' (' + (plSummary.rate === null ? '—' : plSummary.rate + '%') + ')', 'red') +
          tag('回封 ' + (plSummary.relimit || 0), 'warn') +
          tag('断板收红 ' + (plSummary.up || 0), 'red') +
          tag('断板收绿 ' + (plSummary.down || 0), 'green') +
          tag('跌停 ' + (plSummary.limitDown || 0), 'green') +
          tag('平均涨幅 ' + (plSummary.avgPct === null ? '—' : ((plSummary.avgPct > 0 ? '+' : '') + N(plSummary.avgPct) + '%')), plSummary.avgPct > 0 ? 'red' : 'green') +
          '</div><div class="pl-tiers">' + plTiers + '</div>' +
          '<div class="note-box">' + E(pl.note || '') +
          '<br>晋级＝今日仍在涨停池且连板数高于昨日；回封＝今日涨停但连板数未增加；断板＝今日未涨停（按实时涨跌幅分收红 / 收绿 / 跌停）。' +
          '<b>这是已经发生的市场事实统计，不是买入信号，也不预测明日表现。</b></div></div>'
        : '<div class="card empty">' + E(pl.reason || '昨日连板晋级数据暂不可用') + '</div>') + '</div>';

    $('pane-review').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>一、盘面结构与状态诊断</h3>' + src('新浪财经全市场快照 / 腾讯证券指数 / 东方财富涨停池，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid2"><div class="review-left">' +
      '<div class="card pad"><div class="fact-list">' + facts + '</div></div>' +
      '<div class="sub-sec-head" style="margin-top:2px;padding-top:0;border-top:none"><h4>主线题材与生命周期</h4>' + src('行业口径＝东财涨停池行业归属；概念口径＝新浪概念板块成分，交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="review-theme-list">' + (themes || '<div class="empty">当前无涨停题材分组数据</div>') + '</div>' +
      conceptSectionHtml +
      '<div class="note-box"><b>行业口径</b>按东财涨停池行业归属分组；<b>概念口径</b>按新浪概念板块成分股重新归组（一只票可属多个概念，跨行业），两者用<b>完全相同</b>的量价规则判定生命周期，可直接对比。<br><b>龙一 / 龙二 / 龙三</b>＝题材内按连板高度→封单比→首封时间→累计涨停数机械排名（与连板天梯「板块龙头」同口径，悬停看封单比/首封时间），仅表当日地位、不代表次日表现。<br>题材阶段完全由量价结构（涨停扩散数 / 连板高度 / 梯队完整度 / 炸板负反馈率 / 板块涨跌幅）机械推导，本页评分不纳入新闻与公告数据（消息面见「明日龙头」模块独立监控）；阶段判断为前瞻性推演，需次日盘面验证。</div>' +
      '</div>' +
      '<div class="card pad"><div class="em-ladder-head">' +
      '<h4 style="font-size:12.5px;margin-bottom:6px">天梯 <span class="small muted" style="font-weight:400">' +
      (S.ladderKind === 'dt' ? '（按连续跌停天数分层 · 标注最多跌停板块）' : '（东方财富式 · 按板级分层）') + '</span></h4>' +
      '<div class="ld-ctrl">' +
      '<div class="ld-tabs"><button type="button" class="ld-tab' + (S.ladderKind === 'zt' ? ' active' : '') + '" data-kind="zt">连板天梯</button>' +
      '<button type="button" class="ld-tab' + (S.ladderKind === 'dt' ? ' active' : '') + '" data-kind="dt">跌停天梯</button></div>' +
      '<select class="sel" id="ladderDate" title="切换交易日回看历史天梯">' +
      (S.ladderDates.length
        ? S.ladderDates.map(x => '<option value="' + E(x.date) + '"' + (x.date === (S.ladderDate || (m.poolDate || '')) ? ' selected' : '') + '>' +
          E(String(x.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) + '（' + x.count + ' 涨停 / ' + (x.dtCount || 0) + ' 跌停）</option>').join('')
        : '<option value="' + E(m.poolDate || '') + '">' + E(m.poolDate || '当日') + '</option>') +
      '</select>' +
      '<label class="check ld-marks" title="控制首板种子卡片的 ★晋级概率角标与彩色边框（设置会记住）">' +
      '<input type="checkbox" id="showSeedMarks"' + (S.ladderMarks.seed ? ' checked' : '') + '> 种子晋级标记</label>' +
      '<label class="check ld-marks" title="控制历史优势组合的彩色边框与晋级率角标（设置会记住）">' +
      '<input type="checkbox" id="showEdgeMarks"' + (S.ladderMarks.edge ? ' checked' : '') + '> 优势组合标记</label>' +
      '</div></div>' +
      (ladderIsHistory && S.ladderDate !== m.poolDate ? '<div class="note-box" style="margin:0 0 8px">历史回放：' +
        E(String(S.ladderDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) + ' 的' + (S.ladderKind === 'dt' ? '跌停' : '涨停') + '池（来源：' + E(S.ladderData.source || '东方财富') +
        '），分层与板块标注按当日结构判定；' + ((S.ladderMarks.seed || S.ladderMarks.edge) ? '彩色边框与 ★ 角标由该日及之前的数据单独计算，不使用今日回测结果。' : '') + '<b>这是已发生的历史行情，不是今日机会。</b></div>' : '') +
      (S.ladderKind === 'dt'
        ? dtSummary +
          '<div class="em-ladder">' + (S.ladderLoading ? '<div class="empty">载入历史天梯…</div>' : (dtTiersHtml || '<div class="empty">当日无跌停标的</div>')) + '</div>' +
          '<div class="note-box">跌停天梯按<b>连续跌停天数</b>分层（东方财富跌停池 days 字段）：N 连跌 &gt; … &gt; 2 连跌 &gt; 首日跌停，越靠上连续跌停越久、负反馈越极端；同层内按<b>封单强度</b>（封单额 / 流通市值）由高到低排列，封单越大越难撬板。<b class="dt-tier-mark-inline">连续跌停最深</b>标出当日连跌天数最多的层级。<b class="warn">最多跌停板块</b>按东方财富行业归属统计家数，家数 ≥2 且并列居首时标注；跌停个股无稳定的概念题材映射，故不臆测题材。数据：东方财富跌停池，交易日 ' + E(m.poolDate || '—') + '。</div>'
        : '<div class="em-ladder">' + (S.ladderLoading ? '<div class="empty">载入历史天梯…</div>' : (tiersHtml || '<div class="empty">当日无连板梯队数据</div>')) + '</div>' +
          (S.ladderMarks.edge ? dgEdgeLegendCard(true) : '') +
          (S.ladderMarks.seed ? seedLegendCard(ladderIsHistory ? (S.ladderData.firstBoardSeed || null) : d.firstBoardSeed, ladderIsHistory) : '') +
          '<div class="note-box">空间板：' + space + '<br>梯队判读：' + E(ov.gap ? '存在断层，按 leader-game 框架属退潮前置信号，需次日 2/3 板补齐确认。' : '梯队连续无断层，情绪延续性优于断层结构。') +
          '<br>板块地位标注规则（按东财行业分组机械判定，非投资建议）：<b class="up">板块龙头</b>=同行业连板最高且封单最强；<b style="color:var(--warn)">反包核心 / 题材龙 / 封单核心</b>=累计板最高 / 连板最高 / 封单最强但不同时满足龙头条件；板块跟风=连板低于行业最高；独苗=行业仅 1 只涨停。<br>每层按封单比降序、首封时间升序排列；封单比 ≥1% 标红、0.3%~1% 标橙、&lt;0.3% 标灰，炸板次数越多风险越高。数据：东方财富涨停池 + 腾讯证券实时快照。' +
          '</div>') +
      '</div></div>' +
      '</div>' +

      fundHtml +
      prevLadderHtml +

      '<div class="sec"><div class="sec-head"><h3>三、明日博弈焦点</h3><span class="src">依据：leader-game 涨停结构 + theme-lifecycle 阶段研判</span></div><div class="grid3">' + focus + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>四、条件化操作框架</h3><span class="src">条件 → 动作 → 风险，非买卖指令</span></div>' +
      '<div class="card pad"><div class="plan-row plan-head"><div class="col">触发条件</div><div class="col">对应动作</div><div class="col">风险 / 反例</div></div>' + planRows + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>五、风险提示与数据边界</h3></div><div class="card pad"><ul class="tight">' + risks + '</ul>' +
      '<div class="note-box">本模块为复盘与观察框架，不预测指数涨跌方向；所有仓位表述均为研究框架示例，需结合个人风险承受能力独立判断。</div></div></div>';

    const ladderOpt = {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 14, top: 18, bottom: 26 },
      xAxis: { type: 'category', data: ladderItems.map(x => x.name), ...AXIS },
      yAxis: { type: 'value', ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 38, data: ladderItems.map(x => ({ value: x.value, itemStyle: { color: '#d92b2b' } })), label: { show: true, position: 'top', color: '#4b5b6b', fontSize: 10 } }]
    };
    safeChart('chartLadder', ladderOpt, ladderItems);
    const lsel = $('ladderDate');
    if (lsel) lsel.onchange = e => loadLadderDate(e.target.value);
    const seedChk = $('showSeedMarks'), edgeChk = $('showEdgeMarks');
    if (seedChk) seedChk.onchange = e => {
      S.ladderMarks.seed = e.target.checked;
      ladderMarksSave();
      renderReview(S.data);
    };
    if (edgeChk) edgeChk.onchange = e => {
      S.ladderMarks.edge = e.target.checked;
      ladderMarksSave();
      renderReview(S.data);
    };
    $('pane-review').querySelectorAll('.ld-tab').forEach(btn => {
      btn.onclick = () => { S.ladderKind = btn.dataset.kind; renderReview(S.data); };
    });
  }

  /** 切换连板天梯交易日：拉历史涨停池，只重渲染复盘区 */
  async function loadLadderDate(date) {
    const d = String(date || '');
    if (!/^\d{8}$/.test(d)) return;
    S.ladderDate = d;
    S.ladderLoading = true;
    renderReview(S.data); // 立刻显示载入态
    try {
      const r = await fetch('/api/ladder?date=' + encodeURIComponent(d), { cache: 'no-store' });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      S.ladderData = j;
      if (!S.ladderDates.length && j.dates) S.ladderDates = j.dates;
    } catch (e) {
      S.ladderData = null;
      $('alertBox').style.display = '';
      $('alertBox').textContent = '历史天梯加载失败：' + e.message;
    } finally {
      S.ladderLoading = false;
      renderReview(S.data);
    }
  }

  /** 首屏拉取可用交易日列表（轻量，只返回日期与家数） */
  async function initLadderDates() {
    try {
      const r = await fetch('/api/ladder', { cache: 'no-store' });
      const j = await r.json();
      if (!j.error && j.dates) S.ladderDates = j.dates;
    } catch (e) { /* 日期列表非关键，失败则下拉只有当日 */ }
  }

  /* ─────────────── 短线推荐 ─────────────── */
  function renderPicks(d) {
    const rows = d.picks || [], m = d.meta;
    const head = '<thead><tr><th class="left">代码 / 名称</th><th>板块</th><th>现价</th><th>涨跌幅</th><th>连板</th><th>流通市值</th><th>换手</th><th>成交额</th><th>封单/流通</th><th class="left">题材 / 阶段</th><th>评分</th><th class="left">结论</th></tr></thead>';
    const body = rows.map((x, i) => {
      const parts = (x.scoreParts || []).map(p =>
        '<div class="sp"><span class="spn">' + E(p.factor) + '</span><div class="spb"><div class="spf" style="width:' + (p.max ? Math.max(0, Math.min(100, p.got / p.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(p.got) + '/' + E(p.max) + '</span></div>'
      ).join('');
      const detail = '<div class="grid2" style="gap:18px"><div><h4 style="font-size:12px;margin-bottom:7px">评分拆解（总分 ' + E(x.score) + ' / 100）</h4><div class="score-parts">' + parts + '</div></div>' +
        '<div><h4 style="font-size:12px;margin-bottom:7px">风险标签与观察条件</h4>' +
        ((x.risks || []).length ? '<ul class="tight">' + x.risks.map(r => '<li>' + E(r) + '</li>').join('') + '</ul>' : '<div class="small muted">无触发式风险标签</div>') +
        '<div class="note-box">评分由动量、题材热度、封板质量、量能、市值位置、日内强弱六个可量化因子加总；仅为排序依据，不代表收益预期。需等待回踩企稳与板块支持确认。</div></div></div>';
      const vcls = x.verdict === '重点观察' ? 'red' : (x.verdict === '可跟踪' ? 'warn' : '');
      return '<tr class="clickable" data-pick="' + E(x.code) + '">' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') + (x.isST ? ' <span class="mini-tag">ST</span>' : '') + '</td>' +
        '<td><span class="mini-tag">' + E(x.board || '—') + '</span></td>' +
        '<td class="' + flashCls(x.code, x.price) + '">' + N(x.price) + '</td>' +
        '<td>' + PC(x.pct) + '</td><td>' + (x.boards || 1) + '</td>' +
        '<td>' + CAP(x.floatCap) + '</td><td>' + N(x.turnover, 1) + '%</td><td>' + AMT(x.amount) + '</td>' +
        '<td>' + (x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : N(x.sealFundRatio) + '%') + '</td>' +
        '<td class="left">' + E(x.themeName || x.industry || '—') + (x.themeStage ? ' <span class="mini-tag">' + E(x.themeStage) + '</span>' : '') + '</td>' +
        '<td><b class="' + (x.score >= 72 ? 'up' : '') + '">' + E(x.score) + '</b></td>' +
        '<td class="left">' + tag(x.verdict, vcls) + '</td></tr>' +
        '<tr class="detail-row" id="pickDetail_' + E(x.code) + '" style="display:' + (S.expanded.has(x.code) ? '' : 'none') + '"><td colspan="12">' + detail + '</td></tr>';
    }).join('');

    $('pane-picks').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>短线个股候选池</h3>' + src('候选来自东方财富涨停池 / 强势股池实时交集，字段由腾讯证券快照补全，时点 ' + TICK(m)) + '<span class="spacer"></span><span class="small muted">点击任意行展开评分拆解</span></div>' +
      '<div class="conclusion card" style="margin-bottom:12px;border-left-color:var(--blue2)"><div class="lead">打分口径：动量 20 + 题材热度 20 + 封板质量 20 + 量能 15 + 市值位置 15 + 日内强弱 10 = 100 分。所有因子均由实时行情字段计算，不含主观预设名单。</div><div class="tags">' + tag('共 ' + rows.length + ' 只入池', 'blue') + tag('已应用全局筛选', 'blue') + '</div></div>' +
      '<div class="tbl-wrap"><table>' + head + '<tbody>' + (body || '<tr><td colspan="12" class="empty">当前筛选条件下无匹配标的，请放宽流通市值 / 板块 / 连板条件</td></tr>') + '</tbody></table></div></div>';

    $('pane-picks').querySelectorAll('tr[data-pick]').forEach(tr => {
      tr.onclick = () => {
        const code = tr.dataset.pick, el = $('pickDetail_' + code);
        if (!el) return;
        if (el.style.display === 'none') { el.style.display = ''; S.expanded.add(code); }
        else { el.style.display = 'none'; S.expanded.delete(code); }
      };
    });
  }

  /* ─────────────── 实时机会 ─────────────── */
  function simpleTable(rows, cols, emptyText) {
    if (!rows || !rows.length) return '<div class="empty">' + E(emptyText) + '</div>';
    const head = '<thead><tr>' + cols.map(c => '<th class="' + (c.left ? 'left' : '') + '">' + E(c.t) + '</th>').join('') + '</tr></thead>';
    const body = rows.map(x => '<tr>' + cols.map(c => '<td class="' + (c.left ? 'left ' : '') + (c.flash ? flashCls(x.code, x.price) : '') + '">' + c.f(x) + '</td>').join('') + '</tr>').join('');
    return '<div class="tbl-wrap"><table>' + head + '<tbody>' + body + '</tbody></table></div>';
  }
  const nameCell = x => '<span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm');
  const baseCols = [
    { t: '代码 / 名称', left: true, f: nameCell },
    { t: '板块', f: x => '<span class="mini-tag">' + E(x.board || '—') + '</span>' },
    { t: '现价', flash: true, f: x => N(x.price) },
    { t: '涨跌幅', f: x => PC(x.pct) },
    { t: '流通市值', f: x => CAP(x.floatCap) },
    { t: '换手', f: x => N(x.turnover, 1) + '%' },
    { t: '成交额', f: x => AMT(x.amount) },
    { t: '行业', left: true, f: x => E(x.industry || '—') }
  ];

  function renderLive(d) {
    const o = d.opportunities, m = d.meta, ov = d.overview;
    const indTop = (o.industry || []).slice().sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 10);
    const conTop = (o.concept || []).slice().sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 10);
    const boardTable = list =>
      '<div class="tbl-wrap"><table><thead><tr><th class="left">板块</th><th>涨跌幅</th><th>成分</th><th>成交额</th><th class="left">领涨股</th></tr></thead><tbody>' +
      (list.length ? list.map(b => '<tr><td class="left"><b>' + E(b.name) + '</b></td><td>' + PC(b.pct) + '</td><td>' + E(b.members) + '</td><td>' + AMT(b.amount) + '</td><td class="left">' + (b.leaderName ? boardBadge(b.leaderCode) + E(b.leaderName) : '—') + ' <span class="mini-tag">' + PC(b.leaderPct) + '</span></td></tr>').join('') : '<tr><td colspan="5" class="empty">板块数据暂不可用</td></tr>') + '</tbody></table></div>';

    const ztCols = baseCols.concat([
      { t: '连板', f: x => '<b class="up">' + (x.boards || 1) + '</b>' },
      { t: '首封', f: x => E(x.firstSeal || '—') },
      { t: '炸板', f: x => E(x.brokenCount === undefined ? '—' : x.brokenCount) },
      { t: '封单', f: x => YI(x.sealFund) },
      { t: '封单/流通', f: x => (x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : N(x.sealFundRatio) + '%') }
    ]);
    const qsCols = baseCols.concat([
      { t: '量比', f: x => N(x.volRatio) },
      { t: '涨速', f: x => N(x.zs !== undefined ? x.zs : x.speed) },
      { t: '信号', left: true, f: x => tag(x.signal, 'blue') }
    ]);
    const riskCols = [
      { t: '代码 / 名称', left: true, f: nameCell },
      { t: '现价', flash: true, f: x => N(x.price) },
      { t: '涨跌幅', f: x => PC(x.pct) },
      { t: '流通市值', f: x => CAP(x.floatCap) },
      { t: '换手', f: x => N(x.turnover, 1) + '%' },
      { t: '行业', left: true, f: x => E(x.industry || '—') },
      { t: '风险信号', left: true, f: x => tag(x.signal, 'warn') }
    ];

    $('pane-live').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>实时指数快照</h3>' + src('腾讯证券实时行情，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid4">' + (ov.indices || []).map(i => '<div class="info-card"><h4>' + E(i.name) + '</h4><p><span class="big ' + (i.pct > 0 ? 'up' : i.pct < 0 ? 'down' : '') + '" style="font-size:19px;font-weight:700">' + N(i.price) + '</span> ' + PC(i.pct) + '<br><span class="small muted">振幅 ' + N(i.amplitude) + '% · 量比 ' + N(i.volRatio) + ' · 成交额 ' + (i.amountWan ? (i.amountWan / 10000).toFixed(0) + '亿' : '—') + '</span></p></div>').join('') + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>板块异动榜</h3>' + src('新浪财经行业 / 概念板块实时行情，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid2"><div><div class="sec-head"><h3 style="font-size:12.5px">行业板块 · 涨幅 Top10</h3></div><div id="chartIndustry" class="chart-sm"></div>' + boardTable(indTop) + '</div>' +
      '<div><div class="sec-head"><h3 style="font-size:12.5px">概念板块 · 涨幅 Top10</h3></div><div id="chartConcept" class="chart-sm"></div>' + boardTable(conTop) + '</div></div></div>' +

      '<div class="sec"><div class="sec-head"><h3>涨停池（' + ov.limitUp + ' 家）</h3>' + src('东方财富涨停池，交易日 ' + (m.poolDate || '—') + '；连板数、封单、首封时间均来自该接口') + '</div>' + simpleTable(o.zt, ztCols, '当前筛选条件下无涨停标的') + '</div>' +

      '<div class="sec"><div class="sec-head"><h3>强势股池（' + (o.strongCount || 0) + ' 家）</h3>' + src('东方财富强势股池，交易日 ' + (m.poolDate || '—')) + '</div>' + simpleTable(o.qs, qsCols, '当前筛选条件下无强势股') + '</div>' +

      '<div class="sec"><div class="sec-head"><h3>负反馈监控</h3>' + src('东方财富炸板池 / 跌停池，交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="grid2"><div><div class="sec-head"><h3 style="font-size:12.5px;color:var(--warn)">炸板池 ' + (o.zb || []).length + ' 家</h3></div>' + simpleTable(o.zb, riskCols, '无炸板标的') + '</div>' +
      '<div><div class="sec-head"><h3 style="font-size:12.5px;color:var(--down)">跌停池 ' + (o.dt || []).length + ' 家</h3></div>' + simpleTable(o.dt, riskCols, '无跌停标的') + '</div></div></div>';

    const barOpt = (items, color) => ({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 90, right: 34, top: 8, bottom: 20 },
      xAxis: { type: 'value', ...AXIS },
      yAxis: { type: 'category', data: items.map(x => x.name).reverse(), ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 13, data: items.map(x => x.pct || 0).reverse().map(v => ({ value: v, itemStyle: { color: v >= 0 ? color : '#0f9960' } })), label: { show: true, position: 'right', formatter: '{c}%', fontSize: 10, color: '#4b5b6b' } }]
    });
    const indItems = indTop.map(b => ({ name: b.name, value: b.pct || 0, label: (b.pct > 0 ? '+' : '') + N(b.pct) + '%' }));
    const conItems = conTop.map(b => ({ name: b.name, value: b.pct || 0, label: (b.pct > 0 ? '+' : '') + N(b.pct) + '%' }));
    safeChart('chartIndustry', barOpt(indTop, '#d92b2b'), indItems);
    safeChart('chartConcept', barOpt(conTop, '#2f6fd0'), conItems);
  }

  /* ─────────────── 连板低吸（核心） ─────────────── */
  function verdictClass(level) {
    return level === '推荐低吸' ? 'recommend' : (level === '谨慎观察' ? 'watch' : 'no');
  }
  /* ───────── 实时可低吸排序：把「测算区间」与「当前实时价」对齐 ───────── */
  function lowBuyLiveRows(d) {
    const rows = d.lowbuy || [];
    const out = rows.map(x => {
      const lb = x.lowBuy, price = Number(x.price);
      const zone = lb && Array.isArray(lb.zone) ? lb.zone : null;
      const v = x.verdict || {}, th = x.theme || {};
      const veto = (v.veto || []).length;
      const vol = (x.volRatio === null || x.volRatio === undefined) ? null : Number(x.volRatio);
      const volNote = vol === null ? '量比缺失' : (vol < 0.8 ? '缩量回踩' : vol <= 2 ? '量能温和' : '放量·需辨承接');
      const volOK = vol === null || vol <= 3;
      const avg = (x.avgPrice === null || x.avgPrice === undefined || !Number.isFinite(Number(x.avgPrice))) ? null : Number(x.avgPrice);
      const avgGap = (avg && Number.isFinite(price)) ? +((price - avg) / avg * 100).toFixed(2) : null;
      if (!zone || !Number.isFinite(price) || price <= 0) {
        return { ...x, live: { status: '数据不足', rank: 5, gap: null, vol, volNote, avg, avgGap, canAct: false, liveScore: 0, note: '日K或实时价缺失', action: '数据缺失，按纪律宁可等确认' } };
      }
      const lo = Number(zone[0]), hi = Number(zone[1]);
      let status, rank, gap, note, action;
      if (price < lo) {
        gap = (lo - price) / price * 100;
        status = '已破位'; rank = 4;
        note = '跌破区间下沿 ' + N(gap, 1) + '%';
        action = '现价已跌破低吸区间下沿，触发「计划失效条件」，回避而非摊低成本';
      } else if (price > hi) {
        gap = (price - hi) / price * 100;
        status = gap <= 2 ? '接近低吸' : '等待回踩';
        rank = gap <= 2 ? 2 : 3;
        note = '距上沿还需回踩 ' + N(gap, 1) + '%';
        action = '尚未进入测算区间，观察是否缩量回踩至 ' + N(lo) + '—' + N(hi) + '，不提前埋伏';
      } else {
        gap = 0;
        const condOK = v.level === '推荐低吸' || v.level === '谨慎观察';
        const themeOK = th.outlook !== '弱';
        const vetoOK = veto === 0;
        if (condOK && themeOK && vetoOK) { status = '可低吸·条件满足'; rank = 0; }
        else { status = '区间内·条件不足'; rank = 1; }
        note = '现价位于测算区间内';
        action = rank === 0
          ? '价格到位且无一票否决；仍需等分时企稳、缩量不破位确认，不宜仅凭价格执行'
          : '价格到位，但' + (veto ? veto + ' 项一票否决；' : '') +
            (v.level === '不推荐' || v.level === '数据不足' ? '综合结论为「' + E(v.level) + '」；' : '') +
            (th.outlook === '弱' ? '题材预期为「弱」；' : '') + '不建议按区间执行';
      }
      const base = { 0: 70, 1: 50, 2: 40, 3: 20, 4: 0, 5: 0 }[rank] || 0;
      const liveScore = Math.round(Math.max(0, Math.min(100,
        base + Math.max(0, 20 - (gap || 0) * 2) + (Number(x.techScore) || 0) / 100 * 20
        + (v.level === '推荐低吸' ? 10 : v.level === '谨慎观察' ? 5 : 0)
        - (veto ? 10 : 0) - (rank === 4 ? 10 : 0)
      )));
      return {
        ...x,
        live: {
          status, rank, gap: gap === null ? null : +gap.toFixed(2), vol, volNote, avg, avgGap,
          canAct: rank === 0 && volOK, liveScore, note, action, lo, hi,
          cls: rank === 0 ? 'recommend' : (rank === 1 || rank === 2 ? 'watch' : 'no')
        }
      };
    });
    out.sort((a, b) => a.live.rank - b.live.rank || (a.live.gap || 0) - (b.live.gap || 0) || b.live.liveScore - a.live.liveScore);
    return out;
  }

  function lowBuyLiveHtml(d, list) {
    const m = d.meta || {};
    const c = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    list.forEach(x => { c[x.live.rank] = (c[x.live.rank] || 0) + 1; });
    const trading = m.state === '盘中' || m.state === '集合竞价';
    const noActionable = c[0] === 0 && c[1] === 0 && c[2] === 0;
    const head = '<thead><tr><th>#</th><th class="left">代码 / 名称</th><th>现价</th><th>涨跌幅</th><th>均价线</th><th>距均价</th><th>低吸区间</th><th>距上沿</th><th class="left">实时状态</th><th>量比</th><th>技术分</th><th>排序分</th><th class="left">可执行说明</th></tr></thead>';
    const body = list.map((x, i) => {
      const L = x.live;
      return '<tr class="clickable" data-jump="' + E(x.code) + '" title="点击查看该股完整研判卡片">' +
        '<td><span class="lb-live-rank' + (i < 3 && L.rank <= 2 ? ' top' : '') + '">' + (i + 1) + '</span></td>' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') +
        '<div class="small muted">' + E(x.boards) + ' 连板 · ' + E((x.theme && x.theme.name) || x.industry || '无题材') + '</div></td>' +
        '<td class="' + flashCls(x.code, x.price) + '">' + N(x.price) + '</td>' +
        '<td>' + PC(x.pct) + '</td>' +
        '<td>' + (L.avg === null ? '—' : N(L.avg)) + '</td>' +
        '<td class="' + (L.avgGap !== null && L.avgGap < 0 ? 'down' : '') + '">' + (L.avgGap === null ? '—' : (L.avgGap > 0 ? '+' : '') + N(L.avgGap, 1) + '%') + '</td>' +
        '<td class="lb-live-zone">' + (L.lo === undefined ? '—' : N(L.lo) + ' — ' + N(L.hi)) + '</td>' +
        '<td>' + (L.gap === null ? '—' : (L.rank === 4 ? '<span class="down">破位 ' : '') + N(L.gap, 1) + '%' + (L.rank === 4 ? '</span>' : '')) + '</td>' +
        '<td class="left"><span class="verdict ' + L.cls + '">' + E(L.status) + '</span></td>' +
        '<td>' + (L.vol === null ? '—' : N(L.vol)) + '<div class="small muted">' + E(L.volNote) + '</div></td>' +
        '<td>' + E(x.techScore === null ? '—' : x.techScore) + '</td>' +
        '<td><b class="' + (L.liveScore >= 70 ? 'up' : '') + '">' + E(L.liveScore) + '</b></td>' +
        '<td class="left small">' + L.action + '</td></tr>';
    }).join('');
    return '<div class="sec"><div class="sec-head"><h3>实时可低吸排序</h3>' +
      src('实时价：腾讯证券快照 ' + (m.quoteTick || m.universeTick || '—') + '；低吸区间：交易日 ' + (m.poolDate || '—') + ' 日线技术位') +
      '<span class="spacer"></span>' + tag(trading ? '盘中实时' : (m.state || '—'), trading ? 'red' : 'blue') + '</div>' +
      '<div class="card pad"><div class="lb-live-summary">' +
      tag('可低吸 ' + c[0], 'red') + tag('区间内·条件不足 ' + c[1], 'warn') + tag('接近低吸 ' + c[2], 'blue') +
      tag('等待回踩 ' + c[3], '') + tag('已破位 ' + c[4], 'green') + tag('数据不足 ' + c[5], '') +
      '<span class="small muted" style="margin-left:auto">共 ' + list.length + ' 只连板 · 随全局自动刷新（默认 15 秒）· 点击任意行跳转研判卡片</span></div>' +
      '<div class="tbl-wrap"><table>' + head + '<tbody>' +
      (body || '<tr><td colspan="13" class="empty">当前筛选条件下无连板标的</td></tr>') + '</tbody></table></div>' +
      '<div class="note-box">' +
      (noActionable ? '<b>当前提示：</b>没有标的进入或接近测算低吸区间（多为封板 / 高位尚未回踩），列表按「距区间上沿回踩幅度」由近到远排序，最上方即最接近低吸位的标的。这是盘面的客观状态，系统不会为了凑出「可低吸」而放宽条件。<br>' : '') +
      '<b>均价线：</b>腾讯实时快照的分时均价，仅作盘中承接强弱参考；封板时均价通常明显低于现价，贴近均价不等于回踩到波段低吸区间。<br>' +
      '<b>排序依据：</b>① 实时状态（可低吸 &gt; 区间内条件不足 &gt; 接近低吸 &gt; 等待回踩 &gt; 已破位）；② 距区间上沿的回踩幅度（越小越靠前）；③ 排序分 = 状态基分 + 接近度 + 技术评分 + 推荐等级 − 否决扣减。<b>排序分只用于排序，不是收益预测</b>。「可低吸」要求价格落在测算区间、无一票否决、题材预期不为「弱」、综合结论非「不推荐」；量比仅作参考标签（盘中量比波动大，不作硬门槛），仍需分时缩量企稳确认。<br>' +
      '<b>口径与时点：</b>低吸区间由交易日 ' + (m.poolDate || '—') + ' 的前复权日K技术位（斐波那契回撤 / MA5 / MA10）机械测算，<b>锚点固定为当日涨停价、不随实时价漂移</b>，否则每次刷新区间会跟着现价移动，永远无法判定「是否回踩到位」；现价取腾讯证券实时快照（' + (m.quoteTick || m.universeTick || '—') + '）。两者盘中比较正是「是否回踩到位」的观察依据，但除权、跳空、涨跌停制度变化会使区间失真。' +
      (trading ? '' : '<b>当前为' + E(m.state || '非交易时段') + '</b>，价格为最近收盘快照，「可低吸」仅是静态测算状态，不构成盘中实时信号。') +
      '</div></div></div>';
  }

  function renderLowBuy(d) {
    const rows = d.lowbuy || [], m = d.meta, ov = d.overview;
    const cnt = { '推荐低吸': 0, '谨慎观察': 0, '不推荐': 0, '数据不足': 0 };
    rows.forEach(x => { const k = x.verdict.level; if (cnt[k] !== undefined) cnt[k]++; });
    const noRec = cnt['推荐低吸'] === 0 ? '<div class="small muted" style="font-weight:400;margin-top:5px">当前没有标的达到「推荐低吸」阈值，属风控结果而非数据缺失：需技术评分 ≥70、题材地位为核心/龙头、题材预期 ≥较强 三项共振，弱市下宁可空仓等待确认。</div>' : '';
    const summary = '<div class="conclusion card" style="margin-bottom:14px;border-left-color:var(--purple)"><div class="lead">连板低吸模块：从实时涨停池中筛选 ' + rows.length + ' 只连板（≥2 板）标的，逐只做日线技术面交叉验证、题材地位判定与题材生命周期评估，输出「是否推荐 / 是否题材核心或龙头 / 题材是否还有预期」三项结论。' + noRec + '</div>' +
      '<div class="tags">' + tag('连板 ' + rows.length + ' 只', 'purple') + tag('推荐低吸 ' + cnt['推荐低吸'], 'red') + tag('谨慎观察 ' + cnt['谨慎观察'], 'warn') + tag('不推荐 ' + cnt['不推荐'], '') + '</div></div>';

    const cards = rows.map((x, i) => {
      const t = x.technical || {}, th = x.theme, lb = x.lowBuy, v = x.verdict;
      const collapsed = S.collapsed.has(x.code);
      const votes = t.available ? (t.votes || []).map(vt =>
        '<span class="' + (vt.signal === '多' || vt.signal === '偏多' || vt.signal === '显著放量' ? 'bull' : (vt.signal === '空' || vt.signal === '偏空' || vt.signal === '超买' ? 'bear' : '')) + '" title="' + E(vt.detail) + '">' + E(vt.dim) + '：' + E(vt.signal) + '</span>'
      ).join('') : '<span>日K数据缺失</span>';

      const techRows = t.available ? [
        ['均线', 'MA5 ' + N(t.ma && t.ma.ma5) + ' / MA10 ' + N(t.ma && t.ma.ma10) + ' / MA20 ' + N(t.ma && t.ma.ma20) + ' / MA60 ' + N(t.ma && t.ma.ma60)],
        ['排列', (t.bullAlign ? '多头排列（MA5>MA10>MA20）' : (t.aboveMA20 ? '站上 MA20，但未形成多头排列' : '位于 MA20 下方')) + '，偏离 MA5 ' + N(t.devMA5, 1) + '%'],
        ['MACD', t.macd ? 'DIF ' + N(t.macd.dif) + ' / DEA ' + N(t.macd.dea) + ' / 柱 ' + N(t.macd.hist) + (t.macd.goldenCross ? '（金叉）' : t.macd.deadCross ? '（死叉）' : '') : '数据不足'],
        ['RSI / KDJ', 'RSI14 ' + E(t.rsi14) + (t.kdj ? ' / K ' + E(t.kdj.k) + ' D ' + E(t.kdj.d) + ' J ' + E(t.kdj.j) : '')],
        ['布林 / ATR', t.boll ? 'BOLL 中轨 ' + N(t.boll.mid) + ' 上轨 ' + N(t.boll.upper) + ' 带宽 ' + N(t.boll.width) + '% / ATR14 ' + N(t.atr) : '—'],
        ['量能', '最新量 / 前5日均量 = ' + N(t.volSurge) + ' 倍'],
        ['位置', t.position + '；' + t.positionNote + '；距60日高 ' + N(t.fromHigh, 1) + '% / 距20日低 ' + N(t.fromLow, 1) + '%'],
        ['支撑位', (t.supports || []).slice(0, 6).map(s => N(s)).join(' / ') || '—'],
        ['斐波那契', t.fib ? '锚点（涨停价）' + N(t.fib.anchor) + ' / 起涨基准 ' + N(t.fib.base) + ' → 0.382 ' + N(t.fib.f382) + ' / 0.5 ' + N(t.fib.f500) + ' / 0.618 ' + N(t.fib.f618) : '—'],
        ['日K样本', (t.bars || 0) + ' 根，截至 ' + E(t.lastDate || '—') + '（' + E(m.klineSource || '腾讯证券日K') + '）']
      ].map(r => '<tr><td>' + E(r[0]) + '</td><td>' + E(r[1]) + '</td></tr>').join('') : '<tr><td colspan="2">' + E(t.reason || '日K数据缺失') + '</td></tr>';

      const parts = (x.techParts || []).map(p =>
        '<div class="sp"><span class="spn">' + E(p.factor) + '</span><div class="spb"><div class="spf" style="width:' + (p.max ? Math.max(0, Math.min(100, p.got / p.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(p.got) + '/' + E(p.max) + '</span></div>'
      ).join('');

      const themeHtml = th ?
        '<div class="kv"><span class="k">题材名称</span><span class="v">' + E(th.name) + '（' + th.count + ' 只涨停 / 最高 ' + th.maxBoard + ' 板）</span></div>' +
        '<div class="kv"><span class="k">生命周期阶段</span><span class="v">' + tag(th.stage, 'purple') + '</span></div>' +
        '<div class="kv"><span class="k">题材是否还有预期</span><span class="v">' + tag('预期：' + th.outlook, th.outlookScore >= 3 ? 'red' : 'warn') + '</span></div>' +
        '<div class="kv"><span class="k">梯队 / 负反馈</span><span class="v">' + E(Object.keys(th.ladder || {}).sort((a, b) => b - a).map(b => b + '板×' + th.ladder[b]).join(' ')) + (th.gap ? ' · 有断层' : ' · 无断层') + ' / 炸板率 ' + N(th.negRate, 1) + '%</span></div>' +
        '<div class="note-box"><b>阶段依据：</b>' + E(th.stageBasis) + '<br><b>预期依据：</b>' + E(th.basis || th.outlookBasis) + '</div>' +
        (th.boardRef ? '<div class="kv" style="margin-top:6px"><span class="k">板块行情参照</span><span class="v">' + E(th.boardRef.name) + ' ' + (th.boardRef.pct > 0 ? '+' : '') + N(th.boardRef.pct) + '%</span></div>' : '') +
        '<div style="margin-top:9px"><h5 style="font-size:11.5px;margin:0 0 4px;color:var(--purple)">后续需验证的观察点</h5><ul class="tight">' + (th.watchPoints || []).map(w => '<li>' + E(w) + '</li>').join('') + '</ul></div>'
        : '<div class="empty">该标的所属行业未形成涨停分组，无题材周期数据</div>';

      const roleHtml =
        '<div class="kv"><span class="k">是否题材核心 / 龙头</span><span class="v">' + tag(x.role.role, x.role.isCore ? 'red' : '') + '</span></div>' +
        '<div class="kv"><span class="k">判定依据</span><span class="v" style="max-width:75%">' + E(x.role.reason) + '</span></div>' +
        '<div class="kv"><span class="k">连板高度</span><span class="v">' + E(x.boards) + ' 板（全场最高 ' + E(ov.maxBoard) + ' 板）</span></div>' +
        '<div class="kv"><span class="k">封板质量</span><span class="v">封单 ' + YI(x.sealFund) + ' / 占流通 ' + N(x.sealFundRatio) + '% · 炸板 ' + E(x.brokenCount || 0) + ' 次 · 首封 ' + E(x.firstSeal || '—') + '</span></div>' +
        '<div class="kv"><span class="k">流通市值 / 换手</span><span class="v">' + CAP(x.floatCap) + ' / ' + N(x.turnover, 1) + '%</span></div>';

      const planHtml = lb ?
        '<div class="zone-box"><div class="zl">技术测算低吸区间（元）</div><div class="zv">' + N(lb.zone[0]) + ' — ' + N(lb.zone[1]) + '</div>' +
        '<div class="zone-row"><span class="small">止损参考 <b class="down">' + N(lb.stop) + '</b></span><span class="small">上方目标 <b class="up">' + N(lb.target) + '</b></span><span class="small">盈亏比 <b>' + N(lb.riskReward) + '</b></span></div></div>' +
        '<div class="note-box"><b>区间算法：</b>' + E(lb.zoneBasis) + '<br>' + E(lb.note) + '</div>'
        : '<div class="note-box">日K数据不足，无法测算技术位；按 trade-plan 纪律，理由不足时「宁可等确认」，不给低吸区间。</div>';

      return '<div class="lb-card' + (collapsed ? ' lb-collapsed' : '') + '" id="lbCard_' + E(x.code) + '" data-code="' + E(x.code) + '">' +
        '<div class="lb-head" data-toggle="' + E(x.code) + '">' +
        '<span class="lb-name">' + sn(x.code, x.name) + '</span><span class="lb-code">' + E(x.code) + '</span>' +
        '<span class="lb-boards">' + E(x.boards) + ' 连板</span>' +
        '<span class="mini-tag">' + E(x.board) + '</span>' +
        '<span class="lb-price ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + N(x.price) + '</span>' + PC(x.pct) +
        '<span class="lb-spacer"></span>' +
        tag(th ? th.name : (x.industry || '无题材分组'), 'purple') +
        '<span class="verdict ' + verdictClass(v.level) + '">' + E(v.level) + '</span>' +
        '<div class="lb-reason">结论：' + E(v.reason) + '　| 技术评分 <b>' + E(x.techScore === null ? '—' : x.techScore) + '</b> / 100　| 点击' + (collapsed ? '展开' : '收起') + '详情</div>' +
        '</div>' +
        '<div class="lb-body"><div class="lb-grid">' +
        '<div>' +
        '<div class="lb-sub"><h5>① 技术面分析（多系统交叉验证：趋势 &gt; 位置 &gt; 短期信号）</h5>' +
        '<div class="vote">' + votes + '</div>' +
        '<table class="tech-tbl">' + techRows + '</table></div>' +
        '<div class="lb-sub"><h5>技术评分拆解（' + E(x.techScore === null ? '—' : x.techScore) + ' / 100）</h5><div class="score-parts">' + parts + '</div>' +
        (v.veto && v.veto.length ? '<div class="veto"><b>一票否决项（' + v.veto.length + '）：</b><br>' + v.veto.map(z => '· ' + E(z)).join('<br>') + '</div>' : '') + '</div>' +
        '<div class="lb-sub purple"><h5>④ 低吸区间与执行框架（条件化，非买卖指令）</h5>' + planHtml +
        '<div style="margin-top:10px"><h5 style="font-size:11.5px;margin:0 0 4px;color:var(--blue)">分仓路径</h5><ul class="tight">' + (x.entryFramework.steps || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>' +
        '<div style="margin-top:8px"><h5 style="font-size:11.5px;margin:0 0 4px;color:var(--up)">计划失效条件（触发即退出）</h5><ul class="tight">' + (x.entryFramework.invalid || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div></div>' +
        '</div>' +
        '<div>' +
        '<div class="lb-sub purple"><h5>② 是否题材核心 / 龙头</h5>' + roleHtml + '</div>' +
        '<div class="lb-sub warn"><h5>③ 题材是否还有预期</h5>' + themeHtml + '</div>' +
        '<div class="lb-sub"><h5>数据溯源</h5>' +
        '<div class="kv"><span class="k">连板 / 封单 / 行业</span><span class="v">东方财富涨停池 ' + E(m.poolDate || '—') + '</span></div>' +
        '<div class="kv"><span class="k">实时价 / 流通市值</span><span class="v">腾讯证券 ' + E(TICK(m)) + '</span></div>' +
        '<div class="kv"><span class="k">日K技术指标</span><span class="v">' + E(m.klineSource || '腾讯证券日K') + ' ' + E(t.lastDate || '—') + '</span></div>' +
        '<div class="kv"><span class="k">板块阶段参照</span><span class="v">新浪财经板块行情</span></div></div>' +
        '</div></div></div></div>';
    }).join('');

    const scoreItems = rows.slice(0, 12).map(x => ({ name: boardText(x.code) + x.name + '(' + x.code + ')', value: x.techScore || 0, label: x.techScore === null ? '—' : x.techScore }));

    const liveRows = lowBuyLiveRows(d);
    $('pane-lowbuy').innerHTML = summary +
      lowBuyLiveHtml(d, liveRows) +
      '<div class="sec"><div class="sec-head"><h3>连板股技术评分对比</h3>' + src('本系统技术指标计算，输入为腾讯证券前复权日K') + '</div><div class="card pad"><div id="chartLowScore" class="chart"></div></div></div>' +
      '<div class="sec"><div class="sec-head"><h3>逐只研判（' + rows.length + ' 只）</h3>' + src('东方财富涨停池 + 腾讯证券行情/日K + 新浪财经板块，交易日 ' + (m.poolDate || '—')) + '</div>' +
      (cards || '<div class="card empty">当前筛选条件下无连板标的。可放宽「最低连板数 / 流通市值 / 板块」条件；若为非交易时段，涨停池展示最近一个交易日数据。</div>') + '</div>' +
      '<div class="disclaimer" style="margin-top:14px"><strong>风险提示</strong>：连板低吸属于高波动策略，高位股接力赔率最差；题材阶段为量价结构推导的前瞻判断，可能因消息面变化而失效。本模块评分不纳入新闻、公告与龙虎榜数据（消息面见「明日龙头」模块独立监控），所有结论仅供研究参考，不构成投资建议。</div>';

    $('pane-lowbuy').querySelectorAll('.lb-head[data-toggle]').forEach(el => {
      el.onclick = () => {
        const c = el.dataset.toggle, card = el.closest('.lb-card');
        if (S.collapsed.has(c)) { S.collapsed.delete(c); card.classList.remove('lb-collapsed'); }
        else { S.collapsed.add(c); card.classList.add('lb-collapsed'); }
      };
    });
    $('pane-lowbuy').querySelectorAll('tr[data-jump]').forEach(tr => {
      tr.onclick = () => {
        const c = tr.dataset.jump, card = $('lbCard_' + c);
        if (!card) return;
        S.collapsed.delete(c); card.classList.remove('lb-collapsed');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    const scoreOpt = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 135, right: 40, top: 10, bottom: 24 },
      xAxis: { type: 'value', max: 100, ...AXIS },
      yAxis: { type: 'category', data: scoreItems.map(x => x.name).reverse(), ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 14, data: scoreItems.map(x => x.value).reverse().map(v => ({ value: v, itemStyle: { color: v >= 70 ? '#d92b2b' : (v >= 55 ? '#d97706' : '#94a3b8') } })), label: { show: true, position: 'right', fontSize: 10, color: '#4b5b6b' } }]
    };
    safeChart('chartLowScore', scoreOpt, scoreItems);
  }

  /* ─────────────── 明日接力推荐（连板 / 反包板） ─────────────── */
  function relayLevelCls(l) {
    return l === '重点接力' ? 'recommend' : (l === '条件接力' ? 'watch' : 'no');
  }

  function renderRelay(d) {
    const relay = d.relay || { list: [], summary: {} };
    const rows = relay.list || [], sm = relay.summary || {}, m = d.meta;
    const lv = sm.levels || {};
    const cats = [
      ['全部', rows.length],
      ['连板接力', rows.filter(x => x.category === '连板接力').length],
      ['反包接力', rows.filter(x => x.category === '反包接力').length]
    ];

    const head = '<thead><tr><th class="left">代码 / 名称</th><th class="left">类别</th><th>连板</th><th>现价</th><th>涨跌幅</th><th>流通市值</th><th class="left">题材 / 阶段</th><th class="left">板块地位</th><th>封单/流通</th><th>评分</th><th class="left">接力结论</th><th class="left">接力方式</th></tr></thead>';
    const body = rows.map((x, i) => {
      const parts = (x.scoreParts || []).map(p =>
        '<div class="sp"><span class="spn">' + E(p.factor) + '</span><div class="spb"><div class="spf" style="width:' + (p.max ? Math.max(0, Math.min(100, p.got / p.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(p.got) + '/' + E(p.max) + '</span></div>'
      ).join('');
      const ev = x.reverse && x.reverse.evidence ? x.reverse.evidence : null;
      const revHtml = x.reverse && x.reverse.isReverse
        ? '<div class="lb-sub"><h5>反包结构证据（' + E(m.klineSource || '腾讯证券日K') + ' + 东财涨停池统计）</h5>' +
          '<div class="kv"><span class="k">反包类型</span><span class="v">' + tag(x.reverse.type, 'purple') + ' ' + E(x.reverse.strength) + '</span></div>' +
          '<div class="kv"><span class="k">前一日 ' + E(ev && ev.prevDate) + '</span><span class="v">开 ' + N(ev && ev.prevOpen) + ' / 收 ' + N(ev && ev.prevClose) + ' / 高 ' + N(ev && ev.prevHigh) + '，涨跌 ' + N(ev && ev.prevPct, 1) + '%</span></div>' +
          '<div class="kv"><span class="k">形态数据</span><span class="v">收阴 ' + (ev && ev.prevYin ? '是' : '否') + ' · 上影 ' + N(ev && ev.prevUpperShadow, 1) + '% · 今日涨幅 ' + N(ev && ev.todayPct, 1) + '%</span></div>' +
          '<div class="kv"><span class="k">反包幅度 / 量能</span><span class="v">' + E(x.reverse.coverLabel) + ' ' + N(x.reverse.strengthPct, 1) + '% · 量能 ' + N(x.reverse.volConfirm) + ' 倍 · 近期涨停 ' + E(ev && ev.recentLimitStat) + '</span></div>' +
          '<div class="note-box">' + E(x.reverse.note) + '</div></div>'
        : '';
      const t = x.technical;
      const techHtml = t ? '<div class="lb-sub"><h5>技术位与量价</h5>' +
        '<div class="kv"><span class="k">交易位置</span><span class="v">' + E(t.position) + '，偏离MA5 ' + N(t.devMA5, 1) + '%</span></div>' +
        '<div class="kv"><span class="k">均线</span><span class="v">MA5 ' + N(t.ma5) + ' / MA10 ' + N(t.ma10) + ' / MA20 ' + N(t.ma20) + '</span></div>' +
        '<div class="kv"><span class="k">RSI14 / 量能</span><span class="v">' + E(t.rsi14) + ' / ' + N(t.volSurge) + ' 倍</span></div></div>' : '';
      const a = x.anchors || {};
      const anchorHtml = '<div class="lb-sub"><h5>次日关键观察锚点</h5>' +
        '<div class="kv"><span class="k">今日涨停价</span><span class="v">' + N(a.todayLimitUp) + '</span></div>' +
        '<div class="kv"><span class="k">今日均价 / MA5</span><span class="v">' + N(a.avgPrice) + ' / ' + N(a.ma5) + '</span></div>' +
        '<div class="kv"><span class="k">竞价观察区间</span><span class="v">' + (a.auctionZone ? a.auctionZone[0] + ' — ' + a.auctionZone[1] : '—') + '</span></div>' +
        '<div class="note-box">竞价区间为按今日收盘价 ±2% 的规则测算，不是价格预测；实际以次日集合竞价与交易所行情为准。</div></div>';
      const peers = (x.peers || []).length
        ? '<div class="lb-sub"><h5>同题材卡位竞争</h5>' + x.peers.map(p => '<div class="kv"><span class="k">' + boardBadge(p.code) + E(p.name) + '(' + E(p.code) + ')</span><span class="v">' + E(p.boards) + ' 板</span></div>').join('') + '</div>'
        : '';
      const detail = '<div class="grid2" style="gap:14px"><div>' +
        '<div class="lb-sub"><h5>接力评分拆解（' + E(x.relayScore) + ' / 100）</h5><div class="score-parts">' + parts + '</div>' +
        (x.veto && x.veto.length ? '<div class="veto"><b>一票否决：</b>' + x.veto.map(E).join('；') + '</div>' : '') + '</div>' +
        revHtml + techHtml + '</div><div>' + anchorHtml + peers +
        '<div class="lb-sub purple"><h5>晋级条件与失效条件</h5>' +
        '<div class="note-box"><b>晋级：</b>' + E(x.ladderNote) + '</div>' +
        '<ul class="tight">' + (x.invalidate || []).map(z => '<li>' + E(z) + '</li>').join('') + '</ul></div></div></div>';

      return '<tr class="clickable" data-cat="' + E(x.category) + '" data-relay="' + E(x.code) + '">' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') + '</td>' +
        '<td class="left">' + tag(x.category, x.reverse && x.reverse.isReverse ? 'purple' : 'blue') + '</td>' +
        '<td><b class="up">' + E(x.boards) + '</b></td>' +
        '<td class="' + flashCls(x.code, x.price) + '">' + N(x.price) + '</td>' +
        '<td>' + PC(x.pct) + '</td><td>' + CAP(x.floatCap) + '</td>' +
        '<td class="left">' + E(x.theme ? x.theme.name : (x.industry || '—')) + (x.theme ? ' <span class="mini-tag">' + E(x.theme.stage) + '</span>' : '') + '</td>' +
        '<td class="left">' + E(x.role.role) + '</td>' +
        '<td>' + (x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : N(x.sealFundRatio) + '%') + '</td>' +
        '<td><b class="' + (x.relayScore >= 72 ? 'up' : '') + '">' + E(x.relayScore) + '</b></td>' +
        '<td class="left"><span class="verdict ' + relayLevelCls(x.level) + '">' + E(x.level) + '</span></td>' +
        '<td class="left">' + E(x.method.method) + '</td></tr>' +
        '<tr class="detail-row" data-cat-detail="' + E(x.category) + '" id="relayDetail_' + E(x.code) + '" style="display:' + (S.expanded.has('relay_' + x.code) ? '' : 'none') + '"><td colspan="12">' + detail + '</td></tr>';
    }).join('');

    $('pane-relay').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>连板 / 反包板 · 明日接力候选</h3>' + src('东方财富涨停池（连板数/封单/首封/行业）+ ' + E(m.klineSource || '腾讯证券日K') + '（反包识别），交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="conclusion card" style="margin-bottom:12px;border-left-color:var(--purple)"><div class="lead">从当日涨停池中筛出连板股与「前日走弱、今日涨停收复」的反包板，按梯队高度、题材阶段、板块地位、封板质量、量价与大盘环境六维打分，给出明日接力分层、接力方式与失效条件。反包判定完全基于日K真实 OHLCV，不使用资讯。</div>' +
      '<div class="tags">' + tag('候选 ' + (sm.total || 0) + ' 只', 'purple') + tag('连板 ' + (sm.connected || 0), 'blue') + tag('反包 ' + (sm.reverse || 0), 'purple') +
      tag('重点 ' + (lv['重点接力'] || 0), 'red') + tag('条件 ' + (lv['条件接力'] || 0), 'warn') + tag('观察 ' + (lv['观察'] || 0), '') + tag('回避 ' + (lv['回避'] || 0), 'green') + '</div>' +
      '<div class="small muted" style="margin-top:7px">' + ((lv['回避'] || 0) > rows.length / 2 ? '当前「回避」占比过半：主要由市场处于防守/退潮档、高位连板否决与题材预期偏弱触发，属风控结果而非数据缺失。' : '分层由六维评分与一票否决项共同决定，弱市下条件会显著收紧。') + '</div>' +
      ((sm.klineMissing || 0) > 0 ? '<div class="veto" style="margin-top:8px"><b>数据不完整提示</b>：' + E(sm.klineMissing) + ' 只首板股的日K数据缺失，无法判定是否反包，本次反包候选可能偏少。系统已自动尝试备用日K源，稍后刷新会重试；此处不把「数据缺失」伪装成「没有反包」。</div>' : '') +
      '</div>' +
      '<div class="card pad" style="margin-bottom:12px"><div class="sec-head"><h3 style="font-size:12.5px">接力评分对比 Top10</h3></div><div id="chartRelayScore" class="chart"></div></div>' +
      '<div class="relay-cats" id="relayCats">' + cats.map((c, i) => '<button class="chip' + (i === 0 ? ' active' : '') + '" data-cat="' + E(c[0]) + '">' + E(c[0]) + ' ' + c[1] + '</button>').join('') + '</div>' +
      '<div class="tbl-wrap"><table>' + head + '<tbody>' + (body || '<tr><td colspan="12" class="empty">当前筛选条件下无接力候选</td></tr>') + '</tbody></table></div></div>' +
      '<div class="disclaimer" style="margin-top:14px"><strong>风险提示</strong>：连板与反包接力属于高波动博弈，高位股次日开盘高度易被一致性压制；所有分层与「接力方式」为量化研究框架，不是买卖指令。竞价区间为规则测算，非价格预测。</div>';

    $('pane-relay').querySelectorAll('tr[data-relay]').forEach(tr => {
      tr.onclick = () => {
        const key = 'relay_' + tr.dataset.relay, el = $('relayDetail_' + tr.dataset.relay);
        if (!el) return;
        if (el.style.display === 'none') { el.style.display = ''; S.expanded.add(key); }
        else { el.style.display = 'none'; S.expanded.delete(key); }
      };
    });
    $('relayCats').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      [...$('relayCats').children].forEach(c => c.classList.toggle('active', c === b));
      const cat = b.dataset.cat;
      $('pane-relay').querySelectorAll('tr[data-cat]').forEach(tr => {
        tr.style.display = (cat === '全部' || tr.dataset.cat === cat) ? '' : 'none';
      });
      $('pane-relay').querySelectorAll('tr[data-cat-detail]').forEach(tr => {
        const code = tr.id.replace('relayDetail_', '');
        const match = cat === '全部' || tr.dataset.catDetail === cat;
        tr.style.display = (match && S.expanded.has('relay_' + code)) ? '' : 'none';
      });
    };

    const top = rows.slice(0, 10).map(x => ({ name: boardText(x.code) + x.name + '(' + x.code + ')', value: x.relayScore, label: x.relayScore }));
    const opt = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 130, right: 40, top: 10, bottom: 24 },
      xAxis: { type: 'value', max: 100, ...AXIS },
      yAxis: { type: 'category', data: top.map(x => x.name).reverse(), ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 14, data: top.map(x => x.value).reverse().map(v => ({ value: v, itemStyle: { color: v >= 72 ? '#d92b2b' : (v >= 58 ? '#d97706' : '#94a3b8') } })), label: { show: true, position: 'right', fontSize: 10, color: '#4b5b6b' } }]
    };
    safeChart('chartRelayScore', opt, top);
  }

  /* ─────────────── AI 分析推荐 ─────────────── */
  function mdLite(t) {
    return String(t || '').split('\n').map(l => {
      const s = E(l);
      if (/^#{1,4}\s/.test(s)) return '<h4 class="md-h">' + s.replace(/^#{1,4}\s/, '') + '</h4>';
      if (/^[-*]\s/.test(s)) return '<div class="md-li">• ' + s.replace(/^[-*]\s/, '') + '</div>';
      if (!s.trim()) return '<div class="md-br"></div>';
      return '<div class="md-p">' + s + '</div>';
    }).join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  function renderAI(d) {
    const ai = d.ai || {}, m = d.meta;
    const configured = !!m.aiConfigured;
    // 定时刷新不得覆盖正在填写的配置（尤其 API Key 服务端从不回传）
    const oldBase = $('aiBase') ? $('aiBase').value : '';
    const oldKey = $('aiKey') ? $('aiKey').value : '';
    const oldModel = $('aiModel') ? $('aiModel').value : '';
    const sections = (ai.sections || []).map(s =>
      '<div class="info-card"><h4>' + E(s.title) + '</h4><p>' + E(s.body) + '</p>' +
      '<div class="small muted" style="margin-top:7px">依据：' + E((s.basis || []).join('、')) + '</div></div>'
    ).join('');
    const topRows = (ai.topPicks || []).map((x, i) =>
      '<tr><td class="left"><b>' + (i + 1) + '</b></td><td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') + '</td>' +
      '<td>' + N(x.price) + '</td><td>' + PC(x.pct) + '</td><td>' + CAP(x.floatCap) + '</td>' +
      '<td>' + E(x.resonance) + '</td><td><b class="' + (x.composite >= 70 ? 'up' : '') + '">' + E(x.composite) + '</b></td>' +
      '<td class="left">' + (x.modules || []).map(z => tag(z, 'blue')).join(' ') + '</td>' +
      '<td class="left small">' + E((x.notes || []).slice(0, 2).join(' ')) + '</td>' +
      '<td>' + E((x.risks || []).length) + '</td></tr>'
    ).join('');

    $('pane-ai').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>AI 分析推荐</h3><span class="src">默认：本地量化研判引擎 · 可选：OpenAI 兼容大模型</span></div>' +
      '<div class="ai-mode card"><div><div class="ai-mode-title">' + tag(configured ? '大模型增强已启用' : '本地量化研判引擎', configured ? 'purple' : 'blue') +
      ' <span class="muted small">' + E(ai.modeLabel || '规则生成，可追溯') + '</span></div>' +
      '<div class="small muted" style="margin-top:6px">本地模式：由确定性规则引擎基于实时行情生成，每个数字可追溯到具体字段，不假装是 AI 大模型输出。配置大模型后，可额外生成一段基于同一份真实数据摘要的深度研判文本。</div></div>' +
      '<div class="ai-mode-actions"><button id="btnAiCfg" class="btn">' + (S.aiCfgOpen ? '收起配置' : '配置大模型') + '</button>' +
      '<button id="btnAiGen" class="btn btn-primary"' + (configured ? '' : ' disabled title="请先配置大模型"') + '>生成大模型研判</button></div></div>' +

      '<div class="card pad ai-config" id="aiConfigPanel" style="display:' + (S.aiCfgOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:12.5px;margin-bottom:8px">OpenAI 兼容接口配置</h4>' +
      '<div class="ai-form"><label>接口地址 <input type="text" id="aiBase" placeholder="https://api.openai.com/v1" value="' + E(oldBase || m.aiBase || 'https://api.openai.com/v1') + '"></label>' +
      '<label>API Key <input type="password" id="aiKey" placeholder="sk-...（仅存服务端内存）" value="' + E(oldKey) + '"></label>' +
      '<label>模型名 <input type="text" id="aiModel" placeholder="gpt-4o-mini" value="' + E(oldModel || m.aiModel || 'gpt-4o-mini') + '"></label></div>' +
      '<div class="ai-form-actions"><button id="btnAiSave" class="btn btn-primary">保存配置</button><button id="btnAiClear" class="btn">清除并回到本地模式</button>' +
      '<span class="small muted">密钥只保存在本进程内存，不写入任何文件、不出现在日志与接口响应中；服务重启后需重新填写。</span></div></div>' +

      '<div id="aiGenHint" class="small muted" style="margin:10px 0">' + (configured ? '已配置模型 ' + E(m.aiModel || '—') + '，点击「生成大模型研判」调用。' : '未配置大模型，以下为本地量化研判引擎结果。') + '</div>' +
      '<div class="card pad" id="aiOutputBox" style="display:' + (S.aiText ? '' : 'none') + '"><div class="sec-head"><h3 style="font-size:12.5px">' + tag('大模型生成', 'purple') + ' 深度研判</h3><span class="src" id="aiOutputTime">' + E(S.aiTextTime || '') + '</span></div>' +
      '<div class="ai-output" id="aiOutput">' + (S.aiText ? mdLite(S.aiText) : '') + '</div>' +
      '<div class="note-box">以上为大模型基于本页真实行情摘要生成的文本，可能包含不准确内容，请以数据表格与交易所公告为准；不构成投资建议。</div></div>' +

      '<div class="conclusion card" style="margin:14px 0;border-left-color:var(--blue2)"><div class="lead">' + E(ai.headline || '—') + '</div>' +
      '<div class="tags">' + tag('跨模块 Top ' + (ai.topPicks || []).length, 'blue') + tag('共振 ' + (ai.topPicks || []).filter(x => x.resonance >= 2).length + ' 只', 'purple') + tag((m.poolDate || '—'), '') + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>结构化研判</h3>' + src('本地量化研判引擎，基于六模块真实数据') + '</div><div class="grid2">' + sections + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>跨模块综合推荐榜</h3><span class="src">短线推荐 / 连板低吸 / 明日接力三池按代码合并；先按覆盖模块数（共振）降序、同档按综合分排序；综合分 = 各模块评分均值 + 共振加成（每多一模块 +4）</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">#</th><th class="left">代码 / 名称</th><th>现价</th><th>涨跌幅</th><th>流通市值</th><th>覆盖模块</th><th>综合分</th><th class="left">模块</th><th class="left">结论摘要</th><th>风险项</th></tr></thead><tbody>' +
      (topRows || '<tr><td colspan="10" class="empty">当前无跨模块候选</td></tr>') + '</tbody></table></div></div>' +

      '<div class="sec"><div class="grid2"><div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">风险清单</h4><ul class="tight">' + (ai.riskAlerts || []).map(E).map(z => '<li>' + z + '</li>').join('') + '</ul></div>' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">明日观察清单</h4><ul class="tight">' + (ai.watchList || []).map(E).map(z => '<li>' + z + '</li>').join('') + '</ul></div></div></div>' +

      '<div class="note-box" style="margin-top:12px"><b>数据溯源：</b>' + E(ai.sourceNote || '—') + '<br><b>能力边界：</b>' + E(ai.caveat || '—') + '</div></div>';

    $('btnAiCfg').onclick = () => { S.aiCfgOpen = !S.aiCfgOpen; renderAI(d); };
    $('btnAiSave').onclick = async () => {
      const payload = {
        baseUrl: $('aiBase').value.trim(), apiKey: $('aiKey').value.trim(), model: $('aiModel').value.trim()
      };
      try {
        const j = await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
        if (j.error) { $('aiGenHint').textContent = '配置失败：' + j.error; return; }
        S.aiCfgOpen = false;
        await refresh(true);
      } catch (e) { $('aiGenHint').textContent = '配置失败：' + e.message; }
    };
    $('btnAiClear').onclick = async () => {
      await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }).then(r => r.json()).catch(() => ({}));
      S.aiCfgOpen = false; S.aiText = ''; S.aiTextTime = '';
      await refresh(true);
    };
    $('btnAiGen').onclick = async () => {
      const btn = $('btnAiGen'), hint = $('aiGenHint');
      btn.disabled = true; btn.textContent = '生成中…'; hint.textContent = '正在调用大模型（最长 45 秒）…';
      try {
        const r = await fetch('/api/ai/analyze', { method: 'POST' });
        const j = await r.json();
        if (j.error) { hint.textContent = j.error + ' 已保留本地研判结果。'; }
        else {
          S.aiText = j.text; S.aiTextTime = '模型 ' + E(j.model) + ' · ' + E(j.generatedAt);
          $('aiOutputBox').style.display = '';
          $('aiOutputTime').textContent = S.aiTextTime;
          $('aiOutput').innerHTML = mdLite(S.aiText);
          hint.textContent = '生成完成（基于交易日 ' + E(j.basedOn && j.basedOn.poolDate) + ' 的真实行情摘要）。';
        }
      } catch (e) { hint.textContent = '调用失败：' + e.message + ' 已保留本地研判结果。'; }
      finally { btn.disabled = !m.aiConfigured; btn.textContent = '生成大模型研判'; }
    };
  }

  /* ─────────────── 涨停回踩支撑（K线图 + 划线解释） ─────────────── */
  function pbLevelClass(l) {
    return l === '重点观察' ? 'recommend' : l === '条件观察' ? 'watch' : l === '已失效' ? 'no' : 'plain';
  }
  function pbStatusTag(s) {
    return tag(s, s === '已回踩到位' ? 'red' : s === '接近支撑' ? 'warn' : s === '跌破支撑' ? 'green' : '');
  }
  const pbKv = (k, v) => '<div class="pb-kv"><span>' + E(k) + '</span><b>' + v + '</b></div>';

  /* ─────────── 历史回溯 · 成功率验证 ─────────── */
  const btDateLabel = d => String(d || '').length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : String(d || '—');
  const btPct = v => (v === null || v === undefined) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  const btKpi = (label, value, sub, cls) =>
    '<div class="bt-kpi"><span class="lbl">' + E(label) + '</span><b class="' + (cls || '') + '">' + value + '</b>' +
    '<span class="small muted">' + E(sub || '') + '</span></div>';
  const btLevelCls = l => l === '重点观察' ? 'red' : l === '条件观察' ? 'warn' : l === '已失效' ? 'green' : '';
  const btResultTag = r => '<span class="bt-result ' +
    (r === '达标' ? 'up' : r === '止损' ? 'down' : r === '观察中' ? 'blue' : '') + '">' + E(r || '—') + '</span>';

  function btTrendSvg(days) {
    if (!days || !days.length) return '';
    const W = 700, H = 152, L = 26, R = 8, T = 18, B = 36;
    const n = days.length, gap = (W - L - R) / n, bw = Math.min(50, gap - 10);
    const hOf = v => (H - T - B) * (Number(v) || 0) / 100;
    const y50 = H - B - hOf(50);
    const bars = days.map((d, i) => {
      const x = L + i * gap + (gap - bw) / 2;
      const rate = d.winRate;
      const h = rate === null ? 5 : Math.max(2, hOf(rate));
      const y = H - B - h;
      const fill = rate === null ? '#cbd5e1' : rate >= 60 ? '#d92b2b' : rate >= 40 ? '#d97706' : '#0f9960';
      const tip = btDateLabel(d.date) + '：成功率 ' + (rate === null ? '观察中' : rate + '%') +
        '，已完结 ' + d.completed + ' / 样本 ' + d.total;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="3" fill="' + fill + '" opacity="' + (rate === null ? '.5' : '.88') + '"><title>' + E(tip) + '</title></rect>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" font-size="10" fill="#4b5b6b">' +
        (rate === null ? '—' : rate + '%') + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - B + 14) + '" text-anchor="middle" font-size="9.5" fill="#8593a3">' + E(btDateLabel(d.date)) + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - B + 26) + '" text-anchor="middle" font-size="9" fill="#8593a3">n=' + E(d.completed) + '</text>';
    }).join('');
    return '<div class="bt-trend"><div class="bt-h5">近 ' + n + ' 个基准日成功率趋势（柱高为成功率，n 为已完结样本数）</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="152" role="img" aria-label="每日成功率柱状图">' +
      '<line x1="' + L + '" y1="' + y50.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y50.toFixed(1) +
      '" stroke="#e4e9f0" stroke-dasharray="4 4"/>' +
      '<text x="2" y="' + (y50 + 3).toFixed(1) + '" font-size="9" fill="#8593a3">50%</text>' + bars + '</svg></div>';
  }

  function btCardInner() {
    const head = '<div class="bt-head"><div><h4>历史回溯 · 成功率验证</h4>' +
      '<div class="small muted">选一个过去的交易日，用当时可见的日K重跑划线规则，再用之后 N 根真实K线检验「目标 / 止损」是否兑现。</div></div>' +
      '<button class="btn" id="btToggle">' + (S.btOpen ? '收起' : '展开回溯近 10 日') + '</button></div>';
    if (!S.btOpen) return head;

    const j = S.bt;
    const dates = (j && j.meta && j.meta.baseDates) || [];
    const dateOpts = ['<option value="all"' + (S.btDate === 'all' ? ' selected' : '') + '>近 ' + (dates.length || 10) + ' 日汇总</option>']
      .concat(dates.map(d => '<option value="' + E(d) + '"' + (S.btDate === d ? ' selected' : '') + '>' + E(btDateLabel(d)) + ' 基准日</option>')).join('');
    const winOpts = [3, 5, 10].map(w => '<option value="' + w + '"' + (S.btWindow === w ? ' selected' : '') + '>' + w + ' 个交易日</option>').join('');
    const controls = '<div class="bt-controls"><label>基准日 <select class="sel" id="btDate">' + dateOpts + '</select></label>' +
      '<label>观察窗口 <select class="sel" id="btWindow">' + winOpts + '</select></label>' +
      '<button class="btn" id="btReload">重新计算</button>' +
      '<button class="link-btn" id="btMethod">' + (S.btMethodOpen ? '收起' : '查看') + '口径说明</button></div>';

    if (S.btLoading) return head + controls + '<div class="bt-state">正在回溯近 10 个交易日、逐只核对真实日K并判定结果…（首次约需数秒）</div>';
    if (S.btError) return head + controls + '<div class="bt-state err">' +
      (isConnError(new Error(S.btError)) && /Failed to fetch|fetch failed|NetworkError/i.test(S.btError)
        ? '无法连接本地服务：' + E(SERVICE_HINT)
        : '历史回溯失败：' + E(S.btError)) +
      '<br><span class="small muted">系统不会用推测数据填充统计。</span></div>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" id="btRetry">重新回溯</button></div>';
    if (!j) return head + controls + '<div class="bt-state">点击「重新计算」开始回溯。</div>';

    const m = j.meta || {};
    const sum = S.btDate === 'all' ? (j.summary || {}) : (j.days || []).find(d => d.date === S.btDate) || {};
    const rows = S.btDate === 'all' ? (j.rows || []) : (j.rows || []).filter(r => r.date === S.btDate);
    const done = sum.completed || 0;
    const warn = '<div class="bt-warn"><b>口径提醒</b>：这是「触及型」判定（目标通常仅 +2%~+8%，止损约 −3%），成功率天然偏高，' +
      '<b>不等于真实交易胜率</b>；请同时看平均收益与止损率。同一标的会在多个基准日重复出现，样本不独立。</div>';
    const fb = m.fallback ? '<div class="pb-warn">口径提示：腾讯前复权日K当前不可用，本轮回测已降级为「新浪财经日K（不复权）」；除权个股历史价位可能与前复权不一致。</div>' : '';
    const kpis = '<div class="bt-kpi-grid">' +
      btKpi('已完结样本', E(done), '总样本 ' + E(sum.total || 0) + ' 个') +
      btKpi('成功率', (sum.winRate === null || sum.winRate === undefined) ? '—' : sum.winRate + '%', '达标 ' + E(sum.success || 0) + ' 个', 'up') +
      btKpi('止损率', (sum.stopRate === null || sum.stopRate === undefined) ? '—' : sum.stopRate + '%', '止损 ' + E(sum.stopped || 0) + ' 个', 'down') +
      btKpi('平均收益', btPct(sum.avgReturn), '单笔最好 ' + btPct(sum.best) + ' / 最差 ' + btPct(sum.worst), (sum.avgReturn > 0 ? 'up' : sum.avgReturn < 0 ? 'down' : '')) +
      btKpi('观察中', E(sum.watching || 0), '窗口未走完，不计入分母') +
      btKpi('未触发', E(sum.timeout || 0), '窗口内未触及目标/止损') +
      '</div>';

    const levels = Object.keys(sum.byLevel || {}).map(k => {
      const v = sum.byLevel[k];
      return '<tr><td>' + tag(k, btLevelCls(k)) + '</td><td>' + E(v.total) + '</td><td>' + E(v.completed) + '</td>' +
        '<td><b>' + (v.winRate === null ? '—' : v.winRate + '%') + '</b></td><td>' + btPct(v.avgReturn) + '</td>' +
        '<td>' + E(v.stopped) + '</td></tr>';
    }).join('');
    const levelTbl = '<div class="bt-block"><div class="bt-h5">按结论档位分组（可检验评分档位是否真有区分度）</div>' +
      '<div class="tbl-wrap"><table class="tbl bt-tbl"><thead><tr><th>档位</th><th>样本</th><th>已完结</th><th>成功率</th><th>平均收益</th><th>止损数</th></tr></thead>' +
      '<tbody>' + (levels || '<tr><td colspan="6" class="muted">无样本</td></tr>') + '</tbody></table></div></div>';

    const detail = rows.slice(0, 100).map(r => {
      const o = r.outcome || {};
      return '<tr><td>' + E(btDateLabel(r.date)) + '</td>' +
        '<td><b>' + sn(r.code, r.name) + '</b><br><span class="code">' + E(r.code) + '</span></td>' +
        '<td>' + tag(r.level, btLevelCls(r.level)) + '</td><td>' + E(r.score) + '</td>' +
        '<td>' + N(o.entry) + '</td><td>' + N(o.target) + '</td><td>' + N(o.stop) + '</td>' +
        '<td class="small">' + (o.windowHigh === null || o.windowHigh === undefined ? '—' : N(o.windowHigh) + ' / ' + N(o.windowLow)) + '</td>' +
        '<td>' + btResultTag(o.result) + (o.hitDay ? '<span class="small muted"> 第' + E(o.hitDay) + '日</span>' : '') + '</td>' +
        '<td>' + PC(o.returnPct) + '</td><td class="small">' + E(r.klineSource || '—') + '</td></tr>';
    }).join('');
    const detailTbl = '<div class="bt-block"><div class="bt-h5">逐只明细（' + E(rows.length) + ' 条' +
      (rows.length > 100 ? '，仅显示前 100 条' : '') + '）</div>' +
      '<div class="tbl-wrap bt-detail"><table class="tbl bt-tbl"><thead><tr>' +
      '<th>基准日</th><th>标的</th><th>档位</th><th>评分</th><th>基准价</th><th>目标</th><th>止损</th>' +
      '<th>后续高/低</th><th>结果</th><th>收益</th><th>日K口径</th></tr></thead><tbody>' +
      (detail || '<tr><td colspan="11" class="muted">该基准日没有可判定的样本（上游数据不足或全部被规则过滤）</td></tr>') +
      '</tbody></table></div></div>';

    const meth = (j.methodology || {});
    const method = '<div class="bt-method" style="display:' + (S.btMethodOpen ? '' : 'none') + '">' +
      (meth.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(meth.caveat || '') + '</div></div>';
    const skips = Object.keys(m.skipped || {}).map(k => E(k) + ' ' + E(m.skipped[k])).join('；') || '无';
    const trace = '<div class="bt-trace small muted">' +
      '历史涨停池：' + E((m.historyRange || []).join(' ~ ')) + '（' + E(m.historyDays) + ' 个交易日，仅可回溯约 15 日）· ' +
      '计划组合 ' + E(m.plannedCount) + ' 个 → 去重 ' + E(m.codesRequested) + ' 只 → 日K成功 ' + E(m.klineOk) + ' 只 · ' +
      '日K口径：' + E((m.klineSources || []).join(' / ') || '未取得') + ' · 服务端耗时 ' + E(m.elapsedMs) + ' ms<br>' +
      '被规则跳过：' + skips + '<br>' + E(m.dataSourceNote || '') +
      '<br>以上为历史回放，不构成投资建议；市场有风险，投资需谨慎。</div>';

    return head + controls + warn + fb + kpis + btTrendSvg(j.days) + levelTbl + detailTbl +
      '<button class="link-btn" id="btMethod2" style="margin-top:8px">' + (S.btMethodOpen ? '收起' : '查看') + '口径说明</button>' +
      method + trace;
  }

  function refreshBtCard() {
    if ($('btCard')) $('btCard').innerHTML = btCardInner();
    if ($('btToggle')) $('btToggle').onclick = () => { S.btOpen = !S.btOpen; refreshBtCard(); };
    if ($('btDate')) $('btDate').onchange = e => { S.btDate = e.target.value; refreshBtCard(); };
    if ($('btWindow')) $('btWindow').onchange = e => { S.btWindow = Number(e.target.value); loadBacktest(false); };
    if ($('btReload')) $('btReload').onclick = () => loadBacktest(true);
    if ($('btRetry')) $('btRetry').onclick = () => loadBacktest(true);
    if ($('btMethod')) $('btMethod').onclick = () => { S.btMethodOpen = !S.btMethodOpen; refreshBtCard(); };
    if ($('btMethod2')) $('btMethod2').onclick = () => { S.btMethodOpen = !S.btMethodOpen; refreshBtCard(); };
    if (S.btOpen && !S.bt && !S.btLoading && !S.btError) loadBacktest(false);
  }

  async function loadBacktest(force) {
    if (S.btLoading) return;
    S.btLoading = true; S.btError = null;
    refreshBtCard();
    const q = new URLSearchParams({ window: String(S.btWindow), days: '10' });
    if (force) q.set('force', '1');
    let j = null, lastErr = null;
    try {
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch('/api/backtest?' + q.toString(), { cache: 'no-store' });
          let data;
          try { data = await r.json(); }
          catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
          if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
          j = data; break;
        } catch (e) {
          lastErr = e;
          if (!isConnError(e) || i === 2) break;
          await new Promise(res => setTimeout(res, 1000 + i * 1200));
        }
      }
      if (!j) throw lastErr || new Error('未知错误');
      S.bt = j;
      if (S.btDate !== 'all' && !(j.meta.baseDates || []).includes(S.btDate)) S.btDate = 'all';
    } catch (e) { S.btError = e.message; }
    finally { S.btLoading = false; refreshBtCard(); }
  }

  /* 连接级失败（例如服务正在重启）自动重试；服务端 / 上游错误立即返回，不重复打上游 */
  async function fetchPullbackJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/pullback?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '），请确认访问的是本系统地址'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        if (!S.pull) $('pane-pullback').innerHTML = '<div class="card empty">本地服务未响应，正在重连…（第 ' + (i + 1) + ' 次）</div>';
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  /* 服务离线期间每 3 秒探测健康接口，恢复后自动重新扫描，无需手动刷新页面 */
  function watchService(kind) {
    clearTimeout(S.pullOfflineTimer);
    const probe = async () => {
      try {
        const h = await fetch('/api/health?_=' + Date.now(), { cache: 'no-store' });
        if (h.ok) {
          S.pullOfflineTimer = null;
          if (kind === 'dragon') loadDragon(false); else loadPullback(false);
          return;
        }
      } catch (_) { /* 服务尚未就绪，继续探测 */ }
      S.pullOfflineTimer = setTimeout(probe, 3000);
    };
    S.pullOfflineTimer = setTimeout(probe, 3000);
  }

  async function loadPullback(force) {
    if (S.pullLoading) return;
    S.pullLoading = true;
    if (!S.pull) $('pane-pullback').innerHTML = '<div class="card empty">正在回溯近期涨停股、逐只核对真实日K并计算支撑压力位…</div>';
    const f = collectFilters();
    const q = new URLSearchParams();
    ['board', 'capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'excludeST', 'keyword', 'sector', 'sort', 'limit']
      .forEach(k => { if (f[k] !== '' && f[k] !== undefined) q.set(k, f[k]); });
    q.set('days', String(S.pullDays));
    if (force) q.set('force', '1');
    try {
      const j = await fetchPullbackJson(q);
      clearTimeout(S.pullOfflineTimer); S.pullOfflineTimer = null;
      S.pull = j; S.pullAt = Date.now(); S.pullFilters = describeFilters(f); S.pullError = null;
      const list = j.list || [];
      if (!list.some(x => x.code === S.pullSelected)) S.pullSelected = list.length ? list[0].code : null;
      renderPullback();
      $('badgePull').textContent = list.length;
    } catch (e) {
      const conn = isConnError(e);
      S.pullError = e.message;
      S.pullAt = Date.now();   // 失败后防抖，避免自动刷新每 15 秒重复打上游
      $('pane-pullback').innerHTML =
        '<div class="card empty">' + (conn ? '无法连接本地服务' : '划线数据加载失败') + '：' + E(e.message) +
        '<br><span class="small muted">' + E(conn
          ? SERVICE_HINT + ' 服务恢复后页面会自动重新扫描，也可点击「重新扫描」立即重试；系统不会用推测数据填充列表。'
          : '可点击「重新扫描」重试；上游接口临时不可用时，系统不会填充任何推测数据。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="pbRetry">重新扫描</button></div>';
      if ($('pbRetry')) $('pbRetry').onclick = () => loadPullback(true);
      if (conn) watchService();
    } finally { S.pullLoading = false; }
  }

  function renderPullback() {
    const j = S.pull; if (!j) return;
    const m = j.meta || {}, s = j.summary || {}, list = j.list || [], meth = j.methodology || {};
    const lvl = s.levels || {};
    const dates = (s.historyDates || []).map(d => d.date).join('、');
    const warn = /降级|不复权/.test(m.klineNote || '')
      ? '<div class="pb-warn">口径提示：' + E(m.klineNote) + '</div>' : '';
    const head =
      '<div class="conclusion card pb-head"><div class="lead">扫描近 ' + (s.historyDates || []).length + ' 个交易日的 ' + E(s.historyCount) +
      ' 只涨停股，核对真实日K后得到 <b>' + E(s.analyzedCount) + '</b> 只回调结构标的，其中 <b>' + E(s.nearCount) + '</b> 只已回踩或接近支撑位。</div>' +
      '<div class="tags">' +
      tag('重点观察 ' + (lvl['重点观察'] || 0), 'red') + tag('条件观察 ' + (lvl['条件观察'] || 0), 'warn') +
      tag('仅跟踪 ' + (lvl['仅跟踪'] || 0), '') + tag('已失效 ' + (lvl['已失效'] || 0), 'green') +
      tag('市场档位：' + (m.marketTier || '—'), 'blue') + tag('情绪：' + (m.marketEmotion || '—'), 'blue') + '</div></div>';

    const source =
      '<div class="card pad pb-source">' +
      '<div>候选来源：东方财富涨停池（' + E(dates || '—') + '，共 ' + E(s.historyCount) + ' 只）· 实时快照：腾讯证券 ' + E(m.quoteTick || '—') +
      ' · 日K口径：<b>' + E((s.klineSources || []).join(' / ') || '未取得') + '</b></div>' +
      '<div>预筛 ' + E(s.preselectCount) + ' 只 → 取 ' + E(s.scannedCount) + ' 只拉日K（成功 ' + E(s.klineOk) + ' 只）→ 完成划线 ' + E(s.analyzedCount) +
      ' 只 · 服务端耗时 ' + E(m.elapsedMs) + ' ms · 生成时点 ' + E(m.generatedAt) + '</div>' +
      warn +
      '<div class="pb-actions"><button class="btn btn-primary" id="pbRescan">重新扫描</button> ' +
      '<label class="small muted">候选回溯 <select class="sel" id="pbDays">' +
      [8, 10, 15].map(n => '<option value="' + n + '"' + (S.pullDays === n ? ' selected' : '') + '>近 ' + n + ' 个交易日</option>').join('') +
      '</select></label> ' +
      '<button class="btn" id="pbMethod">' + (S.pullMethodOpen ? '收起' : '查看') + '划线口径说明</button> ' +
      '<span class="small muted">本模块应用：市场板块 / 流通市值 / 涨跌幅 / 换手 / 排除ST / 关键字 / 板块筛选；「最低连板数」不适用于回调结构。</span></div></div>';

    const method = '<div class="card pad pb-method" id="pbMethodBox" style="display:' + (S.pullMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">划线口径（先看规则，再看线）</h4>' +
      (meth.steps || []).map(st => '<div class="pb-step"><b>' + E(st.name) + '</b><span>' + E(st.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(meth.caveat || '') + '</div></div>';

    const items = list.map(x =>
      '<div class="pb-item' + (x.code === S.pullSelected ? ' active' : '') + '" data-code="' + E(x.code) + '">' +
      '<div class="pb-item-top"><b>' + sn(x.code, x.name) + '</b><span class="code">' + E(x.code) + '</span>' +
      '<span class="verdict ' + pbLevelClass(x.level) + '">' + E(x.level) + '</span></div>' +
      '<div class="pb-item-mid"><span>现价 <b>' + N(x.price) + '</b></span>' + PC(x.pct) + '<span>评分 <b>' + E(x.score) + '</b></span></div>' +
      '<div class="pb-item-bot"><span>涨停 ' + E(String(x.ztDate).slice(5)) + ' · 回调 ' + E(x.sinceZt) + ' 日</span>' + pbStatusTag(x.status) + '</div>' +
      '<div class="pb-item-sup">主支撑 ' + E(x.primarySupport.short) + ' ' + N(x.primarySupport.price) +
      ' · 距 ' + (x.nearPct > 0 ? '+' : '') + N(x.nearPct, 1) + '%</div></div>'
    ).join('');

    const why = s.analyzedCount
      ? '已完成划线的 ' + E(s.analyzedCount) + ' 只标的均被当前全局筛选条件过滤，请放宽市值 / 涨跌幅 / 换手 / 板块条件。'
      : '可能原因：近期涨停股大多仍在涨停当日或次日窗口内（本模块要求至少 2 根回调K线）、当日仍强势，或上游日K接口临时不可用。';
    const empty = '<div class="card empty pb-empty"><b>当前没有符合条件的回踩标的</b><br><span class="small muted">' + why +
      '系统不会用推测数据填充列表。</span><br><span class="small muted">扫描链路：候选 ' + E(s.historyCount) + ' 只 → 预筛 ' + E(s.preselectCount) +
      ' 只 → 日K成功 ' + E(s.klineOk) + '/' + E(s.scannedCount) + ' 只 → 完成划线 ' + E(s.analyzedCount) + ' 只。</span></div>';

    const body = list.length
      ? '<div class="pb-layout"><div class="pb-list" id="pbList">' + items + '</div><div class="pb-detail" id="pbDetail"></div></div>'
      : empty;
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';

    $('pane-pullback').innerHTML = head + source + '<div class="card pad bt-card" id="btCard"></div>' + method + body + disc;
    refreshBtCard();
    if ($('pbRescan')) $('pbRescan').onclick = () => loadPullback(true);
    if ($('pbDays')) $('pbDays').onchange = e => { S.pullDays = Number(e.target.value); loadPullback(true); };
    if ($('pbMethod')) $('pbMethod').onclick = () => {
      S.pullMethodOpen = !S.pullMethodOpen;
      $('pbMethodBox').style.display = S.pullMethodOpen ? '' : 'none';
      $('pbMethod').textContent = (S.pullMethodOpen ? '收起' : '查看') + '划线口径说明';
    };
    $('pane-pullback').querySelectorAll('.pb-item').forEach(el => {
      el.onclick = () => {
        S.pullSelected = el.dataset.code;
        $('pane-pullback').querySelectorAll('.pb-item').forEach(n => n.classList.toggle('active', n === el));
        renderPullDetail();
      };
    });
    renderPullDetail();
  }

  function renderPullDetail() {
    const j = S.pull; if (!j) return;
    const box = $('pbDetail'); if (!box) return;
    const x = (j.list || []).find(a => a.code === S.pullSelected);
    if (!x) { box.innerHTML = '<div class="card empty">请选择左侧标的查看 K 线图与划线解释</div>'; return; }
    box.innerHTML = detailHead(x) + klineCard(x) + lineExplanations(x) + tradePlanCard(x, j.meta || {});
  }

  function detailHead(x) {
    const ps = x.primarySupport || {}, pr = x.primaryResistance || {};
    return '<div class="card pb-detail-head">' +
      '<div class="pb-dh-top"><span class="lb-name">' + sn(x.code, x.name) + '</span><span class="lb-code">' + E(x.code) + '</span>' +
      tag(x.board || '—', '') + tag(x.industry || '无行业', 'purple') + pbStatusTag(x.status) +
      '<span class="lb-spacer"></span><span class="verdict ' + pbLevelClass(x.level) + '">' + E(x.level) + '</span></div>' +
      '<div class="pb-dh-reason">结论：' + E(x.reason) + '</div>' +
      '<div class="pb-kv-grid">' +
      pbKv('现价 / 涨跌幅', N(x.price) + ' 元　' + PC(x.pct)) +
      pbKv('涨停日 / 回调', E(x.ztDate) + ' · ' + E(x.sinceZt) + ' 个交易日') +
      pbKv('阶段高点 / 回撤', N(x.swingHigh) + '（' + E(String(x.swingHighDate).slice(5)) + '）· −' + N(x.drawdown, 1) + '%') +
      pbKv('起涨低点 / 回撤比例', N(x.swingLow) + ' · 回吐 ' + N(x.retrace, 1) + '%') +
      pbKv('主支撑 / 距现价', E(ps.short) + ' ' + N(ps.price) + ' · ' + (x.nearPct > 0 ? '+' : '') + N(x.nearPct, 1) + '%') +
      pbKv('主压力 / 上方空间', (pr.short ? E(pr.short) + ' ' + N(pr.price) : '—') + ' · +' + N(x.roomPct, 1) + '%') +
      pbKv('缩量比 / RSI14', (x.volRatio === null ? '—' : N(x.volRatio) + ' 倍') + ' · ' + E(x.rsi14 === null ? '—' : x.rsi14)) +
      pbKv('MA20 / 评分', N(x.ma && x.ma.ma20) + ' · ' + (x.aboveMA20 ? '站上' : '跌破') + ' · ' + E(x.score) + ' 分') +
      '</div>' +
      '<div class="pb-trace-line">' + E(x.sourceNote) + '　|　涨停日交叉校验：' + E(x.ztSourceNote) + '</div></div>';
  }

  /** 板块涨停阈值：与后端 limitUpCut 同一口径，用于K线状态着色 */
  function klineLimitCut(code) {
    const s = String(code || '');
    if (/^(300|301|688|689)/.test(s)) return 19.5;
    if (/^(8|4|920)/.test(s)) return 29.5;
    return 9.7;
  }
  /** 零依赖 SVG K 线图：蜡烛 + 成交量 + 均线 + 水平支撑/压力线 + 右侧标签 + 观察区 */
  function klineCard(x) {
    const c = x.chart || {}, bars = c.bars || [];
    if (bars.length < 10) return '<div class="card empty">该标的日K数据不足，无法绘制K线图（不生成示意图）</div>';
    // K线状态配色（默认规则）：涨停=黄、跌停=紫、炸板=蓝，其余保留红涨绿跌
    const KC = { zt: '#e3a800', dt: '#6d4bd6', zb: '#2f6fd0', up: '#d92b2b', down: '#0f9960' };
    const kth = klineLimitCut(x.code);
    // 逐根判定：涨停=收盘涨幅≥阈值；跌停=收盘跌幅≤-阈值；炸板=盘中最高触板但收盘未封住
    const states = bars.map((b, i) => {
      const prev = i > 0 ? bars[i - 1].close : null;
      const plain = b.close >= b.open ? 'up' : 'down';
      if (!prev) return plain;
      const chg = (b.close - prev) / prev * 100, hi = (b.high - prev) / prev * 100;
      if (chg >= kth) return 'zt';
      if (chg <= -kth) return 'dt';
      if (hi >= kth) return 'zb';
      return plain;
    });
    const barColor = i => KC[states[i]];
    const W = 940, H = 438, L = 58, R = 136, PW = W - L - R;
    const PT = 28, PB = 292, VT = 312, VB = 372, DY = 392;
    let minP = Math.min(...bars.map(b => b.low)), maxP = Math.max(...bars.map(b => b.high));
    const visible = (c.lines || []).filter(l => l.price >= minP * 0.97 && l.price <= maxP * 1.03);
    visible.forEach(l => { minP = Math.min(minP, l.price); maxP = Math.max(maxP, l.price); });
    if (c.zone) { minP = Math.min(minP, c.zone[0]); maxP = Math.max(maxP, c.zone[1]); }
    minP = Math.min(minP, c.price); maxP = Math.max(maxP, c.price);
    const pad = (maxP - minP) * 0.06 || maxP * 0.02;
    minP -= pad; maxP += pad;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    const maxV = Math.max(1, ...bars.map(b => b.volume || 0));
    const cw = PW / bars.length, bw = Math.max(2, Math.min(9, cw * 0.62));
    const CX = i => L + cw * (i + 0.5);
    const a = [];
    a.push('<svg class="pb-kline" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + E(x.name) + ' 日K线与支撑压力划线">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7" stroke-width="1"/>');
      a.push('<text x="' + (L - 7) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    if (c.zone) {
      const y1 = Y(c.zone[1]), y2 = Y(c.zone[0]);
      a.push('<rect x="' + L + '" y="' + y1.toFixed(1) + '" width="' + PW + '" height="' + Math.max(2, y2 - y1).toFixed(1) + '" fill="#eaf2fd" opacity="0.8"/>');
      a.push('<text x="' + (L + 5) + '" y="' + (y1 - 4).toFixed(1) + '" font-size="10" fill="#2f6fd0">回踩观察区 ' + N(c.zone[0]) + '–' + N(c.zone[1]) + '</text>');
    }
    bars.forEach((b, i) => {
      const cx = CX(i), col = barColor(i), st = states[i];
      const yo = Y(b.open), yc = Y(b.close), yh = Y(b.high), yl = Y(b.low);
      const stName = { zt: '涨停', dt: '跌停', zb: '炸板', up: '上涨', down: '下跌' }[st];
      const tip = E(b.date) + ' [' + stName + '] 开 ' + N(b.open) + ' 高 ' + N(b.high) + ' 低 ' + N(b.low) + ' 收 ' + N(b.close) + ' 量 ' + E(b.volume);
      a.push('<g><title>' + tip + '</title>');
      a.push('<line x1="' + cx.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yl.toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>');
      a.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Math.min(yo, yc).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.4, Math.abs(yo - yc)).toFixed(1) + '" fill="' + col + '"/></g>');
    });
    [['ma5', '#e8912a'], ['ma10', '#2f6fd0'], ['ma20', '#6d4bd6']].forEach(pair => {
      const arr = c[pair[0]] || [], pts = [];
      arr.forEach((v, i) => { if (v !== null && v !== undefined && Number.isFinite(v)) pts.push(CX(i).toFixed(1) + ',' + Y(v).toFixed(1)); });
      if (pts.length > 1) a.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + pair[1] + '" stroke-width="1.2" opacity="0.85"/>');
    });
    const labels = [];
    visible.forEach(l => {
      const y = Y(l.price), isMain = !!(x.primarySupport && l.id === x.primarySupport.id);
      const col = l.kind === 'support' ? (isMain ? '#0f7b6c' : '#2f6fd0') : '#d92b2b';
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) +
        '" stroke="' + col + '" stroke-width="' + (isMain ? 1.9 : 1.1) + '" stroke-dasharray="' + (isMain ? '7 3' : '4 4') +
        '" opacity="' + (isMain ? 0.95 : 0.7) + '"/>');
      labels.push({ y, col, text: l.id + ' ' + l.short + ' ' + N(l.price), isMain });
    });
    const py = Y(c.price);
    a.push('<line x1="' + L + '" y1="' + py.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + py.toFixed(1) + '" stroke="#1c2733" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>');
    labels.push({ y: py, col: '#1c2733', text: '现价 ' + N(c.price), dark: true });
    labels.sort((p, q) => p.y - q.y);
    let lastY = -100;
    labels.forEach(lb => {
      let ly = Math.max(PT + 10, Math.min(PB + 20, lb.y));
      if (ly - lastY < 15) ly = lastY + 15;
      lastY = ly;
      const lx = L + PW + 6, txt = lb.text.length > 17 ? lb.text.slice(0, 16) + '…' : lb.text;
      if (Math.abs(ly - lb.y) > 2)
        a.push('<line x1="' + (L + PW) + '" y1="' + lb.y.toFixed(1) + '" x2="' + (lx - 2) + '" y2="' + ly.toFixed(1) + '" stroke="' + lb.col + '" stroke-width="0.8" opacity="0.5"/>');
      a.push('<rect x="' + lx + '" y="' + (ly - 8).toFixed(1) + '" width="' + (R - 12) + '" height="15" rx="3" fill="' + lb.col + '" opacity="' + (lb.dark ? 1 : 0.92) + '"/>');
      a.push('<text x="' + (lx + 5) + '" y="' + (ly + 3).toFixed(1) + '" font-size="10" fill="#ffffff" font-weight="600">' + E(txt) + '</text>');
    });
    const zi = bars.findIndex(b => b.date === c.ztDate);
    if (zi >= 0) {
      const cx = CX(zi), top = Y(bars[zi].high);
      a.push('<path d="M' + (cx - 5).toFixed(1) + ' ' + (top - 9).toFixed(1) + ' L' + (cx + 5).toFixed(1) + ' ' + (top - 9).toFixed(1) +
        ' L' + cx.toFixed(1) + ' ' + (top - 3).toFixed(1) + ' Z" fill="' + KC.zt + '"/>');
      a.push('<text x="' + cx.toFixed(1) + '" y="' + (top - 12).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="' + KC.zt + '" font-weight="700">涨停</text>');
    }
    const hi = bars.findIndex(b => b.date === c.highDate);
    if (hi >= 0) {
      const cx = CX(hi), top = Y(bars[hi].high);
      a.push('<circle cx="' + cx.toFixed(1) + '" cy="' + (top - 3).toFixed(1) + '" r="2.6" fill="#d97706"/>');
      a.push('<text x="' + cx.toFixed(1) + '" y="' + (top - 7).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#d97706">阶段高</text>');
    }
    a.push('<line x1="' + L + '" y1="' + VT + '" x2="' + (L + PW) + '" y2="' + VT + '" stroke="#eef2f7"/>');
    a.push('<text x="' + (L - 7) + '" y="' + (VT + 10) + '" text-anchor="end" font-size="9" fill="#8593a3">量</text>');
    bars.forEach((b, i) => {
      const h = (b.volume || 0) / maxV * (VB - VT - 4), col = barColor(i);
      a.push('<rect x="' + (CX(i) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1, h).toFixed(1) + '" fill="' + col + '" opacity="0.55"><title>' + E(b.date) + ' 成交量 ' + E(b.volume) + '</title></rect>');
    });
    const step = Math.max(1, Math.ceil(bars.length / 6));
    bars.forEach((b, i) => {
      if (i % step === 0 || i === bars.length - 1)
        a.push('<text x="' + CX(i).toFixed(1) + '" y="' + DY + '" text-anchor="middle" font-size="9.5" fill="#8593a3">' + E(String(b.date).slice(5)) + '</text>');
    });
    const legend = [[KC.zt, '涨停'], [KC.dt, '跌停'], [KC.zb, '炸板'], [KC.up, '阳线'], [KC.down, '阴线'], ['#e8912a', 'MA5'], ['#2f6fd0', 'MA10'], ['#6d4bd6', 'MA20'], ['#0f7b6c', '主支撑'], ['#d92b2b', '压力位']];
    let lx = L;
    legend.forEach(pair => {
      a.push('<rect x="' + lx + '" y="8" width="8" height="8" rx="2" fill="' + pair[0] + '"/>');
      a.push('<text x="' + (lx + 12) + '" y="16" font-size="10" fill="#6b7a8c">' + pair[1] + '</text>');
      lx += 84;
    });
    a.push('<text x="' + L + '" y="420" font-size="10" fill="#8593a3">日K：' + E(c.source || '—') + '（截至 ' + E(c.asOf || '—') + '，' + bars.length +
      ' 根）；划线由本系统按规则从真实日K计算，非交易所数据；鼠标悬停K线可查看当日 OHLC。</text>');
    a.push('</svg>');
    return '<div class="card pb-chart-card"><div class="pb-chart-head"><h4>日K线图与支撑 / 压力划线</h4>' + src(x.sourceNote) + '</div>' +
      '<div class="pb-svg-wrap">' + a.join('') + '</div>' +
      '<div class="note-box"><b>K线默认着色</b>：<span style="color:' + KC.zt + ';font-weight:700">涨停=黄</span> / <span style="color:' + KC.dt + ';font-weight:700">跌停=紫</span> / <span style="color:' + KC.zb + ';font-weight:700">炸板=蓝</span>（盘中最高触及涨停但收盘未封住）；普通K线仍红涨绿跌。涨停 / 跌停按收盘较前收盘涨跌幅达板块阈值（主板 ' + kth + '%）判定，炸板按盘中最高触及阈值收盘未封判定，均为真实日K机械识别、非当日池标签。<br>图上只标注最重要的 4 条支撑 + 3 条压力（距现价过远的线不画，避免压缩K线），完整清单与每条线的生成依据见下方「划线解释」。蓝色 / 绿色虚线为支撑，红色虚线为压力，粗绿虚线为主支撑，浅蓝阴影为回踩观察区。</div></div>';
  }

  function lineExplanations(x) {
    const shown = x.chart.lines || [], ids = new Set(shown.map(l => l.id));
    const all = [...(x.supports || []), ...(x.resistances || [])];
    const cards = shown.map(l => {
      const main = !!(x.primarySupport && l.id === x.primarySupport.id);
      const col = l.kind === 'support' ? (main ? '#0f7b6c' : '#2f6fd0') : '#d92b2b';
      return '<div class="lv-card" style="border-left-color:' + col + '">' +
        '<div class="lv-top"><span class="lv-id" style="background:' + col + '">' + E(l.id) + '</span><b>' + E(l.name) + '</b>' +
        '<span class="lv-price">' + N(l.price) + ' 元</span>' + tag(l.kind === 'support' ? '支撑' : '压力', l.kind === 'support' ? 'blue' : 'red') +
        (main ? tag('主支撑', 'green') : '') +
        '<span class="lv-dist">距现价 ' + (l.distPct > 0 ? '+' : '') + N(l.distPct, 1) + '%</span></div>' +
        '<div class="lv-basis"><b>为什么画在这里：</b>' + E(l.basis) + '</div>' +
        '<div class="lv-foot">历史有效触碰 ' + E(l.touches) + ' 次' + (l.lastTouch ? '（末次 ' + E(String(l.lastTouch).slice(5)) + '）' : '') +
        ' · 强度 ' + E(l.strength) + '/3 · ' + E(l.source) + '</div></div>';
    }).join('');
    const rows = all.map(l =>
      '<tr' + (ids.has(l.id) ? ' class="lv-onchart"' : '') + '><td class="left">' + (ids.has(l.id) ? '<span class="dot-on">●</span> ' : '') + E(l.id) + '</td>' +
      '<td class="left">' + E(l.short) + '</td><td>' + N(l.price) + '</td><td>' + (l.distPct > 0 ? '+' : '') + N(l.distPct, 1) + '%</td>' +
      '<td>' + E(l.touches) + '</td><td class="left">' + tag(l.kind === 'support' ? '支撑' : '压力', l.kind === 'support' ? 'blue' : 'red') + '</td>' +
      '<td class="left small">' + E(l.basis) + '</td></tr>'
    ).join('');
    const ma = (x.maRefs || []).map(r =>
      '<div class="kv"><span class="k">' + E(r.name) + '</span><span class="v">' + N(r.price) + ' 元 · ' + E(r.note) + '</span></div>').join('');
    return '<div class="card pad pb-lines"><div class="sec-head"><h3>划线解释（逐条可追溯）</h3>' +
      src(x.chart.source + '，截至 ' + x.chart.asOf) + '</div>' +
      '<div class="pb-note">读图顺序：先看现价与主支撑的距离（是否回踩到位），再看上方压力决定空间，最后看缩量与收盘是否破位。支撑被收盘有效跌破即转为压力，这就是「支撑压力互换」。</div>' +
      '<div class="lv-grid">' + cards + '</div>' +
      '<div class="sec-head" style="margin-top:15px"><h3 style="font-size:12.5px">完整水平位清单</h3><span class="src">● 表示已画在图上</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">编号</th><th class="left">线名</th><th>价位</th><th>距现价</th><th>触碰</th><th class="left">类型</th><th class="left">生成依据</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="sec-head" style="margin-top:13px"><h3 style="font-size:12.5px">动态参考线（非水平划线）</h3></div><div class="pb-ma">' + ma + '</div>' +
      (x.klineNote ? '<div class="pb-warn">口径提示：' + E(x.klineNote) + '</div>' : '') + '</div>';
  }

  function tradePlanCard(x, m) {
    const p = x.plan || {};
    const parts = (x.scoreParts || []).map(z =>
      '<div class="sp"><span class="spn">' + E(z.factor) + '</span><div class="spb"><div class="spf" style="width:' +
      (z.max ? Math.max(0, Math.min(100, z.got / z.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(z.got) + '/' + E(z.max) + '</span></div>'
    ).join('');
    const li = arr => (arr || []).map(t => '<li>' + E(t) + '</li>').join('');
    return '<div class="pb-plan-grid">' +
      '<div class="card pad"><div class="sec-head"><h3 style="font-size:12.5px">条件化观察框架（非买卖指令）</h3></div>' +
      '<div class="zone-box"><div class="zl">回踩观察区间（元）</div><div class="zv">' + N(p.zone && p.zone[0]) + ' — ' + N(p.zone && p.zone[1]) + '</div>' +
      '<div class="zone-row"><span class="small">止损参考 <b class="down">' + N(p.stop) + '</b></span>' +
      '<span class="small">上方目标 <b class="up">' + N(p.target) + '</b></span>' +
      '<span class="small">盈亏比 <b>' + N(p.rr) + '</b></span></div></div>' +
      '<div class="note-box"><b>区间算法：</b>' + E(p.basis) + '</div>' +
      '<div class="sec-head" style="margin-top:12px"><h3 style="font-size:12.5px">评分拆解（' + E(x.score) + ' / 100）</h3></div>' +
      '<div class="score-parts">' + parts + '</div>' +
      (x.veto && x.veto.length ? '<div class="veto"><b>一票否决项（' + x.veto.length + '）：</b><br>' + x.veto.map(z => '· ' + E(z)).join('<br>') + '</div>' : '') +
      '</div>' +
      '<div class="card pad"><div class="sec-head"><h3 style="font-size:12.5px">确认条件 / 分仓路径 / 失效条件</h3></div>' +
      '<h5 class="pb-h5">需同时确认（否则不进入观察）</h5><ul class="tight">' + li(p.conditions) + '</ul>' +
      '<h5 class="pb-h5">分仓路径（研究框架示例）</h5><ul class="tight">' + li(p.steps) + '</ul>' +
      '<h5 class="pb-h5" style="color:var(--up)">计划失效条件（触发即退出）</h5><ul class="tight">' + li(p.invalid) + '</ul>' +
      '<div class="pb-trace"><h5 class="pb-h5">数据溯源</h5>' +
      '<div class="kv"><span class="k">候选涨停标记</span><span class="v">东方财富涨停池 ' + E(x.poolDate || '—') + '</span></div>' +
      '<div class="kv"><span class="k">实时价 / 涨跌幅</span><span class="v">腾讯证券 ' + E(x.quoteTick || '—') + '</span></div>' +
      '<div class="kv"><span class="k">日K与划线</span><span class="v">' + E(x.klineSource || '—') + ' · 截至 ' + E(x.lastDate || '—') + '</span></div>' +
      '<div class="kv"><span class="k">涨停日校验</span><span class="v">' + E(x.ztSourceNote) + '</span></div>' +
      '<div class="kv"><span class="k">市场档位</span><span class="v">' + E(m.marketTier || '—') + ' / ' + E(m.marketEmotion || '—') + '</span></div>' +
      '</div></div></div>';
  }

  /* ═══════════ 明日龙头 · 只做龙头 / 买在分歧卖在一致 ═══════════ */
  const dgDtypeCls = d => ({ '良性分歧': 'red', '一致加速': 'warn', '恶性分歧': 'purple', '分歧偏弱': 'blue', '中性': '' }[d] || '');
  const dgToneCls = t => ({ primary: 'red', warn: 'warn', blue: 'blue', muted: '' }[t] || '');
  // 彩色边框由服务端按实时晋级率动态筛选：中性 / 良性分歧等高晋级率组合同样标记。
  // 颜色分档只管展示；哪些组合被标记、概率多少一律取自服务端 S.edgeStats（10 分钟重算）。
  const EDGE_TONES = [
    { min: 45, cls: 'high', color: '#d92b2b', bg: '#fdecec' },
    { min: 35, cls: 'mid', color: '#6d4bd6', bg: '#f1edfd' },
    { min: 30, cls: 'low', color: '#2f6fd0', bg: '#eaf2fd' }
  ];
  const edgeTone = rate => EDGE_TONES.find(t => (Number(rate) || 0) >= t.min) || EDGE_TONES[EDGE_TONES.length - 1];
  const EDGE_ROLES = ['空间板', '累计板龙', '题材龙', '卡位股', '容量中军', '孤立涨停', '后排/补涨'];
  const EDGE_DTYPES = ['一致加速', '良性分歧', '分歧偏弱', '恶性分歧', '中性'];
  const edgeStatOf = key => (S.edgeStats && S.edgeStats.combos && S.edgeStats.combos[key]) || null;
  const edgeRateText = key => {
    const c = edgeStatOf(key);
    return c && c.rate !== null && c.rate !== undefined ? Number(c.rate).toFixed(1) + '%' : '—';
  };
  function dgEdgeOf(x) {
    if (!x) return null;
    const key = String(x.role || '') + '|' + String(x.dtype || '');
    const marks = (S.edgeStats && S.edgeStats.marks) || [];
    if (marks.indexOf(key) < 0) return null;
    const c = edgeStatOf(key);
    if (!c || c.smallSample) return null;
    const tone = edgeTone(c.rate);
    return {
      key, cls: tone.cls, color: tone.color, bg: tone.bg,
      label: String(x.role) + '+' + String(x.dtype),
      rate: edgeRateText(key), n: c.n || 0
    };
  }
  function dgEdgeStyle(edge) {
    return '--edge:' + edge.color + ';--edge-bg:' + edge.bg;
  }
  function dgEdgeTitle(edge) {
    const c = edgeStatOf(edge.key), w = S.edgeStats && S.edgeStats.window;
    return '实时统计：' + edge.label + ' 晋级率 ' + edge.rate +
      (c ? '（n=' + c.n + '，' + (c.promoted || 0) + ' 次晋级）' : '（统计载入中）') +
      (w ? ' · 窗口 ' + String(w.from || '') + '~' + String(w.to || '') : '') +
      '；仅为历史样本，不代表未来收益';
  }
  function dgEdgeBadge(x) {
    const edge = dgEdgeOf(x);
    if (!edge) return '';
    return '<span class="dg-edge-inline edge-' + E(edge.cls) + '" style="' + dgEdgeStyle(edge) +
      '" title="' + E(dgEdgeTitle(edge)) + '">★ ' + E(edge.label) + ' <span data-edge-rate>' + E(edge.rate) + '</span></span>';
  }
  function edgeDaysControl() {
    return '<label class="dg-edge-days">统计窗口 <select data-edge-days>' +
      EDGE_DAYS_OPTIONS.map(n => '<option value="' + n + '"' + (S.edgeDays === n ? ' selected' : '') + '>' + n + ' 个交易日</option>').join('') +
      '</select></label>';
  }
  /** 切换统计窗口：持久化选择、按新窗口请求统计，并就地刷新两处卡片 */
  async function changeEdgeDays(n) {
    const days = Number(n);
    if (EDGE_DAYS_OPTIONS.indexOf(days) < 0 || days === S.edgeDays) return;
    if (S.edgeDaysLoading) { S.edgeDaysPending = days; return; }  // 记住最后一次选择，完成后补跑
    S.edgeDays = days; edgeDaysSave(); S.edgeDaysLoading = true;
    refreshEdgeLegend();
    try {
      const j = await fetch('/api/dragon/edge-stats?days=' + days, { cache: 'no-store' }).then(r => r.json());
      if (j && j.available && Number((j.window || {}).requestedDays) === days) S.edgeStats = j;
    } catch (e) { /* 统计失败不覆盖已有数据 */ }
    S.edgeDaysLoading = false;
    refreshEdgeLegend();
    // 角标 / 徽标也要跟着新概率更新
    try { if (S.dg) renderDragon(); } catch (e) { }
    const pending = S.edgeDaysPending;
    S.edgeDaysPending = null;
    if (pending !== null && pending !== S.edgeDays) changeEdgeDays(pending);
  }
  function refreshEdgeLegend() {
    document.querySelectorAll('.dg-edge-legend-root').forEach(root => {
      root.innerHTML = edgeLegendInner(root.getAttribute('data-compact') === '1');
    });
  }
  /** 实时统计卡片：列出所有「地位 × 一致分歧状态」组合的晋级率（无数据时如实提示，不回退固定常量） */
  function edgeLegendInner(compact) {
    const st = S.edgeStats;
    const head = '<div class="dg-card-head"><h4>历史优势组合 · 彩色边框标记</h4>' +
      '<span class="small muted">概率由服务端按选定窗口实时统计</span></div>';
    if (!st || !st.available || !st.combos) {
      const pending = '<div class="small muted">' +
        (S.edgeDaysLoading ? '正在按 ' + S.edgeDays + ' 个交易日窗口统计…（首次需回溯历史涨停池，可能要十几秒）' : '正在统计各组合晋级率…（数据随主看板刷新下发）') +
        '</div>' + edgeDaysControl();
      return compact
        ? '<div class="dg-h5" style="margin-top:11px">历史优势组合 · 彩色边框标记</div>' + pending
        : '<div class="card pad dg-card dg-edge-legend">' + head + pending + '</div>';
    }
    const w = st.window || {}, minN = Number(st.minSample) || 8;
    const fmtDate = v => String(v || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const marks = st.marks || [];
    const roles = (st.byRole || []).map(r => String(r.key));
    const dtypes = (st.byDtype || []).map(r => String(r.key));
    const roleOrder = EDGE_ROLES.filter(r => roles.indexOf(r) >= 0).concat(roles.filter(r => EDGE_ROLES.indexOf(r) < 0));
    const dtypeOrder = EDGE_DTYPES.filter(d => dtypes.indexOf(d) >= 0).concat(dtypes.filter(d => EDGE_DTYPES.indexOf(d) < 0));
    let html = '<div class="dg-edge-meta">' + edgeDaysControl() +
      '<span>实时统计 · 窗口 ' + E(fmtDate(w.from)) + ' ~ ' + E(fmtDate(w.to)) +
      ' · ' + (w.countedDays || 0) + ' 个有效交易日 · 共 ' + ((st.total || {}).n || 0) + ' 个候选样本 · 全样本晋级率 ' +
      E((st.total && st.total.rate !== null && st.total.rate !== undefined) ? st.total.rate + '%' : '—') +
      ' · 每 10 分钟重算</span></div>';
    html += '<div class="dg-edge-matrix-wrap"><table class="dg-edge-matrix"><thead><tr><th>地位 ＼ 状态</th>' +
      dtypeOrder.map(t => '<th>' + E(t) + '</th>').join('') + '</tr></thead><tbody>';
    roleOrder.forEach(role => {
      html += '<tr><th>' + E(role) + '</th>';
      dtypeOrder.forEach(dtype => {
        const key = role + '|' + dtype;
        const c = st.combos[key], marked = marks.indexOf(key) >= 0;
        if (!c || !c.n) { html += '<td class="dg-edge-cell none">—</td>'; return; }
        const tone = edgeTone(c.rate);
        const alpha = Math.max(0, Math.min(0.22, (Number(c.rate) || 0) / 100 * 0.32));
        const style = 'background:rgba(47,111,208,' + alpha.toFixed(3) + ')' + (marked ? ';border:2px solid ' + tone.color : '');
        const tip = role + ' + ' + dtype + '：晋级 ' + c.promoted + '/' + c.n + ' = ' + c.rate + '%' +
          (c.smallSample ? '（样本不足 ' + minN + '，仅供参考）' : '');
        html += '<td class="dg-edge-cell' + (marked ? ' marked' : '') + (c.smallSample ? ' small-sample' : '') +
          '" style="' + style + '" title="' + E(tip) + '"><b>' + Number(c.rate).toFixed(1) + '%</b>' +
          '<span class="dg-edge-n">n=' + c.n + '</span></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    const line = arr => (arr || []).map(r => E(r.key) + ' ' + E(r.rate === null ? '—' : r.rate + '%') + ' (n=' + r.n + ')').join(' · ');
    html += '<div class="dg-edge-sums"><div><b>按地位：</b>' + line(st.byRole) + '</div><div><b>按状态：</b>' + line(st.byDtype) + '</div></div>';
    html += '<div class="note-box">' + (w.source ? '<b>数据来源：</b>' + E(w.source) + '<br>' : '') +
      E(st.method || '') + '<br>' + E(st.note || '') +
      '<br>彩色边框标记窗口内晋级率 ≥ ' + E((st.markRule || {}).minRate !== undefined ? st.markRule.minRate : 30) +
      '%（全样本基准 ' + E((st.markRule || {}).baselineRate !== undefined ? st.markRule.baselineRate : '—') +
      '%，取 30% 与「基准+8 个百分点」的较高者）且样本 ≥ ' + minN +
      ' 的组合，不限于「一致加速」；红 / 紫 / 蓝分别对应 ≥45% / ≥35% / ≥30%。' +
      '角标与本表数值均取自本次实时统计，样本数 &lt; ' + minN + ' 的组合已淡化显示，不作判断依据。</div>';
    return compact
      ? '<div class="dg-h5" style="margin-top:11px">历史优势组合 · 彩色边框标记</div>' + html
      : '<div class="card pad dg-card dg-edge-legend">' + head + html + '</div>';
  }
  function dgEdgeLegendCard(compact) {
    return '<div class="dg-edge-legend-root" data-compact="' + (compact ? '1' : '0') + '">' + edgeLegendInner(!!compact) + '</div>';
  }
  /** 首板龙头种子：最近回测分档概率图例，挂在连板天梯下方 */
  function seedLegendCard(s, isHistory) {
    if (!s || !s.tiers || !s.samples) return '';
    const tiers = s.tiers.map(t =>
      '<div class="fs-legend-item fs-' + E(t.key) + '" style="--fs:' + E(t.color) + ';--fs-bg:' + E(t.bg) + '">' +
      '<span class="fs-swatch"></span><b>' + E(t.label) + '</b>' +
      '<span class="small muted">晋级 <b>' + E(t.rate) + '%</b>（n=' + E(t.n) + '） · 成龙 <b>' + E(t.dragonRate) + '%</b></span></div>'
    ).join('');
    const factors = (s.factors || []).slice(0, 4).map(f =>
      '<span class="fs-factor">' + E(f.label) + ' ' + E(f.rate) + '%（×' + E(f.lift === null || f.lift === undefined ? '—' : f.lift) + '）</span>').join('');
    return '<div class="fs-legend"><div class="dg-h5" style="margin-top:11px">首板龙头种子 · ' +
      (isHistory ? '截至该日回测标记' : '最近回测标记') + '</div>' +
      '<div class="fs-legend-grid">' + tiers + '</div>' +
      (factors ? '<div class="fs-factors">最强因子：' + factors + '</div>' : '') +
      '<div class="note-box">' + (isHistory ? '截至 ' + E(String(s.asOf || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') || s.asOf || '该日') +
        ' 的 ' : '最近 ') + E(s.days) + ' 个交易日 / ' + E(s.samples) +
      ' 个首板样本，全样本晋级 ' + E(s.baseRate) + '%、成龙 ' + E(s.dragonBaseRate) + '%。' +
      E(s.note || '') + '首板卡片彩色边框与右上角 ★ 晋级概率即此分档；' +
      (isHistory ? '历史回放只使用该日及之前的数据统计，不含该日之后的晋级结果。' : '历史回放按各日自身窗口单独计算。') + '</div></div>';
  }

  const dgBar = (v, cls) => '<div class="dg-bar"><i class="' + (cls || 'blue') + '" style="width:'
    + Math.max(0, Math.min(100, Number(v) || 0)).toFixed(1) + '%"></i></div>';
  const dgNum = (v, suffix) => (v === null || v === undefined) ? '—' : E(v) + (suffix || '');

  function dgHead(j) {
    const s = j.sentiment, su = j.summary, rs = j.riskSummary || {};
    return '<div class="conclusion card dg-head"><div class="lead">「只做龙头」把 ' + E(su.poolCount) +
      ' 只涨停股收敛为 <b>' + E(su.leaderCount) + '</b> 只有明确定位的龙头 / 卡位标的；当前情绪 <b>' + E(s.phase) +
      '</b>（温度 ' + E(s.temperature) + ' / 100，姿态：' + E(s.stance) + '），空间板高度 ' + E(s.maxBoards) + ' 板。' +
      '候选范围已扩至「连续连板 + N天N板累计涨停」双口径，其中累计板龙 <b>' + E(su.cumLeaderCount || 0) + '</b> 只（近 N 日 M 次涨停的反包型龙头，不再因连续板数低被剔除）。' +
      '<div class="dg-head-sub">核心命题：<b>买在分歧</b>（放量换手后等次日弱转强确认）、<b>卖在一致</b>（缩量加速不追高）。下面是<b>明日盘前观察清单</b>，不是买入名单。</div></div>' +
      '<div class="tags">' + tag('涨停 ' + s.ztCount, 'red') +
      tag('炸板率 ' + dgNum(s.brokenRate, '%'), 'warn') + tag('跌停 ' + s.dtCount, 'green') +
      tag('最高 ' + s.maxBoards + ' 板', 'blue') +
      tag('累计最高 ' + (su.maxCumBoards || '—') + ' 板', 'blue') +
      tag('N天N板 ' + (su.cumPoolCount || 0) + ' 只', 'purple') +
      tag('累计板龙 ' + (su.cumLeaderCount || 0), 'purple') +
      tag('名称题材 ' + (su.nameThemeCount || 0), 'warn') +
      tag('昨日连板溢价 ' + (s.prevPremium === null ? '—' : (s.prevPremium > 0 ? '+' : '') + s.prevPremium + '%'), s.prevPremium < 0 ? 'green' : 'red') +
      tag('候选 ' + su.shown, 'purple') +
      (j.meta && j.meta.isReview
        ? tag('风险标记仅实时版提供', '')
        : tag('严重异动预警 ' + ((rs.triggered || 0) + (rs.imminent || 0)), 'red') +
          tag('交易风险高 ' + (rs.tradeHigh || 0), 'warn')) + '</div></div>';
  }

  function dgSource(j) {
    const m = j.meta, o = S.dgOpts;
    return '<div class="card pad dg-source">' +
      '<div>数据溯源：东方财富涨停 / 炸板 / 跌停池（交易日 <b>' + E(m.poolDate) + '</b>）· 历史池近 <b>' +
      E((m.historyDates || []).length) + '</b> 个交易日 · 昨日连板股今日溢价 = 腾讯证券实时快照（' +
      E(m.quotesOk) + '/' + E(m.prevCodesCount) + ' 只，时点 ' + E(m.quoteTick || '—') + '）· 指数：腾讯证券</div>' +
      '<div class="small muted">' + E(m.dataSourceNote) + ' · 生成 ' + E(m.generatedAt) + ' · 服务端耗时 ' + E(m.elapsedMs) + ' ms</div>' +
      (m.empty ? '<div class="pb-warn">' + E(m.emptyReason) + '</div>' : '') +
      (m.historyNote ? '<div class="small muted">口径：' + E(m.historyNote) + '</div>' : '') +
      '<div class="dg-actions">' +
      '<button class="btn btn-primary" id="dgReload">重新扫描</button> ' +
      '<label class="small muted">范围 <select class="sel" id="dgShowAll">' +
      '<option value="0"' + (Number(o.showAll) === 0 ? ' selected' : '') + '>仅龙头（只做龙头）</option>' +
      '<option value="1"' + (Number(o.showAll) === 1 ? ' selected' : '') + '>全池对照（含后排）</option></select></label> ' +
      '<label class="small muted">地位 <select class="sel" id="dgRole">' +
      ['全部', '空间板', '累计板龙', '题材龙', '卡位股', '容量中军', '后排/补涨', '孤立涨停'].map(r =>
        '<option value="' + E(r) + '"' + (o.role === r ? ' selected' : '') + '>' + E(r) + '</option>').join('') +
      '</select></label> ' +
      '<label class="small muted">回溯 <select class="sel" id="dgDays">' +
      [7, 10, 12, 15].map(n => '<option value="' + n + '"' + (Number(o.days) === n ? ' selected' : '') + '>近 ' + n + ' 日</option>').join('') +
      '</select></label> ' +
      '<label class="small muted">排序 <select class="sel" id="dgSort">' +
      [['score', '观察优先级'], ['boards', '连续连板'], ['cumBoards', '累计板数'], ['divergence', '分歧度'], ['consensus', '一致度'], ['amount', '成交额']]
        .map(p => '<option value="' + p[0] + '"' + (o.sort === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('') +
      '</select></label> ' +
      '<button class="btn" id="dgMethod">' + (S.dgMethodOpen ? '收起' : '查看') + '打法口径</button>' +
      '<button class="btn btn-accent" id="dgHistOpen">历史回放 · 看过去某日的分析</button>' +
      '<span class="small muted">全局筛选（市值 / 板块 / ST / 关键字）同样作用于本模块</span></div></div>';
  }

  function dgSentimentCard(j) {
    const s = j.sentiment;
    const kpis = [
      ['涨停家数', s.ztCount, '东财涨停池'], ['炸板家数', s.zbCount, '东财炸板池'],
      ['炸板率', dgNum(s.brokenRate, '%'), '炸板/(涨停+炸板)'], ['跌停家数', s.dtCount, '东财跌停池'],
      ['最高连板', s.maxBoards + ' 板', '空间板高度'],
      ['昨日连板溢价', s.prevPremium === null ? '—' : (s.prevPremium > 0 ? '+' : '') + s.prevPremium + '%', '腾讯实时快照'],
      ['昨日涨停晋级率', dgNum(s.promoteRate, '%'), '今日仍涨停占比']
    ];
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>情绪温度计与高位反馈</h4>' +
      src('东方财富涨停/炸板/跌停池 ' + s.date + ' · 腾讯实时快照 ' + (j.meta.quoteTick || '—')) + '</div>' +
      '<div class="dg-kpi-grid">' + kpis.map(k =>
        '<div class="dg-kpi"><span>' + E(k[0]) + '</span><b>' + E(k[1]) + '</b><em>' + E(k[2]) + '</em></div>').join('') + '</div>' +
      '<div class="dg-temp"><div class="dg-temp-top"><span>情绪温度 <b>' + E(s.temperature) + '</b> / 100</span>' +
      '<span>' + tag(s.phase, 'warn') + ' ' + tag('姿态：' + s.stance, 'blue') + '</span></div>' + dgBar(s.temperature, 'blue') +
      '<div class="small muted">分档：≥70 主升 · 55~70 修复/进攻 · 42~55 高位震荡 · 28~42 分歧退潮 · &lt;28 冰点；高位负反馈强制降档</div></div>' +
      (s.deteriorateNote ? '<div class="pb-warn">' + E(s.deteriorateNote) + '</div>' : '') +
      '<div class="tbl-wrap dg-factor-tbl"><table><thead><tr><th>因子</th><th>实测值</th><th>得分</th><th>权重</th><th>口径</th></tr></thead><tbody>' +
      (s.parts || []).map(p => '<tr><td>' + E(p.name) + '</td><td>' + E(p.value === null ? '—' : p.value) +
        '</td><td>' + E(p.score) + '</td><td>' + E(p.weight) + '%</td><td class="small muted">' + E(p.detail) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      (s.idxNote ? '<div class="small muted" style="margin-top:8px">指数：' + E(s.idxNote) + '</div>' : '') +
      '<div class="note-box">' + E(s.note) + '</div></div>';
  }

  function dgLadderCard(j) {
    const s = j.sentiment;
    const max = Math.max(1, ...j.ladder.map(l => l.count));
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>连板梯队与断层</h4>' +
      src('东方财富涨停池 ' + s.date + ' · 连板数 lbc') + '</div>' +
      (j.ladder || []).map(l =>
        '<div class="dg-ladder-row"><span class="dg-lb">' + E(l.boards) + ' 板</span>' +
        '<div class="dg-ladder-track"><i style="width:' + (l.count / max * 100).toFixed(1) + '%"></i></div>' +
        '<b>' + E(l.count) + ' 家</b><span class="small muted">' + E(l.names.join('、') || '—') +
        (l.codes.length < l.count ? ' 等' : '') + '</span></div>').join('') +
      '<div class="note-box">梯队' + (s.ladderComplete ? '目前无断层（1~' + E(s.maxBoards) + ' 板均有标的）'
        : '在 ' + E(s.gaps.join('/')) + ' 板出现断层，按龙头战法属于退潮信号') +
      '；断层是退潮信号，梯队完整度决定卡位股逻辑是否成立。代表股最多显示 6 只。</div></div>';
  }

  function dgThemesCard(j) {
    const rows = (j.themes || []).slice(0, 10);
    const spark = t => {
      const max = Math.max(1, ...t.series.map(s => s.count));
      return '<div class="dg-spark" title="' + E(t.series.map(s => String(s.date).slice(4) + ':' + s.count + '家').join(' / ')) + '">' +
        t.series.map(s => '<i style="height:' + Math.max(3, s.count / max * 22) + 'px"></i>').join('') + '</div>';
    };
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>题材强度与生命周期</h4>' +
      src('东财行业分类 hybk · 近 5 个交易日涨停家数（历史池）') + '</div>' +
      (rows.length ? '<div class="tbl-wrap"><table><thead><tr><th>行业</th><th>涨停</th><th>最高板</th><th>阶段</th><th>强度</th><th>近 5 日家数</th></tr></thead><tbody>' +
        rows.map(t => '<tr><td><b>' + E(t.industry) + '</b><div class="small muted">' + E(t.names.slice(0, 3).join('、')) + '</div></td>' +
          '<td>' + E(t.count) + '</td><td>' + E(t.maxBoards) + ' 板</td><td>' + tag(t.stage, t.stage === '退潮' ? 'green' : t.stage === '高潮' ? 'warn' : 'blue') + '</td>' +
          '<td><div class="dg-mini-bar">' + dgBar(t.strength, 'purple') + '<span>' + E(t.strength) + '</span></div></td>' +
          '<td>' + spark(t) + '<div class="small muted">' + t.series.map(s => s.count).join('/') + '</div></td></tr>').join('') +
        '</tbody></table></div>' : '<div class="card empty">当日无涨停行业数据</div>') +
      '<div class="note-box">阶段由近 5 日该行业涨停家数序列、最高板变化与今日一字占比判定；东财行业分类较细，「孤立涨停」偏多是分类口径的结果，可能与市场俗称题材不同。</div></div>';
  }

  function dgThemeUnderstandingCard(j) {
    const nt = j.nameThemes || [], cp = j.conceptThemes || [], info = j.themeUnderstanding || {};
    const ntHtml = nt.length
      ? '<div class="grid2">' + nt.slice(0, 8).map(t =>
        '<div class="info-card theme-card"><h4>' + E(t.label) + ' ' + tag(t.kind, t.kind === '玄学名字' ? 'purple' : 'blue') + '</h4>' +
        '<div class="theme-meta">' + tag(t.group, 'purple') + tag(t.count + ' 只涨停', 'red') +
        tag('最高 ' + t.maxBoards + ' 连板', '') + tag('累计最高 ' + t.maxCum + ' 板', 'blue') + '</div>' +
        '<p><b>成分股：</b>' + E(t.names.join('、')) + '</p>' +
        '<p style="margin-top:5px"><b>梯队：</b>' + (t.leaders || []).map(l => boardBadge(l.code) + E(l.name) + '（' + E(l.label) + '）').join('、') + '</p>' +
        '<div class="note-box"><b>识别依据：</b>' + E(t.basis) + '<br><b>边界：</b>' + E(t.caveat) + '</div></div>'
      ).join('') + '</div>'
      : '<div class="card empty">当日涨停股名称未出现符合阈值的字面共振（玄学 / 名字主线未识别到，不代表市场没有，仅说明字面证据不足）</div>';
    const cpHtml = cp.length
      ? '<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th class="left">概念板块</th><th>涨停数</th><th>最高连板</th><th>累计最高</th><th class="left">成分股</th></tr></thead><tbody>' +
        cp.map(c => '<tr><td class="left"><b>' + E(c.name) + '</b></td><td>' + E(c.count) + '</td><td>' + E(c.maxBoards) + '</td><td>' + E(c.maxCum) + '</td><td class="left small">' + E(c.names.join('、')) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<div class="card empty" style="margin-top:10px">当日涨幅居前的概念板块中，未出现 ≥2 只成分股同时涨停</div>';
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>题材理解补充 · 名称 / 玄学共振与跨行业概念</h4>' +
      src('新浪财经概念板块成分映射（' + E(j.meta.conceptBoardCount || 0) + ' 个板块）＋ 涨停股名称字面聚类；交易日 ' + E(j.meta.poolDate || '—')) + '</div>' +
      '<div class="note-box" style="margin-bottom:12px">' + E(info.note || '') + '<br><b>能力边界：</b>' + E(info.caveat || '') + '</div>' +
      '<div class="dg-h5">① 名称 / 玄学字面共振（' + E(nt.length) + ' 组）</div>' + ntHtml +
      '<div class="dg-h5" style="margin-top:14px">② 跨行业概念板块归属（' + E(cp.length) + ' 组）</div>' + cpHtml +
      '</div>';
  }

  function dgValidationCard(j) {
    const v = j.validation || {};
    const emptyRate = () => ({ n: 0, promoted: 0, rate: null });
    const line = (label, o, cls) => '<div class="dg-val-row"><span>' + E(label) + '</span><b>' + E(o.n) + '</b>' +
      '<span class="small muted">晋级 ' + E(o.promoted) + '</span><b class="' + (cls || '') + '">' +
      (o.rate === null ? '—' : o.rate + '%') + '</b>' + dgBar(o.rate || 0, cls === 'down' ? 'green' : 'blue') + '</div>';
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>历史验证 · 次日晋级率</h4>' +
      src('东方财富历史涨停池近 ' + (j.meta.historyDates || []).length + ' 个交易日 · ' + (v.days || 0) + ' 组「基准日→次日」样本') + '</div>' +
      '<div class="dg-val-grid"><div><div class="dg-h5">按一致 / 分歧分类</div>' +
      line('全部龙头', v.overall || emptyRate()) + line('良性分歧', v.divergence || emptyRate()) + line('一致加速', v.consensus || emptyRate()) +
      '</div><div><div class="dg-h5">按分歧度分组</div>' +
      (v.byDivergenceBand || []).map(b => line(b.band, b)).join('') + '</div></div>' +
      (v.insufficient ? '<div class="pb-warn">样本不足：良性分歧组与一致加速组至少一组样本 &lt;20，本模块只展示计数，不据此下结论，更不能反推「分歧无效」或「追一致更好」。</div>' : '') +
      '<div class="note-box"><b>怎么读：</b>晋级率 = 次日再次涨停且连板数增加的比例，<b>不等于收益率或可交易胜率</b>。一字/秒板的一致加速股次日继续涨停概率天然更高，但往往买不进或只能涨停价成交；「卖在一致」讲的是赔率与兑现风险，不是「次日一定不涨」。</div>' +
      '<div class="note-box">' + E(v.note || '') + '</div></div>';
  }

  function dgMethodCard(j) {
    const m = j.methodology || {};
    return '<div class="card pad dg-method" id="dgMethodBox" style="display:' + (S.dgMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">' + E(m.title || '打法口径') + '（先看规则，再看结论）</h4>' +
      (m.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(m.caveat || '') + '</div></div>';
  }

  /* ── 严重异动预测 / 交易风险标记（真实日K + 个股公告，不参与评分） ── */
  function dgRiskBadges(x) {
    const r = x && x.risk;
    if (!r || !(r.badges || []).length) return '';
    return '<div class="dg-risk-badges">' + r.badges.map(b => {
      const cls = b.kind === 'severe'
        ? (b.level === 'triggered' || b.level === 'imminent' ? 'rk-sev-high' : 'rk-sev-mid')
        : (b.level === 'high' ? 'rk-trd-high' : 'rk-trd-mid');
      return '<span class="dg-risk-badge ' + cls + '" title="' + E(b.title) + '">' + E(b.label) + '</span>';
    }).join('') + '</div>';
  }

  function dgRiskMethodCard(j) {
    const m = j.riskMethodology, meta = j.riskMeta || {};
    if (!m) return '';
    return '<div class="card pad dg-risk-method"><div class="dg-card-head"><h4>严重异动预测 · 交易风险标记口径</h4>' +
      '<span class="small muted">规则化阈值推算，不是交易所认定，也不参与龙头评分</span></div>' +
      '<div class="dg-risk-method-rules">' +
      (m.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '</div><div class="note-box">' + E(m.caveat || '') + '</div>' +
      '<div class="small muted">本次覆盖：' + E(meta.klineOk || 0) + '/' + E(meta.klineTotal || 0) +
      ' 只候选日K可用 · 关联公告 ' + E(meta.annItems || 0) + ' 条（时点 ' + E(meta.annAsOf || '—') + '）· 日K来源 ' +
      E((meta.klineSources || []).join(' / ') || '不可用') +
      (meta.error ? ' · <b>部分数据获取失败：' + E(meta.error) + '</b>' : '') + '</div></div>';
  }

  function dgRiskCard(x) {
    const r = x && x.risk;
    const head = '<div class="card pad dg-card dg-risk-card"><div class="dg-card-head"><h4>严重异动预测 · 交易风险</h4>' +
      '<span class="small muted">真实日K + 个股公告 · 不参与评分</span></div>';
    if (!r) return head + '<div class="empty">本次未获取到该股的风险数据，系统不会用推测数据填充。</div></div>';
    const v = r.severe || {}, t = r.trade || {};
    const cls = (v.level === 'triggered' || v.level === 'imminent') ? 'high'
      : (v.level === 'near' || v.level === 'watch' ? 'mid' : 'low');
    const status = '<div class="dg-risk-status ' + cls + '"><b>' + E(v.label || '异动数据不可用') + '</b>' +
      '<span>交易风险 · ' + E(t.levelLabel || '—') + '（' + E(t.flagCount || 0) + ' 项证据）</span>' +
      (v.need10 !== null && v.need10 !== undefined && v.need10 > 0
        ? '<span>距 +100% 阈值约 ' + E(v.need10) + ' 个涨停</span>' : '') + '</div>';
    const tbl = (v.evidence || []).length
      ? '<div class="tbl-wrap"><table><thead><tr><th>指标</th><th>数值</th><th>阈值 / 提示线</th><th>判读</th></tr></thead><tbody>' +
        v.evidence.map(e => '<tr><td>' + E(e.label) + '</td><td><b>' + E(e.value) + '</b></td><td>' + E(e.threshold) +
          '</td><td class="small muted">' + E(e.note) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<div class="empty">日K不可用，无法计算阈值距离。</div>';
    const srcNote = '<div class="small muted">日K来源：' + E(v.source || '不可用') + '（' +
      (v.adjusted === false ? '不复权' : (v.adjusted === true ? '前复权' : '口径未知')) + '，' +
      E(v.klineCount || 0) + ' 根，截至 ' + E(v.lastDate || '—') + '）· 关联公告 ' + E(r.annCount || 0) +
      ' 条 · 板块口径 ' + E(v.board || '—') + '</div>';
    const action = '<div class="dg-risk-action"><b>条件化提示：</b>' + E(v.action || '') + '</div>';
    const flags = '<div class="dg-h5">交易风险证据（' + E(t.flagCount || 0) + ' 项，按来源标注）</div>' +
      ((t.flags || []).length ? t.flags.map(f =>
        '<div class="dg-risk-flag ' + E(f.severity) + '"><div class="dg-risk-flag-top"><b>' + E(f.tag) + '</b>' +
        '<span class="mini-tag">' + (f.kind === 'announcement' ? '个股公告' : '量价 / 规则推算') + '</span>' +
        '<span class="mini-tag">' + (f.severity === 'high' ? '高危' : '一般') + '</span></div>' +
        '<div class="small muted">' + E(f.detail) + '</div>' +
        ((f.links || []).length ? '<div class="dg-risk-links">' + f.links.map(l =>
          (l.url ? '<a href="' + E(l.url) + '" target="_blank" rel="noopener noreferrer">' + E(l.title) + ' ↗</a>' : '') +
          (l.pdfUrl ? ' <a href="' + E(l.pdfUrl) + '" target="_blank" rel="noopener noreferrer">公告 PDF ↗</a>' : '')
        ).join('') + '</div>' : '') + '</div>').join('')
        : '<div class="small muted">未命中公告风险词，量价字段也未触发风险提示线。</div>');
    return head + status + tbl + srcNote + action + flags + '<div class="note-box">' + E(v.caveat || '') + '</div></div>';
  }

  function dgListItems(j) {
    return (j.list || []).map(x => {
      const edge = dgEdgeOf(x);
      return '<div class="dg-item' + (x.code === S.dgSelected ? ' active' : '') + (edge ? ' dg-edge edge-' + E(edge.cls) : '') +
        '" data-code="' + E(x.code) + '"' + (edge ? ' data-edge-corner="★ ' + E(edge.label) + ' ' + E(edge.rate) + '" style="' + dgEdgeStyle(edge) + '" title="' + E(dgEdgeTitle(edge)) + '"' : '') + '>' +
      '<div class="dg-item-top"><b>' + sn(x.code, x.name) + '</b><span class="code muted">' + E(x.code) + '</span>' +
      '<span class="tag ' + dgDtypeCls(x.dtype) + '">' + E(x.dtype) + '</span>' +
      '<span class="dg-score">' + E(x.score) + '</span></div>' +
      '<div class="dg-item-mid"><span title="连续连板 / 近 N 日累计涨停">' + E(x.boardLabel || (x.boards + ' 板')) + '</span><span class="tag ' + (x.roleRank === 1 ? 'red' : 'blue') + '">' + E(x.role) + '</span>' +
      '<span class="muted">' + E(x.industry) + '</span></div>' +
      '<div class="dg-mini-meters"><span>一致 ' + E(x.consensus) + '</span>' + dgBar(x.consensus, 'blue') +
      '<span>分歧 ' + E(x.divergence) + '</span>' + dgBar(x.divergence, 'red') + '</div>' +
      '<div class="dg-item-bot">' + E(x.script.title) + '</div>' + dgRiskBadges(x) + '</div>';
    }).join('');
  }

  function dgDetailHead(x) {
    return '<div class="card pad dg-detail-head"><div class="dg-dh-top"><h3>' + sn(x.code, x.name) + ' <span class="muted" style="font-size:12px;font-weight:400">' + E(x.code) + '</span></h3>' +
      tag(x.boardLabel || (x.boards + ' 板'), 'red') + tag(x.role, 'blue') + tag(x.dtype, dgDtypeCls(x.dtype)) + dgEdgeBadge(x) +
      tag('观察优先级 ' + x.score, 'purple') + '<span class="muted small">' + E(x.industry) + ' · ' + E(x.board) + '</span></div>' +
      '<div class="dg-dh-reason"><b>地位依据：</b>' + E(x.roleReason) + '</div>' +
      '<div class="dg-kv-grid">' +
      dgKv('收盘价', N(x.price) + ' 元') + dgKv('当日涨幅', PC(x.pct)) +
      dgKv('首次封板', E(x.firstSeal)) + dgKv('最后封板', E(x.lastSeal)) +
      dgKv('炸板次数', E(x.brokenCount) + ' 次') + dgKv('封单/流通市值', N(x.sealFundRatio) + '%') +
      dgKv('换手率', N(x.turnover) + '%') + dgKv('成交额', AMT(x.amount)) +
      dgKv('流通市值', CAP(x.floatCap)) + dgKv('近期涨停', (x.statDays === null || x.statDays === undefined ? '—' : E(x.statDays) + ' 天 ' + E(x.statCount) + ' 板')) +
      dgKv('累计涨停密度', x.cumDensity === null || x.cumDensity === undefined ? '—' : N(x.cumDensity) + ' 板/日') +
      dgKv('封单额', AMT(x.sealFund)) + dgKv('所属题材阶段', x.theme ? E(x.theme.stage) + ' / 强度 ' + E(x.theme.strength) : '—') +
      dgKv('名称 / 玄学题材', (x.nameThemes || []).length ? E(x.nameThemes.join('、')) : '—') +
      dgKv('概念板块题材', (x.conceptThemes || []).length ? E(x.conceptThemes.join('、')) : '—') +
      '</div><div class="dg-trace">' + src(x.sourceNote) + '</div></div>';
  }
  function dgKv(k, v) { return '<div class="dg-kv"><span>' + E(k) + '</span><b>' + v + '</b></div>'; }

  function dgMeters(x) {
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>一致度 / 分歧度（0~100，全部由真实封板字段计算）</h4></div>' +
      '<div class="dg-meter-block"><div class="dg-meter-top"><b>一致度 ' + E(x.consensus) + '</b>' +
      '<span class="small muted">早封 + 零炸板 + 高封单比 + 低换手 = 筹码锁定</span></div>' + dgBar(x.consensus, 'blue') + '</div>' +
      '<div class="dg-meter-block"><div class="dg-meter-top"><b>分歧度 ' + E(x.divergence) + '</b>' +
      '<span class="small muted">炸板 + 换手 + 封板晚 + 封单弱 + 放量 = 筹码交换</span></div>' + dgBar(x.divergence, 'red') + '</div>' +
      '<div class="note-box">' + E(x.benignRule) + '；当前判定：<b>' + E(x.dtype) + '</b>。</div>' +
      '<div class="dg-factor-grid"><div><div class="dg-h5">一致度因子</div>' +
      (x.consensusParts || []).map(p => '<div class="dg-factor"><span>' + E(p.name) + ' <em>权重' + E(p.weight) + '%</em></span>' +
        '<b>' + E(p.got) + '</b>' + dgBar(p.got, 'blue') + '<small>' + E(p.detail) + '</small></div>').join('') +
      '</div><div><div class="dg-h5">分歧度因子</div>' +
      (x.divergenceParts || []).map(p => '<div class="dg-factor"><span>' + E(p.name) + ' <em>权重' + E(p.weight) + '%</em></span>' +
        '<b>' + E(p.got) + '</b>' + dgBar(p.got, 'red') + '<small>' + E(p.detail) + '</small></div>').join('') +
      '</div></div></div>';
  }

  function dgScriptCard(x) {
    const sc = x.script || {};
    return '<div class="card pad dg-card dg-script ' + (sc.tone || '') + '"><div class="dg-card-head">' +
      '<h4>' + E(sc.title) + '</h4>' + tag('明日条件化剧本', dgToneCls(sc.tone)) + '</div>' +
      '<div class="dg-thesis">' + E(sc.thesis) + '</div>' +
      '<div class="dg-h5">触发条件 → 观察结论</div>' +
      (sc.triggers || []).map((t, i) => '<div class="dg-trigger"><b>' + (i + 1) + '</b>' +
        '<div><span class="dg-cond">若 ' + E(t.condition) + '</span><span class="dg-action">→ ' + E(t.action) + '</span></div></div>').join('') +
      '<div class="dg-h5">失效条件 / 证伪信号</div><ul class="dg-list-plain">' +
      (sc.invalidation || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul>' +
      '<div class="dg-risk"><b>风险：</b>' + E(sc.risk) + '</div>' +
      '<div class="dg-h5">明日需同步观察</div><ul class="dg-list-plain">' +
      (x.watch || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>';
  }

  function dgScoreCard(x) {
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>观察优先级评分明细</h4>' +
      '<span class="small muted">满分 100 = 地位 30 + 分歧质量 25 + 题材 20 + 情绪 15 − 风险 10</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>因子</th><th>得分</th><th>上限</th><th>依据</th></tr></thead><tbody>' +
      (x.scoreParts || []).map(p => '<tr><td>' + E(p.name) + '</td><td><b>' + E(p.got) + '</b></td><td>' +
        (p.max === 0 ? '扣减项' : E(p.max)) + '</td><td class="small muted">' + E(p.detail) + '</td></tr>').join('') +
      '</tbody></table></div><div class="note-box">排序是「明日观察优先级」，不是收益预测，更不是买入建议；一致加速的一字板在此项会被扣分。</div></div>';
  }

  function renderDragonDetail() {
    const j = S.dg; if (!j) return;
    const box = $('dgDetail'); if (!box) return;
    const x = (j.list || []).find(a => a.code === S.dgSelected);
    if (!x) { box.innerHTML = '<div class="card empty">请选择左侧标的查看地位依据、一致/分歧拆解与明日剧本</div>'; return; }
    box.innerHTML = dgDetailHead(x) + dgRiskCard(x) + dgMeters(x) + dgScriptCard(x) + dgScoreCard(x) + nwDetailCard(x);
  }

  /* ─────────── 明日龙头 · 历史回放（逐日重放 + 事后晋级验证） ─────────── */
  async function fetchDragonHistoryJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/dragon/review?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  async function loadDragonHistory(date, force) {
    if (S.dgHistLoading) return;
    S.dgHistLoading = true;
    S.dgHistError = null;
    $('pane-dragon').innerHTML = '<div class="card empty">正在回放 ' + E(date || '历史交易日') + ' 的涨停池分析与次日兑现结果…</div>';
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    q.set('days', '15');
    q.set('showAll', '1');
    q.set('limit', '60');
    if (force) q.set('force', '1');
    try {
      const j = await fetchDragonHistoryJson(q);
      S.dgHist = j;
      S.dgHistDate = j.meta && j.meta.poolDate;
      const dates = (j.review && j.review.availableDates) || [];
      if (!dates.some(d => String(d.date) === String(S.dgHistDate))) S.dgHistSelected = dates.length ? String(dates[0].date) : null;
      else S.dgHistSelected = String(S.dgHistDate);
      renderDragonHistory();
    } catch (e) {
      S.dgHistError = e.message;
      const offline = isConnError(e);
      $('pane-dragon').innerHTML = '<div class="card empty"><b>历史回放加载失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (offline ? E(SERVICE_HINT) : '服务端或上游数据源异常；系统不会用推测数据填充，可稍后重试。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="dhRetry">重试</button> ' +
        '<button class="btn" id="dhBack">返回实时分析</button></div>';
      $('dhRetry').onclick = () => loadDragonHistory(S.dgHistDate, true);
      $('dhBack').onclick = () => { S.dgHistOpen = false; renderDragon(); };
      if (offline) watchService('dragon');
    } finally { S.dgHistLoading = false; }
  }

  function dgHistBar(j) {
    const r = j.review || {}, dates = r.availableDates || [], m = j.meta || {};
    const opts = dates.map(d => {
      const sel = String(d.date) === String(S.dgHistSelected) ? ' selected' : '';
      return '<option value="' + E(d.date) + '"' + sel + '>' + E(fmtDate(d.date)) + '（涨停 ' + E(d.zt) + ' / 炸板 ' + E(d.zb) + '）</option>';
    }).join('');
    const hasNext = r.summary && r.summary.hasNext;
    return '<div class="card pad dh-bar"><div class="dh-bar-top"><div><b>历史回放</b>' +
      '<span class="small muted"> · 用与实时版相同的规则，重放「站在那天收盘时」看到的明日龙头分析</span></div>' +
      '<button class="btn" id="dhBackTop">返回实时分析</button></div>' +
      '<div class="dh-bar-ctl"><label class="small muted">选择交易日 <select class="sel" id="dhDate">' + opts + '</select></label>' +
      '<button class="btn" id="dhPrev" title="更早一个交易日">← 更早</button>' +
      '<button class="btn" id="dhNext" title="更近一个交易日" ' + (dates.length && String(S.dgHistSelected) === String(dates[0].date) ? 'disabled' : '') + '>更近 →</button>' +
      '<button class="btn btn-primary" id="dhGo">回放该日</button>' +
      '<span class="small muted">回放日数据截至 ' + E(fmtDate(m.poolDate)) + ' · 次日兑现' + (hasNext ? '取 ' + E(fmtDate(r.nextDate)) : '：尚无后续数据') + '</span></div>' +
      '<div class="dh-bar-note">' + E('无未来函数：当日分析只用该日及之前数据；实时溢价快照 / 指数 / 概念映射在历史回放中不可用，「昨日连板今日溢价」按中性计，故回放温度与当日实时版不直接可比。次日兑现为事后验证，不改写当日评分。') + '</div>' +
      '</div>';
  }

  function dhPct(v, digits) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '<span class="muted">—</span>';
    const n = Number(v), d = digits === undefined ? 2 : digits;
    return '<b class="' + (n > 0 ? 'up' : n < 0 ? 'down' : 'flat') + '">' + (n > 0 ? '+' : '') + n.toFixed(d) + '%</b>';
  }
  function dhPctSmall(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const n = Number(v);
    return '<span class="' + (n > 0 ? 'up' : n < 0 ? 'down' : 'flat') + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }

  function dgHistOutcomeCard(j) {
    const r = j.review || {}, su = r.summary || {}, rows = r.outcome || [], pf = su.perf || {};
    const pct = su.promoteRate === null ? '—' : su.promoteRate + '%';
    const surv = su.surviveRate === null ? '—' : su.surviveRate + '%';
    const ksrc = (pf.sources || []).join(' / ') || '日K不可用';
    const kadj = (pf.adjustedModes || []).length === 0 ? '口径未知'
      : (pf.adjustedModes || []).every(Boolean) ? '前复权'
        : (pf.adjustedModes || []).some(Boolean) ? '复权口径混用' : '不复权';
    const head = '<div class="card pad dg-card"><div class="dg-card-head"><h4>次日兑现 · 事后验证</h4>' +
      src(r.nextDate ? '回放日 ' + fmtDate(r.date) + ' 的龙头 → 下一交易日 ' + fmtDate(r.nextDate) + ' 真实涨停 / 炸板池；次日涨跌幅取 ' + ksrc + '（' + kadj + '），可用 ' + E(pf.available || 0) + '/' + E(pf.total || 0) : '回放日为最新交易日，暂无下一交易日数据') + '</div>';
    if (!su.hasNext) {
      return head + '<div class="empty">' + E(fmtDate(r.date) + ' 是当前可回溯的最新交易日，尚无下一交易日的真实池数据，无法计算次日晋级与涨跌幅。稍后数据更新后再回放即可看到兑现结果。') + '</div></div>';
    }
    const kpis = '<div class="dg-kpi-grid">' +
      '<div class="dg-kpi"><span>当日龙头候选</span><b>' + E(su.candidates) + '</b><em>回放选出的观察清单</em></div>' +
      '<div class="dg-kpi"><span>次日晋级</span><b>' + E(su.promoted) + '</b><em>连板数继续增加</em></div>' +
      '<div class="dg-kpi"><span>晋级率</span><b>' + E(pct) + '</b><em>晋级 / 候选，非收益率</em></div>' +
      '<div class="dg-kpi"><span>次日仍涨停</span><b>' + E(surv) + '</b><em>含晋级 + 连板持平</em></div>' +
      '<div class="dg-kpi"><span>次日平均涨跌</span><b>' + dhPct(pf.avgClosePct) + '</b><em>收盘 / 回放日收盘 − 1</em></div>' +
      '<div class="dg-kpi"><span>收盘上涨占比</span><b>' + E(pf.winRate === null ? '—' : pf.winRate + '%') + '</b><em>收盘涨幅 &gt; 0</em></div>' +
      '<div class="dg-kpi"><span>平均最高涨幅</span><b>' + dhPct(pf.avgHighPct) + '</b><em>盘中最大上冲</em></div>' +
      '<div class="dg-kpi"><span>平均最低涨幅</span><b>' + dhPct(pf.avgLowPct) + '</b><em>盘中最大回撤</em></div></div>';
    const byDtype = (su.byDtype || []).map(b =>
      '<tr><td>' + E(b.dtype) + '</td><td>' + E(b.n) + '</td><td>' + E(b.promoted) + '</td><td>' + E(b.rate === null ? '—' : b.rate + '%') + '</td>' +
      '<td>' + dhPct(b.avgClosePct) + '</td><td>' + E(b.winRate === null ? '—' : b.winRate + '%') + '</td></tr>').join('');
    const tbl = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr><th>标的</th><th>地位</th><th>分歧类型</th><th>回放日连板</th><th>次日连板</th><th>结果</th><th>次日涨跌幅（收盘）</th><th>观察优先级</th></tr></thead><tbody>' +
        rows.map(o => {
          const p = o.perf || {}, edge = dgEdgeOf(o);
          const pc = p.available
            ? dhPct(p.closePct) + '<div class="small muted">开 ' + dhPctSmall(p.openPct) + ' / 高 ' + dhPctSmall(p.highPct) + ' / 低 ' + dhPctSmall(p.lowPct) + '</div>'
            : '<span class="small muted">' + E(p.reason || '无数据') + '</span>';
          return '<tr' + (edge ? ' class="dg-edge-row edge-' + E(edge.cls) + '" style="' + dgEdgeStyle(edge) + '" title="' + E(dgEdgeTitle(edge)) + '"' : '') + '><td><b>' + sn(o.code, o.name) + '</b>' + dgEdgeBadge(o) + '<div class="small muted">' + E(o.code) + (o.theme ? ' · ' + E(o.theme) : '') + '</div></td>' +
            '<td>' + E(o.role) + '</td><td>' + E(o.dtype) + '</td><td>' + E(o.boards) + ' 板</td><td>' + (o.nextBoards === null ? '—' : E(o.nextBoards) + ' 板') + '</td>' +
            '<td>' + tag(o.resultLabel, o.result === 'promoted' ? 'red' : o.result === 'broken' ? 'green' : o.result === 'pending' ? '' : 'blue') + '</td>' +
            '<td>' + pc + '</td><td>' + E(o.score) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty">当日回放没有可展示的龙头候选。</div>';
    const extremes = (pf.best || pf.worst)
      ? '<div class="small muted" style="margin-top:8px">涨幅最高：<b>' + boardBadge((pf.best || {}).code) + E((pf.best || {}).name || '—') + '</b> ' + dhPct((pf.best || {}).closePct) +
        '　跌幅最大：<b>' + boardBadge((pf.worst || {}).code) + E((pf.worst || {}).name || '—') + '</b> ' + dhPct((pf.worst || {}).closePct) + '</div>' : '';
    return head + kpis +
      '<div class="dh-dtype"><div class="dg-h5">按分歧类型看晋级与次日涨跌（样本小，仅作对照）</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>分歧类型</th><th>候选</th><th>晋级</th><th>晋级率</th><th>平均次日涨跌</th><th>上涨占比</th></tr></thead><tbody>' +
      (byDtype || '<tr><td colspan="6" class="small muted">无样本</td></tr>') + '</tbody></table></div></div>' + tbl + extremes +
      '<div class="note-box">晋级率只衡量「回放日龙头在次日是否继续涨停且连板数增加」，<b>不等于收益率或可交易胜率</b>：一字 / 秒板天然更易连板但往往买不进。涨跌幅以<b>回放日收盘价</b>为基准，收盘 / 开盘 / 最高 / 最低分别计算，来自真实日K（' + E(ksrc) + ' · ' + E(kadj) + '）；它同样<b>不等于可交易收益</b>，因为买入价、滑点与能否成交都未计入。此表是事后验证，回放日的评分、情绪与候选均未使用次日数据，不可反推「该提前知道」。样本跨日重复、不独立，历史池约 15 日、样本量小。</div></div>';
  }

  function renderDragonHistory() {
    const j = S.dgHist; if (!j) return;
    const bar = dgHistBar(j);
    const focus = '<div class="card pad dg-card"><div class="dg-card-head"><h4>那天的「明日 3 个核心变量」</h4>' +
      '<span class="small muted">回放日收盘时按当时数据生成，不含次日结果</span></div>' +
      (j.focus || []).map((f, i) => '<div class="dg-focus"><b>' + (i + 1) + '</b><span>' + E(f) + '</span></div>').join('') + '</div>';
    const list = j.list || [];
    const perfMap = {};
    ((j.review || {}).outcome || []).forEach(o => { if (o && o.code) perfMap[o.code] = o.perf; });
    const body = list.length
      ? '<div class="dg-layout"><div class="dg-list" id="dhList">' + list.map(x => {
        const edge = dgEdgeOf(x);
        return '<div class="dg-item' + (x.code === S.dgHistSelected ? ' active' : '') + (edge ? ' dg-edge edge-' + E(edge.cls) : '') +
          '" data-code="' + E(x.code) + '"' + (edge ? ' data-edge-corner="★ ' + E(edge.label) + ' ' + E(edge.rate) + '" style="' + dgEdgeStyle(edge) + '" title="' + E(dgEdgeTitle(edge)) + '"' : '') + '>' +
        '<div class="dg-item-top"><b>' + sn(x.code, x.name) + '</b><span class="code muted">' + E(x.code) + '</span>' +
        '<span class="tag ' + dgDtypeCls(x.dtype) + '">' + E(x.dtype) + '</span><span class="dg-score">' + E(x.score) + '</span></div>' +
        '<div class="dg-item-mid"><span>' + E(x.boardLabel || (x.boards + ' 板')) + '</span>' +
        '<span class="tag ' + (x.roleRank === 1 ? 'red' : 'blue') + '">' + E(x.role) + '</span><span class="muted">' + E(x.industry) + '</span></div>' +
        '<div class="dg-mini-meters"><span>一致 ' + E(x.consensus) + '</span>' + dgBar(x.consensus, 'blue') +
        '<span>分歧 ' + E(x.divergence) + '</span>' + dgBar(x.divergence, 'red') + '</div>' +
        '<div class="dg-item-bot">' + E(x.script && x.script.title || '') +
        (perfMap[x.code] && perfMap[x.code].available ? '<span style="float:right">次日 ' + dhPct(perfMap[x.code].closePct) + '</span>' : '') + '</div></div>';
      }).join('') + '</div>' +
        '<div class="dg-detail" id="dhDetail"></div></div>'
      : '<div class="card empty">该交易日回放没有符合条件的龙头候选（可切到「全池对照」口径的回放或换一天）。</div>';
    const method = '<div class="card pad dg-method" id="dhMethodBox" style="display:' + (S.dgHistMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">' + E((j.methodology || {}).title || '回放口径') + '</h4>' +
      ((j.methodology || {}).rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E((j.methodology || {}).note || '') + '</div></div>';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：历史回放基于公开涨停池与量化规则，仅供研究复盘，不构成投资建议。过往表现不预示未来收益。</div>';
    $('pane-dragon').innerHTML = bar + dgHead(j) +
      '<div class="dh-method-toggle"><button class="btn" id="dhMethod">查看回放口径与边界</button></div>' + method +
      dgSentimentCard(j) + '<div class="dg-grid2">' + dgLadderCard(j) + dgThemesCard(j) + '</div>' +
      dgThemeUnderstandingCard(j) + focus + dgValidationCard(j) + dgEdgeLegendCard() +
      dgHistOutcomeCard(j) + body + disc;

    const setDate = d => { if (d) { S.dgHistSelected = String(d); loadDragonHistory(S.dgHistSelected, false); } };
    $('dhBackTop').onclick = () => { S.dgHistOpen = false; renderDragon(); };
    $('dhGo').onclick = () => setDate(($('dhDate') && $('dhDate').value));
    const dates = (j.review && j.review.availableDates) || [];
    const ci = dates.findIndex(d => String(d.date) === String(S.dgHistSelected));
    $('dhPrev').onclick = () => { if (ci >= 0 && ci < dates.length - 1) setDate(dates[ci + 1].date); };
    $('dhNext').onclick = () => { if (ci > 0) setDate(dates[ci - 1].date); };
    $('dhMethod').onclick = () => {
      S.dgHistMethodOpen = !S.dgHistMethodOpen;
      $('dhMethodBox').style.display = S.dgHistMethodOpen ? '' : 'none';
      $('dhMethod').textContent = S.dgHistMethodOpen ? '收起回放口径' : '查看回放口径与边界';
    };
    const renderHistDetail = () => {
      const box = $('dhDetail'); if (!box) return;
      const x = list.find(a => a.code === S.dgHistSelected);
      if (!x) { box.innerHTML = '<div class="card empty">选择左侧标的查看当日的地位依据与明日剧本</div>'; return; }
      const ot = (j.review.outcome || []).find(o => o.code === x.code);
      const outCard = ot ? '<div class="card pad dg-card"><div class="dg-card-head"><h4>该股次日兑现（事后验证）</h4></div>' +
        '<div class="dg-kv-grid">' + dgKv('回放日连板', E(ot.boards) + ' 板') + dgKv('次日连板', ot.nextBoards === null ? '—' : E(ot.nextBoards) + ' 板') +
        dgKv('次日结果', E(ot.resultLabel)) + dgKv('观察优先级', E(ot.score)) + '</div>' +
        '<div class="note-box">此项为事后验证，回放日的评分与剧本未使用次日数据。</div></div>' : '';
      box.innerHTML = dgDetailHead(x) + dgMeters(x) + dgScriptCard(x) + dgScoreCard(x) + outCard;
    };
    $('pane-dragon').querySelectorAll('#dhList .dg-item').forEach(el => {
      el.onclick = () => {
        S.dgHistSelected = el.dataset.code;
        $('pane-dragon').querySelectorAll('#dhList .dg-item').forEach(n => n.classList.toggle('active', n === el));
        renderHistDetail();
      };
    });
    renderHistDetail();
  }

  function renderDragon() {
    const j = S.dg; if (!j) return;
    if (S.dgHistOpen) { renderDragonHistory(); return; }
    const s = j.sentiment, list = j.list || [];
    const focus = '<div class="card pad dg-card"><div class="dg-card-head"><h4>明日 3 个核心变量</h4>' +
      '<span class="small muted">由今日真实梯队 / 情绪 / 题材数据生成，不是预测</span></div>' +
      (j.focus || []).map((f, i) => '<div class="dg-focus"><b>' + (i + 1) + '</b><span>' + E(f) + '</span></div>').join('') + '</div>';
    const empty = '<div class="card empty dg-empty"><b>当前没有符合条件的龙头候选</b><br>' +
      '<span class="small muted">' + (j.meta.empty ? E(j.meta.emptyReason)
        : '「只做龙头」纪律下已剔除 ' + E((j.excluded || []).length) + ' 只后排 / 孤立涨停。可切换「全池对照」查看被剔除标的，或放宽地位筛选。系统不会用推测数据填充。') +
      '</span></div>';
    const body = list.length
      ? '<div class="dg-layout"><div class="dg-list" id="dgList">' + dgListItems(j) + '</div>' +
      '<div class="dg-detail" id="dgDetail"></div></div>'
      : empty;
    const excl = (j.excluded || []).length && Number(S.dgOpts.showAll) === 0
      ? '<div class="card pad dg-card dg-excluded"><div class="dg-h5">「只做龙头」纪律剔除（' + E(j.excluded.length) + ' 只，仅作对照）</div>' +
      '<div class="dg-excl-tags">' + j.excluded.slice(0, 18).map(x =>
        '<span class="tag" title="' + E(x.roleReason) + '">' + boardBadge(x.code) + E(x.name) + ' ' + E(x.boardLabel || (x.boards + '板')) + ' · ' + E(x.role) + '</span>').join('') +
      (j.excluded.length > 18 ? '<span class="small muted">等共 ' + E(j.excluded.length) + ' 只</span>' : '') + '</div></div>' : '';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';
    $('pane-dragon').innerHTML = dgHead(j) + dgSource(j) + nwPanel() + dgSentimentCard(j) +
      '<div class="dg-grid2">' + dgLadderCard(j) + dgThemesCard(j) + '</div>' +
      dgThemeUnderstandingCard(j) +
      focus + dgValidationCard(j) + dgEdgeLegendCard() + dgMethodCard(j) + dgRiskMethodCard(j) + body + excl + disc;

    $('dgReload').onclick = () => loadDragon(true);
    $('dgShowAll').onchange = e => { S.dgOpts.showAll = Number(e.target.value); loadDragon(true); };
    $('dgRole').onchange = e => { S.dgOpts.role = e.target.value; loadDragon(true); };
    $('dgDays').onchange = e => { S.dgOpts.days = Number(e.target.value); loadDragon(true); };
    $('dgSort').onchange = e => { S.dgOpts.sort = e.target.value; loadDragon(true); };
    $('dgHistOpen').onclick = () => {
      S.dgHistOpen = true;
      const d = (j.meta && j.meta.historyDates || []).length ? j.meta.historyDates[0].date : null;
      loadDragonHistory(d, false);
    };
    $('dgMethod').onclick = () => {
      S.dgMethodOpen = !S.dgMethodOpen;
      $('dgMethodBox').style.display = S.dgMethodOpen ? '' : 'none';
      $('dgMethod').textContent = (S.dgMethodOpen ? '收起' : '查看') + '打法口径';
    };
    $('pane-dragon').querySelectorAll('.dg-item').forEach(el => {
      el.onclick = () => {
        S.dgSelected = el.dataset.code;
        $('pane-dragon').querySelectorAll('.dg-item').forEach(n => n.classList.toggle('active', n === el));
        renderDragonDetail();
      };
    });
    renderDragonDetail();
    renderNewsPanel();
  }

  async function fetchDragonJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/dragon?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '），请确认访问的是本系统地址'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        if (!S.dg) $('pane-dragon').innerHTML = '<div class="card empty">本地服务未响应，正在重连…（第 ' + (i + 1) + ' 次）</div>';
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  async function loadDragon(force) {
    if (S.dgLoading) return;
    S.dgLoading = true;
    if (!S.dg) $('pane-dragon').innerHTML = '<div class="card empty">正在回溯涨停/炸板池、核对连板梯队与封板质量，生成明日观察清单…</div>';
    const q = new URLSearchParams();
    const o = S.dgOpts;
    ['days', 'showAll', 'sort', 'sortDir', 'role', 'limit'].forEach(k => {
      if (o[k] !== '' && o[k] !== undefined && o[k] !== null) q.set(k, o[k]);
    });
    // 复用全局筛选（与本模块相关的字段）
    const f = collectFilters();
    ['board', 'capMin', 'capMax', 'excludeST', 'keyword'].forEach(k => {
      if (f[k] !== '' && f[k] !== undefined && f[k] !== null) q.set(k, f[k]);
    });
    q.set('edgeDays', String(S.edgeDays));
    if (force) q.set('force', '1');
    try {
      const j = await fetchDragonJson(q);
      S.dg = j; S.dgAt = Date.now(); S.dgError = null; S.dgFilters = S.lastFilters;
      if (j.edgeStats && (!j.edgeStats.window || Number(j.edgeStats.window.requestedDays) === S.edgeDays)) S.edgeStats = j.edgeStats;
      const list = j.list || [];
      if (!list.some(x => x.code === S.dgSelected)) S.dgSelected = list.length ? list[0].code : null;
      renderDragon();
      $('badgeDragon').textContent = list.length;
      const codes = list.map(x => x.code).join(',');
      const changed = S.newsCodes !== codes;
      S.newsCodes = codes;
      if (S.tab === 'dragon') {
        if (!S.news) startNewsMonitor();
        else if (changed) loadNews(false);
        else scheduleNews(S.newsInterval);
      }
    } catch (e) {
      S.dgError = e.message;
      const offline = isConnError(e);
      $('badgeDragon').textContent = '—';
      $('pane-dragon').innerHTML = '<div class="card empty"><b>明日龙头数据加载失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (offline ? E(SERVICE_HINT)
          : '服务端或上游数据源返回异常；系统不会用推测数据填充，稍后可点下方按钮重试。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="dgRetry">重新扫描</button></div>';
      $('dgRetry').onclick = () => loadDragon(true);
      if (offline) watchService('dragon');
    } finally { S.dgLoading = false; }
  }

  /* ─────────────── 消息面实时监控（明日龙头） ─────────────── */
  const nwTime = t => { const s = String(t || ''); return s.length >= 16 ? s.slice(5, 16) : (s || '—'); };
  const nwToneCls = x => x.tone === 'bull' ? 'nw-bull' : (x.tone === 'bear' ? 'nw-bear' : 'nw-neutral');
  const nwToneLabel = x => (x.toneLabel || '中性') + (x.severity === 'high' && x.tone === 'bear' ? ' · 高危' : '');

  function nwPanel() {
    return '<div class="card pad nw-card" id="nwCard"><div id="nwBox"></div></div>';
  }

  function nwFilteredItems() {
    const items = (S.news && S.news.items) || [];
    const f = S.newsFilter, kw = String(S.newsKeyword || '').trim().toLowerCase();
    return items.filter(x => {
      if (f === 'linked' && !(x.matched || []).length) return false;
      if (f === 'bear' && x.tone !== 'bear') return false;
      if (f === 'bull' && x.tone !== 'bull') return false;
      if (f === 'high' && !(x.tone === 'bear' && x.severity === 'high')) return false;
      if (f === 'new' && !x.isNew) return false;
      if (kw) {
        const hay = [x.title, x.text, (x.matched || []).map(m => m.name).join(' ')].join(' ').toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
  }

  function nwItemHtml(x, compact) {
    const matched = (x.matched || []).length
      ? x.matched.map(m => '<span class="nw-code' + (m.confidence === '精确' ? ' exact' : '') + '" title="' + E(m.method) + '">' +
        boardBadge(m.code) + E(m.name) + ' ' + E(m.code) + ' · ' + E(m.confidence) + '</span>').join('')
      : '<span class="small muted">未精确关联个股（市场 / 政策面）</span>';
    const hits = (x.hits || []).length ? x.hits.map(h => E(h.words.join('、'))).join(' / ') : '—';
    const links = (x.url ? '<a href="' + E(x.url) + '" target="_blank" rel="noopener noreferrer">原文 ↗</a>' : '') +
      (x.pdfUrl ? ' <a href="' + E(x.pdfUrl) + '" target="_blank" rel="noopener noreferrer">公告 PDF ↗</a>' : '');
    const impact = (x.isLeader && (x.impact || []).length)
      ? '<div class="nw-impact"><b>条件化提示</b>' + x.impact.slice(0, compact ? 1 : 2).map(p => '<div>· ' + E(p) + '</div>').join('') + '</div>'
      : '';
    return '<div class="nw-item' + (x.isNew ? ' nw-new' : '') + '">' +
      '<div class="nw-item-top"><span class="nw-time">' + E(nwTime(x.timeText)) + '</span>' +
      '<span class="nw-kind">' + E(x.kindLabel) + '</span>' +
      '<span class="nw-tone ' + nwToneCls(x) + '">' + E(nwToneLabel(x)) + '</span>' +
      '<span class="nw-scope">' + E(x.scope) + '</span>' +
      (x.isNew ? '<span class="nw-new-badge">NEW</span>' : '') + '</div>' +
      '<div class="nw-title">' + (x.url ? '<a href="' + E(x.url) + '" target="_blank" rel="noopener noreferrer">' + E(x.title) + '</a>' : E(x.title)) + '</div>' +
      '<div class="nw-meta">' + matched + '<span class="small muted">' + E(x.media || x.source) + ' · 命中词 ' + hits + '</span>' + links + '</div>' +
      (compact ? '' : '<div class="nw-basis small muted">' + E(x.basis) + '</div>') +
      impact + '</div>';
  }

  function nwListHtml() {
    const list = nwFilteredItems();
    const shown = S.newsShowAll ? list.slice(0, 80) : list.slice(0, 12);
    if (!list.length) return '<div class="nw-empty-line">当前筛选下没有消息。系统不会用推测数据填充；可调宽时间窗口或切换筛选。</div>';
    return shown.map(x => nwItemHtml(x, false)).join('') +
      (list.length > shown.length ? '<div class="small muted nw-more-note">仅显示最近 ' + shown.length + ' 条，共 ' + list.length + ' 条；点「显示全部」展开。</div>' : '');
  }

  function renderNewsPanel() {
    const box = $('nwBox'); if (!box) return;
    const j = S.news, m = j && j.meta, su = j && j.summary;
    const err = S.newsError;
    const status = err ? '暂不可用' : (S.newsPaused ? '已暂停' : (S.newsLoading ? '刷新中' : '监控中'));
    const statusCls = err ? 'off' : (S.newsPaused ? 'pause' : 'on');
    const intervalOpts = [15, 30, 60].map(n => '<option value="' + n + '"' + (S.newsInterval === n ? ' selected' : '') + '>' + n + ' 秒</option>').join('');
    const windowOpts = [[6, '近 6 小时'], [24, '近 24 小时'], [48, '近 48 小时'], [72, '近 3 天'], [168, '近 7 天']]
      .map(p => '<option value="' + p[0] + '"' + (S.newsWindow === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('');
    const filterOpts = [['all', '全部消息'], ['linked', '仅关联个股'], ['bear', '仅利空'], ['bull', '仅利多'], ['high', '仅高危风险'], ['new', '仅本轮新增']]
      .map(p => '<option value="' + p[0] + '"' + (S.newsFilter === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('');
    const srcDetail = m ? '（' + (m.sources || []).map(s => E(s.label) + (s.ok ? '✓' : '✗')).join(' ') + '）' : '';

    const head = '<div class="nw-head"><div class="nw-title-line"><h4>消息面 · 实时监控</h4>' +
      '<span class="nw-status ' + statusCls + '" id="nwStatus"><i></i>' + status + '</span>' +
      '<span class="small muted">公告 / 7×24 快讯 / 财经资讯 · 规则归类</span></div>' +
      '<div class="nw-ctl">' +
      '<label class="small muted">轮询 <select class="sel" id="nwInterval">' + intervalOpts + '</select></label>' +
      '<label class="small muted">窗口 <select class="sel" id="nwWindow">' + windowOpts + '</select></label>' +
      '<label class="small muted">筛选 <select class="sel" id="nwFilter">' + filterOpts + '</select></label>' +
      '<input class="nw-input" id="nwKeyword" placeholder="搜索标题 / 个股" value="' + E(S.newsKeyword) + '">' +
      '<button class="btn" id="nwPause">' + (S.newsPaused ? '继续监控' : '暂停') + '</button>' +
      '<button class="btn btn-primary" id="nwReload">立即刷新</button>' +
      '<button class="btn" id="nwMethod">' + (S.newsMethodOpen ? '收起' : '查看') + '监控口径</button>' +
      '</div></div>';

    const statusbar = '<div class="nw-statusbar">' +
      '<span class="small muted">上次刷新 <b>' + (S.newsAt ? E(new Date(S.newsAt).toTimeString().slice(0, 8)) : '—') + '</b></span>' +
      '<span class="small muted">下次 <b id="nwCountdown">' + (S.newsPaused ? '已暂停' : '—') + '</b></span>' +
      '<span class="small muted">数据源 <b>' + (m ? E(m.sourcesOnline) + '/' + E(m.sourcesTotal) : '—') + '</b> 在线' + srcDetail + '</span>' +
      (m ? '<span class="small muted">候选 ' + E(m.codesCount) + ' 只 · 公告 ' + E(m.annCount) + ' 条 / 快讯 ' + E(m.flashCount) + ' 条 · 服务端 ' + E(m.elapsedMs) + 'ms</span>' : '') +
      '<span class="small muted">口径：北京时间 · 公开接口轮询，非交易所官方推送</span></div>' +
      (err ? '<div class="nw-error"><b>消息源暂不可用：</b>' + E(err) + '（' + (isConnError({ message: err }) ? E(SERVICE_HINT) : '上游接口临时异常') + '）下次轮询会自动重试，已有消息保留展示。</div>' : '');

    const kpis = su ? [
      ['关联候选利多', su.byToneLeader.bull, 'nw-bull'], ['关联候选利空', su.byToneLeader.bear, 'nw-bear'],
      ['高危风险', su.highRisk, 'nw-warn'], ['关联候选', su.leaderCount, 'nw-purple'],
      ['本轮新增', m ? m.newCount : 0, 'nw-blue'], ['消息总数', su.total, '']
    ].map(p => '<div class="nw-kpi"><span>' + E(p[0]) + '</span><b class="' + p[2] + '">' + E(p[1]) + '</b></div>').join('') : '';

    const alerts = (j && j.alerts) || [];
    const alertHtml = '<div class="nw-alerts"><div class="nw-h5">个股预警 <span class="small muted">精确关联当前候选 · 高危优先 · 最多 6 条</span></div>' +
      (alerts.length ? alerts.slice(0, 6).map(x => nwItemHtml(x, true)).join('')
        : '<div class="nw-empty-line">' + (j ? '当前窗口内未监控到与候选精确关联的利空 / 利多消息；系统不会填充推测数据。' : '正在建立首轮消息基线…') + '</div>') + '</div>';

    const list = nwFilteredItems();
    const stream = j ? '<div class="nw-stream"><div class="nw-h5">实时消息流 <span class="small muted">共 ' + E(list.length) + ' 条 · 按时间倒序</span></div>' +
      '<div id="nwList">' + nwListHtml() + '</div>' +
      (list.length > 12 ? '<button class="btn" id="nwMore">' + (S.newsShowAll ? '收起' : '显示全部 ' + list.length + ' 条') + '</button>' : '') + '</div>' : '';

    const method = j && j.methodology ? '<div class="nw-method" id="nwMethodBox" style="display:' + (S.newsMethodOpen ? '' : 'none') + '">' +
      j.methodology.rules.map(r => '<div class="nw-rule"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(j.methodology.caveat) + '</div></div>' : '';

    const foot = '<div class="nw-foot small muted">' + (m ? E(m.note) : '首轮加载将建立消息基线，之后按轮询间隔标记新增。') +
      ' · 消息面不参与龙头评分，也不改写一致度 / 分歧度与明日剧本；不构成投资建议。</div>';

    box.innerHTML = head + statusbar + (kpis ? '<div class="nw-kpis">' + kpis + '</div>' : '') +
      (err ? '' : alertHtml + stream) + method + foot;

    const bind = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
    bind('nwInterval', 'onchange', e => { S.newsInterval = Number(e.target.value); scheduleNews(S.newsInterval); renderNewsPanel(); });
    bind('nwWindow', 'onchange', e => { S.newsWindow = Number(e.target.value); loadNews(true); });
    bind('nwFilter', 'onchange', e => { S.newsFilter = e.target.value; renderNewsPanel(); });
    bind('nwKeyword', 'oninput', e => {
      S.newsKeyword = e.target.value;
      const el = $('nwList'); if (el) el.innerHTML = nwListHtml();
    });
    bind('nwPause', 'onclick', () => {
      S.newsPaused = !S.newsPaused;
      if (S.newsPaused) { if (S.newsTimer) { clearTimeout(S.newsTimer); S.newsTimer = null; } S.newsNextAt = 0; }
      else { scheduleNews(S.newsInterval); loadNews(false); }
      renderNewsPanel();
    });
    bind('nwReload', 'onclick', () => loadNews(true));
    bind('nwMethod', 'onclick', () => {
      S.newsMethodOpen = !S.newsMethodOpen;
      const el = $('nwMethodBox'); if (el) el.style.display = S.newsMethodOpen ? '' : 'none';
      $('nwMethod').textContent = (S.newsMethodOpen ? '收起' : '查看') + '监控口径';
    });
    bind('nwMore', 'onclick', () => { S.newsShowAll = !S.newsShowAll; renderNewsPanel(); });
  }

  /** 龙头详情内的该股消息（精确 / 字面匹配都列，标注匹配方式） */
  function nwDetailCard(x) {
    const j = S.news;
    const head = '<div class="card pad nw-detail"><div class="dg-h5">消息面 · 该股关联（近 ' + E(j ? j.meta.windowHours : S.newsWindow) + ' 小时）</div>';
    if (!j) return head + '<div class="small muted">消息监控尚未加载或已暂停。</div></div>';
    const rows = (j.items || []).filter(it => (it.matched || []).some(m => m.code === x.code)).slice(0, 6);
    if (!rows.length) return head + '<div class="small muted">近 ' + E(j.meta.windowHours) +
      ' 小时未监控到与该股关联的公告 / 快讯；系统不会用推测数据填充，重大事项请点交易所公告原文核实。</div></div>';
    return head + rows.map(it => {
      const mm = (it.matched || []).find(m => m.code === x.code) || {};
      return '<div class="nw-detail-row"><span class="nw-tone ' + nwToneCls(it) + '">' + E(nwToneLabel(it)) + '</span>' +
        '<span class="nw-detail-time">' + E(nwTime(it.timeText)) + '</span>' +
        (it.isNew ? '<span class="nw-new-badge">NEW</span>' : '') +
        '<div class="nw-detail-title">' + (it.url ? '<a href="' + E(it.url) + '" target="_blank" rel="noopener noreferrer">' + E(it.title) + '</a>' : E(it.title)) + '</div>' +
        '<div class="small muted">' + E(it.kindLabel) + ' · ' + E(it.media || it.source) + ' · 关联方式 ' + E(mm.method || '—') + '</div>' +
        ((it.impact || []).length ? '<div class="nw-impact-mini">' + E(it.impact[0]) + '</div>' : '') + '</div>';
    }).join('') + '<div class="small muted">关键词规则归类，务必点开原文核实；消息面不参与本页评分。</div></div>';
  }

  /** 只更新状态徽标，避免每次轮询重绘整块面板打断关键字输入 */
  function updateNwStatus() {
    const el = $('nwStatus'); if (!el) return;
    const st = S.newsError ? '暂不可用' : (S.newsPaused ? '已暂停' : (S.newsLoading ? '刷新中' : '监控中'));
    const cls = S.newsError ? 'off' : (S.newsPaused ? 'pause' : 'on');
    el.className = 'nw-status ' + cls;
    el.innerHTML = '<i></i>' + st;
  }

  function scheduleNews(sec) {
    if (S.newsTimer) { clearTimeout(S.newsTimer); S.newsTimer = null; }
    if (S.newsPaused || S.tab !== 'dragon') { S.newsNextAt = 0; return; }
    const s = Math.max(5, Number(sec) || 30);
    S.newsNextAt = Date.now() + s * 1000;
    S.newsTimer = setTimeout(() => {
      S.newsTimer = null;
      if (!S.newsPaused && S.tab === 'dragon') loadNews(false);
    }, s * 1000);
  }

  function startNewsTicker() {
    if (S.newsTickTimer) clearInterval(S.newsTickTimer);
    S.newsTickTimer = setInterval(() => {
      const el = $('nwCountdown'); if (!el) return;
      if (S.newsPaused || !S.newsNextAt) { el.textContent = S.newsPaused ? '已暂停' : '—'; return; }
      el.textContent = Math.max(0, Math.ceil((S.newsNextAt - Date.now()) / 1000)) + ' 秒后';
    }, 1000);
  }

  function stopNewsMonitor() {
    if (S.newsTimer) { clearTimeout(S.newsTimer); S.newsTimer = null; }
    if (S.newsTickTimer) { clearInterval(S.newsTickTimer); S.newsTickTimer = null; }
    S.newsNextAt = 0;
  }

  function startNewsMonitor() {
    if (S.tab !== 'dragon') return;
    startNewsTicker();
    if (!S.news && !S.newsLoading) loadNews(false);
    else if (!S.newsPaused) scheduleNews(S.newsInterval);
  }

  async function loadNews(force) {
    if (S.newsLoading) return;
    S.newsLoading = true;
    updateNwStatus();
    const q = new URLSearchParams();
    q.set('window', String(S.newsWindow));
    q.set('scope', Number(S.dgOpts.showAll) === 1 ? 'pool' : 'leaders');
    q.set('limit', '60');
    const codes = ((S.dg && S.dg.list) || []).map(x => x.code).filter(Boolean).slice(0, 60);
    if (codes.length) q.set('codes', codes.join(','));
    if (S.newsSince) q.set('since', S.newsSince);
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/news?' + q.toString(), { cache: 'no-store' });
      let j;
      try { j = await r.json(); }
      catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.news = j; S.newsAt = Date.now(); S.newsSince = j.meta.generatedAt; S.newsError = null;
      renderNewsPanel();
      if (S.dg) renderDragonDetail();
    } catch (e) {
      S.newsError = String(e && e.message || e);
      if ($('nwBox')) renderNewsPanel();
    } finally {
      S.newsLoading = false;
      updateNwStatus();
      if (S.tab === 'dragon' && !S.newsPaused) scheduleNews(S.newsInterval);
    }
  }

  /* ─────────────── 页脚 ─────────────── */
  function renderFooter(d) {
    const m = d.meta;
    $('sourceInfo').innerHTML =
      '本地服务：http://localhost:' + E(m.port || '8899') + '（端口被占用时自动顺延，以启动控制台输出为准）<br>' +
      '全市场广度：新浪财经行情中心（' + E(m.universeCount) + '/' + E(m.universeExpected) + ' 只，快照 ' + E(m.universeTick || '—') + '）<br>' +
      '实时快照 / 指数：腾讯证券行情（快照 ' + E(m.quoteCount) + ' 只，时点 ' + E(m.quoteTick || '—') + '）<br>' +
      '日K（多源自动降级）：' + E(m.klineSource || '全部不可用') + '，本轮成功 ' + E(m.klineCount) + ' 只；腾讯 web 域触发 WAF 时自动切 ifzq 域 / 新浪不复权日K<br>' +
      '涨停 / 炸板 / 强势 / 跌停池（含连板数、封单、行业）：东方财富涨停池，交易日 ' + E(m.poolDate || '—') + '<br>' +
      '行业 / 概念板块：新浪财经板块行情<br>' +
      '服务端生成时点：' + E(m.generatedAt) + '，耗时 ' + E(m.elapsedMs) + ' ms；北京时间口径 ' + E(m.now);
    $('healthList').innerHTML = (m.health || []).map(h =>
      '<div class="health-item"><span class="hdot' + (h.ok || (!h.lastTry && NEWS_KEYS.indexOf(h.key) >= 0) ? '' : (h.degraded ? ' warn' : ' bad')) + '"></span><b>' + E(h.label) + (h.sourceLabel ? ' · ' + E(h.sourceLabel) : '') + '</b>' +
      (h.standby || (!h.lastTry && NEWS_KEYS.indexOf(h.key) >= 0) ? '<span class="mini-tag">' + (h.standby ? '备用源' : '按需') + '</span>' : '') +
      (h.degraded ? '<span class="mini-tag" style="color:var(--warn)">已降级</span>' : '') +
      '<span class="muted">' + (h.ok ? '在线 · ' + E(h.rows) + ' 条 · ' + E(h.latency) + 'ms'
        : (h.degraded ? '降级 · ' + E(h.error || '备用源接管')
          : (h.standby ? '未启用（主源可用时不调用）'
            : (!h.lastTry && NEWS_KEYS.indexOf(h.key) >= 0 ? '待加载（「明日龙头」启用后调用）' : '异常 · ' + E(h.error || '未知'))))) + '</span></div>'
    ).join('') +
      ((m.health || []).some(h => h.key === 'qqKline' && (h.degraded || !h.ok)) && (m.health || []).some(h => h.standby && h.ok)
        ? '<div class="note-box" style="margin-top:8px"><b>日K口径提示：</b>腾讯前复权日K被 WAF 限流，系统已自动切换「新浪财经日K（不复权）」并进入 2 分钟冷却，冷却结束后自动探活恢复前复权口径。使用备用源期间，历史价位划线、支撑位与回撤测算可能与前复权口径不一致，相关模块已如实标注；请以交易所行情为准。</div>' : '');
  }

  /* ─────────────── 龙场悟道 · 多方法回测选优 ─────────────── */
  async function loadEnlightenment(force) {
    if (S.enLoading) return;
    S.enLoading = true;
    if (!S.en) $('pane-enlighten').innerHTML = '<div class="card empty">正在回放近 ' + S.enOpts.days +
      ' 个交易日涨停池、逐只核对次日真实日K，比较六种可量化短线方法…</div>';
    const q = new URLSearchParams({ days: S.enOpts.days });
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/enlightenment?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.en = j; S.enError = null;
      renderEnlightenment();
      $('badgeEn').textContent = j.best ? String(j.best.name).slice(0, 6) : '已回测';
    } catch (e) {
      S.enError = e.message;
      $('pane-enlighten').innerHTML = '<div class="card empty"><b>回测未完成：' + E(e.message) +
        '</b><br><span class="small muted">系统不会用推测数据填充，可点下方按钮重试。</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="enRetry">重新回测</button></div>';
      $('enRetry').onclick = () => loadEnlightenment(true);
    } finally { S.enLoading = false; }
  }

  /* ═══════════ 支撑位反转 · 回调后主力资金首次翻红（回测 + 当日信号） ═══════════ */
  function srMethodCard() {
    const meth = (S.support && S.support.result && S.support.result.method) || {};
    const points = meth.points || [];
    const open = S.supportMethodOpen;
    return '<div class="card pad dg-card" style="margin-top:12px">' +
      '<div class="dg-card-head"><h4>口径与免责说明</h4>' +
      '<button class="btn btn-ghost btn-sm" id="srMethodToggle">' + (open ? '收起' : '查看') + '全部口径</button></div>' +
      '<div id="srMethodBody" style="display:' + (open ? '' : 'none') + '">' +
      points.map(p => '<div class="kv"><span class="k">' + E(p.name) + '</span><span class="v">' + E(p.text) + '</span></div>').join('') +
      '</div></div>';
  }
  const srPct = (v, suf) => v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + N(v) + (suf || '');
  // 影响服务端候选池的筛选签名（其余全局筛选项与该模块无关，不应触发长耗时回测）
  function srFilterSignature(f) {
    const x = f || collectFilters();
    return [x.board || '全部', x.capMin || '', x.capMax || '', S.supportOpts.board || '全部'].join('|');
  }
  function srAppliedFilters(m) {
    const f = (m && m.filters) || {};
    const out = ['市场板块=' + (f.boards && f.boards.length ? f.boards.join('/') : (f.board || '全部'))];
    if (f.localBoard) out.push('模块板块=' + f.localBoard);
    if ((f.capMin !== null && f.capMin !== undefined) || (f.capMax !== null && f.capMax !== undefined)) {
      out.push('流通市值=' + (f.capMin === null || f.capMin === undefined ? '0' : f.capMin) + '~' +
        (f.capMax === null || f.capMax === undefined ? '∞' : f.capMax) + '亿');
    }
    if (m && m.eligibleCount !== undefined && m.eligibleCount !== null) out.push('命中候选 ' + m.eligibleCount + ' 只');
    if (m && m.usedCodes !== undefined && m.usedCodes !== null) out.push('有效样本池 ' + m.usedCodes + ' 只');
    return out.join(' · ');
  }
  // 主回测与样本分页共用同一组参数，保证两次请求命中同一份服务端缓存
  function srQueryParams() {
    const o = S.supportOpts, f = collectFilters();
    const q = new URLSearchParams({
      scan: String(o.scan), window: String(o.window), minDraw: String(o.minDraw),
      bandPct: String(o.bandPct), smallYang: String(o.smallYang), lookback: String(o.lookback)
    });
    ['board', 'capMin', 'capMax'].forEach(k => {
      if (f[k] !== '' && f[k] !== undefined && f[k] !== null) q.set(k, f[k]);
    });
    q.set('srBoard', o.board || '全部');
    return q;
  }
  const SR_SAMPLE_PAGE = 80;
  function srSampleKey() { return srQueryParams().toString(); }
  function srSampleRow(s) {
    const n = s.next || {};
    return '<tr><td>' + E(fmtDate(s.date)) + '</td>' +
      '<td><span class="stock-link" data-stock-code="' + E(s.code) + '">' + E(s.name) + '</span> <span class="em-code">' + E(s.code) + '</span></td>' +
      '<td>' + E(s.shape === 'doji' ? '十字星' : '小阳线') + '</td>' +
      '<td class="down">' + E(s.drawdown) + '%</td><td class="up">' + E((s.main / 1e8).toFixed(2)) + '亿</td>' +
      (s.pending || !s.next ? '<td colspan="3" class="muted">pending（待次日）</td>' :
        '<td class="' + (n.limitUp ? 'up' : '') + '">' + (n.limitUp ? '涨停 +' + E(n.pct) + '%' : E(n.pct) + '%') + '</td>' +
        '<td class="' + (n.retOC > 0 ? 'up' : n.retOC < 0 ? 'down' : '') + '">' + srPct(n.retOC, '%') + '</td>' +
        '<td class="' + (n.retCC > 0 ? 'up' : n.retCC < 0 ? 'down' : '') + '">' + srPct(n.retCC, '%') + '</td>') +
      '</tr>';
  }
  function srSampleStatus() {
    const st = S.srSamples;
    const total = st.total === null ? '…' : st.total;
    const tail = st.loading ? '正在加载更早数据…'
      : st.error ? '加载失败：' + st.error + '（可点下方按钮重试）'
        : st.done ? '已到最早一条' : '向下滚动继续查看更早数据';
    return '已载入 ' + st.rows.length + ' / ' + total + ' 条历史信号 · ' + tail;
  }
  function renderSrSampleRows(appendFrom) {
    const body = $('srSamplesBody'), wrap = $('srSamplesScroll'), st = S.srSamples;
    if (!body || !wrap) return;
    if (appendFrom !== undefined && body.rows.length === appendFrom && st.rows.length > appendFrom) {
      // 触底追加：只插新行，避免越滚越大时全量重建导致卡顿与跳动
      body.insertAdjacentHTML('beforeend', st.rows.slice(appendFrom).map(srSampleRow).join(''));
    } else {
      const top = wrap.scrollTop;
      body.innerHTML = st.rows.length ? st.rows.map(srSampleRow).join('')
        : '<tr><td colspan="8" class="empty">' + (st.loading ? '正在载入历史信号样本…' : st.error ? '样本载入失败' : '无信号样本') + '</td></tr>';
      wrap.scrollTop = top;
    }
    const c = $('srSampleCount'); if (c) c.textContent = '共 ' + (st.total === null ? '…' : st.total) + ' 条';
    const h = $('srSampleHint'); if (h) h.textContent = srSampleStatus();
    const more = $('srSampleMore');
    if (more) more.style.display = (!st.done && !st.loading && (st.rows.length || st.error)) ? '' : 'none';
  }
  async function loadSrSamples(reset) {
    const st = S.srSamples, key = st.key;
    if (reset) { st.rows = []; st.offset = 0; st.total = null; st.done = false; st.error = ''; }
    if (st.loading || st.done || !$('srSamplesBody')) return;
    st.loading = true; st.error = '';
    renderSrSampleRows();
    let appendedFrom = null;
    const q = srQueryParams();
    q.set('offset', String(st.offset)); q.set('limit', String(SR_SAMPLE_PAGE));
    try {
      const resp = await fetch('/api/support-reversal/samples?' + q.toString(), { cache: 'no-store' });
      const j = await resp.json();
      if (!resp.ok || !j.ok) throw new Error(j.error || ('HTTP ' + resp.status));
      if (S.srSamples.key !== key) return; // 筛选已变化，丢弃过期响应
      appendedFrom = st.rows.length;
      st.rows = st.rows.concat(j.rows || []);
      st.offset += (j.rows || []).length;
      st.total = j.total;
      st.done = !(j.rows || []).length || st.offset >= (j.total || 0);
    } catch (e) {
      if (S.srSamples.key === key) st.error = e.message;
    } finally {
      st.loading = false;
      if (S.srSamples.key === key) renderSrSampleRows(appendedFrom === null ? undefined : appendedFrom);
    }
  }
  function bindSrSamples() {
    const wrap = $('srSamplesScroll');
    if (!wrap) return;
    const key = srSampleKey();
    if (S.srSamples.key !== key) {
      S.srSamples = { key, rows: [], offset: 0, total: null, loading: false, done: false, error: '' };
    }
    renderSrSampleRows();
    wrap.onscroll = () => {
      if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 160) loadSrSamples(false);
    };
    const more = $('srSampleMore');
    if (more) more.onclick = () => loadSrSamples(false);
    if (!S.srSamples.rows.length && !S.srSamples.loading) loadSrSamples(false);
  }
  function renderSupportReversal() {
    const j = S.support;
    if (!j) return;
    if (!j.ok || !j.result) {
      $('pane-support').innerHTML = '<div class="card empty"><b>回测失败：' + E(j.error || '数据不足') + '</b><br>' +
        '<span class="small muted">' + (isConnError(j) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="srRetry">重新回测</button></div>';
      const rb = $('srRetry'); if (rb) rb.onclick = () => loadSupportReversal(true);
      return;
    }
    const m = j.meta || {}, r = j.result;
    const ov = r.overall || {};
    const o = S.supportOpts;
    // 顶部控制条
    const head = '<div class="card pad"><div class="pb-controls">' +
      '<label>扫描 <select class="sel" id="srScan">' + [300, 600, 900, 1200].map(n => '<option value="' + n + '"' + (o.scan === n ? ' selected' : '') + '>' + n + ' 只</option>').join('') + '</select></label>' +
      '<label>回测 <select class="sel" id="srWindow">' + [30, 60, 90, 120].map(n => '<option value="' + n + '"' + (o.window === n ? ' selected' : '') + '>近 ' + n + ' 日</option>').join('') + '</select></label>' +
      '<label>最小回撤 <select class="sel" id="srDraw">' + [3, 4, 6, 8, 10].map(n => '<option value="' + n + '"' + (o.minDraw === n ? ' selected' : '') + '>' + n + '%</option>').join('') + '</select></label>' +
      '<label>形态 <select class="sel" id="srShape">' + ['全部', '十字星', '小阳线'].map(v => '<option value="' + v + '"' + (o.shape === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></label>' +
      '<label>板块 <select class="sel" id="srBoard">' + ['全部', '主板', '创业板', '科创板'].map(v => '<option value="' + v + '"' + (o.board === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></label>' +
      '<button class="btn btn-primary" id="srRefresh">重新回测</button>' +
      '<span class="small muted">首次扫描约需 ' + (o.scan >= 900 ? '60~90' : '30~60') + ' 秒，结果缓存 10 分钟；改板块/市值会按新条件重算</span></div>' +
      '<div class="small" style="margin-top:8px"><b>已生效筛选</b>：' + E(srAppliedFilters(m)) +
      (S.srLoadingNote ? ' · <b>' + E(S.srLoadingNote) + '</b>' : '') + '</div>' +
      '<div class="small muted" style="margin-top:5px">候选口径：' + E(m.candidateNote || '') + '</div></div>';
    // KPI 概览
    const kpi = '<div class="card pad" style="margin-top:12px"><div class="sr-kpis">' +
      '<div class="pb-kpi"><span>有效样本 / 信号</span><b>' + E(r.counted) + ' <span class="small muted">/ ' + E(r.signalCount) + '</span></b></div>' +
      '<div class="pb-kpi"><span>次日涨停率</span><b class="up">' + E(ov.limitRate == null ? '—' : ov.limitRate + '%') + '</b></div>' +
      '<div class="pb-kpi"><span>次日开→收 均收益</span><b class="' + (ov.retOC > 0 ? 'up' : ov.retOC < 0 ? 'down' : '') + '">' + srPct(ov.retOC, '%') + '</b></div>' +
      '<div class="pb-kpi"><span>信号收→次收 均收益</span><b class="' + (ov.retCC > 0 ? 'up' : ov.retCC < 0 ? 'down' : '') + '">' + srPct(ov.retCC, '%') + '</b></div>' +
      '<div class="pb-kpi"><span>次日上涨占比(开→收)</span><b>' + E(ov.winOC == null ? '—' : ov.winOC + '%') + '</b></div>' +
      '<div class="pb-kpi"><span>最新信号日</span><b>' + E(fmtDate(r.latestDate)) + '</b></div>' +
      '</div><div class="small muted" style="margin-top:8px">资金口径：' + E(m.fundCaliber || r.fundCaliber || '') +
      ' · 资金源：' + E((m.fundSources || []).map(x => x.source + '(' + x.n + ')').join(' / ') || '—') + '</div></div>';
    // 分档对比表
    const tierRows = (arr, label) => arr.map(x => '<tr><td>' + E(label + x.label) + '</td><td>' + E(x.n) + '</td>' +
      '<td>' + E(x.n >= 8 && x.limitRate != null ? x.limitRate + '%' : (x.limitRate == null ? '—' : '样本少')) + '</td>' +
      '<td class="' + (x.retOC > 0 ? 'up' : x.retOC < 0 ? 'down' : '') + '">' + srPct(x.retOC, '%') + '</td>' +
      '<td class="' + (x.retCC > 0 ? 'up' : x.retCC < 0 ? 'down' : '') + '">' + srPct(x.retCC, '%') + '</td>' +
      '<td>' + E(x.winOC == null ? '—' : x.winOC + '%') + '</td></tr>').join('');
    const tiers = '<div class="card pad" style="margin-top:12px"><div class="sm-block-head"><h4>分档对比（次日涨停率 / 收益）</h4>' +
      '<span class="small muted">样本 &lt;8 只显示计数不显示概率</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>分档</th><th>样本</th><th>次日涨停率</th><th>开→收均收益</th><th>收→收均收益</th><th>上涨占比</th></tr></thead><tbody>' +
      tierRows(r.shapes || [], '形态·') + tierRows(r.draws || [], '回调·') +
      '</tbody></table></div></div>';
    // 当日信号列表（按形态/板块筛选）
    let list = (r.list || []).filter(x => (o.shape === '全部' || x.shapeLabel === o.shape) && (o.board === '全部' || x.board === o.board));
    // 股吧人气优先：排名越小越热，未上榜或接口不可用排末尾并回退到资金排序
    const rankOf = x => Number(x.popRank) > 0 ? Number(x.popRank) : Infinity;
    const popAvail = Number(m.popularityCount) > 0;
    const byPop = o.sort === 'pop' && popAvail;
    list = list.slice().sort((a, b) => byPop
      ? (rankOf(a) - rankOf(b) || (b.main || 0) - (a.main || 0))
      : ((b.main || 0) - (a.main || 0) || rankOf(a) - rankOf(b)));
    const sortSel = '<label class="small muted">排序 </label><select class="sel" id="srSort">' +
      '<option value="pop"' + (o.sort === 'pop' ? ' selected' : '') + '>股吧实时人气</option>' +
      '<option value="main"' + (o.sort === 'main' ? ' selected' : '') + '>主力净流入</option></select>';
    const listCard = '<div class="card pad" style="margin-top:12px"><div class="sm-block-head"><h4>最新信号股（' + E(fmtDate(r.latestDate)) + ' · ' + list.length + ' 只）</h4>' +
      '<span class="small muted">' + sortSel + ' · 概率=历史同形态次日涨停率</span></div>' +
      '<div class="small muted" style="margin:2px 0 8px">' + E(m.popularityNote || '') + (byPop ? '' : ' · 当前按主力净额排序') + '</div>' +
      (list.length ? '<div class="sr-list">' + list.map(x =>
        '<div class="pb-item" data-code="' + E(x.code) + '">' +
        '<div class="pb-item-top"><span class="stock-link" data-stock-code="' + E(x.code) + '"><b>' + E(x.name) + '</b> <span class="em-code">' + E(x.code) + '</span></span>' +
        '<span class="tag ' + (x.shape === 'doji' ? 'blue' : 'red') + '">' + E(x.shapeLabel) + '</span>' +
        '<span class="tag">' + E(x.board) + '</span>' +
        (Number(x.popRank) > 0 ? '<span class="tag blue">股吧人气 #' + E(x.popRank) + '</span>' : '<span class="tag">股吧人气 —</span>') +
        '<span class="sr-spacer"></span><span class="sr-prob">次日涨停率 <b>' + E(x.prob === null ? '—' : x.prob + '%') + '</b></span></div>' +
        '<div class="pb-item-meta"><span>收盘 <b>' + N(x.close) + '</b></span><span>当日 ' + srPct(x.pct, '%') + '</span>' +
        '<span>距高点回撤 <b class="down">' + E(x.drawdown) + '%</b></span><span>支撑参考 ' + N(x.support) + '</span>' +
        '<span>主力净额 <b class="up">' + E(x.mainYi) + '亿</b>（前 ' + E((x.prevMain / 1e8).toFixed(2)) + '亿）</span>' +
        '<span>流通市值 ' + E(x.floatCap === null || x.floatCap === undefined ? '—' : x.floatCap + '亿') + '</span>' +
        '<span>预期开→收 ' + srPct(x.expOC, '%') + '</span></div>' +
        '<div class="small muted" style="margin-top:5px">' + E((x.basis || []).join(' · ')) + '</div>' +
        '</div>').join('') + '</div>' : '<div class="empty">当前筛选下无信号股，可调高扫描数或放宽回撤阈值</div>') + '</div>';
    // 最近样本明细：固定高度滚动容器 + 触底自动加载更早的历史信号
    const sampleCard = '<div class="card pad" style="margin-top:12px"><div class="sm-block-head">' +
      '<h4>最近信号样本（含次日结果）</h4><span class="small muted" id="srSampleCount">载入中…</span></div>' +
      '<div class="small muted" style="margin:2px 0 8px">pending=最新信号日尚无次日数据；按信号日由近到远排列，可向下滚动查看更早记录</div>' +
      '<div class="tbl-wrap sr-samples-wrap" id="srSamplesScroll"><table><thead><tr>' +
      '<th>信号日</th><th>个股</th><th>形态</th><th>回撤</th><th>主力净额</th><th>次日涨停</th><th>开→收</th><th>收→收</th>' +
      '</tr></thead><tbody id="srSamplesBody"></tbody></table></div>' +
      '<div class="small muted sr-sample-hint" id="srSampleHint">向下滚动可继续查看更早的历史信号</div>' +
      '<button class="btn btn-ghost btn-sm" id="srSampleMore" style="display:none;margin-top:8px">加载更早的样本</button>' +
      '</div>';
    $('pane-support').innerHTML = head + kpi + tiers + listCard + sampleCard + srMethodCard() +
      '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：' + E(m.disclaimer || '') + '</div>';
    // 事件
    $('srScan').onchange = e => { S.supportOpts.scan = Number(e.target.value); loadSupportReversal(true); };
    $('srWindow').onchange = e => { S.supportOpts.window = Number(e.target.value); loadSupportReversal(true); };
    $('srDraw').onchange = e => { S.supportOpts.minDraw = Number(e.target.value); loadSupportReversal(true); };
    $('srShape').onchange = e => { S.supportOpts.shape = e.target.value; renderSupportReversal(); };
    $('srSort').onchange = e => { S.supportOpts.sort = e.target.value; renderSupportReversal(); };
    $('srBoard').onchange = e => { S.supportOpts.board = e.target.value; loadSupportReversal(true); };
    $('srRefresh').onclick = () => loadSupportReversal(true);
    const mt = $('srMethodToggle'); if (mt) mt.onclick = () => { S.supportMethodOpen = !S.supportMethodOpen; renderSupportReversal(); };
    bindSrSamples();
  }
  async function loadSupportReversal(force) {
    // 长耗时扫描期间用户又改了筛选：登记待办，等当前扫描结束后按最新条件补跑一次
    if (S.supportLoading) { S.srPending = true; return; }
    S.supportLoading = true;
    S.srLoadingNote = S.support ? '筛选已变更，正在按新条件重新回测…' : '正在扫描并回测…';
    const sig = srFilterSignature();
    S.srFilters = sig;
    if (!S.support) $('pane-support').innerHTML = '<div class="card empty">正在按当前板块/市值条件筛选「回调到位 + 主力资金首次翻红 + 十字星/小阳线」个股并回测次日表现…<br><span class="small muted">首次需拉取数百只个股的日K与资金流，约 30~90 秒，请耐心等待。</span></div>';
    else renderSupportReversal();
    const q = srQueryParams();
    if (force) q.set('force', '1');
    let failed = false;
    try {
      const resp = await fetch('/api/support-reversal?' + q.toString(), { cache: 'no-store' });
      const j = await resp.json();
      if (!resp.ok || j.error) throw new Error(j.error || ('HTTP ' + resp.status));
      S.support = j; S.supportAt = Date.now(); S.supportError = null;
      S.srFilters = sig; S.srLoadingNote = '';
      renderSupportReversal();
      $('badgeSupport').textContent = ((j.result && j.result.list) || []).length || '—';
    } catch (e) {
      failed = true;
      S.supportError = e.message;
      S.srFilters = ''; // 失败后允许主刷新自动重试
      $('badgeSupport').textContent = '—';
      $('pane-support').innerHTML = '<div class="card empty"><b>回测失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (isConnError(e) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="srRetry">重新回测</button></div>';
      const rb = $('srRetry'); if (rb) rb.onclick = () => loadSupportReversal(true);
    } finally {
      S.supportLoading = false;
      S.srLoadingNote = '';
      if (S.srPending) {
        S.srPending = false;
        // 失败时不再立即补跑，交给下一次主刷新重试，避免接口异常时连续打满请求
        if (!failed) setTimeout(() => loadSupportReversal(true), 0);
      }
    }
  }

  /* ═══════════ DDX首红精选 · 复刻东财 ddx1120 动态分组 ═══════════ */
  function ddxMethodCard() {
    const meth = (S.ddx && S.ddx.result && S.ddx.result.method) || {};
    const points = meth.points || [];
    const open = S.ddxMethodOpen;
    return '<div class="card pad dg-card" style="margin-top:12px">' +
      '<div class="dg-card-head"><h4>口径与免责说明</h4>' +
      '<button class="btn btn-ghost btn-sm" id="ddxMethodToggle">' + (open ? '收起' : '查看') + '全部口径</button></div>' +
      '<div id="ddxMethodBody" style="display:' + (open ? '' : 'none') + '">' +
      points.map(p => '<div class="kv"><span class="k">' + E(p.name) + '</span><span class="v">' + E(p.text) + '</span></div>').join('') +
      '</div></div>';
  }
  function ddxFilterSignature(f) {
    const x = f || collectFilters();
    return [x.board || '全部', x.capMin || '', x.capMax || '', S.ddxOpts.board || '全部'].join('|');
  }
  function ddxAppliedFilters(m) {
    const f = (m && m.filters) || {};
    const out = ['市场板块=' + (f.boards && f.boards.length ? f.boards.join('/') : (f.board || '全部'))];
    if (f.localBoard) out.push('模块板块=' + f.localBoard);
    if ((f.capMin !== null && f.capMin !== undefined) || (f.capMax !== null && f.capMax !== undefined)) {
      out.push('流通市值=' + (f.capMin === null || f.capMin === undefined ? '0' : f.capMin) + '~' +
        (f.capMax === null || f.capMax === undefined ? '∞' : f.capMax) + '亿');
    }
    if (m && m.eligibleCount !== undefined && m.eligibleCount !== null) out.push('命中候选 ' + m.eligibleCount + ' 只');
    if (m && m.usedCodes !== undefined && m.usedCodes !== null) out.push('有效样本池 ' + m.usedCodes + ' 只');
    return out.join(' · ');
  }
  function ddxQueryParams() {
    const o = S.ddxOpts, f = collectFilters();
    const q = new URLSearchParams({
      scan: String(o.scan), window: String(o.window),
      ddxMin: String(o.ddxMin), bodyMax: String(o.bodyMax), turnMin: String(o.turnMin),
      smooth: o.smooth ? '1' : '0'
    });
    ['board', 'capMin', 'capMax'].forEach(k => {
      if (f[k] !== '' && f[k] !== undefined && f[k] !== null) q.set(k, f[k]);
    });
    q.set('ddxBoard', o.board || '全部');
    return q;
  }
  const DDX_SAMPLE_PAGE = 80;
  function ddxSampleKey() { return ddxQueryParams().toString(); }
  function ddxSampleRow(s) {
    return '<tr><td>' + E(s.date) + '</td><td class="left"><span class="stock-link" data-stock-code="' + E(s.code) + '">' + E(s.name) + '</span> <span class="em-code">' + E(s.code) + '</span></td>' +
      '<td>' + E(s.ddx) + '‱</td><td>' + E(s.body) + '%</td><td>' + E(s.turnover) + '%</td><td class="up">' + E(s.pct) + '%</td>' +
      '<td>' + (s.pending ? '<span class="muted">待验证</span>' : (s.next && s.next.limitUp ? '<b class="up">涨停</b>' : '<span class="down">' + E(s.next && s.next.pct) + '%</span>')) + '</td>' +
      '<td class="' + (s.next && s.next.retOC > 0 ? 'up' : 'down') + '">' + (s.pending || !s.next ? '—' : E(s.next.retOC) + '%') + '</td>' +
      '<td class="' + (s.next && s.next.retCC > 0 ? 'up' : 'down') + '">' + (s.pending || !s.next ? '—' : E(s.next.retCC) + '%') + '</td></tr>';
  }
  function renderDdxSampleRows() {
    const st = S.ddxSamples, body = $('ddxSamplesBody'); if (!body) return;
    body.innerHTML = st.rows.map(ddxSampleRow).join('');
    const cnt = $('ddxSampleCount'); if (cnt) cnt.textContent = '已载入 ' + st.rows.length + ' / ' + (st.total || 0) + ' 条';
    const hint = $('ddxSampleHint'); if (hint) hint.style.display = st.done ? 'none' : '';
    const more = $('ddxSampleMore'); if (more) more.style.display = st.done ? 'none' : '';
  }
  async function loadDdxSamples(reset) {
    const st = S.ddxSamples, key = ddxSampleKey();
    if (st.loading) return;
    if (reset || st.key !== key) { st.key = key; st.rows = []; st.offset = 0; st.total = null; st.done = false; st.error = ''; }
    if (st.done) return;
    st.loading = true;
    const q = ddxQueryParams(); q.set('offset', String(st.offset)); q.set('limit', String(DDX_SAMPLE_PAGE));
    try {
      const resp = await fetch('/api/ddx-first-red/samples?' + q.toString(), { cache: 'no-store' });
      const j = await resp.json();
      if (!resp.ok || !j.ok) throw new Error(j.error || ('HTTP ' + resp.status));
      st.rows = st.rows.concat(j.rows || []); st.offset = st.offset + (j.rows || []).length; st.total = j.total;
      st.done = st.offset >= (j.total || 0);
      renderDdxSampleRows();
    } catch (e) {
      st.error = e.message;
      const hint = $('ddxSampleHint'); if (hint) hint.textContent = '样本载入失败：' + E(e.message);
    } finally { st.loading = false; }
  }
  function bindDdxSamples() {
    const box = $('ddxSamplesScroll');
    if (box) box.onscroll = () => { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 160) loadDdxSamples(false); };
    const more = $('ddxSampleMore'); if (more) more.onclick = () => loadDdxSamples(false);
  }
  function renderDdxFirstRed() {
    const j = S.ddx; if (!j) return;
    if (!j.ok || !j.result) {
      $('pane-ddx').innerHTML = '<div class="card empty"><b>回测失败：' + E(j.error || '数据不足') + '</b><br>' +
        '<span class="small muted">' + (isConnError(j) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="ddxRetry">重新回测</button></div>';
      const rb = $('ddxRetry'); if (rb) rb.onclick = () => loadDdxFirstRed(true);
      return;
    }
    const m = j.meta || {}, r = j.result, ov = r.overall || {}, o = S.ddxOpts;
    const kpi = (label, val, cls) => '<div class="pb-kpi"><span>' + label + '</span><b class="' + (cls || '') + '">' + (val === null || val === undefined ? '—' : val) + '</b></div>';
    const head = '<div class="card pad">' +
      '<div class="pb-controls">' +
      '<label>扫描 <select class="sel" id="ddxScan"><option value="400">400 只</option><option value="900" selected>900 只</option><option value="1500">1500 只</option><option value="2000">全市场2000</option></select></label>' +
      '<label>回测 <select class="sel" id="ddxWindow"><option value="30">近 30 日</option><option value="60" selected>近 60 日</option><option value="90">近 90 日</option><option value="120">近 120 日</option></select></label>' +
      '<label>DDX≥ <select class="sel" id="ddxDdxMin"><option value="1" selected>1‱</option><option value="5">5‱</option><option value="10">10‱</option><option value="30">30‱</option><option value="50">50‱</option></select></label>' +
      '<label>口径 <select class="sel" id="ddxSmooth"><option value="0" selected>当日柱值</option><option value="1">DDX1平滑</option></select></label>' +
      '<label>实体≤ <select class="sel" id="ddxBodyMax"><option value="3">3%</option><option value="5" selected>5%</option><option value="8">8%</option></select></label>' +
      '<label>换手≥ <select class="sel" id="ddxTurnMin"><option value="3">3%</option><option value="5" selected>5%</option><option value="8">8%</option><option value="10">10%</option></select></label>' +
      '<label>板块 <select class="sel" id="ddxBoard"><option value="全部">全部</option><option value="主板">主板</option><option value="创业板">创业板</option><option value="科创板">科创板</option></select></label>' +
      '<button class="btn btn-primary" id="ddxRefresh">重新回测</button>' +
      '<span class="small muted">复刻东财 ddx1120：全市场换手快筛 → 当日DDX≥阈值 + 前一日<0 + 实体&lt;上限 + 换手≥下限 + 未炸板；首次约 60~120 秒</span></div>' +
      '<div class="small" style="margin-top:8px"><b>已生效筛选</b>：' + E(ddxAppliedFilters(m)) + '</div>' +
      '<div class="small muted" style="margin-top:5px">' + E(m.candidateNote || '') + '</div></div>';
    // 回填 select 当前值
    const setSel = (id, v) => { const el = $(id); if (el) el.value = String(v); };
    const kpis = '<div class="card pad" style="margin-top:12px"><div class="sr-kpis">' +
      kpi('有效样本 / 信号', r.counted + ' / ' + r.signalCount) +
      kpi('次日涨停率', ov.limitRate === null ? '—' : ov.limitRate + '%', 'up') +
      kpi('次日开→收 均收益', ov.retOC === null ? '—' : (ov.retOC > 0 ? '+' : '') + ov.retOC + '%', ov.retOC > 0 ? 'up' : 'down') +
      kpi('信号收→次收 均收益', ov.retCC === null ? '—' : (ov.retCC > 0 ? '+' : '') + ov.retCC + '%', ov.retCC > 0 ? 'up' : 'down') +
      kpi('次日上涨占比(开→收)', ov.winOC === null ? '—' : ov.winOC + '%') +
      kpi('最新信号日', r.latestDate || '—') + '</div>' +
      '<div class="small muted" style="margin-top:8px">DDX口径：' + E(r.fundCaliber || '') + ' · 源：' + E(r.realSource || '') + '</div></div>';
    const tierRows = (arr, label) => arr.map(t => '<tr><td>' + E(label) + ' ' + E(t.label) + '</td><td>' + t.n + '</td><td class="' + (t.limitRate > 0 ? 'up' : '') + '">' + (t.n < 8 ? '—' : E(t.limitRate) + '%') + '</td><td>' + (t.n < 8 ? '—' : E(t.retOC) + '%') + '</td><td>' + (t.n < 8 ? '—' : E(t.retCC) + '%') + '</td><td>' + (t.n < 8 ? '—' : E(t.winOC) + '%') + '</td></tr>').join('');
    const tiers = '<div class="card pad" style="margin-top:12px"><div class="sm-block-head"><h4>分档对比（次日涨停率 / 收益）</h4><span class="small muted">样本 &lt;8 只显示计数不显示概率</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>分档</th><th>样本</th><th>次日涨停率</th><th>开→收均收益</th><th>收→收均收益</th><th>上涨占比</th></tr></thead><tbody>' +
      tierRows(r.ddxTiers || [], 'DDX') + tierRows(r.turnTiers || [], '换手') + '</tbody></table></div></div>';

    let list = (r.list || []).slice();
    if (o.popOnly) list = list.filter(x => x.popTop500);
    const rankOf = x => Number(x.popRank) > 0 ? Number(x.popRank) : Infinity;
    const byPop = o.sort === 'pop' && Number(m.popularityCount) > 0;
    list.sort((a, b) => byPop ? (rankOf(a) - rankOf(b) || (b.ddx - a.ddx)) : ((b.ddx - a.ddx) || (b.turnover - a.turnover)));
    const listCard = '<div class="card pad" style="margin-top:12px"><div class="sm-block-head"><h4>最新信号股（' + E(r.latestDate || '') + ' · ' + list.length + ' 只）</h4>' +
      '<span class="small muted"><label>人气门槛 </label><select class="sel sel-sm" id="ddxPopOnly"><option value="1"' + (o.popOnly ? ' selected' : '') + '>仅前500</option><option value="0"' + (!o.popOnly ? ' selected' : '') + '>不限</option></select>' +
      ' <label>排序 </label><select class="sel sel-sm" id="ddxSort"><option value="pop"' + (o.sort === 'pop' ? ' selected' : '') + '>股吧人气</option><option value="ddx"' + (o.sort === 'ddx' ? ' selected' : '') + '>DDX代理</option></select>' +
      ' · 概率=历史同口径次日涨停率</span></div>' +
      '<div class="small muted" style="margin:2px 0 8px">' + E(m.popularityNote || '') + '</div>' +
      '<div class="sr-list">' + (list.length ? list.map(x => '<div class="pb-item" data-code="' + E(x.code) + '">' +
        '<div class="pb-item-top"><span class="stock-link" data-stock-code="' + E(x.code) + '"><b>' + E(x.name) + '</b> <span class="em-code">' + E(x.code) + '</span></span>' +
        '<span class="tag blue">DDX ' + E(x.ddx) + '‱</span><span class="tag">实体 ' + E(x.body) + '%</span><span class="tag">换手 ' + E(x.turnover) + '%</span>' +
        (x.popTop500 ? '<span class="tag blue">人气 #' + E(x.popRank) + '</span>' : (x.popRank ? '<span class="tag">人气 #' + E(x.popRank) + '</span>' : '')) +
        '<span class="sr-spacer"></span><span class="sr-prob">次日涨停率 <b>' + (x.prob === null ? '—' : E(x.prob) + '%') + '</b></span></div>' +
        '<div class="pb-item-meta"><span>收盘 ' + E(x.close) + '</span><span>当日 ' + E(x.pct) + '%</span><span>主力净额 ' + E(x.mainYi) + '亿</span><span>流通市值 ' + E(x.floatCap) + '亿</span><span>预期开→收 ' + E(x.expOC) + '%</span></div>' +
        '<div class="small muted" style="margin-top:5px">' + E((x.basis || []).join(' · ')) + '</div></div>').join('') : '<div class="empty">当前人气门槛下无信号，切「不限」查看全部</div>') + '</div></div>';

    const sampleCard = '<div class="card pad" style="margin-top:12px"><div class="sm-block-head"><h4>最近信号样本（含次日结果）</h4><span class="small muted" id="ddxSampleCount">载入中…</span></div>' +
      '<div class="small muted" style="margin:2px 0 8px">pending=最新信号日尚无次日数据；按信号日由近到远排列，向下滚动查看更早记录</div>' +
      '<div class="tbl-wrap sr-samples-wrap" id="ddxSamplesScroll"><table><thead><tr><th>信号日</th><th class="left">个股</th><th>DDX(‱)</th><th>实体</th><th>换手</th><th>当日</th><th>次日涨停</th><th>开→收</th><th>收→收</th></tr></thead><tbody id="ddxSamplesBody"></tbody></table></div>' +
      '<div class="small muted sr-sample-hint" id="ddxSampleHint">向下滚动可继续查看更早的历史信号</div>' +
      '<button class="btn btn-ghost btn-sm" id="ddxSampleMore" style="display:none;margin-top:8px">加载更早的样本</button></div>';

    $('pane-ddx').innerHTML = head + kpis + tiers + listCard + sampleCard + ddxMethodCard() +
      '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：' + E(m.disclaimer || '') + '</div>';
    // 回填控件值（render 会重建 DOM，必须每次设置）
    setSel('ddxScan', o.scan); setSel('ddxWindow', o.window); setSel('ddxDdxMin', o.ddxMin);
    setSel('ddxSmooth', o.smooth ? '1' : '0');
    setSel('ddxBodyMax', o.bodyMax); setSel('ddxTurnMin', o.turnMin); setSel('ddxBoard', o.board);
    $('ddxScan').onchange = e => { S.ddxOpts.scan = Number(e.target.value); loadDdxFirstRed(true); };
    $('ddxWindow').onchange = e => { S.ddxOpts.window = Number(e.target.value); loadDdxFirstRed(true); };
    $('ddxDdxMin').onchange = e => { S.ddxOpts.ddxMin = Number(e.target.value); loadDdxFirstRed(true); };
    $('ddxSmooth').onchange = e => { S.ddxOpts.smooth = e.target.value === '1'; loadDdxFirstRed(true); };
    $('ddxBodyMax').onchange = e => { S.ddxOpts.bodyMax = Number(e.target.value); loadDdxFirstRed(true); };
    $('ddxTurnMin').onchange = e => { S.ddxOpts.turnMin = Number(e.target.value); loadDdxFirstRed(true); };
    $('ddxBoard').onchange = e => { S.ddxOpts.board = e.target.value; loadDdxFirstRed(true); };
    $('ddxRefresh').onclick = () => loadDdxFirstRed(true);
    $('ddxPopOnly').onchange = e => { S.ddxOpts.popOnly = e.target.value === '1'; renderDdxFirstRed(); };
    $('ddxSort').onchange = e => { S.ddxOpts.sort = e.target.value; renderDdxFirstRed(); };
    const mt = $('ddxMethodToggle'); if (mt) mt.onclick = () => { S.ddxMethodOpen = !S.ddxMethodOpen; renderDdxFirstRed(); };
    bindDdxSamples();
    renderDdxSampleRows();
    if (!S.ddxSamples.rows.length) loadDdxSamples(true);
  }
  async function loadDdxFirstRed(force) {
    if (S.ddxLoading) { S.ddxPending = true; return; }
    S.ddxLoading = true;
    const sig = ddxFilterSignature(); S.ddxFilters = sig;
    if (!S.ddx) $('pane-ddx').innerHTML = '<div class="card empty">正在按「当日DDX代理翻红 + 实体&lt;5% + 换手≥5% + 未炸板」筛选个股并回测次日表现…<br><span class="small muted">首次需拉取数百只个股的日K与资金流，约 30~90 秒。</span></div>';
    else renderDdxFirstRed();
    const q = ddxQueryParams(); if (force) q.set('force', '1');
    let failed = false;
    try {
      const resp = await fetch('/api/ddx-first-red?' + q.toString(), { cache: 'no-store' });
      const j = await resp.json();
      if (!resp.ok || j.error) throw new Error(j.error || ('HTTP ' + resp.status));
      S.ddx = j; S.ddxAt = Date.now(); S.ddxError = null; S.ddxFilters = sig;
      S.ddxSamples = { key: '', rows: [], offset: 0, total: null, loading: false, done: false, error: '' };
      renderDdxFirstRed();
      $('badgeDdx').textContent = ((j.result && j.result.list) || []).length || '—';
    } catch (e) {
      failed = true; S.ddxError = e.message; S.ddxFilters = '';
      $('badgeDdx').textContent = '—';
      $('pane-ddx').innerHTML = '<div class="card empty"><b>回测失败：' + E(e.message) + '</b><br><span class="small muted">' + (isConnError(e) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="ddxRetry">重新回测</button></div>';
      const rb = $('ddxRetry'); if (rb) rb.onclick = () => loadDdxFirstRed(true);
    } finally {
      S.ddxLoading = false;
      if (S.ddxPending) { S.ddxPending = false; if (!failed) setTimeout(() => loadDdxFirstRed(true), 0); }
    }
  }

  /* ═══════════ 集合竞价 · 多因子首板封板概率（选股视图） ═══════════ */
  function auctionProbCls(p) {
    return p === null || p === undefined ? '' : p >= 75 ? 'ap-high' : p >= 50 ? 'ap-mid' : 'ap-low';
  }
  function auctionTierCls(t) {
    return t === 'focus' ? 'red' : t === 'watch' ? 'warn' : '';
  }
  function auctionMethodCard() {
    const meth = (S.auction && S.auction.method) || {};
    const rules = meth.rules || [];
    const body = rules.map(r => '<div class="kv"><span class="k">' + E(r.name) + '</span><span class="v">' + E(r.text) + '</span></div>').join('');
    const open = S.auctionMethodOpen;
    return '<div class="card pad dg-card" style="margin-top:12px">' +
      '<div class="dg-card-head"><h4>回测口径与方法</h4>' +
      '<button class="btn btn-ghost btn-sm" id="apMethodToggle">' + (open ? '收起' : '查看') + '全部口径</button></div>' +
      '<div id="apMethodBody" style="display:' + (open ? '' : 'none') + '">' + body +
      '<div class="note-box" style="margin-top:10px">' + E(meth.caveat || '') + '</div></div></div>';
  }

  function renderAuction() {
    const j = S.auction;
    if (!j) return;
    if (!j.available) {
      $('pane-auction').innerHTML = '<div class="card empty"><b>无法回测：' + E(j.reason || j.emptyReason || '样本不足') + '</b><br>' +
        '<span class="small muted">系统不会用推测数据填充；可稍后重试。</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="apRetry">重新回测</button></div>';
      const rb = $('apRetry'); if (rb) rb.onclick = () => loadAuction(true);
      return;
    }
    const m = j.meta || {}, list = j.list || [], factors = j.factors || [], val = j.validation || {};
    const rolling = val.rolling || {}, sm = j.samples || {};
    const focus = list.filter(x => x.tier === 'focus'), watch = list.filter(x => x.tier === 'watch');
    const daysOpts = [5, 8, 10, 12, 15].map(d => '<option value="' + d + '"' + (Number(S.auctionOpts.days) === d ? ' selected' : '') + '>' + d + ' 日</option>').join('');
    const head = '<div class="sec-head"><h3>集合竞价 · 多因子首板概率选股</h3>' +
      src('东方财富涨停/炸板池 + 腾讯前复权日K') +
      '<span class="spacer"></span><label class="small muted">回测窗口 </label>' +
      '<select id="apDays" class="sel-sm">' + daysOpts + '</select>' +
      '<button class="btn btn-ghost btn-sm" id="apRefresh">重新回测</button></div>';

    // 核心横幅：讲清"怎么用"——分层逻辑 + 事实复盘定位
    const banner = '<div class="conclusion card" style="border-left-color:var(--up);margin-bottom:12px">' +
      '<div class="lead"><b>怎么用：</b>系统用近 ' + (sm.train || 0) + ' 个首板样本训练一个多因子评分卡，对最近交易日（' + E(fmtDate(j.holdoutDate)) +
      '）冲击首板的 ' + list.length + ' 只票按封板概率排序，分「重点关注 / 次选观察 / 回避」三档。' +
      '高分＝历史上具备「位置低、竞价温和、量能健康、不过热」的特征组合；点击任意票看K线。' +
      '<span class="up">这是历史回测的概率复盘，不是明日预测，也不是买入信号。</span></div></div>';

    // KPI：模型表现为主
    const kpi = '<div class="dg-kpi-grid">' +
      '<div class="dg-kpi"><span>滚动验证 AUC</span><b class="' + (rolling.avgAuc >= 0.55 ? 'up' : '') + '">' + E(rolling.avgAuc === null ? '—' : rolling.avgAuc) + '</b><em>' + E((rolling.days || []).length) + ' 日样本外均值 · 0.5=随机</em></div>' +
      '<div class="dg-kpi"><span>高分 vs 低分封板率</span><b>' + E(rolling.topAvg === null ? '—' : rolling.topAvg + '%') +
        ' <span class="small muted">vs</span> ' + E(rolling.botAvg === null ? '—' : rolling.botAvg + '%') + '</b><em>前30% vs 后30% 平均分档</em></div>' +
      '<div class="dg-kpi"><span>重点关注</span><b class="up">' + E(focus.length) + ' <span class="small muted">只</span></b><em>共 ' + E(list.length) + ' 只候选</em></div>' +
      '<div class="dg-kpi"><span>训练 / 验证样本</span><b>' + E(sm.train || 0) + ' / ' + E(sm.holdout || 0) + '</b><em>基准封板率 ' + E(j.baseRate === null ? '—' : j.baseRate + '%') + ' · 跳过 ' + E(sm.skipped || 0) + '</em></div>' +
      '</div>';

    // 因子分解 chip：每只票 4 个因子的落档 + WoE 方向
    const factorChip = (label, d) => {
      if (!d) return '';
      const positive = Number(d.woe) > 0;
      const cls = positive ? 'ap-high' : Number(d.woe) < 0 ? 'ap-low' : 'ap-mid';
      return '<span class="af-chip ' + cls + '" title="该档历史封板率 ' + (d.rate === null ? '—' : d.rate + '%') + ' · WoE ' + d.woe + '">' +
        E(label) + ' ' + E(d.label) + '<i>' + (positive ? '+' : '') + E(d.woe) + '</i></span>';
    };
    const probBar = p => {
      const w = p === null || p === undefined ? 0 : Math.max(2, Math.min(100, p));
      return '<div style="display:flex;align-items:center;gap:6px"><b class="' + auctionProbCls(p) + '">' + E(p === null ? '—' : p + '%') + '</b>' +
        '<div class="dg-bar" style="flex:1;min-width:40px"><i class="' + (p >= 75 ? 'red' : p >= 50 ? 'warn' : 'blue') + '" style="width:' + w.toFixed(0) + '%"></i></div></div>';
    };

    // 选股列表
    const tierOrder = { focus: 0, watch: 1, avoid: 2 };
    const sortedList = list.slice().sort((a, b) => (tierOrder[a.tier] - tierOrder[b.tier]) || (b.probability - a.probability));
    const listRows = sortedList.map(x => {
      const hitIco = x.hit === null || x.hit === undefined ? '<span class="muted">—</span>' : x.hit ? '<span class="up">✓</span>' : '<span class="down">✗</span>';
      const resultTag = x.sealed === 1 ? tag('封住', 'red') : tag('炸板', 'green');
      const chips = factorChip('竞价', x.detail && x.detail.gap) + factorChip('位置', x.detail && x.detail.loc) +
        factorChip('量能', x.detail && x.detail.vr) + factorChip('热度', x.detail && x.detail.hot);
      return '<tr class="ap-row ap-' + x.tier + '"><td style="text-align:center"><span class="ap-rank ' + auctionTierCls(x.tier) + '">' + E(x.rank) + '</span></td>' +
        '<td class="left">' + sn(x.code, x.name) + '<div class="small muted">' + E(x.code) + ' · ' + E(x.industry || '') + '</div></td>' +
        '<td>' + tag(x.tierLabel, auctionTierCls(x.tier)) + '</td>' +
        '<td style="min-width:92px">' + probBar(x.probability) + '</td>' +
        '<td class="left"><div class="ap-chips">' + chips + '</div></td>' +
        '<td>' + PC(x.gap, 2) + '</td>' +
        '<td>' + resultTag + '</td>' +
        '<td style="text-align:center">' + hitIco + '</td></tr>';
    }).join('');
    const listCard = '<div class="sec"><div class="sec-head"><h3>选股清单 · ' + E(fmtDate(j.holdoutDate)) + ' 冲击首板的股票</h3>' +
      '<span class="small muted">按综合封板概率分层排序 · 点击名称看K线</span></div>' +
      '<div class="card pad"><div class="ap-tier-legend"><span class="ap-rank red">重点</span> 前30% 优先研究　' +
      '<span class="ap-rank warn">次选</span> 中间40% 观察　<span class="ap-rank">回避</span> 后30% 概率低</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>排名</th><th class="left">个股</th><th>分层</th><th>综合概率</th><th class="left">因子分解(竞价/位置/量能/热度)</th><th>竞价高开</th><th>实际</th><th>命中</th></tr></thead>' +
      '<tbody>' + listRows + '</tbody></table></div>' +
      (list.length ? '' : '<div class="empty">该交易日无首板样本</div>') +
      '<div class="note-box">「因子分解」显示每只票在各因子上落入的档位与其历史贡献（WoE，<span class="up">正</span>=加分/<span class="down">负</span>=减分）。' +
      '综合概率由 4 因子加权合成；实际结果用于验证排序是否有效。<b>竞价高开≠可买，一字/近涨停开盘常买不进。</b></div></div></div>';

    // 因子有效性表
    const factorRows = factors.map(f => {
      const icCls = f.ic === null ? '' : f.ic > 0 ? 'ap-high' : f.ic < 0 ? 'ap-low' : '';
      const binCells = (f.bins || []).map(b => '<div class="af-bin"><span>' + E(b.label) + '</span><b>' + E(b.rate === null ? '—' : b.rate + '%') + '</b></div>').join('');
      return '<tr><td class="left"><b>' + E(f.label) + '</b><div class="small muted">' + E(f.desc) + '</div></td>' +
        '<td><b class="' + icCls + '">' + E(f.ic === null ? '—' : f.ic) + '</b></td>' +
        '<td>' + E(f.spread === null ? '—' : f.spread + 'pp') + '</td>' +
        '<td><div class="af-bins">' + binCells + '</div></td></tr>';
    }).join('');
    const factorCard = '<div class="card pad" style="margin-top:12px"><h4>为什么用这 4 个因子（训练样本实测）</h4>' +
      '<div class="note-box" style="margin-bottom:8px">IC＝因子值与是否封板的相关（负=因子越大越易炸板）；档位封板率从左到右按因子值由低到高排列。' +
      '「位置/涨幅」区分力最强，说明<b>涨太高、离均线远的票更容易炸板</b>；单一竞价高开区分力有限，所以才用多因子合成。</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">因子</th><th>IC</th><th>首尾档差</th><th class="left">各档实际封板率（低→高）</th></tr></thead>' +
      '<tbody>' + factorRows + '</tbody></table></div></div>';

    // 滚动验证表
    const rollRows = (rolling.days || []).map(d => {
      const aucCls = d.auc === null ? '' : d.auc >= 0.55 ? 'up' : d.auc < 0.5 ? 'down' : '';
      return '<tr><td>' + E(fmtDate(d.date)) + '</td><td>' + E(d.n) + '</td>' +
        '<td><b class="' + aucCls + '">' + E(d.auc === null ? '—' : d.auc) + '</b></td>' +
        '<td>' + E(d.topRate === null ? '—' : d.topRate + '%') + '</td>' +
        '<td>' + E(d.botRate === null ? '—' : d.botRate + '%') + '</td>' +
        '<td>' + E(d.actualRate === null ? '—' : d.actualRate + '%') + '</td></tr>';
    }).join('');
    const rollCard = '<div class="card pad" style="margin-top:12px"><h4>多日滚动验证（每个交易日用它之前的数据训练，在当日预测）</h4>' +
      '<div class="kv"><span class="k">结论</span><span class="v">' + E(rolling.note || '—') + '</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>交易日</th><th>候选数</th><th>AUC</th><th>高分前30%封板</th><th>低分后30%封板</th><th>当日实际封板率</th></tr></thead>' +
      '<tbody>' + rollRows + '</tbody></table></div>' +
      '<div class="note-box">AUC≥0.55 视为有区分力；可见模型<b>多数日期有效、个别市场情绪异常日失效</b>。' +
      '样本外单日（' + E(fmtDate(val.date)) + '）AUC ' + E(val.auc === null ? '—' : val.auc) + '、命中率 ' + E(val.hitRate === null ? '—' : val.hitRate + '%') +
      ' —— ' + E(val.note || '') + '</div></div>';

    const metaNote = '<div class="small muted" style="margin-top:8px">数据口径：' + E(m.dataSourceNote || '') + '</div>';
    $('pane-auction').innerHTML = head + banner + kpi + listCard + factorCard + rollCard + auctionMethodCard() +
      '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：' + E(m.disclaimer || '') + '</div>' + metaNote;

    $('apDays').onchange = e => { S.auctionOpts.days = Number(e.target.value) || 10; loadAuction(true); };
    $('apRefresh').onclick = () => loadAuction(true);
    const mt = $('apMethodToggle');
    if (mt) mt.onclick = () => { S.auctionMethodOpen = !S.auctionMethodOpen; renderAuction(); };
  }

  async function loadAuction(force) {
    if (S.auctionLoading) return;
    S.auctionLoading = true;
    if (!S.auction) $('pane-auction').innerHTML = '<div class="card empty">正在回溯近 ' + S.auctionOpts.days + ' 个交易日涨停/炸板池与真实日K，训练多因子评分卡并做样本外验证…</div>';
    const q = new URLSearchParams({ days: String(S.auctionOpts.days) });
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/auction?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.auction = j; S.auctionAt = Date.now(); S.auctionError = null;
      renderAuction();
      const focusN = (j.list || []).filter(x => x.tier === 'focus').length;
      $('badgeAuction').textContent = focusN || '—';
    } catch (e) {
      S.auctionError = e.message;
      $('badgeAuction').textContent = '—';
      $('pane-auction').innerHTML = '<div class="card empty"><b>回测失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (isConnError(e) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="apRetry">重新回测</button></div>';
      const rb = $('apRetry'); if (rb) rb.onclick = () => loadAuction(true);
    } finally { S.auctionLoading = false; }
  }

  /* ═══════════ 9:25 首板预测（竞价强度信号 · 经验概率） ═══════════ */
  function predScoreCls(s) {
    return s >= 70 ? 'ap-high' : s >= 50 ? 'ap-mid' : 'ap-low';
  }
  function predMethodCard() {
    const meth = (S.predict && S.predict.method) || {};
    const rules = meth.rules || [];
    const body = rules.map(r => '<div class="kv"><span class="k">' + E(r.name) + '</span><span class="v">' + E(r.text) + '</span></div>').join('');
    const open = S.predictMethodOpen;
    return '<div class="card pad dg-card" style="margin-top:12px">' +
      '<div class="dg-card-head"><h4>预测口径与校准说明</h4>' +
      '<button class="btn btn-ghost btn-sm" id="pdMethodToggle">' + (open ? '收起' : '查看') + '全部口径</button></div>' +
      '<div id="pdMethodBody" style="display:' + (open ? '' : 'none') + '">' + body +
      '<div class="note-box" style="margin-top:10px">' + E(meth.caveat || '') + '</div></div></div>';
  }

  function renderPredict() {
    const j = S.predict;
    if (!j) return;
    if (!j.available) {
      $('pane-predict').innerHTML = '<div class="card empty"><b>无法生成预测：' + E(j.reason || '样本不足') + '</b><br>' +
        '<span class="small muted">系统不会用推测数据填充；可稍后重试。</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="pdRetry">重新生成</button></div>';
      const rb = $('pdRetry'); if (rb) rb.onclick = () => loadPredict(true);
      return;
    }
    const m = j.meta || {}, list = j.list || [], sum = j.summary || {}, cal = j.calibration || {};
    const isEmp = cal.mode === 'empirical';
    const dateOpts = (m.calibration && m.calibration.filledDays !== undefined) ? null : null;
    const needBackfill = list.some(x => x.result === null || x.result === undefined);
    const bfStat = j.stat || (m && m.stat) || null;
    const bfPool = j.backfillPool || (m && m.backfillPool) || null;
    const bfLine = bfStat && bfStat.withResult
      ? '<span class="pd-bf-ok">已实时回填 ' + E(bfStat.withResult) + '/' + E(bfStat.total) + ' · 封住首板 <b>' + E(bfStat.sealed) + '</b> 只' +
        (bfPool ? '（' + E(bfPool.source) + ' ' + E(bfPool.date) + '）' : '') + '</span>'
      : (needBackfill ? '<span class="pd-bf-wait">' + E(j.note || '待回填：等待收盘后拉取真实封板结果') + '</span>' : '');

    const head = '<div class="sec-head"><h3>9:25 首板预测 · 竞价强度信号</h3>' +
      src('新浪竞价快照 + 腾讯量比/日K') +
      '<span class="spacer"></span>' +
      '<label class="small muted">回放日 </label>' +
      '<input id="pdDate" class="sel-sm" style="width:100px" placeholder="YYYYMMDD" value="' + E(j.tradeDate || '') + '">' +
      '<button class="btn btn-ghost btn-sm" id="pdReplay">回放</button>' +
      '<button class="btn btn-primary btn-sm" id="pdRefresh">生成当前</button>' +
      (needBackfill ? '<button class="btn btn-ghost btn-sm" id="pdBackfill">拉取回填</button>' : '') + '</div>';

    // 时点 + 概率口径横幅（诚实标注）
    const stateNote = m.state ? ('<b>当前时点：' + E(m.state) + '</b> · ' + E(m.note || '') + '。') : '';
    const amtStateNote = m.auctionAmountEnabled === true
      ? '<span class="up">竞价成交额已采集（集合竞价时段），作为惩罚项参与打分。</span>'
      : '<span class="muted">当前非集合竞价时段，快照成交额为全天量、不可当竞价额，<b>竞价额惩罚项已禁用</b>（不扣分）。</span>';
    const banner = '<div class="conclusion card" style="border-left-color:var(--warn);margin-bottom:12px">' +
      '<div class="lead">' + stateNote +
      '<span class="up">概率为' + (isEmp ? '实测校准' : '保守经验估计') + '（基准约 ' + E(j.baseRate) + '%），不是精确命中率、不是买入信号。</span><br>' +
      amtStateNote +
      '每天 9:25 自动落盘当日竞价快照，收盘后自动拉取真实封板结果回填，累计 20 交易日后自动切换为实测概率。' +
      (bfLine ? '<br>' + bfLine : '') +
      (j.replay ? '<br>正在查看<b>历史预测回放</b>：' + E(j.note || '') : '') +
      '</div></div>';

    // KPI
    const kpi = '<div class="dg-kpi-grid">' +
      '<div class="dg-kpi"><span>重点关注</span><b class="up">' + E(sum.focus || 0) + ' <span class="small muted">只</span></b><em>信号分 ≥70 · 共 ' + E(sum.candidates || 0) + ' 候选</em></div>' +
      '<div class="dg-kpi"><span>次选 / 回避</span><b>' + E(sum.watch || 0) + ' / ' + E(sum.avoid || 0) + '</b><em>信号分 50~70 / &lt;50</em></div>' +
      '<div class="dg-kpi"><span>校准状态</span><b class="' + (isEmp ? 'up' : '') + '">' + E(cal.days || 0) + ' <span class="small muted">日</span></b><em>' + E(cal.label || '') + '</em></div>' +
      '<div class="dg-kpi"><span>基准封板率</span><b>' + E(j.baseRate) + '%</b><em>高开票经验基准 · 一字 ' + E(sum.oneWord || 0) + ' 只</em></div>' +
      '</div>';

    // 信号分量展示
    // 竞价额惩罚为负分，单独配色显示（惩罚项），未启用时不显示
    const amtSigCell = d => {
      if (!d || d.usable === false) return '';
      const penalty = Number(d.pts) || 0;
      return '<span class="pd-sig pd-sig-penalty' + (penalty <= -12 ? ' heavy' : '') + '" title="' + E(d.label) + '（竞价额/流通市值 ' + E(d.turnover === null || d.turnover === undefined ? '—' : d.turnover + '%') + '）">' +
        E(d.label) + '<b> ' + E(d.pts) + '</b></span>';
    };
    const sigCell = (d, max) => {
      if (!d) return '';
      return '<span class="pd-sig" title="' + E(d.label) + '">' + E(d.label) + '<b> ' + E(d.pts) + '</b></span>';
    };
    const probBar = p => {
      const w = p === null || p === undefined ? 0 : Math.max(2, Math.min(100, p * 3));
      return '<div style="display:flex;align-items:center;gap:6px"><b class="' + (p >= 18 ? 'ap-high' : p >= 12 ? 'ap-mid' : 'ap-low') + '">' + E(p === null ? '—' : p + '%') + '</b>' +
        '<div class="dg-bar" style="flex:1;min-width:40px"><i class="' + (p >= 18 ? 'red' : p >= 12 ? 'warn' : 'blue') + '" style="width:' + w.toFixed(0) + '%"></i></div></div>';
    };
    const tierCls = t => t === 'focus' ? 'red' : t === 'watch' ? 'warn' : '';

    // 分层筛选
    const filter = S.predictFilter || 'all';
    const shown = filter === 'all' ? list : list.filter(x => x.tier === filter);
    const filterBar = '<div class="pd-filter">' +
      [['all', '全部 ' + (sum.candidates || 0)], ['focus', '重点关注 ' + (sum.focus || 0)], ['watch', '次选 ' + (sum.watch || 0)], ['avoid', '回避 ' + (sum.avoid || 0)]]
        .map(([k, label]) => '<button class="pd-filter-btn ' + (filter === k ? 'active' : '') + '" data-pd-filter="' + k + '">' + E(label) + '</button>').join('') + '</div>';

    const listRows = shown.map(x => {
      const resultCell = x.result === null || x.result === undefined
        ? '<span class="muted">待回填</span>'
        : x.result === 1 ? tag('封住', 'red') : tag(x.resultLabel === '炸板未封' ? '炸板' : '未封', 'green');
      return '<tr class="ap-row"><td style="text-align:center"><span class="ap-rank ' + tierCls(x.tier) + '">' + E(x.rank) + '</span></td>' +
        '<td class="left">' + sn(x.code, x.name) + '<div class="small muted">' + E(x.code) + ' · ' + E(x.industry || x.board || '') + '</div></td>' +
        '<td>' + tag(x.tierLabel, tierCls(x.tier)) + '</td>' +
        '<td><b class="' + predScoreCls(x.score) + '">' + E(x.score) + '</b></td>' +
        '<td style="min-width:88px">' + probBar(x.expProb) + '<div class="small muted" style="text-align:center">' + E(x.probLabel) + '</div></td>' +
        '<td class="left"><div class="ap-chips">' +
          sigCell(x.signals && x.signals.gap) + sigCell(x.signals && x.signals.volume) + sigCell(x.signals && x.signals.prevVol) +
          sigCell(x.signals && x.signals.cap) + sigCell(x.signals && x.signals.heat) +
          amtSigCell(x.signals && x.signals.auctionAmt) + '</div></td>' +
        '<td>' + PC(x.gap, 2) + '</td>' +
        '<td>' + (x.volRatio === null || x.volRatio === undefined ? '—' : N(x.volRatio, 2)) + '</td>' +
        '<td>' + (x.floatCap === null || x.floatCap === undefined ? '—' : CAP(x.floatCap)) + '</td>' +
        '<td>' + (x.oneWord ? tag('一字买不进', 'warn') : '<span class="muted">—</span>') + '</td>' +
        '<td>' + resultCell + '</td></tr>';
    }).join('');

    const listCard = '<div class="sec"><div class="sec-head"><h3>预测清单 · ' + E(fmtDate(j.tradeDate)) + ' 9:25 竞价</h3>' +
      '<span class="small muted">按信号分降序 · 点击名称看K线 · 收盘后自动回填结果</span></div>' +
      '<div class="card pad">' + filterBar +
      '<div class="tbl-wrap"><table><thead><tr><th>排名</th><th class="left">个股</th><th>分层</th><th>信号分</th><th>首板概率</th>' +
      '<th class="left">信号分解(竞价/量比/昨量/市值/题材/竞价额)</th><th>竞价高开</th><th>量比</th><th>流通市值</th><th>一字</th><th>实际</th></tr></thead>' +
      '<tbody>' + listRows + '</tbody></table></div>' +
      (shown.length ? '' : '<div class="empty">该分层暂无个股</div>') +
      '<div class="note-box">「信号分解」括号后为该信号得分（竞价30 / 量比25 / 昨量15 / 市值20 / 题材10；竞价额为惩罚项 0~−16，红字显示）。' +
      '竞价额惩罚依据近6日217只冲击涨停票回测：竞价换手≥0.5% 封板率骤降至18.2%，故高竞价额扣分；仅集合竞价时段采集，盘后禁用。' +
      '概率为<b>' + (isEmp ? '实测校准' : '保守经验估计') + '</b>，' + E(cal.note || '') +
      ' 收盘后回填真实封板结果，用于持续校准。<b>竞价高开≠可买入，一字/近涨停开盘常买不进。</b></div></div></div>';

    const metaNote = '<div class="small muted" style="margin-top:8px">数据口径：' + E(m.dataSourceNote || '') + '</div>';
    $('pane-predict').innerHTML = head + banner + kpi + listCard + predMethodCard() +
      '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：' + E(m.disclaimer || '') + '</div>' + metaNote;

    // 绑定
    $('pdDate').onchange = e => { S.predictOpts.date = e.target.value.replace(/\D/g, ''); };
    $('pdReplay').onclick = () => { const d = $('pdDate').value.replace(/\D/g, ''); if (/^\d{8}$/.test(d)) loadPredict(false, d); };
    $('pdRefresh').onclick = () => loadPredict(true);
    const bfb = $('pdBackfill');
    if (bfb) bfb.onclick = () => doBackfill(j.tradeDate);
    document.querySelectorAll('[data-pd-filter]').forEach(b => {
      b.onclick = () => { S.predictFilter = b.getAttribute('data-pd-filter'); renderPredict(); };
    });
    const mt = $('pdMethodToggle');
    if (mt) mt.onclick = () => { S.predictMethodOpen = !S.predictMethodOpen; renderPredict(); };
  }

  /** 主动实时拉取真实封板结果回填当前快照（后端按 tradeDate 取对应日涨停/炸板池） */
  async function doBackfill(date, silent) {
    const d = String(date || '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(d) || S.predictLoading) return;
    if (!silent) $('pane-predict').insertAdjacentHTML('afterbegin', '<div class="card empty" id="pdBfLoading">正在实时拉取 ' + E(d) + ' 涨停/炸板池回填真实结果…</div>');
    try {
      const r = await fetch('/api/predict?mode=backfill&date=' + encodeURIComponent(d) + '&force=1', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      const rec = j.result || {};
      if (!rec.backfilled) throw new Error(rec.backfillReason || '上游该交易日涨停池暂不可用，保持待回填');
      // 用回填后的真实结果刷新当前视图（保持回放模式，不重抓快照）
      await loadPredict(true, d);
    } catch (e) {
      if (!silent) {
        const box = $('pdBfLoading');
        if (box) box.innerHTML = '<b>回填失败：' + E(e.message) + '</b><br><span class="small muted">系统不会用推测数据填充；可稍后重试。</span>';
      }
    } finally {
      const box = $('pdBfLoading'); if (box) box.remove();
    }
  }

  async function loadPredict(force, replayDate) {
    if (S.predictLoading) return;
    S.predictLoading = true;
    if (!S.predict) $('pane-predict').innerHTML = '<div class="card empty">正在抓取全市场竞价快照、计算竞价强度信号并生成预测列表…</div>';
    const q = new URLSearchParams();
    if (replayDate) q.set('date', replayDate);
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/predict?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.predict = j; S.predictAt = Date.now(); S.predictError = null;
      renderPredict();
      $('badgePredict').textContent = (j.summary && j.summary.focus) || '—';
      // 若存在待回填项且该日已收盘，自动实时拉取一次回填（延迟避开加载锁；5分钟节流防盘中反复请求）
      const pend = (j.list || []).some(x => x.result === null || x.result === undefined);
      const pd = j.tradeDate;
      if (pend && pd && /^\d{8}$/.test(String(pd))) {
        S.autoBfAt = S.autoBfAt || {};
        if (!S.autoBfAt[pd] || Date.now() - S.autoBfAt[pd] > 300000) {
          S.autoBfAt[pd] = Date.now();
          setTimeout(() => doBackfill(pd, true), 0);
        }
      }
    } catch (e) {
      S.predictError = e.message;
      $('badgePredict').textContent = '—';
      $('pane-predict').innerHTML = '<div class="card empty"><b>预测失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (isConnError(e) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="pdRetry">重新生成</button></div>';
      const rb = $('pdRetry'); if (rb) rb.onclick = () => loadPredict(true);
    } finally { S.predictLoading = false; }
  }

  function renderEnlightenment() {
    const j = S.en; if (!j) return;
    const m = j.meta || {}, methods = j.methods || [], best = j.best, mk = j.market || {}, cands = j.candidates || [];
    const ksrc = (m.klineSources || []).join(' / ') || '—';
    const range = (m.historyRange || []).filter(Boolean).join(' — ') || '—';
    const totalN = methods.reduce((s, x) => s + (Number(x.n) || 0), 0);
    const verdictTag = j.verdict === 'edge' ? tag('区间内有超额', 'red')
      : j.verdict === 'no-edge' ? tag('无显著超额', 'warn')
        : j.verdict === 'illiquid' ? tag('流动性偏差', 'warn') : tag('样本不足', 'blue');

    const head = '<div class="conclusion card" style="margin-bottom:14px;border-left-color:var(--purple)"><div class="lead">' +
      '<b>龙场悟道 · 次日买入机会计划</b>：用 ' + E(m.days || 0) + ' 个交易日（' + E(range) + '）的真实涨停池，为 ' +
      methods.length + ' 种选股方法套用同一套计划 —— <b>T 日只选股、T+1 回踩触发才买、T+2 收盘卖出（A 股 T+1）</b>。' +
      '买入价不是 T 日涨停价，因此不含「次日溢价」偏差；按「每候选期望值＝成交后平均收益 × 触发率」选优，并对当前池输出明日的计划价位。' +
      '<div style="margin-top:7px;font-weight:600">' + E(j.bestReason || '') + '</div></div>' +
      '<div class="tags">' + verdictTag + tag('候选 ' + totalN + ' 次', 'blue') +
      tag(j.planRules ? j.planRules.label : '次日计划', 'purple') +
      tag('日K源 ' + ksrc, m.fallback ? 'warn' : 'green') +
      tag('交易日 ' + (m.poolDate || '—'), '') + tag('时点 ' + (m.quoteTick || '—'), 'blue') + '</div></div>';

    const controls = '<div class="card pad" style="margin-bottom:12px"><div class="small muted">' +
      '回测窗口 <b>' + E((m.baseDates || []).length) + '</b> 个基准日 · 每日候选上限 ' + E(m.perDay) +
      ' 只 · 日K去重请求 ' + E(m.codesRequested) + ' 只（成功 ' + E(m.klineOk) + '）· 成交样本门槛 ≥' + E(j.minSamples) +
      ' 笔 · 服务端耗时 ' + E(m.elapsedMs) + ' ms · 生成 ' + E(m.generatedAt) +
      '<br><b>统一计划模板</b>：' + E(j.planRules ? j.planRules.label : '—') + ' — ' + E(j.planRules ? j.planRules.desc : '—') +
      '（需要 T+1 与 T+2 两根日K，因此最新 2 个交易日只作「观察中」，不计入分母）' +
      (m.fallback ? '<br><b style="color:var(--warn)">当前使用新浪不复权日K</b>：腾讯前复权被限流降级，除权日价格跳变可能污染买入价与收益，数值可靠性低于前复权口径。' : '') +
      '</div><div class="dg-actions" style="margin-top:9px"><label class="small muted">回溯 <select class="sel" id="enDays">' +
      [5, 6, 8, 10, 12].map(n => '<option value="' + n + '"' + (Number(S.enOpts.days) === n ? ' selected' : '') + '>近 ' + n + ' 日</option>').join('') +
      '</select></label> <button class="btn btn-primary" id="enReload">重新回测</button>' +
      '<span class="small muted">回测按 10 分钟缓存；切换天数或点击按钮会强制重算</span></div></div>';

    const kpis = [
      ['涨停 / 跌停', '<span class="up">' + E(mk.limitUp) + '</span> / <span class="down">' + E(mk.limitDown) + '</span>', '炸板 ' + E(mk.broken) + ' 家 · 率 ' + N(mk.breakRate, 1) + '%'],
      ['涨跌家数', '<span class="up">' + E(mk.up) + '</span> / <span class="down">' + E(mk.down) + '</span>', '广度 ' + N(mk.breadth, 1) + '%'],
      ['最高连板', E(mk.maxBoard) + ' 板', '市场档位 ' + E(mk.tier) + ' / 情绪 ' + E(mk.emotion)],
      ['指数均值', (Number(mk.idxAvg) > 0 ? '+' : '') + N(mk.idxAvg) + '%', '6 大指数当日均值']
    ];
    const marketCard = '<div class="sec"><div class="sec-head"><h3>最近市场情况</h3>' +
      src('新浪财经全市场快照 / 腾讯证券指数 / 东方财富涨停池，交易日 ' + (mk.poolDate || m.poolDate || '—')) + '</div>' +
      '<div class="grid4">' + kpis.map(k => '<div class="info-card"><h4>' + k[0] + '</h4><p>' +
        '<span style="font-size:18px;font-weight:700">' + k[1] + '</span><br><span class="small muted">' + k[2] + '</span></p></div>').join('') +
      '</div></div>';

    const mRows = methods.map(x => {
      const skips = Object.entries(x.skipReasons || {}).sort((a, b) => b[1] - a[1]);
      return '<tr' + (best && x.id === best.id ? ' style="background:#fff8f8"' : '') + '>' +
        '<td class="left"><b>' + E(x.name) + '</b>' + (x.caveat ? '<div class="small" style="color:var(--warn)">' + E(x.caveat) + '</div>' : '') +
        '<div class="small muted" style="max-width:280px;white-space:normal">' + E(x.desc) + '</div></td>' +
        '<td>' + tag(x.kind, x.kind === '基准' ? '' : x.kind === '对照' ? 'warn' : 'blue') + '</td>' +
        '<td>' + E(x.n) + '</td>' +
        '<td>' + N(x.triggerRate, 1) + '%</td>' +
        '<td>' + E(x.triggered) + (x.sampleOK ? '' : ' <span class="mini-tag">样本不足</span>') + '</td>' +
        '<td class="' + (x.avgRet > 0 ? 'up' : x.avgRet < 0 ? 'down' : '') + '"><b>' + (x.avgRet > 0 ? '+' : '') + N(x.avgRet) + '%</b></td>' +
        '<td>' + N(x.winRate, 1) + '%</td>' +
        '<td class="down">' + N(x.avgMae, 1) + '%</td>' +
        '<td><b class="' + (x.expectancy > 0 ? 'up' : 'down') + '">' + (x.expectancy > 0 ? '+' : '') + N(x.expectancy) + '%</b></td>' +
        '<td class="' + (x.edge > 0 ? 'up' : x.edge < 0 ? 'down' : '') + '">' + (x.edge === null ? '—' : (x.edge > 0 ? '+' : '') + N(x.edge) + 'pp') + '</td>' +
        '<td class="left small">' + (skips.length ? E(skips[0][0]) + ' ×' + skips[0][1] : '—') + '</td></tr>';
    }).join('');
    const methodCard = '<div class="sec"><div class="sec-head"><h3>六种方法 · 次日买入计划回测榜</h3>' +
      src('东方财富历史涨停池 + 腾讯/新浪日K；T 日选股、T+1 触发买入、T+2 收盘卖出，无未来函数') + '</div>' +
      '<div class="card pad" style="margin-bottom:12px"><div id="enMethodChart" class="chart"></div></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">方法 / 选股条件</th><th>类型</th><th>候选 n</th><th>触发率</th><th>成交笔数</th><th>成交后平均收益</th><th>胜率</th><th>平均 MAE</th><th>每候选期望</th><th>超额 vs 基准</th><th class="left">主要放弃原因</th></tr></thead><tbody>' +
      (mRows || '<tr><td colspan="11" class="empty">回测区间内无可用样本</td></tr>') + '</tbody></table></div>' +
      '<div class="note-box" style="margin-top:10px"><b>怎么读：</b>所有方法共用同一套「次日回踩低吸」计划，差异只在 T 日选出哪些股。' +
      '<b>触发率</b>＝T+1 真正给出回踩买点的比例；未触发（高开过度 / 破位 / 没回踩）是「没机会就不做」，不计入收益但计入分母。' +
      '<b>成交后平均收益</b>＝以 C×0.98 买入、T+2 收盘卖出的平均收益；<b>每候选期望</b>＝成交后平均收益 × 触发率，是本次选优的唯一排序依据。' +
      'MAE 为成交后 T+1/T+2 最大浮亏。不计手续费、滑点、隔夜跳空与仓位。</div></div>';

    const insuff = j.insufficientStrong || [];
    const bestCard = '<div class="sec"><div class="sec-head"><h3>选优结论与待验证观察项</h3></div>' +
      '<div class="grid2"><div class="info-card"><h4>' + (best ? E(best.name) + ' ' + verdictTag : '未产出最佳方法') + '</h4>' +
      (best ? '<p>' + E(best.desc) + '</p><div class="kv"><span class="k">候选 / 实际成交</span><span class="v">' + E(best.n) + ' / ' + E(best.triggered) + ' 笔（触发率 ' + N(best.triggerRate, 1) + '%）</span></div>' +
        '<div class="kv"><span class="k">成交后平均收益 / 胜率</span><span class="v">' + N(best.avgRet) + '% / ' + N(best.winRate, 1) + '%</span></div>' +
        '<div class="kv"><span class="k">每候选期望值</span><span class="v"><b>' + N(best.expectancy) + '%</b></span></div>' +
        '<div class="kv"><span class="k">相对基准超额</span><span class="v">' + (best.edge === null ? '—' : (best.edge > 0 ? '+' : '') + N(best.edge) + ' pp') + '</span></div>' +
        '<div class="kv"><span class="k">平均最大浮亏 MAE</span><span class="v">' + N(best.avgMae, 1) + '%</span></div>'
        : '<p>' + E(j.bestReason || '') + '</p>') +
      '<div class="note-box">' + E(j.bestReason || '') + '</div></div>' +
      '<div class="info-card"><h4>期望更高但成交样本不足（待验证）</h4>' +
      (insuff.length ? insuff.map(x => '<div class="kv"><span class="k">' + E(x.name) + '</span><span class="v">期望 ' + N(x.expectancy) + '% · 成交 ' + E(x.triggered) + ' 笔 · 触发率 ' + N(x.triggerRate, 1) + '%</span></div>').join('') +
        '<div class="note-box">这些方法的每候选期望更高，但成交样本 &lt;' + E(j.minSamples) + ' 笔，按纪律不参与选优；需要更长回溯窗口才能判断，不能据此认定「更好」。</div>'
        : '<p class="small muted">本区间没有「样本不足但期望显著高于基准」的方法。</p>') +
      '</div></div></div>';

    const cRows = cands.map((x, i) => {
      const p = x.plan || {};
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') +
        '<div class="small muted">' + E(x.boardLabel || (x.boards + ' 板')) + ' · ' + E(x.industry || '—') +
        (x.theme ? ' · ' + E(x.theme.stage) : '') + '</div></td>' +
        '<td>' + N(p.base) + '</td>' +
        '<td><b class="up">' + N(p.entry) + '</b><div class="small muted">回踩 −2%</div></td>' +
        '<td class="down">' + N(p.stop) + '<div class="small muted">破位放弃</div></td>' +
        '<td>' + N(p.maxOpen) + '<div class="small muted">高开放弃</div></td>' +
        '<td><b class="' + (x.score >= 60 ? 'up' : '') + '">' + E(x.score) + '</b></td>' +
        '<td class="left small">' + (x.risks.length ? x.risks.map(r => tag(r, 'warn')).join(' ') : tag('无触发式风险', 'green')) + '</td></tr>';
    }).join('');
    const steps = (cands[0] && cands[0].planSteps) || [], invalids = (cands[0] && cands[0].invalidations) || [];
    const candCard = '<div class="sec"><div class="sec-head"><h3>明日买入机会计划 · ' +
      (j.planFallback ? '全池基准（无方法达标，不做优选）' : E(j.candidateMethod ? j.candidateMethod.name : '未选定方法')) +
      '（' + cands.length + ' 只）</h3>' +
      src('东方财富最新涨停池 ' + (m.poolDate || '—') + '；基准价 腾讯证券 ' + (m.quoteTick || '—')) + '</div>' +
      (cands.length ? '<div class="tbl-wrap"><table><thead><tr><th>#</th><th class="left">代码 / 名称</th><th>今日基准价 C</th><th>回踩买入价</th><th>破位放弃价</th><th>高开放弃价</th><th>排序分</th><th class="left">风险标签</th></tr></thead><tbody>' + cRows + '</tbody></table></div>'
        : '<div class="card empty">最新交易日涨停池中没有符合胜出方法选股条件的标的；系统不降低门槛凑数。</div>') +
      (cands.length ? '<div class="grid2" style="margin-top:12px">' +
        '<div class="info-card"><h4>计划执行步骤（T 日收盘后制定，T+1 才决定是否买）</h4><ul class="tight">' +
        steps.map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>' +
        '<div class="info-card"><h4>未触发 / 失效条件（任一出现即放弃）</h4><ul class="tight">' +
        invalids.map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div></div>' : '') +
      '<div class="note-box" style="margin-top:10px"><b>计划口径：</b>上表所有价位仅由「今日收盘价 C」机械推算（C×0.98 / C×0.95 / C×1.05），不含任何明日信息；' +
      '所有候选共用同一计划模板，差异只在是否符合「' + E(j.candidateMethod ? j.candidateMethod.name : '—') + '」的选股条件。' +
      '排序分只用于排序，不是收益预测。<b>这是条件化观察清单，不是买入指令</b>；未触发就是「没机会不做」，不追价。' +
      (j.verdict === 'no-edge' ? '<br><b>重要：</b>胜出方法在本区间并未跑赢「不筛选」的全池基准，下方计划<b>不具备方法优势</b>，应视作普通涨停股的条件观察，而非优选推荐。'
        : (j.verdict === 'insufficient' ? '<br><b>重要：</b>本区间成交样本不足，未选定最佳方法；下方计划按「全池基准」生成，<b>不做任何优选</b>，只是把同一套次日触发规则套到当日涨停股上，供条件观察。' : '')) + '</div></div>';

    const methodDoc = '<div class="sec"><div class="card pad"><div class="sec-head"><h3>回测口径与能力边界</h3></div>' +
      (m.methodology && m.methodology.rules ? m.methodology.rules.map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') : '') +
      '<div class="note-box">' + E((m.methodology && m.methodology.caveat) || '') + '</div>' +
      '<div class="small muted" style="margin-top:8px">数据溯源：' + E(m.dataSourceNote || j.metaNote || '—') +
      ' · 跳过样本：无日K ' + E((j.skipped || {}).noKline || 0) + ' / 缺 T+1 或 T+2 日K（观察中）' + E((j.skipped || {}).noT2Bar || 0) +
      ' / 计划参数异常 ' + E((j.skipped || {}).noPlan || 0) + ' / 无涨停池 ' + E((j.skipped || {}).noPool || 0) + '</div></div></div>';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';

    $('pane-enlighten').innerHTML = head + controls + marketCard + methodCard + bestCard + candCard + methodDoc + disc;
    $('enDays').onchange = e => { S.enOpts.days = Number(e.target.value); loadEnlightenment(true); };
    $('enReload').onclick = () => loadEnlightenment(true);

    const items = methods.slice().sort((a, b) => (Number(a.expectancy) || 0) - (Number(b.expectancy) || 0))
      .map(x => ({ name: x.name, value: Number(x.expectancy) || 0, label: N(x.expectancy) + '%', kind: x.kind }));
    const opt = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 150, right: 48, top: 10, bottom: 24 },
      xAxis: { type: 'value', ...AXIS, axisLabel: { color: '#6b7a8c', fontSize: 10, formatter: '{value}%' } },
      yAxis: { type: 'category', data: items.map(x => x.name), ...AXIS },
      series: [{
        type: 'bar', barMaxWidth: 17,
        data: items.map(x => ({ value: x.value, itemStyle: { color: x.kind === '基准' ? '#94a3b8' : (x.kind === '对照' ? '#d97706' : '#2f6fd0') } })),
        label: { show: true, position: 'right', formatter: '{c}%', fontSize: 10, color: '#4b5b6b' }
      }]
    };
    safeChart('enMethodChart', opt, items);
  }

  /* ═══════════════ 个股搜索（代码 / 名称 → 打开K线弹窗） ═══════════════ */
  function initStockSearch() {
    const input = $('stockSearchInput'), panel = $('stockSearchPanel');
    if (!input || !panel) return;
    let timer = null, hits = [];
    const close = () => { panel.style.display = 'none'; panel.innerHTML = ''; };
    const pick = x => {
      close(); input.value = '';
      openStockChart(x.code);
      if (S.chart && x.name) { S.chart.name = x.name; $('smName').innerHTML = boardBadge(x.code) + E(x.name); }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const kw = input.value.trim();
      if (!kw) { close(); return; }
      timer = setTimeout(async () => {
        try {
          const r = await fetch('/api/search?q=' + encodeURIComponent(kw), { cache: 'no-store' });
          const j = await r.json();
          if (input.value.trim() !== kw) return;      // 输入已变化，丢弃过期结果
          hits = j.list || [];
          if (!hits.length) {
            panel.innerHTML = '<div class="ss-empty">未找到匹配股票（全市场约 5,500 只，可按代码 / 名称 / 拼音首字母匹配，如 dfhy）</div>';
          } else {
            panel.innerHTML = hits.map((x, i) =>
              '<div class="ss-item" data-i="' + i + '"><b>' + boardBadge(x.code) + E(x.name) + '</b><span class="ss-code">' + E(x.code) + '</span>' +
              '<span class="ss-px ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + N(x.price) + '</span>' +
              '<span class="ss-pct ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + (x.pct > 0 ? '+' : '') + N(x.pct) + '%</span>' +
              '<span class="ss-board">' + E(x.board || '') + '</span>' +
              '<button class="ss-star' + (wlHas(x.code) ? ' on' : '') + '" data-ss-star="' + E(x.code) + '" title="加入 / 取消自选">' + (wlHas(x.code) ? '★' : '☆') + '</button></div>').join('') +
              '<div class="ss-foot">新浪财经全市场行情 · 截至 ' + E(String(j.asOf || '').slice(0, 16).replace('T', ' ')) + ' · ↑↓ 选择 / Enter 打开 · ☆ 加自选</div>';
            [...panel.querySelectorAll('.ss-item')].forEach(el => { el.onclick = () => pick(hits[Number(el.dataset.i)]); });
            [...panel.querySelectorAll('[data-ss-star]')].forEach(b => {
              b.onclick = ev => {
                ev.preventDefault(); ev.stopPropagation();
                const code = b.dataset.ssStar, hit = hits.find(h => String(h.code) === code) || {};
                watchToggle(code, hit.name || code);
                b.classList.toggle('on', wlHas(code)); b.textContent = wlHas(code) ? '★' : '☆';
              };
            });
          }
          panel.style.display = 'block';
        } catch (e) { if (input.value.trim() !== kw) return; panel.innerHTML = '<div class="ss-empty">搜索失败：' + E(e.message) + '</div>'; panel.style.display = 'block'; }
      }, 220);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); input.blur(); return; }
      if (!hits.length) return;
      let idx = [...panel.querySelectorAll('.ss-item')].findIndex(el => el.classList.contains('active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = e.key === 'ArrowDown' ? Math.min(hits.length - 1, idx + 1) : Math.max(0, idx - 1);
        [...panel.querySelectorAll('.ss-item')].forEach((el, i) => el.classList.toggle('active', i === idx));
      } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); pick(hits[idx]); }
    });
    document.addEventListener('click', e => {
      if (!$('stockSearch').contains(e.target)) close();
    });
  }

  /* ═══════════════ 自选股：左侧列表 + 右侧复用个股详情 ═══════════════ */
  const wlFind = code => S.watch.list.find(x => x.code === String(code));
  const wlHas = code => !!wlFind(code);
  let smDialogEl = null; // 弹窗 .sm-dialog 节点引用：在遮罩与自选右栏间移动复用
  const getSmDialog = () => smDialogEl || (smDialogEl = document.querySelector('.sm-dialog'));
  /**
   * 背景滚动锁的唯一入口：只有「全屏遮罩弹窗」可见时才锁 body。
   * 停靠在自选股右栏的详情是页面内容的一部分，必须保持整页可滚；
   * 之前各处直接写 body.style.overflow，停靠态也被锁死且切模块后不会自动恢复。
   */
  function syncBodyScrollLock() {
    const modal = $('stockModal'), cfg = $('moduleCfgMask');
    const locked = (modal && modal.style.display !== 'none') || (cfg && cfg.style.display !== 'none');
    document.body.style.overflow = locked ? 'hidden' : '';
  }
  /** 把个股详情停靠到自选右栏（docked=true）或移回弹窗遮罩（false） */
  function dockDialog(docked) {
    const dlg = getSmDialog(), modal = $('stockModal'); if (!dlg || !modal) return;
    S.chart.docked = !!docked;
    if (docked) {
      const host = $('wlDetail');
      if (host) { host.innerHTML = ''; host.appendChild(dlg); }
      modal.style.display = 'none';
    } else {
      if (dlg.parentNode !== modal) modal.appendChild(dlg);
      modal.style.display = 'flex';
    }
    syncBodyScrollLock();
  }
  /** renderWatchlist 重建左栏前先摘下已停靠的详情节点，避免连同 innerHTML 一起销毁 */
  function detachDockedDialog() {
    if (!S.chart.docked) return;
    const dlg = getSmDialog();
    if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
  }
  /** 详情渲染完成后把节点重新挂回右栏 */
  function reattachDockedDialog() {
    if (!S.chart.docked) return;
    const dlg = getSmDialog(), host = $('wlDetail');
    if (dlg && host && dlg.parentNode !== host) host.appendChild(dlg);
  }
  function updateStar() {
    const b = $('smStar'); if (!b) return;
    const code = S.chart && S.chart.code;
    const on = !!(code && wlHas(code));
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
    b.title = on ? '取消自选' : '加入自选';
  }

  function watchAdd(code, name) {
    const c = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(c) || wlHas(c)) return false;
    S.watch.list.push({ code: c, name: String(name || c) });
    watchSave(); renderWatchlist(); refreshWatchQuotes(true); updateStar();
    return true;
  }
  function watchRemove(code) {
    const c = String(code || '');
    S.watch.list = S.watch.list.filter(x => x.code !== c);
    watchSave(); renderWatchlist(); updateStar();
  }
  function watchToggle(code, name) {
    if (wlHas(code)) { watchRemove(code); return false; }
    watchAdd(code, name); return true;
  }

  /** 左栏列表：用 /api/quotes 批量实时行情，逐只显示现价/涨跌幅，点击进入右栏详情 */
  function renderWatchlist() {
    const pane = $('pane-watchlist'); if (!pane) return;
    detachDockedDialog();
    // 行情轮询会重建列表：先记住添加框状态，重建后还原，避免拼音尚未输完就被清空
    const prevInput = $('wlAddInput');
    const addOpen = !!(prevInput && prevInput.parentElement && prevInput.parentElement.classList.contains('open'));
    const addVal = prevInput ? prevInput.value : '';
    const addFocused = !!prevInput && document.activeElement === prevInput;
    const addPos = prevInput ? prevInput.selectionStart : null;
    const prevSug = $('wlAddPanel');
    const sugHtml = prevSug ? prevSug.innerHTML : '';
    const sugShown = prevSug ? prevSug.style.display : '';
    const list = S.watch.list;
    const q = S.watch.quotes || {};
    if (!list.length) {
      pane.innerHTML = '<div class="wl-layout"><div class="wl-panel">' +
        '<div class="wl-panel-head"><h3>自选股 <span class="muted small" id="wlCount">0</span></h3>' +
        '<div class="wl-panel-tools"><button class="wl-btn" id="wlAddBtn">＋ 添加</button></div></div>' +
        '<div class="wl-add-wrap"><div class="wl-add-row" id="wlAddRow"><input id="wlAddInput" placeholder="代码 / 名称 / 拼音，如 dfhy" autocomplete="off"><button class="wl-btn primary" id="wlAddOk">添加</button></div>' +
        '<div class="wl-sug-panel" id="wlAddPanel" style="display:none"></div></div>' +
        '<div class="wl-empty">还没有自选股。<br>点「＋ 添加」输入代码、名称或拼音首字母；<br>也可在搜索结果 / 个股详情点 ☆ 加入。</div></div>' +
        '<div class="wl-detail" id="wlDetail"><div class="wl-empty">从左侧选择一只自选股，右侧显示分时 / 日K / 筹码峰 / 详情</div></div></div>';
      bindWatchEvents(); restoreAddState(addOpen, addVal, addFocused, addPos, sugHtml, sugShown); return;
    }
    const items = list.map(x => {
      const qq = q[x.code] || {};
      const px = qq.price > 0 ? N(qq.price) : '—';
      const pct = Number.isFinite(Number(qq.pct)) ? Number(qq.pct) : null;
      const pcls = pct === null ? '' : (pct > 0 ? 'up' : pct < 0 ? 'down' : '');
      const pctTxt = pct === null ? '—' : (pct > 0 ? '+' : '') + N(pct) + '%';
      const active = S.watch.sel === x.code ? ' active' : '';
      return '<div class="wl-item' + active + '" data-wl-code="' + E(x.code) + '">' +
        '<div class="wl-item-top">' + boardBadge(x.code) +
        '<span class="wl-item-name">' + E(x.name) + '</span>' +
        '<span class="wl-item-code">' + E(x.code) + '</span>' +
        '<button class="wl-del" data-wl-del="' + E(x.code) + '" title="移出自选">×</button></div>' +
        '<div class="wl-item-bottom"><span class="wl-item-px ' + pcls + '">' + px + '</span>' +
        '<span class="wl-item-pct ' + pcls + '">' + pctTxt + '</span>' +
        '<span class="wl-item-sub">' + E(boardOfCode(x.code) || '') + '</span></div></div>';
    }).join('');
    pane.innerHTML = '<div class="wl-layout"><div class="wl-panel">' +
      '<div class="wl-panel-head"><h3>自选股 <span class="muted small" id="wlCount">' + list.length + '</span></h3>' +
      '<div class="wl-panel-tools"><button class="wl-btn primary" id="wlAddBtn">＋ 添加</button></div></div>' +
      '<div class="wl-add-wrap"><div class="wl-add-row" id="wlAddRow"><input id="wlAddInput" placeholder="代码 / 名称 / 拼音，如 dfhy" autocomplete="off"><button class="wl-btn primary" id="wlAddOk">添加</button></div>' +
      '<div class="wl-sug-panel" id="wlAddPanel" style="display:none"></div></div>' +
      '<div class="wl-list" id="wlList">' + items + '</div>' +
      '<div class="small muted" style="margin-top:7px;line-height:1.6">行情为腾讯实时快照，随主看板刷新；列表存本地浏览器，不上传。</div></div>' +
      '<div class="wl-detail" id="wlDetail"><div class="wl-empty">从左侧选择一只自选股，右侧显示分时 / 日K / 筹码峰 / 详情</div></div></div>';
    bindWatchEvents();
    restoreAddState(addOpen, addVal, addFocused, addPos, sugHtml, sugShown);
  }

  /** 还原添加框输入内容、焦点与实时候选，避免行情轮询重建 DOM 时打断输入 */
  function restoreAddState(open, val, focused, pos, sugHtml, sugShown) {
    if (!open) return;
    const row = $('wlAddRow'); if (row) row.classList.add('open');
    const inp = $('wlAddInput'); if (!inp) return;
    inp.value = val;
    const panel = $('wlAddPanel');
    if (panel && sugHtml) { panel.innerHTML = sugHtml; panel.style.display = sugShown || 'block'; }
    if (focused) {
      inp.focus();
      try { inp.setSelectionRange(pos == null ? val.length : pos, pos == null ? val.length : pos); } catch (_) { }
    }
  }

  /** 批量拉自选股实时行情（复用顶部搜索同款 /api/quotes） */
  async function refreshWatchQuotes(force) {
    const list = S.watch.list; if (!list.length) return;
    if (!force && Date.now() - (S.watch.at || 0) < 8000) return;
    S.watch.at = Date.now();
    try {
      const codes = list.map(x => x.code).join(',');
      const r = await fetch('/api/quotes?codes=' + encodeURIComponent(codes), { cache: 'no-store' });
      const j = await r.json();
      if (j.quotes) {
        Object.keys(j.quotes).forEach(c => {
          const qq = j.quotes[c] || {};
          const hit = wlFind(c); if (hit && qq.name) hit.name = qq.name;
        });
        S.watch.quotes = j.quotes;
        if (S.tab === 'watchlist') renderWatchlist();
      }
    } catch (e) { /* 行情刷新失败保留上一帧 */ }
  }

  function bindWatchEvents() {
    const pane = $('pane-watchlist'); if (!pane) return;
    reattachDockedDialog();
    if (pane.dataset.bound === '1') return;
    let sugTimer = null, sugHits = [];
    const hideSug = () => {
      const p = $('wlAddPanel'); if (p) { p.style.display = 'none'; p.innerHTML = ''; }
      sugHits = [];
    };
    // 事件委托绑在 pane 上，renderWatchlist 重建 innerHTML 后仍有效
    pane.addEventListener('click', e => {
      const sug = e.target.closest('[data-wl-sug]');
      if (sug) {
        e.stopPropagation();
        const hit = sugHits[Number(sug.dataset.wlSug)];
        if (hit) {
          watchAdd(hit.code, hit.name);
          const inp = $('wlAddInput'); if (inp) { inp.value = ''; inp.focus(); }
        }
        hideSug(); return;
      }
      const del = e.target.closest('[data-wl-del]');
      if (del) { e.stopPropagation(); watchRemove(del.dataset.wlDel); return; }
      if (e.target.closest('#wlAddBtn')) {
        const row = $('wlAddRow'); if (row) row.classList.toggle('open');
        const inp = $('wlAddInput'); if (inp && row.classList.contains('open')) inp.focus();
        return;
      }
      if (e.target.closest('#wlAddOk') || (e.key === 'Enter' && e.target.id === 'wlAddInput')) { doWatchAdd(); return; }
      const item = e.target.closest('[data-wl-code]');
      if (item) {
        e.stopPropagation();
        const code = item.dataset.wlCode;
        S.watch.sel = code;
        [...pane.querySelectorAll('.wl-item')].forEach(el => el.classList.toggle('active', el.dataset.wlCode === code));
        openStockChart(code, true); // docked：详情停靠到右栏
      }
    });
    // 与顶部搜索共用 /api/search：代码 / 名称 / 拼音首字母实时候选
    pane.addEventListener('input', e => {
      if (e.target.id !== 'wlAddInput') return;
      clearTimeout(sugTimer);
      const kw = e.target.value.trim();
      if (!kw) { hideSug(); return; }
      sugTimer = setTimeout(async () => {
        try {
          const r = await fetch('/api/search?q=' + encodeURIComponent(kw), { cache: 'no-store' });
          const j = await r.json();
          const inp = $('wlAddInput');
          if (!inp || inp.value.trim() !== kw) return; // 输入已变化，丢弃过期结果
          sugHits = (j.list || []).slice(0, 8);
          const p = $('wlAddPanel'); if (!p) return;
          p.innerHTML = sugHits.length
            ? sugHits.map((x, i) => '<div class="wl-sug" data-wl-sug="' + i + '"><b>' + E(x.name) + '</b><span class="code">' + E(x.code) + '</span><span class="px">' + N(x.price) + '</span></div>').join('')
            : '<div class="wl-sug-empty">未找到匹配股票（支持代码 / 名称 / 拼音首字母）</div>';
          p.style.display = 'block';
        } catch (_) { hideSug(); }
      }, 200);
    });
    pane.addEventListener('keydown', e => {
      if (e.target.id !== 'wlAddInput') return;
      if (e.key === 'Escape') { hideSug(); return; }
      if (e.key === 'Enter') { e.preventDefault(); doWatchAdd(); }
    });
    document.addEventListener('click', e => { if (!e.target.closest('.wl-add-wrap')) hideSug(); });
    pane.dataset.bound = '1';
  }

  async function doWatchAdd() {
    const inp = $('wlAddInput'); if (!inp) return;
    const kw = inp.value.trim(); if (!kw) return;
    inp.disabled = true;
    try {
      if (/^\d{6}$/.test(kw)) { watchAdd(kw, kw); inp.value = ''; return; }
      const r = await fetch('/api/search?q=' + encodeURIComponent(kw), { cache: 'no-store' });
      const j = await r.json();
      const hit = (j.list || [])[0];
      if (hit) { watchAdd(hit.code, hit.name); inp.value = ''; }
      else { inp.title = '未找到匹配股票'; setTimeout(() => { inp.title = ''; }, 2500); }
    } catch (e) { /* 添加失败不打断 */ }
    finally { inp.disabled = false; }
  }

  /* ═══════════════ 个股K线弹窗：分时 / 日K / 周K / 成交量 / 筹码峰 ═══════════════ */
  function openStockChart(code, docked) {
    const c = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(c)) return;
    stopMinuteTimer();
    S.chart = { open: true, code: c, name: c, period: 'minute', data: null, loading: true, error: null, view: null, geom: null, lockIdx: null, docked: !!docked };
    dockDialog(!!docked);
    $('smName').innerHTML = boardBadge(c) + E(c);
    $('smCode').textContent = '';
    $('smQuote').innerHTML = '';
    $('smSource').textContent = '载入中…';
    $('smBody').innerHTML = '<div class="empty">正在拉取 ' + E(c) + ' 的分时 / 日K / 周K / 筹码分布…</div>';
    $('smFoot').innerHTML = '';
    fetch('/api/stock/chart?code=' + encodeURIComponent(c))
      .then(r => r.json())
      .then(j => {
        if (S.chart.code !== c) return; // 期间切换了标的
        if (j.error) throw new Error(j.error);
        S.chart.data = j;
        S.chart.name = j.name || c;
        S.chart.loading = false;
        // 用接口返回的真实名称回填自选列表（搜索添加时可能只有代码占位）
        const wl = wlFind(c); if (wl && j.name) { wl.name = j.name; watchSave(); if (S.tab === 'watchlist') renderWatchlist(); }
        $('smName').innerHTML = boardBadge(c) + E(j.name || c);
        $('smCode').textContent = E(c);
        updateStar();
        renderStockChart();
      })
      .catch(e => {
        S.chart.loading = false;
        S.chart.error = isConnError(e) ? SERVICE_HINT : String(e && e.message || e);
        $('smSource').textContent = '加载失败';
        $('smBody').innerHTML = '<div class="empty">' + E(S.chart.error) + '</div>';
      });
  }

  // 分时图自动刷新：只在「弹窗开着 + 分时 tab + 交易时段」时每 12 秒重拉，
  // 不复用主看板定时器，关闭弹窗或切到K线 tab 立即停掉。
  function stopMinuteTimer() {
    if (S.chart && S.chart.minuteTimer) { clearInterval(S.chart.minuteTimer); S.chart.minuteTimer = null; }
  }
  function syncMinuteTimer() {
    const c = S.chart;
    if (!c || !c.open || c.period !== 'minute' || !c.data || !isTradingNow() || c.histDate ||
      (c.docked && S.tab !== 'watchlist')) { stopMinuteTimer(); return; }
    if (c.minuteTimer) return;
    c.minuteTimer = setInterval(() => {
      const cur = S.chart;
      if (!cur || !cur.open || cur.period !== 'minute' || (cur.docked && S.tab !== 'watchlist')) { stopMinuteTimer(); return; }
      if (!isTradingNow()) { stopMinuteTimer(); renderStockChart(); return; }
      refreshMinuteOnly(cur.code);
    }, 12000);
  }
  async function refreshMinuteOnly(code) {
    try {
      const r = await fetch('/api/stock/minute?code=' + encodeURIComponent(code), { cache: 'no-store' });
      const j = await r.json();
      if (!S.chart || S.chart.code !== code || S.chart.period !== 'minute') return;
      if (j.error) return;
      S.chart.data.minute = j.minute || {};
      S.chart.data.quote = j.quote || S.chart.data.quote;
      S.chart.data.seal = j.seal || null;
      if (j.fund && j.fund.now) S.chart.data.fund = Object.assign({}, S.chart.data.fund, { now: j.fund.now });
      renderStockChart();
    } catch (e) { /* 分时刷新失败保留上一帧，不打断查看 */ }
  }

  /** 从日K某天进入该交易日历史分时：最近5日腾讯1分钟线，更早东财5分钟线(约1个月)，超范围如实提示 */
  async function loadMinuteOfDate(date) {
    const c = S.chart, d = String(date || '').replace(/\D/g, '');
    if (!c || !c.data || !/^\d{8}$/.test(d)) return;
    const code = c.code;
    stopMinuteTimer();
    $('smSource').textContent = '正在拉取 ' + E(d) + ' 分时…';
    try {
      const r = await fetch('/api/stock/minute?code=' + encodeURIComponent(code) + '&date=' + encodeURIComponent(d), { cache: 'no-store' });
      const j = await r.json();
      if (!S.chart || S.chart.code !== code) return; // 期间切换了标的
      if (j.error) throw new Error(j.error);
      const md = j.minute || {};
      if (!md.rows || !md.rows.length) {
        // 超范围/无数据：留在日K，弹出明确提示，不伪造分时
        alert('无法查看 ' + d + ' 分时：' + (md.reason || '该交易日分时数据不可用'));
        renderStockChart();
        return;
      }
      c.histDate = d;
      c.histMinute = md;                 // 历史分时单独保存，不覆盖当日
      c.period = 'minute';
      c.view = null; c.lockIdx = null;
      renderStockChart();
    } catch (e) {
      $('smSource').textContent = '历史分时加载失败';
      $('smBody').innerHTML = '<div class="empty">' + E(isConnError(e) ? SERVICE_HINT : (e && e.message || e)) + '</div>';
    }
  }

  function closeStockChart() {
    stopMinuteTimer();
    S.chart.open = false;
    if (S.chart.docked) {
      // 停靠态：把详情节点移回遮罩并隐藏，右栏恢复空提示
      const dlg = getSmDialog(), m = $('stockModal');
      if (dlg && m && dlg.parentNode !== m) m.appendChild(dlg);
      if (m) m.style.display = 'none';
      const host = $('wlDetail'); if (host) host.innerHTML = '<div class="wl-empty">已从左侧选择 ' + E(S.chart.code || '') + '，点击可再次查看详情</div>';
      S.chart.docked = false;
      syncBodyScrollLock();
      return;
    }
    const m = $('stockModal'); if (m) m.style.display = 'none';
    syncBodyScrollLock();
  }

  /* K线配色设置面板：5 类颜色 + 恢复默认 + 口径说明 */
  function smColorPanelHtml() {
    const items = KL_COLOR_META.map(m =>
      '<label class="sm-clr-item"><span>' + E(m.label) + '</span>' +
      '<input type="color" data-klcolor="' + m.k + '" value="' + E(S.klColors[m.k]) + '" title="点击选择颜色"></label>'
    ).join('');
    const rateNote = '涨停/跌停按收盘价相对前收的涨跌幅判定：主板 ±10%、创业板/科创板 ±20%、北交所 ±30%、ST ±5%（容差 0.3%）；' +
      '炸板为盘中最高/最低触及涨跌停价但收盘未封住。周K无涨跌停制度，不标记。识别为近似推算，仅供复盘参考。';
    return '<div class="sm-color-panel" id="smColorPanel">' +
      '<div class="sm-clr-head"><b>🎨 K线配色设置</b><span class="small muted">改动即时生效并自动保存</span>' +
      '<button type="button" data-kact="colors" class="sm-clr-close" title="收起">收起</button></div>' +
      '<div class="sm-clr-grid">' + items + '</div>' +
      '<div class="sm-clr-foot"><button type="button" class="sm-clr-reset" id="smClrReset">恢复默认配色</button>' +
      '<span class="small muted">' + E(rateNote) + '</span></div></div>';
  }

  /** 分时图：价格线（水上红 / 水下绿） + 均价线 + 昨收基准 + 成交量，纯 SVG 无额外依赖 */
  function smMinuteSvg(rows, quote, mdate, seal) {
    if (!rows || rows.length < 2) return '<div class="empty">分时数据不足（需 ≥2 分钟），无法绘制</div>';
    const W = 1110, H = 520, L = 62, R = 68, PT = 22, PB = 388, VT = 406, VB = 498;
    const PW = W - L - R;
    const prev = Number(quote && quote.prevClose) > 0 ? Number(quote.prevClose) : rows[0].price;
    const prices = rows.map(x => x.price);
    const maxDev = Math.max(0.02, ...prices.map(p => Math.abs(p - prev) / prev));
    const hi = prev * (1 + maxDev * 1.12), lo = prev * (1 - maxDev * 1.12);
    const Y = p => PB - (p - lo) / (hi - lo) * (PB - PT);

    // 当前涨幅：当日分时优先用行情快照口径（相对昨收）；历史分时无快照，
    // 退化为「相对该日首分钟价」的区间涨幅，文案也相应改为「较首价」，避免误标成实时涨幅。
    const lastPrice = Number(rows[rows.length - 1] && rows[rows.length - 1].price);
    const rawPct = quote && quote.pct;
    const hasSnapPct = rawPct !== null && rawPct !== undefined && rawPct !== '' && Number.isFinite(Number(rawPct)) && Number(quote && quote.prevClose) > 0;
    const snapPct = hasSnapPct ? Number(rawPct) : null;
    const chartPct = prev > 0 && Number.isFinite(lastPrice) ? (lastPrice - prev) / prev * 100 : null;
    const curPct = hasSnapPct ? snapPct : chartPct;
    const curPctText = curPct === null ? null : (curPct > 0 ? '+' : '') + curPct.toFixed(2) + '%';
    const curColor = curPct === null || Math.abs(curPct) < 0.005 ? 'var(--ink2)' : (curPct > 0 ? 'var(--up)' : 'var(--down)');

    // A股交易时段 09:30–11:30、13:00–15:00 共 240 分钟，横轴按真实时间定位。
    // 盘中只画到当前时刻，右侧剩余时段留白，不再把已有分钟拉伸铺满整幅。
    const TOTAL = 240;
    const TICKS = [
      { m: 0,   t: '09:30' },
      { m: 60,  t: '10:30' },
      { m: 120, t: '11:30/13:00' },
      { m: 180, t: '14:00' },
      { m: 240, t: '15:00' }
    ];
    const toMin = t => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
      if (!m) return null;
      const v = (+m[1]) * 60 + (+m[2]);
      if (v >= 570 && v <= 690) return v - 570;            // 09:30–11:30
      if (v >= 780 && v <= 900) return 120 + (v - 780);     // 13:00–15:00
      if (v > 555 && v < 570) return 0;                     // 9:25 竞价结果归入开盘
      return null;
    };
    const mins = rows.map(x => toMin(x.time));
    const byTime = mins.every((v, i) => v !== null && (i === 0 || v >= mins[i - 1]));
    const tX = v => L + Math.max(0, Math.min(TOTAL, v)) / TOTAL * PW;
    const X = byTime ? i => tX(mins[i]) : i => L + i / Math.max(1, rows.length - 1) * PW;
    const a = [];
    a.push('<svg viewBox="0 0 ' + W + ' ' + H + '" class="sm-chart-svg" preserveAspectRatio="xMidYMid meet">');
    // 竖向时间网格（中午休市分界线加深）
    TICKS.forEach((tk, k) => {
      const x = tX(tk.m);
      a.push('<line x1="' + x.toFixed(1) + '" y1="' + PT + '" x2="' + x.toFixed(1) + '" y2="' + VB + '" stroke="' + (k === 2 ? '#cbd5e1' : '#eef2f7') + '" stroke-dasharray="' + (k === 2 ? '3 4' : '2 5') + '"/>');
    });
    // 首封时刻竖线：把封单情况直接标在分时图上（来自东财涨停/炸板/跌停池快照，跌停用绿色）
    const sealMin = seal && seal.firstSeal ? toMin(String(seal.firstSeal).slice(0, 5)) : null;
    if (sealMin !== null && sealMin !== undefined) {
      const sx = tX(sealMin), isDtSeal = seal.kind === 'dt';
      const sealColor = isDtSeal ? '#0f9960' : '#e3a800', sealTextColor = isDtSeal ? '#0b7a4b' : '#a87600';
      a.push('<line x1="' + sx.toFixed(1) + '" y1="' + PT + '" x2="' + sx.toFixed(1) + '" y2="' + VB + '" stroke="' + sealColor + '" stroke-dasharray="4 3"/>');
      a.push('<text x="' + Math.min(sx + 5, W - R - 92).toFixed(1) + '" y="' + (PT + 12) + '" font-size="10" fill="' + sealTextColor + '">' + (isDtSeal ? '首封跌停 ' : '首封 ') + E(String(seal.firstSeal).slice(0, 5)) + '</text>');
    }
    // 横向网格 + 涨跌幅刻度
    for (let k = 0; k <= 4; k++) {
      const p = lo + (hi - lo) * k / 4, y = Y(p);
      const dev = (p - prev) / prev * 100;
      const col = dev > 0.01 ? 'var(--up)' : dev < -0.01 ? 'var(--down)' : 'var(--ink2)';
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (W - R + 6) + '" y="' + (y + 4).toFixed(1) + '" font-size="11" fill="' + col + '">' + (dev > 0 ? '+' : '') + dev.toFixed(2) + '%</text>');
      a.push('<text x="6" y="' + (y + 4).toFixed(1) + '" font-size="11" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    // 昨收虚线
    a.push('<line x1="' + L + '" y1="' + Y(prev).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(prev).toFixed(1) + '" stroke="#8593a3" stroke-dasharray="4 4"/>');
    // 集合竞价结果：开盘价即 9:25 竞价成交价，单独虚线标注
    const auction = Number(quote && quote.open) > 0 ? Number(quote.open) : null;
    if (auction && Math.abs(auction - prev) / prev > 0.0001) {
      a.push('<line x1="' + L + '" y1="' + Y(auction).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(auction).toFixed(1) + '" stroke="#6d4bd6" stroke-dasharray="2 5"/>');
      a.push('<text x="' + L + '" y="' + (Y(auction) - 5).toFixed(1) + '" font-size="10" fill="#6d4bd6">竞价开盘 ' + auction.toFixed(2) + '（' + ((auction - prev) / prev * 100 > 0 ? '+' : '') + ((auction - prev) / prev * 100).toFixed(2) + '%）</text>');
    }
    // 成交量柱（每分钟）
    const maxV = Math.max(1, ...rows.map(x => x.volume || 0));
    const step = byTime ? PW / TOTAL : PW / Math.max(1, rows.length - 1);
    const bw = Math.max(1, step * 0.62);
    rows.forEach((x, i) => {
      const h = (x.volume || 0) / maxV * (VB - VT);
      a.push('<rect x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (x.price >= prev ? 'var(--up)' : 'var(--down)') + '" opacity=".55"/>');
    });
    // 价格线：以昨收为界，水上红色 / 水下绿色，穿越处按线性插值分段
    const segUp = [], segDown = [];
    const pt = (s, x, y, move) => s.push((move ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1));
    let side = prices[0] >= prev ? 'up' : 'down';
    pt(side === 'up' ? segUp : segDown, X(0), Y(prices[0]), true);
    for (let i = 1; i < rows.length; i++) {
      const p0 = prices[i - 1], p1 = prices[i];
      const x0 = X(i - 1), x1 = X(i);
      const up0 = p0 >= prev, up1 = p1 >= prev;
      if (up0 === up1) {
        pt(side === 'up' ? segUp : segDown, x1, Y(p1), false);
      } else {
        const cross = x0 + (x1 - x0) * ((prev - p0) / (p1 - p0));
        pt(side === 'up' ? segUp : segDown, cross, Y(prev), false);
        side = up1 ? 'up' : 'down';
        pt(side === 'up' ? segUp : segDown, cross, Y(prev), true);
        pt(side === 'up' ? segUp : segDown, x1, Y(p1), false);
      }
    }
    if (segUp.length) a.push('<path d="' + segUp.join(' ') + '" fill="none" stroke="var(--up)" stroke-width="1.8" stroke-linejoin="round"/>');
    if (segDown.length) a.push('<path d="' + segDown.join(' ') + '" fill="none" stroke="var(--down)" stroke-width="1.8" stroke-linejoin="round"/>');
    // 均价线（累计成交额 / 累计成交量 / 100，与腾讯口径一致）
    let amt = 0, vol = 0;
    const avgPts = rows.map((x, i) => {
      amt += Number(x.amount) || 0;
      vol += Number(x.volume) || 0;
      const avg = vol > 0 ? amt / (vol * 100) : x.price;
      return X(i).toFixed(1) + ',' + Y(avg).toFixed(1);
    }).join(' ');
    a.push('<polyline points="' + avgPts + '" fill="none" stroke="#d97706" stroke-width="1.5" stroke-dasharray="3 2"/>');
    // 时间轴：固定交易时段刻度
    TICKS.forEach((tk, k) => {
      const anchor = k === 0 ? 'start' : (k === TICKS.length - 1 ? 'end' : 'middle');
      a.push('<text x="' + tX(tk.m).toFixed(1) + '" y="' + (VB + 15) + '" font-size="10.5" fill="#6b7a8c" text-anchor="' + anchor + '">' + tk.t + '</text>');
    });
    a.push('<text x="' + L + '" y="14" font-size="10.5" fill="#8593a3">分时价格 / 均价 · ' + E(mdate || '最近交易日') + ' · 腾讯证券</text>');
    // 图内右上角醒目标注当前涨幅（红涨绿跌），与右侧图例错开，不遮挡分时曲线
    if (curPctText) {
      a.push('<rect x="' + (W - R - 274) + '" y="2" width="132" height="18" rx="4" fill="' + curColor + '" opacity=".10"/>');
      a.push('<text x="' + (W - R - 208) + '" y="14.5" font-size="12" font-weight="700" text-anchor="middle" fill="' + curColor + '">' +
        (hasSnapPct ? '当前涨幅 ' : '较首价 ') + curPctText + '</text>');
    }
    a.push('<circle cx="' + (W - R - 128) + '" cy="10.5" r="3" fill="var(--up)"/><text x="' + (W - R - 120) + '" y="14" font-size="10" fill="#8593a3">昨收上</text>');
    a.push('<circle cx="' + (W - R - 62) + '" cy="10.5" r="3" fill="var(--down)"/><text x="' + (W - R - 54) + '" y="14" font-size="10" fill="#8593a3">昨收下</text>');
    a.push('<text x="' + L + '" y="' + (VT - 6) + '" font-size="10.5" fill="#8593a3">成交量（手）</text>');
    // 分时线末端：现价 + 涨幅跟随曲线终点，盘中一眼可见；靠近右边界时标签自动翻到左侧
    if (Number.isFinite(lastPrice) && curPctText) {
      const lx = X(rows.length - 1), ly = Y(lastPrice);
      const rightSide = lx < W - R - 118;
      const tx = rightSide ? lx + 9 : lx - 9;
      const ty = Math.max(PT + 13, Math.min(PB - 8, ly - 8));
      a.push('<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="3.6" fill="' + curColor + '" stroke="#fff" stroke-width="1.2"/>');
      a.push('<text x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="' + (rightSide ? 'start' : 'end') +
        '" font-size="11.5" font-weight="700" fill="' + curColor + '" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">' +
        lastPrice.toFixed(2) + ' ' + curPctText + '</text>');
    }
    a.push('</svg>');
    return a.join('');
  }

  /** 分时 / 五日共用：右侧现价快照 + 涨停/炸板封单卡片，均为真实接口数据 */
  function smQuoteSealSide(q, seal) {
    const money = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—'
      : Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + '亿'
      : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(0) + '万' : Math.round(v) + '元';
    const sideRow = (k, v, cls) => '<div class="sm-side-row"><span>' + k + '</span><b class="' + (cls || '') + '">' + v + '</b></div>';
    const qcls2 = q.pct > 0 ? 'up' : q.pct < 0 ? 'down' : '';
    const num = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);
    const signPct = v => { const x = num(v); return x === null ? '—' : (x > 0 ? '+' : '') + N(x) + '%'; };
    const fmtVol = v => { const x = num(v); return x === null ? '—' : (x >= 10000 ? (x / 10000).toFixed(2) + '万手' : x.toFixed(0) + '手'); };
    const fmtAmt = v => { const x = num(v); return x === null ? '—' : (x >= 10000 ? (x / 10000).toFixed(2) + '亿' : x.toFixed(0) + '万'); };
    const devCls = v => { const x = num(v), base = num(q.prevClose); return (x !== null && base !== null && base > 0) ? (x > base ? 'up' : x < base ? 'down' : '') : ''; };
    const quoteRows = [
      ['现价', N(q.price), qcls2],
      ['涨跌', num(q.change) === null ? '—' : (num(q.change) > 0 ? '+' : '') + N(q.change), qcls2],
      ['涨幅', signPct(q.pct), qcls2],
      ['今开', N(q.open), devCls(q.open)],
      ['昨收', N(q.prevClose), ''],
      ['最高', N(q.high), devCls(q.high)],
      ['最低', N(q.low), devCls(q.low)],
      ['均价', N(q.avgPrice), ''],
      ['成交量', fmtVol(q.volume), ''],
      ['成交额', fmtAmt(q.amountWan), ''],
      ['换手', num(q.turnover) === null ? '—' : N(q.turnover) + '%', ''],
      ['量比', N(q.volRatio), ''],
      ['振幅', num(q.amplitude) === null ? '—' : N(q.amplitude) + '%', ''],
      ['涨停价', N(q.limitUp), 'up'],
      ['跌停价', N(q.limitDown), 'down']
    ].map(r => sideRow(r[0], r[1], r[2])).join('');
    const isDt = seal && seal.kind === 'dt';
    const isZb = seal && seal.kind === 'zb';
    const sealTitle = isDt ? '跌停封单' : isZb ? '炸板池封单快照' : '涨停封单';
    const sealHtml = seal
      ? '<div class="sm-side-seal' + (isDt ? ' is-down' : isZb ? ' is-broken' : '') + '">' +
          '<div class="sm-side-seal-h"><b>' + sealTitle + '</b>' +
          (isDt
            ? (Number(seal.downDays) > 1 ? '<span>连续跌停 ' + seal.downDays + ' 天</span>' : '<span>首日跌停</span>')
            : (Number(seal.boards) > 1 ? '<span>' + seal.boards + ' 连板</span>' : '')) + '</div>' +
          sideRow('封单额', money(seal.sealFund), 'seal-amt') +
          (Number.isFinite(seal.sealFundRatio) && seal.sealFundRatio !== null ? sideRow('占流通', N(seal.sealFundRatio) + '%', '') : '') +
          sideRow(isDt ? '首封跌停' : '首封时间', E(seal.firstSeal || '—'), '') +
          sideRow(isDt ? '撬板次数' : '炸板次数', (Number(seal.brokenCount) || 0) + ' 次', Number(seal.brokenCount) > 0 ? (isDt ? '' : 'down') : '') +
          '<div class="sm-side-seal-foot">' + E(String(seal.date || '')) + ' · ' + E(seal.source || '') + '</div>' +
        '</div>'
      : '<div class="sm-side-seal is-none"><div class="sm-side-seal-h"><b>涨停 / 跌停封单</b></div>' +
        '<div class="sm-side-seal-none">该股当日未进入涨停 / 炸板 / 跌停池，无封单快照</div></div>';
    return '<div class="sm-minute-side">' +
      '<div class="sm-side-quote"><div class="sm-side-h">分时快照 <span class="small muted">' + E(q.ticktime || '') + '</span></div>' + quoteRows + '</div>' +
      sealHtml + '</div>';
  }

  /** 五日分时图（参考东方财富「分时·五日」）：5 个交易日连续横轴，每天以各自昨收为基准算涨跌幅，段间不连线；红涨绿跌 + 成交量 */
  function smFiveDaySvg(multi, quote) {
    const days = (multi && multi.days) || [];
    const valid = days.filter(d => d.rows && d.rows.length >= 2);
    if (valid.length < 2) return '<div class="empty">五日分时数据不足（需 ≥2 个交易日），无法绘制</div>';
    const W = 1110, H = 520, L = 62, R = 68, PT = 22, PB = 388, VT = 406, VB = 498;
    const PW = W - L - R;
    const SESS = 240; // 每个交易日 240 分钟槽
    const toMin = t => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
      if (!m) return null;
      const v = (+m[1]) * 60 + (+m[2]);
      if (v >= 570 && v <= 690) return v - 570;            // 09:30–11:30
      if (v >= 780 && v <= 900) return 120 + (v - 780);     // 13:00–15:00
      if (v >= 905 && v <= 930) return 240;                 // 15:00 后收盘价（腾讯含 15:30）
      if (v > 555 && v < 570) return 0;                     // 9:25 竞价结果归入开盘
      return null;
    };
    // 每天归一化：价格→相对该日昨收的涨跌幅%，并把分钟映射到该天槽位
    const series = valid.map(d => {
      const first = d.rows[0].price;
      const base = Number(d.prevClose) > 0 ? Number(d.prevClose) : (Number(quote && quote.prevClose) > 0 ? Number(quote.prevClose) : first);
      const pts = d.rows.map((x, i) => ({
        i,
        min: toMin(x.time),
        pct: base > 0 ? (x.price - base) / base * 100 : 0,
        price: x.price,
        volume: Number(x.volume) || 0,
        amount: Number(x.amount) || 0
      })).filter(p => p.min !== null && p.min >= 0 && p.min <= SESS);
      return { date: d.date, base, approx: !(Number(d.prevClose) > 0), pts };
    }).filter(s => s.pts.length >= 2);
    if (series.length < 2) return '<div class="empty">五日分时数据不足（需 ≥2 个有效交易日），无法绘制</div>';
    const dayW = PW / series.length;
    const X = (di, min) => L + di * dayW + Math.max(0, Math.min(SESS, min)) / SESS * dayW;
    // 纵轴：以统一的涨跌幅%刻度对齐 5 天（东方财富口径），留白 12%
    let maxDev = 0.02;
    series.forEach(s => s.pts.forEach(p => { maxDev = Math.max(maxDev, Math.abs(p.pct)); }));
    const hi = maxDev * 1.12, lo = -hi;
    const Y = pct => PB - (pct - lo) / (hi - lo) * (PB - PT);
    const a = [];
    a.push('<svg viewBox="0 0 ' + W + ' ' + H + '" class="sm-chart-svg" preserveAspectRatio="xMidYMid meet">');
    a.push('<text x="' + L + '" y="14" font-size="10.5" fill="#8593a3">五日分时 · 纵轴为相对各日昨收的涨跌幅 · ' + E((multi && multi.source) || '腾讯证券') + '</text>');
    a.push('<circle cx="' + (W - R - 128) + '" cy="10.5" r="3" fill="var(--up)"/><text x="' + (W - R - 120) + '" y="14" font-size="10" fill="#8593a3">昨收上</text>');
    a.push('<circle cx="' + (W - R - 62) + '" cy="10.5" r="3" fill="var(--down)"/><text x="' + (W - R - 54) + '" y="14" font-size="10" fill="#8593a3">昨收下</text>');
    // 每天分隔竖线 + 日期标签
    series.forEach((s, k) => {
      if (k > 0) {
        const dx = L + k * dayW;
        a.push('<line x1="' + dx.toFixed(1) + '" y1="' + PT + '" x2="' + dx.toFixed(1) + '" y2="' + VB + '" stroke="#cbd5e1" stroke-dasharray="3 4"/>');
      }
      const lab = String(s.date).replace(/(\d{4})(\d{2})(\d{2})/, '$2-$3');
      a.push('<text x="' + (L + k * dayW + dayW / 2).toFixed(1) + '" y="' + (VB + 15) + '" font-size="10.5" fill="#6b7a8c" text-anchor="middle">' + E(lab) + '</text>');
    });
    // 横向网格 + 涨跌幅刻度
    for (let k = 0; k <= 4; k++) {
      const pct = lo + (hi - lo) * k / 4, y = Y(pct);
      const col = pct > 0.01 ? 'var(--up)' : pct < -0.01 ? 'var(--down)' : 'var(--ink2)';
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (W - R + 6) + '" y="' + (y + 4).toFixed(1) + '" font-size="11" fill="' + col + '">' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</text>');
    }
    // 昨收基准线
    a.push('<line x1="' + L + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(0).toFixed(1) + '" stroke="#8593a3" stroke-dasharray="4 4"/>');
    // 成交量柱（每天以当日最大量为基准，段间不混算）
    series.forEach((s, di) => {
      const maxV = Math.max(1, ...s.pts.map(p => p.volume));
      const step = dayW / SESS;
      const bw = Math.max(0.6, step * 0.62);
      s.pts.forEach(p => {
        const h = p.volume / maxV * (VB - VT);
        a.push('<rect x="' + (X(di, p.min) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (p.pct >= 0 ? 'var(--up)' : 'var(--down)') + '" opacity=".5"/>');
      });
    });
    // 价格线：每天独立分段（不跨日连线），昨收上方红/下方绿，穿越处插值
    series.forEach((s, di) => {
      const pts = s.pts;
      const segUp = [], segDown = [];
      const pt = (arr, x, y, move) => arr.push((move ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1));
      let side = pts[0].pct >= 0 ? 'up' : 'down';
      pt(side === 'up' ? segUp : segDown, X(di, pts[0].min), Y(pts[0].pct), true);
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1], p1 = pts[i];
        const x0 = X(di, p0.min), x1 = X(di, p1.min);
        const up0 = p0.pct >= 0, up1 = p1.pct >= 0;
        if (up0 === up1) {
          pt(side === 'up' ? segUp : segDown, x1, Y(p1.pct), false);
        } else {
          const cross = x0 + (x1 - x0) * ((0 - p0.pct) / (p1.pct - p0.pct));
          pt(side === 'up' ? segUp : segDown, cross, Y(0), false);
          side = up1 ? 'up' : 'down';
          pt(side === 'up' ? segUp : segDown, cross, Y(0), true);
          pt(side === 'up' ? segUp : segDown, x1, Y(p1.pct), false);
        }
      }
      if (segUp.length) a.push('<path d="' + segUp.join(' ') + '" fill="none" stroke="var(--up)" stroke-width="1.6" stroke-linejoin="round"/>');
      if (segDown.length) a.push('<path d="' + segDown.join(' ') + '" fill="none" stroke="var(--down)" stroke-width="1.6" stroke-linejoin="round"/>');
    });
    a.push('<text x="' + L + '" y="' + (VT - 6) + '" font-size="10.5" fill="#8593a3">成交量（手，各日独立刻度）</text>');
    a.push('</svg>');
    return a.join('');
  }

  /** 资金流柱状图：主力净流入（超大单+大单），红涨绿跌，与K线同一时间窗对齐 */
  function smFundSvg(fundRows, view, period) {
    const rows = fundRows || [];
    if (rows.length < 3) return '<div class="empty">资金流数据不足，无法绘制</div>';
    const W = 1110, H = 118, L = 62, R = 24, PT = 20, PB = 100;
    const PW = W - L - R;
    // 与K线共享可见窗口：资金日线通常比K线多，用日期对齐取最后 N 根
    const count = Math.max(10, Math.min(view && view.count ? view.count : 60, rows.length));
    const vis = rows.slice(-count);
    const n = vis.length, cw = PW / n, bw = Math.max(1.4, Math.min(16, cw * 0.6));
    const vals = vis.map(x => Number(x.main) || 0);
    const mx = Math.max(1, ...vals.map(Math.abs));
    const Y = v => (PT + PB) / 2 - v / mx * ((PB - PT) / 2);
    const a = ['<svg viewBox="0 0 ' + W + ' ' + H + '" class="sm-fund-svg" preserveAspectRatio="none">'];
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>');
    a.push('<line x1="' + L + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(0).toFixed(1) + '" stroke="#dbe3ec"/>');
    a.push('<text x="6" y="' + (Y(mx) + 4).toFixed(1) + '" font-size="10" fill="#8593a3">+' + (mx / 1e8).toFixed(2) + '亿</text>');
    a.push('<text x="6" y="' + (Y(-mx) + 4).toFixed(1) + '" font-size="10" fill="#8593a3">-' + (mx / 1e8).toFixed(2) + '亿</text>');
    a.push('<text x="' + L + '" y="12" font-size="10.5" fill="#6d4bd6">主力净流入（超大单+大单）· ' + E(period === 'week' ? '周' : '日') + '</text>');
    vis.forEach((x, i) => {
      const v = vals[i], y = Y(v), cx = L + cw * (i + 0.5);
      const color = v >= 0 ? '#d92b2b' : '#0f9960';
      a.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Math.min(y, Y(0)).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1, Math.abs(Y(0) - y)).toFixed(1) + '" fill="' + color + '" opacity=".82"><title>' +
        E(x.date) + ' 主力净额 ' + (v / 1e8).toFixed(2) + ' 亿 · 占比 ' + N(x.mainPct) + '% · 收盘 ' + N(x.close) + '</title></rect>');
    });
    a.push('</svg>');
    return a.join('');
  }

  function renderStockChart() {
    const j = S.chart.data; if (!j) return;
    const per = S.chart.period;
    if (per === 'minute') {
      const hist = !!S.chart.histDate;
      const md = hist ? (S.chart.histMinute || {}) : (j.minute || {});
      const rows = md.rows || [];
      const q = j.quote || {};
      [...document.querySelectorAll('.sm-tab')].forEach(b => b.classList.toggle('active', b.dataset.period === per));
      const trading = isTradingNow();
      $('smSource').textContent = (hist ? '历史分时 · ' : '分时 · ') + E(md.source || '来源不可用') + (md.date ? ' · 交易日 ' + E(String(md.date)) : '') +
        (hist ? ' · ' + E(md.intervalLabel || '分钟线') + ' · 可回溯约1个月' : ' · 数据拉取 ' + E(String(md.asOf || '').slice(11, 19)) + (trading ? ' · 每 12 秒自动刷新' : ' · 已收盘（静态）'));
      const seal = hist ? null : (j.seal || null);
      const fn = hist ? {} : ((j.fund && j.fund.now) || {});
      const money = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—'
        : Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + '亿'
        : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(0) + '万' : Math.round(v) + '元';
      const histBar = hist
        ? '<div class="sm-seal-now is-hist">正在查看 <b>' + E(String(md.date || S.chart.histDate)) + '</b> 历史分时 · 封单 / 当日资金快照为实时数据，不适用历史日，已隐藏 · ' +
          '<button type="button" class="sm-back-today" id="smBackToday">返回当日分时</button></div>'
        : '';
      const fundBar = !hist && Number.isFinite(fn.main) && fn.main !== null
        ? '<div class="sm-fund-now">当日资金：<span class="' + (fn.main >= 0 ? 'up' : 'down') + '">主力净额 ' +
          money(fn.main) + (Number.isFinite(fn.mainPct) && fn.mainPct !== null ? '（' + N(fn.mainPct) + '%）' : '') +
          '</span><span class="small muted">（超大单 ' + money(fn.huge) + ' / 大单 ' + money(fn.big) +
          '）· ' + E(fn.source || '') + '</span></div>'
        : '';
      // 右侧信息栏（参考东方财富分时图）：现价快照 + 涨停/炸板封单详情，均为真实接口数据
      const sidePanel = hist ? '' : smQuoteSealSide(q, seal);
      const chartHtml = md.rows && md.rows.length
        // 历史模式传空 quote：不画"竞价开盘"虚线、不用今日昨收当历史日基准（改用该日首分钟价为基准）
        ? '<div class="sm-minute-chart">' + smMinuteSvg(rows, hist ? {} : q, md.date, seal) + '</div>'
        : '<div class="empty">' + E(md.reason || '分时数据暂不可用') + '</div>';
      $('smBody').innerHTML = histBar + fundBar + (sidePanel
        ? '<div class="sm-minute-layout">' + chartHtml + sidePanel + '</div>'
        : chartHtml);
      if (hist) {
        const iv = E(md.intervalLabel || '分钟线');
        const srcName = E(md.source || '公开行情接口');
        const avail = (md.available || []);
        const availTip = avail.length
          ? '当前可回溯 <b>' + avail.length + ' 个交易日</b>（' + E(String(avail[0]).replace(/(\d{4})(\d{2})(\d{2})/, '$2-$3')) + ' ~ ' + E(String(avail[avail.length - 1]).replace(/(\d{4})(\d{2})(\d{2})/, '$2-$3')) + '）。'
          : '';
        $('smFoot').innerHTML = '<div class="note-box"><b>历史分时口径：</b>数据来自<b>' + srcName + '</b>，精度 <b>' + iv + '</b>。' +
          '最近 5 个交易日为腾讯 1 分钟线；更早日期回退东方财富 5 分钟线（约 1 个月），' + availTip + '更早数据公开接口无法取得，系统不伪造。' +
          '展示的是 <b>' + E(String(md.date || S.chart.histDate)) + '</b> 当日完整分时走势；均价线＝累计成交额 ÷ 累计成交量。' +
          '<br><b>不适用历史日的数据：</b>封单快照与当日资金均为实时接口数据，无法回溯到该日，已隐藏；历史模式下不画竞价虚线、改用该日首分钟价为基准。' +
          '<br>' + (md.granularity === 5 ? '5 分钟线每根为该 5 分钟收盘价与区间成交量，走势与 1 分钟一致，但不及后者细腻。' : '分钟级数据，不是逐笔成交，不构成投资建议。') + '</div>';
      } else {
        $('smFoot').innerHTML = '<div class="note-box">分时数据来自腾讯证券公开接口（每分钟价格 / 成交量 / 成交额）；均价线＝累计成交额 ÷ 累计成交量，与行情软件口径一致。' +
          '<br><b>封单：</b>' + (seal ? '东方财富' + (seal.kind === 'dt' ? '跌停' : seal.kind === 'zb' ? '炸板' : '涨停') + '池 ' + E(String(seal.date || '')) + ' 快照（封单额 / 占流通市值 / ' + (seal.kind === 'dt' ? '首封跌停 / 撬板次数 / 连续跌停天数' : '首封 / 炸板次数') + '），随分时同步刷新；是池内快照，不是逐笔或分钟连续封单曲线。' : '该股当日未进入涨停 / 炸板 / 跌停池，故无封单快照。') +
          '<br><b>当日资金：</b>' + E(fn.caliber || '主力净额=超大单+大单（东方财富口径）') + '，与下方日K资金柱同口径。' +
          (trading
            ? '<b>当前为交易时段，每 12 秒自动重拉分时</b>；盘后自动停止。'
            : '<b>当前为非交易时段，展示最近一个交易日的完整分时，不再变动</b>；开盘后自动恢复刷新。') +
          '<br><b>关于集合竞价：</b>腾讯分时接口从 09:30 开始返回分钟数据，<b>不含 9:15–9:25 的竞价过程</b>（竞价没有连续分钟成交）。' +
          '图中的紫色虚线是 9:25 竞价成交价（即开盘价' + (q.open > 0 ? ' ' + N(q.open) : '，当前快照未取得') + '），' +
          '竞价涨跌幅 ' + (q.open > 0 && q.prevClose > 0 ? (q.open > q.prevClose ? '+' : '') + N((q.open - q.prevClose) / q.prevClose * 100) + '%' : '—') +
          '；竞价期间的委托撤单过程不展示。' +
          '<br><b>看图口径：</b>价格线以昨收价（灰色虚线）为界，<b style="color:var(--up)">水上红色</b>、<b style="color:var(--down)">水下绿色</b>；横轴为固定交易时段，盘中曲线只画到当前时刻、右侧留白。' +
          '<b>DDX / DDZ 为第三方专有算法指标，公开接口无法取得真实序列，此处用真实的特大单/大单资金快照替代，非东财终端真值</b>；DDX首红精选模块另按公开公式给出可回测的近似值并已明确标注。' +
          '<b>分钟级数据，不是逐笔成交，不构成投资建议。</b></div>';
      }
      const bt = $('smBackToday');
      if (bt) bt.onclick = () => { S.chart.histDate = null; S.chart.histMinute = null; syncMinuteTimer(); renderStockChart(); };
      syncMinuteTimer();
      return;
    }
    if (per === 'multiDay') {
      stopMinuteTimer();
      S.chart.histDate = null;
      const md = j.multiDay || {};
      const q = j.quote || {};
      const seal = j.seal || null;
      const days = md.days || [];
      const approxCnt = days.filter(d => !(Number(d.prevClose) > 0)).length;
      [...document.querySelectorAll('.sm-tab')].forEach(b => b.classList.toggle('active', b.dataset.period === per));
      $('smSource').textContent = '五日分时 · ' + E(md.source || '来源不可用') + (days.length ? ' · ' + days.length + ' 个交易日（' + E(String(days[0].date).replace(/(\d{4})(\d{2})(\d{2})/, '$2-$3')) + ' ~ ' + E(String(days[days.length - 1].date).replace(/(\d{4})(\d{2})(\d{2})/, '$2-$3')) + '）' : '');
      const sidePanel = smQuoteSealSide(q, seal);
      const chartHtml = days.length >= 2
        ? '<div class="sm-minute-chart">' + smFiveDaySvg(md, q) + '</div>'
        : '<div class="empty">' + E(md.reason || '五日分时数据暂不可用') + '</div>';
      $('smBody').innerHTML = '<div class="sm-minute-layout">' + chartHtml + sidePanel + '</div>';
      $('smFoot').innerHTML = '<div class="note-box"><b>五日分时口径：</b>连续展示最近 <b>' + days.length + '</b> 个交易日的 1 分钟分时（腾讯证券），' +
        '每天以<b>各自昨收</b>（取日K前一交易日收盘）为基准换算涨跌幅，故横轴 5 天纵向可比、段间不连线；红色为昨收之上、绿色为昨收之下，成交量按各日独立刻度。' +
        (approxCnt ? '<b class="warn">' + approxCnt + ' 天昨收取日K失败，已用当日首分钟价兜底</b>，该日涨跌幅基准可能有偏差。' : '') +
        '<br><b>右侧快照 / 封单：</b>现价与封单为<b>最新交易日</b>的实时数据，不适用于历史各日；五日图仅用于对比多日日内形态，不构成投资建议。</div>';
      return;
    }
    const series = j[per] || {};
    const chip = (j.chip || {})[per] || null;
    // 顶部快照
    const q = j.quote || {};
    const pc = q.pct;
    const qcls = pc > 0 ? 'up' : pc < 0 ? 'down' : '';
    $('smQuote').innerHTML =
      '<span class="sm-price ' + qcls + '">' + N(q.price) + '</span>' +
      '<span class="sm-pct ' + qcls + '">' + (pc === null || pc === undefined ? '—' : (pc > 0 ? '+' : '') + N(pc) + '%') + '</span>' +
      (q.floatCap ? '<span class="sm-meta">流通 ' + E(CAP(q.floatCap)) + '</span>' : '') +
      (q.turnover !== null && q.turnover !== undefined ? '<span class="sm-meta">换手 ' + N(q.turnover, 1) + '%</span>' : '');
    // tab 高亮
    [...document.querySelectorAll('.sm-tab')].forEach(b => b.classList.toggle('active', b.dataset.period === per));
    const adj = series.adjusted === false ? '不复权' : (series.adjusted ? '前复权' : '');
    $('smSource').textContent = (per === 'day' ? '日K' : '周K') + ' · ' + E(series.source || '来源不可用') + (adj ? ' · ' + adj : '') + (series.asOf ? ' · 截至 ' + E(String(series.asOf).slice(0, 10)) : '');
    // 主体：左K线 + 右筹码峰（共享同一价格Y轴，水平网格线对齐）
    const bars = series.rows || [];
    if (!S.chart.view || S.chart.view.total !== bars.length) {
      const def = Math.min(60, bars.length);
      S.chart.view = { total: bars.length, start: Math.max(0, bars.length - def), count: def };
    }
    // 深链 ?zoom=20&day=20261110：指定缩放根数并锁定到某一天
    if (S.chart._initZoom) {
      const z = Math.min(S.chart._initZoom, bars.length);
      S.chart.view.count = z;
      S.chart.view.start = Math.max(0, Math.min(S.chart.view.start, bars.length - z));
      S.chart._initZoom = 0;
    }
    if (S.chart._initLock) {
      const d = S.chart._initLock;
      const idx = bars.findIndex(b => String(b.date).replace(/\D/g, '') === d);
      if (idx >= 0) {
        S.chart.lockIdx = idx;
        if (idx < S.chart.view.start || idx >= S.chart.view.start + S.chart.view.count)
          S.chart.view.start = Math.max(0, Math.min(idx - Math.floor(S.chart.view.count / 2), bars.length - S.chart.view.count));
      }
      S.chart._initLock = null;
    }
    const range = smSharedRange(bars, chip, S.chart.view);
    S.chart.range = range;
    const ksvg = smKlineSvg(bars, per, range, S.chart.view);
    const csvg = chip ? smChipSvg(chip, range) : '<div class="empty">筹码峰数据不足</div>';
    $('smBody').innerHTML =
      '<div class="sm-hd-layout">' +
        '<div class="sm-chart-block sm-kline-block"><div class="sm-block-head"><h4>' + (per === 'day' ? '日K' : '周K') + '线图（蜡烛 + 成交量 + 均线）</h4>' +
        '<div class="sm-k-tools">' +
          '<button type="button" data-kact="out" title="缩小（显示更多K线）">−</button>' +
          '<button type="button" data-kact="in" title="放大（显示更少K线）">＋</button>' +
          '<button type="button" data-kact="left" title="向前平移">◀</button>' +
          '<button type="button" data-kact="right" title="向后平移">▶</button>' +
          '<button type="button" data-kact="reset" title="重置视图">重置</button>' +
          '<button type="button" data-kact="colors" class="sm-color-btn' + (S.klPanelOpen ? ' active' : '') + '" title="自定义涨跌停/炸板配色">🎨 配色</button>' +
          '<span class="sm-view-info" id="smViewInfo"></span>' +
        '</div></div>' +
        (S.klPanelOpen ? smColorPanelHtml() : '') +
        '<div class="sm-svg-wrap" id="smSvgWrap">' + ksvg +
          '<div class="sm-hover-panel" id="smHoverPanel" style="display:none"></div>' +
        '</div>' +
        (j.fund && j.fund[per] && j.fund[per].rows && j.fund[per].rows.length
          ? '<div class="sm-fund-block"><div class="sm-block-head"><h4>主力资金流向</h4>' +
            '<span class="small muted">' + E(j.fund.source || j.fund[per].source || '东方财富资金流') + ' · 红=净流入 / 绿=净流出</span></div>' +
            smFundSvg(j.fund[per].rows, S.chart.view, per) + '</div>'
          : '') +
        '<div class="sm-k-hint">滚轮缩放 · 按住拖动平移 · 移动鼠标看某日数据 · 单击锁定 / 双击重置</div></div>' +
        '<div class="sm-chart-block sm-chip-block"><div class="sm-block-head"><h4>筹码峰分布</h4>' +
        '<span class="small muted">模型估算 · 与左图价格轴对齐</span></div>' +
        '<div class="sm-chip-body">' + csvg + (chip ? '<div class="sm-chip-stats">' + smChipStatsHtml(chip) + '</div>' : '') + '</div></div>' +
      '</div>';
    smUpdateViewInfo();
    // 底部方法论与免责
    const m = j.method || {};
    $('smFoot').innerHTML =
      '<div class="note-box">' + E(m.day || '') + ' ' + E(m.week || '') + ' ' + E(m.chip || '') +
      '<br><b>资金流：</b>' + E((j.fund && j.fund.note) || '主力净流入=超大单+大单净额（东方财富口径）。') + '</div>' +
      '<div class="small muted" style="margin-top:6px">' + E((j.meta || {}).disclaimer || '') + '</div>';
    if (chip) bindChipHover();
    if (bars.length >= 6) bindKlineInteractions();
    // 配色面板：取色器即时改色、恢复默认、收起
    const cp = $('smColorPanel');
    if (cp) {
      cp.querySelectorAll('[data-klcolor]').forEach(inp => {
        inp.addEventListener('input', e => {
          S.klColors[e.target.dataset.klcolor] = e.target.value;
          klSaveColors();
          smRedrawKline(); // 只重绘K线SVG，面板与状态保持不变
        });
      });
      const rst = $('smClrReset');
      if (rst) rst.onclick = () => {
        S.klColors = Object.assign({}, KL_COLOR_DEFAULT);
        klSaveColors();
        renderStockChart();
      };
      const cls = cp.querySelector('.sm-clr-close');
      if (cls) cls.onclick = () => { S.klPanelOpen = false; renderStockChart(); };
    }
    // 恢复深链/重绘后的锁定态十字光标与数据面板
    if (S.chart.lockIdx !== null && S.chart.geom) {
      const g = S.chart.geom, jj = S.chart.lockIdx - g.start;
      if (jj >= 0 && jj < g.n) smShowCross(jj, null, null, null, true);
      else S.chart.lockIdx = null;
    }
  }

  /* K线与筹码峰共享的价格范围：基于「可见区间」自适应，避免放大后K线被全量高价压扁。
     传入 view 时只取可见窗口的高低点；无 view 时用全量。两图共用同一结果，保证水平对齐。 */
  function smSharedRange(bars, chip, view) {
    let src = bars || [];
    if (view && src.length) {
      const start = Math.max(0, Math.min(view.start, src.length - 1));
      const count = Math.max(6, Math.min(view.count, src.length - start));
      src = src.slice(start, Math.min(src.length, start + count));
    }
    let lo = [], hi = [];
    if (src.length) { lo = src.map(b => b.low); hi = src.map(b => b.high); }
    // 无K线数据时才回退到筹码全量范围
    if (!lo.length && chip) {
      if (chip.range) { lo.push(chip.range[0]); hi.push(chip.range[1]); }
      if (chip.bins && chip.bins.length) { lo.push(...chip.bins.map(b => b.price)); hi.push(...chip.bins.map(b => b.price)); }
      if (chip.price !== null && chip.price !== undefined) { lo.push(chip.price); hi.push(chip.price); }
    }
    if (!lo.length) return { min: 0, max: 1 };
    let minP = Math.min(...lo), maxP = Math.max(...hi);
    const pad = (maxP - minP) * 0.06 || maxP * 0.02;
    return { min: minP - pad, max: maxP + pad };
  }

  /* 零依赖 SVG K线：蜡烛 + 成交量 + MA5/10/20 + 十字光标提示（title） */
  function smKlineSvg(bars, per, range, view) {
    if (!bars || bars.length < 6) return '<div class="empty">该周期K线数据不足（需 ≥6 根），无法绘制</div>';
    const W = 1110, H = 520, L = 62, R = 24;
    const PT = 24, PB = 430, VT = 448, VB = 500, DY = 516;
    const PW = W - L - R;
    const minP = range.min, maxP = range.max;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    const total = bars.length;
    const vv = view || { start: 0, count: total };
    const start = Math.max(0, Math.min(vv.start, total - 1));
    const count = Math.max(6, Math.min(vv.count, total - start));
    const end = Math.min(total, start + count);
    const vis = bars.slice(start, end);
    const n = vis.length;
    const cw = PW / n, bw = Math.max(1.6, Math.min(22, cw * 0.62));
    const CX = j => L + cw * (j + 0.5);
    const maxV = Math.max(1, ...vis.map(b => b.volume || 0));
    // 暴露几何信息供交互（缩放/平移/十字光标）做坐标换算
    S.chart.geom = { W, H, L, PT, PB, VT, VB, PW, cw, bw, n, start, count, total, minP, maxP };
    const a = [];
    a.push('<svg class="sm-kline" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + (per === 'day' ? '日' : '周') + 'K线图">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    const KC = S.klColors;
    const kindLabel = { limitUp: '涨停', limitDown: '跌停', broken: '炸板' };
    const kindShown = { limitUp: 0, limitDown: 0, broken: 0 };
    vis.forEach((b, j) => {
      const gi = start + j, cx = CX(j);
      const kind = per === 'day' ? klBarKind(bars, gi, S.chart.code, S.chart.name) : null;
      if (kind) kindShown[kind]++;
      const col = kind ? KC[kind] : (b.close >= b.open ? KC.up : KC.down);
      const yo = Y(b.open), yc = Y(b.close), yh = Y(b.high), yl = Y(b.low);
      const tip = E(b.date) + (kind ? ' 【' + kindLabel[kind] + '】' : '') + ' 开 ' + N(b.open) + ' 高 ' + N(b.high) + ' 低 ' + N(b.low) + ' 收 ' + N(b.close) + ' 量 ' + AMT(b.volume);
      a.push('<g><title>' + tip + '</title>');
      a.push('<line x1="' + cx.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yl.toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>');
      a.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Math.min(yo, yc).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.4, Math.abs(yo - yc)).toFixed(1) + '" fill="' + col + '"/>');
      // 涨停/跌停/炸板小圆点标记（收盘端），仅 K线足够宽时绘制避免糊成一团
      if (kind && bw >= 4) {
        const my = kind === 'limitDown' ? yc + 7 : yc - 7;
        a.push('<circle cx="' + cx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="2.4" fill="' + col + '" stroke="#fff" stroke-width="0.8"/>');
      }
      a.push('</g>');
    });
    [['ma5', 5, '#e8912a'], ['ma10', 10, '#2f6fd0'], ['ma20', 20, '#6d4bd6']].forEach(pair => {
      const pts = [];
      for (let j = 0; j < n; j++) {
        const gi = start + j;
        if (gi >= pair[1] - 1) {
          let s = 0; for (let k = 0; k < pair[1]; k++) s += bars[gi - k].close;
          pts.push(CX(j).toFixed(1) + ',' + Y(s / pair[1]).toFixed(1));
        }
      }
      if (pts.length > 1) a.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + pair[2] + '" stroke-width="1.3" opacity="0.85"/>');
    });
    // 成交量
    a.push('<line x1="' + L + '" y1="' + VT + '" x2="' + (L + PW) + '" y2="' + VT + '" stroke="#eef2f7"/>');
    a.push('<text x="' + (L - 8) + '" y="' + (VT + 12) + '" text-anchor="end" font-size="10" fill="#8593a3">量</text>');
    vis.forEach((b, j) => {
      const gi = start + j;
      const kind = per === 'day' ? klBarKind(bars, gi, S.chart.code, S.chart.name) : null;
      const h = (b.volume || 0) / maxV * (VB - VT - 4);
      const col = kind ? KC[kind] : (b.close >= b.open ? KC.up : KC.down);
      a.push('<rect x="' + (CX(j) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1, h).toFixed(1) + '" fill="' + col + '" opacity="0.5"><title>' + E(b.date) + ' 成交量 ' + AMT(b.volume) + '</title></rect>');
    });
    const step = Math.max(1, Math.ceil(n / 7));
    vis.forEach((b, j) => {
      if (j % step === 0 || j === n - 1)
        a.push('<text x="' + CX(j).toFixed(1) + '" y="' + DY + '" text-anchor="middle" font-size="10.5" fill="#8593a3">' + E(String(b.date).slice(5)) + '</text>');
    });
    const legend = [[KC.up, '阳线'], [KC.down, '阴线']];
    if (per === 'day') {
      if (kindShown.limitUp) legend.push([KC.limitUp, '涨停 ' + kindShown.limitUp]);
      if (kindShown.limitDown) legend.push([KC.limitDown, '跌停 ' + kindShown.limitDown]);
      if (kindShown.broken) legend.push([KC.broken, '炸板 ' + kindShown.broken]);
    }
    legend.push(['#e8912a', 'MA5'], ['#2f6fd0', 'MA10'], ['#6d4bd6', 'MA20']);
    let lx = L;
    legend.forEach(pair => {
      a.push('<rect x="' + lx + '" y="10" width="10" height="10" rx="2" fill="' + pair[0] + '"/>');
      a.push('<text x="' + (lx + 14) + '" y="20" font-size="11" fill="#6b7a8c">' + E(pair[1]) + '</text>');
      lx += 92;
    });
    // 十字光标（交互时由 JS 显示/定位），置于最上层
    a.push('<g id="smCross" style="display:none">');
    a.push('<line id="smCrossV" x1="0" y1="' + PT + '" x2="0" y2="' + VB + '" stroke="#7c8a9a" stroke-width="1" stroke-dasharray="4 3"/>');
    a.push('<line id="smCrossH" x1="' + L + '" y1="0" x2="' + (L + PW) + '" y2="0" stroke="#7c8a9a" stroke-width="1" stroke-dasharray="4 3"/>');
    a.push('<circle id="smCrossDot" r="4" fill="#fff" stroke="#1c2733" stroke-width="1.5"/>');
    a.push('</g>');
    a.push('</svg>');
    return a.join('');
  }

  /* 筹码峰：横向柱状，纵轴价格与K线对齐；获利(现价下方)红、套牢绿 */
  function smChipSvg(chip, range) {
    const bins = chip.bins || [];
    if (!bins.length) return '<div class="empty">无筹码分布数据</div>';
    // 与K线同Y轴：PT=24 PB=430，价格标签放右侧，筹码条自右向左延伸
    const W = 300, H = 520, L = 10, R = 54;
    const PT = 24, PB = 430;
    const PW = W - L - R;
    const minP = range.min, maxP = range.max;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    // 只显示落在可见价格区间的筹码；放大后按可见 bins 重新归一化，保持筹码峰饱满
    const visBins = bins.filter(b => b.price >= minP && b.price <= maxP);
    const maxPct = Math.max(1, ...(visBins.length ? visBins : bins).map(b => b.pct));
    // 每个 bin 的像素高度由价格跨度决定（与K线价格轴同步缩放）
    const step = bins.length > 1 ? Math.abs(bins[1].price - bins[0].price) : (maxP - minP) / bins.length;
    const bh = Math.max(1, (PB - PT) * step / (maxP - minP));
    const price = chip.price;
    const a = [];
    a.push('<svg class="sm-chip" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="筹码峰分布">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (L + PW + 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="start" font-size="10.5" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    visBins.forEach((b, i) => {
      const y = Y(b.price) - bh / 2;
      if (y + bh < PT || y > PB) return; // 超出绘图区不画
      const w = b.pct / maxPct * PW;
      const col = (price !== null && b.price <= price) ? '#d92b2b' : '#0f9960';
      a.push('<rect class="sm-chip-bin" x="' + (L + PW - w).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(0.5, w).toFixed(1) + '" height="' + Math.max(1, bh - 0.4).toFixed(1) +
        '" fill="' + col + '" opacity="0.76"><title>' + N(b.price) + ' 元 · 筹码 ' + N(b.pct, 2) + '%</title></rect>');
    });
    // 获利/套牢分界：轻量红色虚线 + 右侧紧凑圆角价格胶囊（不贯穿全宽）
    if (price !== null && price >= minP && price <= maxP) {
      const yp = Y(price);
      a.push('<line x1="' + L + '" y1="' + yp.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + yp.toFixed(1) +
        '" stroke="#d92b2b" stroke-width="1.1" stroke-dasharray="5 4" opacity="0.72"/>');
      const capW = 64, capH = 18, capX = L + PW - capW, capY = yp - capH / 2;
      // 白色描边作分隔，避免胶囊与筹码条颜色粘连
      a.push('<rect x="' + capX.toFixed(1) + '" y="' + capY.toFixed(1) + '" width="' + capW + '" height="' + capH +
        '" rx="9" fill="#d92b2b" stroke="#fff" stroke-width="1.2"/>');
      a.push('<text x="' + (capX + capW / 2).toFixed(1) + '" y="' + (yp + 3.8).toFixed(1) +
        '" text-anchor="middle" font-size="10.5" fill="#fff" font-weight="700">现价 ' + N(price) + '</text>');
    }
    // 峰值标注（只标落在可见价格区间的峰）
    (chip.peaks || []).forEach((p, idx) => {
      if (p.price < minP || p.price > maxP) return;
      const y = Y(p.price);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#e8912a" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>');
      if (idx < 2) a.push('<text x="' + (L + 2) + '" y="' + (y - 4).toFixed(1) + '" font-size="10" fill="#e8912a" font-weight="700">峰' + N(p.price) + '</text>');
    });
    a.push('<text x="' + L + '" y="478" font-size="11" fill="#d92b2b" font-weight="600">■ 获利盘 ' + N(chip.profitRatio, 1) + '%</text>');
    a.push('<text x="' + (L + 150) + '" y="478" font-size="11" fill="#0f9960" font-weight="600">■ 套牢 ' + N(chip.trappedRatio, 1) + '%</text>');
    a.push('</svg>');
    return a.join('');
  }

  function smChipStatsHtml(chip) {
    const c = chip.concentration || {};
    const dev = chip.costDeviation;
    const items = [
      ['获利比例', '<span class="up">' + N(chip.profitRatio, 1) + '%</span>'],
      ['套牢比例', '<span class="down">' + N(chip.trappedRatio, 1) + '%</span>'],
      ['90%集中度', N(c.c90) + '<small class="muted"> ' + E(c.label90 || '') + '</small>'],
      ['70%集中度', N(c.c70) + '<small class="muted"> ' + E(c.label70 || '') + '</small>'],
      ['平均成本', N(chip.costAvg) + ' 元'],
      ['成本偏离', (dev === null || dev === undefined ? '—' : (dev > 0 ? '+' : '') + N(dev, 1) + '%')],
      ['70%成本区', N(chip.cost70[0]) + '–' + N(chip.cost70[1])],
      ['90%成本区', N(chip.cost90[0]) + '–' + N(chip.cost90[1])],
      ['筹码峰', (chip.peaks || []).slice(0, 2).map(p => N(p.price)).join('/') || '—']
    ];
    return items.map(x => '<div class="sm-stat"><span class="k">' + x[0] + '</span><span class="v">' + x[1] + '</span></div>').join('');
  }

  function bindChipHover() {
    // title 原生提示已够用，这里预留：点击筹码区间不做跳转，避免误触
  }

  /* ─────────── K线交互：缩放 / 平移 / 十字光标 / 单日数据 ─────────── */
  const smClamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function smUpdateViewInfo() {
    const el = $('smViewInfo'), v = S.chart.view;
    if (!el || !v) return;
    el.textContent = '显示 ' + (v.start + 1) + '–' + Math.min(v.total, v.start + v.count) + ' / ' + v.total + ' 根';
  }

  function smViewReset() {
    const total = S.chart.geom ? S.chart.geom.total : 0;
    const def = Math.min(60, total || 60);
    S.chart.view = { total: total, start: Math.max(0, total - def), count: def };
    S.chart.lockIdx = null;
    smRedrawKline();
  }

  /* 重绘 K线 + 筹码峰：价格轴随可见区间自适应，两图共享同一 range 保持对齐 */
  function smRedrawKline() {
    const j = S.chart.data; if (!j) return;
    const per = S.chart.period, bars = j[per].rows || [];
    const chip = (j.chip || {})[per] || null;
    const range = smSharedRange(bars, chip, S.chart.view);
    S.chart.range = range;
    const svgHtml = smKlineSvg(bars, per, range, S.chart.view);
    const wrap = $('smSvgWrap'); if (!wrap) return;
    const old = wrap.querySelector('svg.sm-kline');
    if (old) old.outerHTML = svgHtml;
    else wrap.insertAdjacentHTML('afterbegin', svgHtml);
    // 筹码峰同步重绘（价格轴已随可见区间变化）
    if (chip) {
      const cbody = document.querySelector('.sm-chip-body');
      const oldChip = cbody && cbody.querySelector('svg.sm-chip');
      if (oldChip) oldChip.outerHTML = smChipSvg(chip, range);
    }
    smUpdateViewInfo();
    // 恢复锁定态
    const g = S.chart.geom;
    if (S.chart.lockIdx !== null && g) {
      const jj = S.chart.lockIdx - g.start;
      if (jj >= 0 && jj < g.n) smShowCross(jj, null, null, null, true);
      else { S.chart.lockIdx = null; smHideCross(); }
    } else smHideCross();
  }

  /* 缩放：factor<1 放大（更少K线），>1 缩小；anchorFrac 为鼠标在绘图区的横向比例 */
  function smZoom(factor, anchorFrac) {
    const v = S.chart.view, total = v.total;
    const aF = smClamp(anchorFrac === undefined ? 1 : anchorFrac, 0, 1);
    const newCount = Math.round(smClamp(v.count * factor, 6, total));
    if (newCount === v.count) return;
    const anchorGi = v.start + aF * v.count;
    v.start = Math.round(smClamp(anchorGi - aF * newCount, 0, total - newCount));
    v.count = newCount;
    smRedrawKline();
  }

  function smPan(delta) {
    const v = S.chart.view;
    const ns = Math.round(smClamp(v.start + delta, 0, v.total - v.count));
    if (ns === v.start) return;
    v.start = ns;
    smRedrawKline();
  }

  /* 鼠标/屏幕坐标 → SVG viewBox 坐标 + 相对 wrap 的像素坐标 */
  function smEvtPos(e) {
    const svg = document.querySelector('#smSvgWrap svg.sm-kline'), wrap = $('smSvgWrap');
    if (!svg || !wrap || !S.chart.geom) return null;
    const r = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), g = S.chart.geom;
    if (!r.width || !r.height) return null;
    return {
      vx: (e.clientX - r.left) / r.width * g.W,
      vy: (e.clientY - r.top) / r.height * g.H,
      rx: e.clientX - wr.left, ry: e.clientY - wr.top,
      svgRect: r, wrapRect: wr
    };
  }

  /* 十字光标 + 单日数据面板。vy 为空时用该日收盘价定位水平线 */
  function smShowCross(j, vy, rx, ry, locked) {
    const g = S.chart.geom, wrap = $('smSvgWrap'), panel = $('smHoverPanel');
    if (!g || !wrap) return;
    const rows = (S.chart.data[S.chart.period] || {}).rows || [];
    const gi = g.start + j, bar = rows[gi];
    if (!bar) return;
    const cx = g.L + g.cw * (j + 0.5);
    const yy = vy === null || vy === undefined ? g.PB - (bar.close - g.minP) / (g.maxP - g.minP) * (g.PB - g.PT) : vy;
    const cross = document.getElementById('smCross');
    if (cross) {
      cross.style.display = 'inline';
      const vline = document.getElementById('smCrossV'), hline = document.getElementById('smCrossH'), dot = document.getElementById('smCrossDot');
      if (vline) { vline.setAttribute('x1', cx.toFixed(1)); vline.setAttribute('x2', cx.toFixed(1)); }
      if (hline) { hline.setAttribute('y1', smClamp(yy, g.PT, g.PB).toFixed(1)); hline.setAttribute('y2', smClamp(yy, g.PT, g.PB).toFixed(1)); }
      if (dot) { dot.setAttribute('cx', cx.toFixed(1)); dot.setAttribute('cy', smClamp(yy, g.PT, g.PB).toFixed(1)); }
    }
    if (!panel) return;
    // 面板内容只在数据变化时重建：鼠标微动导致 DOM 反复重建会让按钮的 click 丢失
    const key = S.chart.period + '|' + gi + '|' + (locked ? 1 : 0);
    if (S.chart._hoverKey !== key) {
      panel.innerHTML = smHoverDataHtml(bar, gi, !!locked);
      S.chart._hoverKey = key;
    }
    panel.style.display = 'block';
    // 位置锚定该 K 线蜡烛（中心 x + 收盘价 y），不随鼠标实时跳动，按钮才点得到
    const cyBar = g.PB - (bar.close - g.minP) / (g.maxP - g.minP) * (g.PB - g.PT);
    let ax = 20, ay = 20;
    const svgEl = wrap.querySelector('svg.sm-kline');
    if (svgEl) {
      const sr = svgEl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      ax = (sr.left - wr.left) + cx / g.W * sr.width;
      ay = (sr.top - wr.top) + smClamp(cyBar, g.PT, g.PB) / g.H * sr.height;
    }
    const pw = panel.offsetWidth || 210, ph = panel.offsetHeight || 120;
    let left = ax + 16; if (left + pw > wrap.clientWidth - 4) left = ax - pw - 16;
    if (left < 2) left = 2;
    let top = ay - ph / 2; if (top + ph > wrap.clientHeight - 4) top = wrap.clientHeight - ph - 4;
    if (top < 2) top = 2;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function smHideCross() {
    const cross = document.getElementById('smCross'), panel = $('smHoverPanel');
    if (cross) cross.style.display = 'none';
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    S.chart._hoverKey = null;
  }

  function smHoverDataHtml(bar, gi, locked) {
    const rows = (S.chart.data[S.chart.period] || {}).rows || [];
    const prev = gi > 0 ? rows[gi - 1] : null;
    const pct = prev && prev.close ? (bar.close / prev.close - 1) * 100 : null;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    const ma = n => { if (gi < n - 1) return '—'; let s = 0; for (let k = 0; k < n; k++) s += rows[gi - k].close; return N(s / n); };
    const row = (k, v, c) => '<div class="sm-hover-row"><span>' + k + '</span><b class="' + (c || '') + '">' + v + '</b></div>';
    const kind = S.chart.period === 'day' ? klBarKind(rows, gi, S.chart.code, S.chart.name) : null;
    const kindChip = kind ? '<span class="sm-hover-kind kind-' + kind + '">' + { limitUp: '涨停', limitDown: '跌停', broken: '炸板' }[kind] + '</span>' : '';
    const dnum = String(bar.date || '').replace(/\D/g, '');
    const minuteBtn = S.chart.period === 'day' && /^\d{8}$/.test(dnum)
      ? '<button type="button" class="sm-hover-minBtn" data-md="' + E(dnum) + '" title="查看该交易日分时（可回溯约1个月：最近5日1分钟线，更早5分钟线）">📈 看 ' + E(String(bar.date).slice(5)) + ' 分时</button>' : '';
    return '<div class="sm-hover-head"><b>' + E(bar.date) + '</b>' + kindChip + (locked ? '<span class="sm-lock-flag">已锁定 · 再点取消</span>' : '') + '</div>' +
      '<div class="sm-hover-grid">' +
        row('开盘', N(bar.open)) + row('最高', N(bar.high), 'up') +
        row('最低', N(bar.low), 'down') + row('收盘', N(bar.close), cls) +
        row('涨跌幅', pct === null ? '—' : (pct > 0 ? '+' : '') + N(pct) + '%', cls) + row('成交量', AMT(bar.volume)) +
        row('MA5', ma(5)) + row('MA10', ma(10)) + row('MA20', ma(20)) +
      '</div>' + minuteBtn;
  }

  function bindKlineInteractions() {
    const wrap = $('smSvgWrap'); if (!wrap) return;
    const block = wrap.closest('.sm-kline-block'), tools = block && block.querySelector('.sm-k-tools');
    if (tools) tools.onclick = e => {
      const b = e.target.closest('[data-kact]'); if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const step = Math.max(1, Math.round(S.chart.view.count * 0.3));
      if (b.dataset.kact === 'in') smZoom(0.8);
      else if (b.dataset.kact === 'out') smZoom(1.25);
      else if (b.dataset.kact === 'left') smPan(-step);
      else if (b.dataset.kact === 'right') smPan(step);
      else if (b.dataset.kact === 'reset') smViewReset();
      else if (b.dataset.kact === 'colors') { S.klPanelOpen = !S.klPanelOpen; renderStockChart(); }
    };
    if (S.chart.upHandler) document.removeEventListener('mouseup', S.chart.upHandler);
    let drag = null, raf = 0;
    S.chart.upHandler = () => {
      if (drag) { if (drag.moved) S.chart._justDragged = true; drag = null; wrap.classList.remove('dragging'); }
    };
    document.addEventListener('mouseup', S.chart.upHandler);

    wrap.addEventListener('wheel', e => {
      // 停靠态详情属于页面内容：普通滚轮交还页面正常下滑，按住 Ctrl / Shift / Alt 才缩放 K 线；
      // 弹窗态保持原有「滚轮即缩放」交互（背景本就被遮罩锁住）。
      if (S.chart && S.chart.docked && !(e.ctrlKey || e.shiftKey || e.altKey)) return;
      e.preventDefault();
      const p = smEvtPos(e); if (!p) return;
      const g = S.chart.geom, aF = (p.vx - g.L) / g.PW;
      smZoom(e.deltaY < 0 ? 0.82 : 1.22, aF);
      const pos = smEvtPos(e);
      if (pos) { const j = Math.floor((pos.vx - S.chart.geom.L) / S.chart.geom.cw); if (j >= 0 && j < S.chart.geom.n) smShowCross(j, pos.vy, pos.rx, pos.ry, S.chart.lockIdx !== null); }
    }, { passive: false });

    wrap.addEventListener('mousemove', e => {
      const p = smEvtPos(e); if (!p) return;
      // 鼠标进入数据面板（含"看分时"按钮）时冻结十字，面板保持不动，按钮可稳定点击
      if (e.target.closest && e.target.closest('#smHoverPanel')) return;
      if (drag) {
        const target = Math.round(smClamp(drag.start - Math.round((p.vx - drag.vx) / drag.g.cw), 0, drag.g.total - S.chart.view.count));
        if (Math.abs(p.vx - drag.vx) > 3) drag.moved = true;
        if (target !== S.chart.view.start) {
          S.chart.view.start = target;
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; smRedrawKline(); });
        }
        return;
      }
      if (S.chart.lockIdx !== null) return;
      const g = S.chart.geom, j = Math.floor((p.vx - g.L) / g.cw);
      if (j >= 0 && j < g.n) smShowCross(j, p.vy, p.rx, p.ry, false);
      else smHideCross();
    });
    wrap.addEventListener('mouseleave', () => { if (!drag && S.chart.lockIdx === null) smHideCross(); });
    wrap.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      // 在面板按钮上按下时不启动拖拽，避免误平移 K 线
      if (e.target.closest && e.target.closest('#smHoverPanel')) return;
      const p = smEvtPos(e); if (!p) return;
      drag = { vx: p.vx, start: S.chart.view.start, g: Object.assign({}, S.chart.geom), moved: false };
      wrap.classList.add('dragging');
    });
    wrap.addEventListener('click', e => {
      // hover 面板里的"看分时"按钮：加载该交易日历史分时并切到分时 tab
      const mb = e.target.closest('.sm-hover-minBtn');
      if (mb) { e.preventDefault(); e.stopPropagation(); loadMinuteOfDate(mb.dataset.md); return; }
      if (S.chart._justDragged) { S.chart._justDragged = false; return; }
      const p = smEvtPos(e); if (!p) return;
      const g = S.chart.geom, j = Math.floor((p.vx - g.L) / g.cw);
      if (j < 0 || j >= g.n) return;
      const gi = g.start + j;
      S.chart.lockIdx = (S.chart.lockIdx === gi) ? null : gi;
      smShowCross(j, p.vy, p.rx, p.ry, S.chart.lockIdx !== null);
    });
    wrap.addEventListener('dblclick', e => { e.preventDefault(); smViewReset(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
