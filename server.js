'use strict';
/**
 * A股实时复盘与短线机会系统 —— 本地服务（Node.js 零第三方依赖）
 * 启动： node server.js   →   http://localhost:8787
 *
 * 所有行情均为免费公开接口实时拉取，服务端不内置、不缓存任何历史行情数字。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ds = require('./lib/datasource');
const an = require('./lib/analytics');

// 默认 8899：8787 常与其它本地服务冲突；可用环境变量 PORT 覆盖
// 若目标端口被占用，启动时自动顺延到下一个可用端口（最多 15 次），并在控制台打印实际地址
const PREFERRED_PORT = Number(process.env.PORT) || 8899;
let ACTIVE_PORT = PREFERRED_PORT;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const DISCLAIMER = '以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。';

/* ─────────── 交易状态（北京时间口径） ─────────── */
function beijingNow() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  const hm = Number(parts.hour) * 100 + Number(parts.minute);
  const weekend = /周六|周日|Sat|Sun/.test(parts.weekday || '');
  let state, note;
  if (weekend) { state = '休市'; note = '周末休市，展示最近一个交易日收盘数据'; }
  else if (hm < 915) { state = '盘前'; note = '未开盘，展示最近一个交易日收盘数据与复盘计划'; }
  else if (hm < 930) { state = '集合竞价'; note = '集合竞价阶段，行情可能频繁变动'; }
  else if (hm <= 1130) { state = '盘中'; note = '早盘交易时段'; }
  else if (hm < 1300) { state = '午间休市'; note = '午间休市，行情为上午收盘快照'; }
  else if (hm <= 1500) { state = '盘中'; note = '午盘交易时段'; }
  else { state = '盘后'; note = '今日已收盘，数据为当日收盘快照'; }
  return {
    now: parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' (北京时间)',
    date: parts.year + parts.month + parts.day,
    weekday: parts.weekday, state, note,
    caveat: '节假日未内置交易日历，如遇法定假日请以交易所公告为准'
  };
}

/* ─────────── HTTP 工具 ─────────── */
function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(PUBLIC, '.' + rel);
  if (!full.startsWith(path.resolve(PUBLIC))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found: ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ─────────── 数据聚合 ─────────── */
const dashCache = { at: 0, value: null, inflight: null };

async function limitedMap(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function buildDashboard(query) {
  const t0 = Date.now();
  const f = { ...query };
  delete f._;

  // 1) 四路数据并行
  const [universe, pools, indices, boards] = await Promise.all([
    ds.getUniverse().catch(() => ({ list: [], count: 0, asOf: new Date().toISOString() })),
    ds.getPools().catch(() => ({ zt: [], qs: [], zb: [], dt: [], date: '', asOf: new Date().toISOString() })),
    ds.getIndices().catch(() => []),
    ds.getSectorBoards().catch(() => ({ industry: [], concept: [], asOf: new Date().toISOString() }))
  ]);

  // 2) 板块筛选解析（新浪板块成分股）
  let sectorSet = null, sectorLabel = null;
  if (f.sector && /^[A-Za-z0-9_]+$/.test(String(f.sector))) {
    sectorSet = await ds.getSectorMembers(String(f.sector));
    const all = [...(boards.industry || []), ...(boards.concept || [])];
    const hit = all.find(b => b.node === f.sector);
    sectorLabel = hit ? `${hit.kind === 'concept' ? '概念' : '行业'}·${hit.name}` : f.sector;
    if (!sectorSet || !sectorSet.size) sectorSet = null;
  }

  // 3) 市场结构 / 题材 / 复盘
  const ov = an.marketOverview(universe, indices, pools);
  const themes = an.buildThemes(pools, boards);
  const review = an.reviewPlan(ov, themes, pools);

  // 4) 需要实时快照的代码池
  const codeSet = new Set();
  for (const k of ['zt', 'qs', 'zb', 'dt']) (pools[k] || []).forEach(x => codeSet.add(x.code));
  // 全市场涨幅榜 / 成交额榜补充，用于筛选器覆盖非涨停标的
  const uniSorted = [...(universe.list || [])].filter(x => x.pct !== null).sort((a, b) => b.pct - a.pct).slice(0, 40);
  uniSorted.forEach(x => codeSet.add(x.code));
  const codes = [...codeSet].slice(0, 400);
  const quotes = await ds.getQQQuotes(codes).catch(() => ({}));
  const qTimes = Object.values(quotes).map(x => x && x.ticktime).filter(Boolean).sort();
  const latestQT = qTimes.length ? qTimes[qTimes.length - 1] : null;
  const quoteTick = latestQT && String(latestQT).length >= 14
    ? String(latestQT).slice(8, 10) + ':' + String(latestQT).slice(10, 12) + ':' + String(latestQT).slice(12, 14)
    : null;

  // 5) 连板股日K（技术指标）
  const lbCodes = (pools.zt || []).filter(x => (x.boards || 1) >= 2).slice(0, 25).map(x => x.code);
  const klines = await limitedMap(lbCodes, 8, async c => ds.getKline(c, 90));
  const klineMap = {};
  lbCodes.forEach((c, i) => { klineMap[c] = klines[i] || []; });

  const ctx = { ov, themes, sectorSet };
  const filtersWithSet = { ...f, _sectorSet: sectorSet };

  // 6) 四大模块
  const [picks, lowbuy, opps] = await Promise.all([
    Promise.resolve(an.shortTermPicks(pools, universe, quotes, ctx, f)),
    Promise.resolve(an.boardLowBuy(pools, ov, themes, klineMap, quotes, filtersWithSet)),
    Promise.resolve(an.liveOpportunities(pools, boards, universe, quotes, filtersWithSet))
  ]);

  const meta = {
    ...beijingNow(),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    poolDate: pools.date || null,
    poolQDate: pools.qdate || null,
    universeCount: universe.count,
    universeExpected: universe.expected,
    universeTick: universe.ticktime,
    quoteTick,
    quoteCount: Object.keys(quotes).length,
    klineCount: Object.values(klineMap).filter(a => a && a.length).length,
    sectorLabel,
    filters: f,
    sources: Object.values(ds.SOURCE_META).map(s => ({ label: s.label, host: s.host })),
    health: ds.getHealth(),
    port: ACTIVE_PORT,
    dataSourceNote: '全市场广度=新浪财经行情中心；实时快照/指数=腾讯证券行情；日K(前复权)=腾讯证券；涨停/炸板/强势/跌停池与连板数、封单、行业=东方财富涨停池。均为免费公开接口，非交易所官方推送，盘中可能有秒级延迟。',
    disclaimer: DISCLAIMER
  };

  return { meta, overview: ov, review, themes, picks, lowbuy, opportunities: opps, boards };
}

/* ─────────── 涨停回调到支撑位（独立模块，避免拖慢主看板） ─────────── */
const pullCache = { at: 0, key: '', value: null, inflight: null };

async function buildPullback(query) {
  const t0 = Date.now();
  const f = { ...query };
  delete f._; delete f.force;
  const lookback = Math.min(15, Math.max(3, Number(f.days) || 8));
  const scanLimit = Math.min(60, Math.max(12, Number(f.scan) || 42));

  // 1) 候选池 / 全市场 / 市场环境 并行
  const [hist, universe, pools, indices] = await Promise.all([
    ds.getRecentLimitUpPools(lookback).catch(() => ({ dates: [], byCode: {} })),
    ds.getUniverse().catch(() => ({ list: [], count: 0 })),
    ds.getPools().catch(() => ({ zt: [], qs: [], zb: [], dt: [], date: '' })),
    ds.getIndices().catch(() => [])
  ]);
  const ov = an.marketOverview(universe, indices, pools);
  const byCode = hist.byCode || {};
  const candidates = Object.values(byCode);
  const codes = candidates.map(x => x.code);
  const quotes = codes.length ? await ds.getQQQuotes(codes).catch(() => ({})) : {};
  const uniMap = new Map((universe.list || []).map(x => [x.code, x]));

  // 2) 预筛：当日仍强势/当日才涨停/停牌/ST 不进入「回调」扫描
  const dateIndex = new Map((hist.dates || []).map((d, i) => [d.date, i]));
  let preselect = candidates.map(x => {
    const q = quotes[x.code] || {};
    const u = uniMap.get(x.code) || {};
    return {
      ...x, quote: q,
      pct: q.pct !== null && q.pct !== undefined ? q.pct : u.pct,
      floatCap: q.floatCap !== null && q.floatCap !== undefined ? q.floatCap : (x.floatCap !== null && x.floatCap !== undefined ? x.floatCap : u.floatCap),
      turnover: q.turnover !== null && q.turnover !== undefined ? q.turnover : u.turnover,
      amount: q.amountWan !== null && q.amountWan !== undefined ? q.amountWan * 1e4 : u.amount
    };
  }).filter(x => {
    if (!(x.quote.price > 0)) return false;
    if (String(f.excludeST || '1') === '1' && /ST/i.test(x.name || '')) return false;
    if (x.pct !== null && x.pct !== undefined && Number(x.pct) >= 7) return false;
    if (x.date === pools.date) return false;   // 最新交易日才涨停，尚未进入回调窗口
    return true;
  });
  // 至少 2 根回调 K 线：涨停日必须在 2 个交易日之前（与划线引擎的 z <= len-3 口径一致）
  preselect.forEach(x => { x.daysAgo = dateIndex.has(x.date) ? dateIndex.get(x.date) : 99; });
  preselect = preselect.filter(x => x.daysAgo >= 2 && x.daysAgo < 99);
  // 分层取样：每个回调天数各取若干只（组内按成交额降序），避免 42 个名额全被同一涨停日占满
  const groups = new Map();
  preselect.forEach(x => { if (!groups.has(x.daysAgo)) groups.set(x.daysAgo, []); groups.get(x.daysAgo).push(x); });
  const perDay = Math.max(3, Math.ceil(scanLimit / Math.max(1, groups.size)));
  const scan = [];
  [...groups.keys()].sort((a, b) => a - b).forEach(k => {
    scan.push(...groups.get(k).sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, perDay));
  });
  scan.length = Math.min(scan.length, scanLimit);

  // 3) 低并发拉日K（腾讯前复权优先，失败自动降级新浪不复权），避免上游限流
  const kdata = await limitedMap(scan, 4, async x => ds.getKlineData(x.code, 120).catch(() => null));

  // 4) 逐只划线与判定（全部数值来自真实日K，未返回数据的标的直接跳过并计数）
  const rows = [];
  const skipReasons = {};
  kdata.forEach((kd, i) => {
    const x = scan[i];
    if (!x) return;
    const a = an.pullbackAnalysis(kd && kd.rows, x.quote, x, { code: x.code, ov, klineSource: kd && kd.source });
    if (!a.available) { skipReasons[a.reason] = (skipReasons[a.reason] || 0) + 1; return; }
    rows.push({
      ...a,
      code: x.code, name: x.name, industry: x.industry,
      board: ds.boardOf(x.code), isST: /ST/i.test(x.name || ''),
      pct: x.pct, floatCap: x.floatCap, turnover: x.turnover, amount: x.amount,
      volRatioQuote: x.quote.volRatio === undefined ? null : x.quote.volRatio,
      quoteTick: x.quote.ticktime || null,
      poolDate: x.date, ztBoards: x.boards,
      klineSource: kd.source, klineAdjusted: kd.adjusted, klineAsOf: kd.asOf,
      klineNote: kd.adjusted === false ? '本标的日K来自备用源（不复权口径），除权个股的历史价位可能与前复权口径不一致' : null
    });
  });

  // 5) 应用全局筛选中与本模块相关的条件
  let sectorSet = null, sectorLabel = null;
  if (f.sector && /^[A-Za-z0-9_]+$/.test(String(f.sector))) {
    sectorSet = await ds.getSectorMembers(String(f.sector));
    sectorLabel = String(f.sector);
    if (!sectorSet || !sectorSet.size) sectorSet = null;
  }
  const sortWhite = ['score', 'pct', 'amount', 'turnover', 'floatCap', 'nearPct'];
  const sort = sortWhite.includes(f.sort) ? f.sort : 'score';
  const list = an.applyFilters(rows, {
    board: f.board, capMin: f.capMin, capMax: f.capMax,
    pctMin: f.pctMin, pctMax: f.pctMax,
    turnoverMin: f.turnoverMin, turnoverMax: f.turnoverMax,
    excludeST: f.excludeST, keyword: f.keyword,
    sort, sortDir: sort === 'nearPct' ? 'asc' : 'desc', limit: 60
  }, sectorSet);

  const qTimes = Object.values(quotes).map(x => x && x.ticktime).filter(Boolean).sort();
  const latestQT = qTimes.length ? qTimes[qTimes.length - 1] : null;
  const quoteTick = latestQT && String(latestQT).length >= 14
    ? String(latestQT).slice(8, 10) + ':' + String(latestQT).slice(10, 12) + ':' + String(latestQT).slice(12, 14) : null;
  const klineSources = [...new Set(kdata.filter(d => d && d.source).map(d => d.source))];
  const fallback = klineSources.some(s => /新浪/.test(s));
  const levels = {};
  rows.forEach(x => { levels[x.level] = (levels[x.level] || 0) + 1; });
  const statuses = {};
  rows.forEach(x => { statuses[x.status] = (statuses[x.status] || 0) + 1; });

  const summary = {
    historyDates: hist.dates || [], historyCount: candidates.length,
    preselectCount: preselect.length, scannedCount: scan.length,
    klineOk: kdata.filter(d => d && d.rows && d.rows.length).length,
    analyzedCount: rows.length, shown: list.length,
    levels, statuses, skipReasons,
    nearCount: rows.filter(x => x.status === '已回踩到位' || x.status === '接近支撑').length,
    brokenCount: rows.filter(x => x.broken).length,
    klineSources, fallback, sectorLabel
  };

  const meta = {
    ...beijingNow(),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    poolDate: pools.date || null,
    quoteTick, universeCount: universe.count,
    health: ds.getHealth(), port: ACTIVE_PORT,
    sources: Object.values(ds.SOURCE_META).map(s => ({ label: s.label, host: s.host, standby: !!s.standby })),
    marketTier: ov.tier, marketEmotion: ov.emotion,
    methodology: an.PULLBACK_METHOD,
    filters: f,
    dataSourceNote: '历史涨停候选=东方财富涨停池（近 ' + (hist.dates || []).length + ' 个交易日）；实时价/流通市值/换手=腾讯证券行情；日K与划线=' + (klineSources.join(' / ') || '未取得') + '；市场档位=本地量化引擎由新浪全市场快照与东财涨停池推导。',
    klineNote: fallback
      ? '腾讯前复权日K当前不可用，已自动降级为「新浪财经日K（不复权）」；除权个股的历史价位划线可能与前复权口径不一致，请以此标注为准。'
      : '日K为腾讯证券前复权口径。',
    historyNote: hist.note || '',
    disclaimer: DISCLAIMER
  };

  return { meta, summary, methodology: an.PULLBACK_METHOD, list };
}

async function getPullback(query, force) {
  const now = Date.now();
  const key = JSON.stringify(query);
  if (!force && pullCache.value && pullCache.key === key && now - pullCache.at < 180000) return pullCache.value;
  if (pullCache.inflight) return pullCache.inflight;
  pullCache.inflight = (async () => {
    try {
      const v = await buildPullback(query);
      pullCache.value = v; pullCache.key = key; pullCache.at = Date.now();
      return v;
    } finally { pullCache.inflight = null; }
  })();
  return pullCache.inflight;
}

async function getDashboard(query, force) {
  const now = Date.now();
  const key = JSON.stringify(query);
  if (!force && dashCache.value && dashCache.key === key && now - dashCache.at < 9000) return dashCache.value;
  if (dashCache.inflight) return dashCache.inflight;
  dashCache.inflight = (async () => {
    try {
      const v = await buildDashboard(query);
      dashCache.value = v; dashCache.key = key; dashCache.at = Date.now();
      return v;
    } finally { dashCache.inflight = null; }
  })();
  return dashCache.inflight;
}

/* ─────────── 涨停回踩支撑 · 历史回溯（成功率） ─────────── */
const backtestCache = { at: 0, key: '', value: null, inflight: null };
const toKlineDate = d => {
  const s = String(d || '');
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
};

async function buildBacktest(query) {
  const t0 = Date.now();
  const q = { ...query };
  delete q._; delete q.force;
  const window = [3, 5, 10].includes(Number(q.window)) ? Number(q.window) : 5;
  const dayCount = Math.min(10, Math.max(3, Number(q.days) || 10));
  const perDay = Math.min(40, Math.max(8, Number(q.perDay) || 30));
  const maxCodes = Math.min(220, Math.max(40, Number(q.maxCodes) || 180));

  // 1) 历史涨停池：交易日以请求日期为准，降序（最新在前）
  const hist = await ds.getLimitUpHistory(dayCount + 12);
  const allDates = (hist.dates || []).map(d => d.date);
  const baseDates = allDates.slice(0, dayCount);
  const methodology = an.BACKTEST_METHOD;

  if (!baseDates.length) {
    return {
      meta: { ...beijingNow(), generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, window, dayCount, perDay, baseDates: [], historyDays: 0, plannedCount: 0, codesRequested: 0, klineOk: 0, klineSources: [], skipped: {}, methodology, disclaimer: DISCLAIMER, emptyReason: '东方财富历史涨停池未返回任何交易日，无法回溯；系统不填充推测数据。' },
      days: [], rows: [], summary: an.summarizeBacktest([]), methodology
    };
  }

  // 2) 逐基准日重建候选：只取「该基准日之前 2~10 个交易日已公布」的涨停池，
  //    绝不使用基准日之后才出现的名单（避免幸存者偏差 / 未来函数）
  const plan = [];
  baseDates.forEach((d, i) => {
    const map = new Map();
    for (let back = 2; back <= 10; back++) {
      const pd = allDates[i + back];
      if (!pd) continue;
      for (const r of (hist.byDate[pd] || [])) {
        if (!r || !r.code || /ST/i.test(r.name || '')) continue;
        const prev = map.get(r.code);
        if (!prev || (r.amount || 0) > (prev.amount || 0)) map.set(r.code, { ...r, poolDate: pd });
      }
    }
    const picked = [...map.values()].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, perDay);
    picked.forEach(r => plan.push({
      date: d, code: r.code, name: r.name, industry: r.industry,
      poolDate: r.poolDate, amount: r.amount
    }));
  });

  // 3) 代码去重：每只只拉一次日K，覆盖多个基准日；按覆盖日数 / 成交额优先
  const stat = new Map();
  plan.forEach(p => {
    const s = stat.get(p.code) || { code: p.code, name: p.name, hits: 0, amount: 0 };
    s.hits++; s.amount = Math.max(s.amount, p.amount || 0);
    stat.set(p.code, s);
  });
  const codes = [...stat.values()]
    .sort((a, b) => b.hits - a.hits || b.amount - a.amount)
    .slice(0, maxCodes).map(x => x.code);
  const kdata = await limitedMap(codes, 4, c => ds.getKlineData(c, 90).catch(() => null));
  const kByCode = new Map();
  codes.forEach((c, i) => { if (kdata[i] && kdata[i].rows && kdata[i].rows.length) kByCode.set(c, kdata[i]); });

  // 4) 时点切片重跑划线 → 用后续真实日K判定结果
  const rows = [], skipped = {};
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const p of plan) {
    const kd = kByCode.get(p.code);
    if (!kd) { skip('日K未取得（上游不可用）'); continue; }
    const kl = kd.rows;
    const idx = kl.findIndex(b => b.date === toKlineDate(p.date));
    if (idx < 30) { skip('基准日缺失或此前历史K线不足 30 根（停牌/新股）'); continue; }
    const visible = kl.slice(0, idx + 1);   // 关键：只给基准日及之前，杜绝未来函数
    const a = an.pullbackAnalysis(visible, { price: kl[idx].close },
      { code: p.code, name: p.name, date: p.poolDate },
      { code: p.code, klineSource: kd.source, priceSource: '基准日真实日K收盘价（历史回放）' });
    if (!a.available) { skip(a.reason); continue; }
    const outcome = an.backtestOutcome(kl, idx, a.plan, window);
    if (!outcome) { skip('目标/止损价位异常，无法判定'); continue; }
    rows.push({
      date: p.date, code: p.code, name: p.name, industry: p.industry,
      board: ds.boardOf(p.code), poolDate: p.poolDate,
      level: a.level, score: a.score, status: a.status, nearPct: a.nearPct,
      support: a.primarySupport.short, supportPrice: a.primarySupport.price,
      target: a.plan.target, stop: a.plan.stop, rr: a.plan.rr,
      ztDate: a.ztDate, sinceZt: a.sinceZt, klineSource: kd.source,
      outcome
    });
  }

  // 5) 逐日 / 整体汇总
  const days = baseDates.map(d => {
    const list = rows.filter(r => r.date === d);
    return {
      date: d, ...an.summarizeBacktest(list),
      plannedCount: plan.filter(p => p.date === d).length
    };
  });
  const klineSources = [...new Set([...kByCode.values()].map(k => k.source).filter(Boolean))];
  const meta = {
    ...beijingNow(), generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
    window, dayCount, perDay, maxCodes,
    historyDays: allDates.length,
    historyRange: [allDates[allDates.length - 1], allDates[0]],
    baseDates, plannedCount: plan.length, codesRequested: codes.length,
    klineOk: kByCode.size, skipped, klineSources,
    fallback: klineSources.some(s => /新浪/.test(s)),
    methodology,
    dataSourceNote: '候选=东方财富历史涨停池（按基准日之前的交易日切片，不使用未来名单）；基准价/划线/结果判定=腾讯证券前复权日K（限流时自动降级新浪不复权并逐只标注）；历史市场档位无法回溯，评分中该因子固定 5 分。',
    disclaimer: DISCLAIMER
  };
  return { meta, days, rows, summary: an.summarizeBacktest(rows), methodology };
}

async function getBacktest(query, force) {
  const key = JSON.stringify({
    window: query.window || '', days: query.days || '',
    perDay: query.perDay || '', maxCodes: query.maxCodes || ''
  });
  if (!force && backtestCache.value && backtestCache.key === key && Date.now() - backtestCache.at < 600000) return backtestCache.value;
  if (backtestCache.inflight) return backtestCache.inflight;
  backtestCache.inflight = (async () => {
    try {
      const v = await buildBacktest(query);
      backtestCache.value = v; backtestCache.key = key; backtestCache.at = Date.now();
      return v;
    } finally { backtestCache.inflight = null; }
  })();
  return backtestCache.inflight;
}

/* ─────────── 路由 ─────────── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:' + ACTIVE_PORT);
  const q = Object.fromEntries(u.searchParams.entries());
  try {
    if (u.pathname === '/api/dashboard') return sendJson(res, await getDashboard(q, q.force === '1'));
    if (u.pathname === '/api/pullback') return sendJson(res, await getPullback(q, q.force === '1'));
    if (u.pathname === '/api/backtest') return sendJson(res, await getBacktest(q, q.force === '1'));
    if (u.pathname === '/api/health') return sendJson(res, { ...beijingNow(), port: ACTIVE_PORT, health: ds.getHealth(), disclaimer: DISCLAIMER });
    if (u.pathname === '/api/boards') return sendJson(res, await ds.getSectorBoards());
    if (u.pathname === '/api/pools') return sendJson(res, await ds.getPools());
    if (u.pathname === '/api/quotes') {
      const codes = String(q.codes || '').split(',').filter(Boolean).slice(0, 200);
      return sendJson(res, { quotes: await ds.getQQQuotes(codes), asOf: new Date().toISOString(), source: '腾讯证券实时行情' });
    }
    if (u.pathname === '/api/kline') return sendJson(res, { code: q.code, kline: await ds.getKline(q.code, Number(q.limit) || 90), source: '腾讯证券日K(前复权)' });
    if (u.pathname === '/api/universe') {
      const uni = await ds.getUniverse();
      const rows = an.applyFilters(uni.list, q, null);
      return sendJson(res, { rows, total: uni.count, asOf: uni.asOf, source: uni.source });
    }
    if (u.pathname.startsWith('/api/')) return sendJson(res, { error: 'unknown api', path: u.pathname }, 404);
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    console.error('[ERROR]', u.pathname, e);
    return sendJson(res, { error: String(e && e.message || e), path: u.pathname }, 500);
  }
});

function startListen(port, retries) {
  // 用具名监听器 + 显式移除：listen 失败重试时，若沿用 listen(port, cb) 形式，
  // 每次调用都会新增一个 'listening' 回调且不会自动清除，最终成功时历史回调会全部触发，
  // 打印出多个错误端口。这里在 error / listening 任一分支都先清理两个监听器。
  const cleanup = () => {
    server.removeListener('error', onError);
    server.removeListener('listening', onListening);
  };
  const onListening = () => {
    cleanup();
    ACTIVE_PORT = port;
    console.log('A股实时复盘与短线机会系统已启动');
    console.log('本机访问: http://localhost:' + port);
    console.log('数据源: 新浪财经行情中心 / 腾讯证券行情 / 东方财富涨停池（均为免费公开接口）');
    // 后台预热一次，使数据源健康状态与首屏数据立即可用（失败不影响服务监听）
    setTimeout(() => {
      getDashboard({}, false).catch(e => console.warn('预热未完成（不影响使用）：' + e.message));
    }, 300);
  };
  const onError = err => {
    cleanup();
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn('端口 ' + port + ' 已被占用，自动顺延至 ' + (port + 1));
      startListen(port + 1, retries - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}
startListen(PREFERRED_PORT, 15);
