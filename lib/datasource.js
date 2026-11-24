'use strict';
/**
 * 数据接入层 —— 全部使用免费公开行情接口，无任何商业数据授权。
 *
 *  新浪财经行情中心  vip.stock.finance.sina.com.cn  全市场 A 股列表 / 行业 / 概念板块
 *  腾讯证券行情      qt.gtimg.cn                    实时快照（含流通市值、量比、涨跌停价）
 *  腾讯证券日K       web.ifzq.gtimg.cn              前复权日线（技术指标计算）
 *  东方财富涨停池    push2ex.eastmoney.com          涨停 / 强势 / 炸板 / 跌停池（含连板数、封单、行业）
 *  同花顺涨停池      data.10jqka.com.cn             历史涨停池（可回溯数月，用于长周期统计回补）
 *
 * 所有对外返回的数据都带 source 与 asOf 字段，禁止在其它层伪造数字。
 */
const https = require('https');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10000;

const SOURCE_META = {
  sina:    { label: '新浪财经行情中心', host: 'vip.stock.finance.sina.com.cn', url: 'https://finance.sina.com.cn/' },
  qq:      { label: '腾讯证券实时行情', host: 'qt.gtimg.cn',                   url: 'https://gu.qq.com/' },
  qqKline: { label: '腾讯证券日K(前复权)', host: 'web.ifzq.gtimg.cn',         url: 'https://gu.qq.com/' },
  emPool:  { label: '东方财富涨停池',     host: 'push2ex.eastmoney.com',      url: 'https://quote.eastmoney.com/ztb/detail' },
  thsPool: { label: '同花顺涨停池(历史回补)', host: 'data.10jqka.com.cn', url: 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html' },
  sinaKline: { label: '新浪财经日K(不复权·备用)', host: 'quotes.sina.cn', url: 'https://finance.sina.com.cn/', standby: true },
  emAnn:     { label: '东方财富交易所公告', host: 'np-anotice-stock.eastmoney.com', url: 'https://data.eastmoney.com/notices/' },
  sinaFlash: { label: '新浪财经 7×24 快讯', host: 'zhibo.sina.com.cn',      url: 'https://finance.sina.com.cn/7x24/' },
  qqMinute:  { label: '腾讯证券分时', host: 'web.ifzq.gtimg.cn', url: 'https://gu.qq.com/' },
  emMinute:  { label: '东方财富历史分时(5分钟)', host: 'push2his.eastmoney.com', url: 'https://quote.eastmoney.com/' },
  sinaFund:  { label: '新浪财经资金流向', host: 'vip.stock.finance.sina.com.cn', url: 'https://finance.sina.com.cn/' },
  sinaFundHist: { label: '新浪财经个股资金流(日线·备用)', host: 'vip.stock.finance.sina.com.cn', url: 'https://finance.sina.com.cn/' },
  qqFund:    { label: '腾讯证券板块资金流', host: 'proxy.finance.qq.com', url: 'https://gu.qq.com/' },
  emFund:    { label: '东方财富个股资金流(日线)', host: 'push2his.eastmoney.com', url: 'https://data.eastmoney.com/' },
  emFundNow: { label: '东方财富个股资金流(实时)', host: 'push2.eastmoney.com',     url: 'https://data.eastmoney.com/' },
  emFlash:   { label: '东方财富财经快讯',   host: 'np-listapi.eastmoney.com',  url: 'https://finance.eastmoney.com/' },
  emPop:     { label: '东方财富股吧人气榜', host: 'emappdata.eastmoney.com',  url: 'https://guba.eastmoney.com/rank' }
};

const health = {};
for (const k of Object.keys(SOURCE_META)) {
  health[k] = { key: k, label: SOURCE_META[k].label, ok: false, lastOk: null, lastTry: null, error: null, latency: 0, rows: 0 };
}

const cache = new Map();
const inflight = new Map();

function mark(key, ok, extra) {
  const h = health[key];
  h.ok = ok;
  h.lastTry = new Date().toISOString();
  if (ok) { h.lastOk = h.lastTry; h.error = null; }
  if (extra && typeof extra === 'object') Object.assign(h, extra);
  else if (!ok) h.error = String(extra || 'unknown error');
}

async function cached(key, ttl, producer, validate) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (hit.ttl || ttl) && hit.value !== undefined) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      // validate 用于「空结果不缓存」：上游短时限流时不要把空数组锁住整个 TTL
      if (value !== undefined && value !== null && (!validate || validate(value)))
        cache.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      // 上游失败时允许吃旧缓存，避免整页空白；调用方仍能看到 health 里的失败状态
      if (hit && hit.value !== undefined) return hit.value;
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

function rawGet(url, { referer, ua, gbk = false, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      family: 4,
      method: 'GET',
      headers: {
        'User-Agent': ua || UA,
        'Referer': referer || 'https://finance.sina.com.cn/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'close'
      },
      timeout
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' @ ' + u.hostname));
        }
        let text;
        try { text = gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8'); }
        catch (e) { text = buf.toString('utf8'); }
        resolve(text);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout @ ' + u.hostname)); });
    req.on('error', reject);
    req.end();
  });
}

function rawPost(url, payload, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, family: 4,
      method: 'POST',
      headers: {
        'User-Agent': UA, 'Referer': SOURCE_META.emPop.url,
        'Content-Type': 'application/json', 'Content-Length': data.length,
        'Accept': '*/*', 'Connection': 'close'
      }, timeout
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ' @ ' + u.hostname));
        resolve(text);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout @ ' + u.hostname)); });
    req.on('error', reject);
    req.end(data);
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = null; }
    }
  }));
  return out;
}

async function timed(key, url, opts) {
  const t0 = Date.now();
  try {
    const text = await rawGet(url, opts);
    mark(key, true, { latency: Date.now() - t0 });
    return text;
  } catch (e) {
    mark(key, false, e.message);
    throw e;
  }
}

const SINA_BASE = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const SINA_COUNT = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount';

function sinaNodeUrl(node, page, num, sort, asc) {
  return SINA_BASE + '?page=' + page + '&num=' + num + '&sort=' + (sort || 'changepercent') +
    '&asc=' + (asc === undefined ? 0 : asc) + '&node=' + encodeURIComponent(node) + '&_=' + Date.now();
}

function num(v) {
  if (v === undefined || v === null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 新浪全市场快照标准化：流通市值统一换算为「亿元」 */
function normalizeSina(row) {
  const symbol = String(row.symbol || '');
  const code = String(row.code || '').padStart(6, '0');
  const nmc = num(row.nmc);       // 万元
  const mktcap = num(row.mktcap); // 万元
  return {
    code,
    symbol,
    name: String(row.name || '').replace(/\s+/g, ''),
    price: num(row.trade),
    prevClose: num(row.settlement),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    change: num(row.pricechange),
    pct: num(row.changepercent),
    volume: num(row.volume),          // 股
    amount: num(row.amount),          // 元
    turnover: num(row.turnoverratio), // %
    pe: num(row.per),
    pb: num(row.pb),
    floatCap: nmc === null ? null : +(nmc / 10000).toFixed(2),   // 亿元
    totalCap: mktcap === null ? null : +(mktcap / 10000).toFixed(2),
    ticktime: row.ticktime || null,
    board: boardOf(code),
    isST: /ST/i.test(String(row.name || ''))
  };
}

/** 板块归属：按证券代码规则判定（规则判定，不是行情数据） */
function boardOf(code) {
  const c = String(code || '');
  if (/^(600|601|603|605|000|001|002|003)/.test(c)) return '主板';
  if (/^(300|301)/.test(c)) return '创业板';
  if (/^(688|689)/.test(c)) return '科创板';
  if (/^(8|4|920)/.test(c)) return '北交所';
  return '其他';
}

async function nodeCount(node) {
  const txt = await timed('sina', SINA_COUNT + '?node=' + encodeURIComponent(node) + '&_=' + Date.now(),
    { referer: SOURCE_META.sina.url });
  try { return Number(String(txt).replace(/"/g, '')) || 0; } catch (e) { return 0; }
}

/** 拉取某个新浪节点（全市场 / 行业 / 概念）的成分股行情 */
async function fetchNode(node, { maxPages = 1, num: pageSize = 100, sort = 'changepercent', asc = 0, concurrency = 8 } = {}) {
  const firstTxt = await timed('sina', sinaNodeUrl(node, 1, pageSize, sort, asc), { referer: SOURCE_META.sina.url });
  let first;
  try { first = JSON.parse(firstTxt); } catch (e) { first = []; }
  if (!Array.isArray(first)) first = [];
  const rows = [...first];
  const totalPages = Math.max(1, Math.min(maxPages, 60));
  if (totalPages > 1) {
    const pages = [];
    for (let p = 2; p <= totalPages; p++) pages.push(p);
    for (let i = 0; i < pages.length; i += concurrency) {
      const batch = pages.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(async p => {
        try {
          const t = await timed('sina', sinaNodeUrl(node, p, pageSize, sort, asc), { referer: SOURCE_META.sina.url });
          const j = JSON.parse(t);
          return Array.isArray(j) ? j : [];
        } catch (e) { return []; }
      }));
      results.forEach(r => rows.push(...r));
    }
  }
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const c = String(r.code || '').padStart(6, '0');
    if (!c || seen.has(c)) continue;
    seen.add(c);
    list.push(normalizeSina(r));
  }
  return { list, count: list.length, node };
}

/** 全市场 A 股（含北交所），缓存 45 秒 */
async function getUniverse(force) {
  const key = 'universe';
  if (force) cache.delete(key);
  return cached(key, 45000, async () => {
    const total = await nodeCount('hs_a');
    const pages = Math.min(60, Math.max(1, Math.ceil(total / 100)));
    const res = await fetchNode('hs_a', { maxPages: pages, num: 100, sort: 'symbol', asc: 1, concurrency: 10 });
    mark('sina', true, { rows: res.list.length });
    return {
      list: res.list,
      count: res.list.length,
      expected: total,
      asOf: new Date().toISOString(),
      source: SOURCE_META.sina.label,
      ticktime: res.list.length ? res.list[0].ticktime : null
    };
  });
}

/** 供搜索等高频接口使用：有旧缓存立即返回，过期则在后台刷新，避免按键被全市场拉取阻塞 */
async function getUniverseStale() {
  const hit = cache.get('universe');
  if (hit && hit.value !== undefined) {
    if (Date.now() - hit.at >= 45000 && !inflight.has('universe')) {
      getUniverse(false).catch(() => { });
    }
    return hit.value;
  }
  return getUniverse(false);
}

/** 行业 / 概念板块列表（新浪） */
function parseSinaBoard(txt, kind) {
  const m = String(txt).match(/=\s*(\{[\s\S]*?\})\s*;?\s*$/);
  if (!m) return [];
  let obj;
  try { obj = JSON.parse(m[1]); } catch (e) { return []; }
  return Object.keys(obj).map(k => {
    const p = String(obj[k]).split(',');
    return {
      node: p[0] || k,
      name: p[1] || k,
      kind,
      members: num(p[2]),
      avgPrice: num(p[3]),
      avgChange: num(p[4]),
      pct: num(p[5]),
      volume: num(p[6]),
      amount: num(p[7]),
      leaderCode: String(p[8] || '').replace(/^(sh|sz|bj)/, ''),
      leaderPct: num(p[9]),
      leaderPrice: num(p[10]),
      leaderName: p[12] || ''
    };
  }).filter(x => x.name);
}

async function getSectorBoards() {
  return cached('boards', 60000, async () => {
    const out = { industry: [], concept: [] };
    const jobs = [
      ['industry', 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php'],
      ['concept', 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class']
    ];
    await Promise.all(jobs.map(async ([kind, url]) => {
      try {
        const txt = await timed('sina', url, { referer: SOURCE_META.sina.url, gbk: true });
        out[kind] = parseSinaBoard(txt, kind).sort((a, b) => (b.pct || 0) - (a.pct || 0));
      } catch (e) { out[kind] = []; }
    }));
    return { ...out, asOf: new Date().toISOString(), source: SOURCE_META.sina.label };
  });
}

/** 板块成分股代码集合（用于板块筛选） */
async function getSectorMembers(node) {
  if (!node || !/^[A-Za-z0-9_]+$/.test(node)) return new Set();
  return cached('sector:' + node, 120000, async () => {
    try {
      const r = await fetchNode(node, { maxPages: 3, num: 100, sort: 'changepercent', asc: 0, concurrency: 6 });
      return new Set(r.list.map(x => x.code));
    } catch (e) { return new Set(); }
  });
}

/** 腾讯实时快照批量查询；codes 支持 6 位代码或 sh/sz/bj 前缀 */
function qqSymbol(code) {
  const c = String(code || '').replace(/^(sh|sz|bj)/, '');
  if (/^(6|9)/.test(c)) return 'sh' + c;
  if (/^(0|2|3)/.test(c)) return 'sz' + c;
  if (/^(8|4)/.test(c)) return 'bj' + c;
  return null;
}

function parseQQQuotes(text) {
  const out = {};
  const lines = String(text).split(';');
  for (const line of lines) {
    const m = line.match(/v_([a-z]{2}\d{6})\s*=\s*"([\s\S]*?)"/);
    if (!m) continue;
    const p = m[2].split('~');
    if (p.length < 50) continue;
    const code = p[2] || m[1].slice(2);
    out[code] = {
      code,
      name: p[1],
      price: num(p[3]),
      prevClose: num(p[4]),
      open: num(p[5]),
      change: num(p[31]),
      pct: num(p[32]),
      high: num(p[33]),
      low: num(p[34]),
      volume: num(p[36]),       // 手
      amountWan: num(p[37]),    // 万元
      turnover: num(p[38]),
      pe: num(p[39]),
      amplitude: num(p[43]),
      floatCap: num(p[44]),     // 亿元
      totalCap: num(p[45]),     // 亿元
      pb: num(p[46]),
      limitUp: num(p[47]),
      limitDown: num(p[48]),
      volRatio: num(p[49]),
      avgPrice: num(p[51]),
      ticktime: p[30] || null,
      source: SOURCE_META.qq.label
    };
  }
  return out;
}

async function getQQQuotes(codes, { ttl = 12000 } = {}) {
  const uniq = [...new Set((codes || []).map(qqSymbol).filter(Boolean))];
  if (!uniq.length) return {};
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 60) chunks.push(uniq.slice(i, i + 60));
  const key = 'qq:' + uniq.join(',');
  // 组合过多时不做长 key 缓存，直接走单次请求
  const cacheKey = key.length < 1500 ? key : null;
  const run = async () => {
    const results = await Promise.all(chunks.map(async part => {
      try {
        const txt = await timed('qq', 'https://qt.gtimg.cn/q=' + part.join(',') + '&_=' + Date.now(),
          { referer: SOURCE_META.qq.url, gbk: true });
        return parseQQQuotes(txt);
      } catch (e) { return {}; }
    }));
    const merged = Object.assign({}, ...results);
    mark('qq', true, { rows: Object.keys(merged).length });
    return merged;
  };
  return cacheKey ? cached(cacheKey, ttl, run) : run();
}

/** 腾讯前复权日K：web 域高频抓取会触发 WAF(501)，优先 ifzq 域，失败再退回 web 域 */
const TENCENT_KLINE_HOSTS = [
  { host: 'ifzq.gtimg.cn', label: '腾讯 ifzq 前复权日K' },
  { host: 'web.ifzq.gtimg.cn', label: '腾讯 web.ifzq 前复权日K' }
];
let lastKlineSource = null;
// 腾讯 WAF 会对短时间高频日K请求临时封禁（HTTP 501）。命中后进入冷却：
// 冷却期内直接走备用源、不再逐个请求撞墙；到期自动探活，恢复前复权口径。
const TENCENT_COOLDOWN_MS = 120000;
let tencentBlockedUntil = 0;
let klineRound = { at: 0, sources: {} };
function noteKlineSource(src) {
  const now = Date.now();
  if (now - klineRound.at > 60000) klineRound = { at: now, sources: {} };
  if (src) klineRound.sources[src] = (klineRound.sources[src] || 0) + 1;
}

async function tencentKline(sym, limit) {
  if (Date.now() < tencentBlockedUntil) {
    mark('qqKline', false, {
      degraded: true,
      error: '腾讯日K触发 WAF 限流，冷却中；已自动切换新浪不复权日K',
      sourceLabel: SOURCE_META.sinaKline.label,
      resumeAt: new Date(tencentBlockedUntil).toISOString()
    });
    return [];
  }
  for (const src of TENCENT_KLINE_HOSTS) {
    try {
      // 不加 _=timestamp：日K本身有服务端缓存，随机参数只会增加 WAF 穿透特征
      const url = 'https://' + src.host + '/appstock/app/fqkline/get?param=' + sym + ',day,,,' + limit + ',qfq';
      const txt = await timed('qqKline', url, { referer: SOURCE_META.qqKline.url });
      const j = JSON.parse(txt);
      const d = j && j.data && j.data[sym];
      const arr = (d && (d.qfqday || d.day)) || [];
      const rows = arr.map(r => ({
        date: r[0], open: num(r[1]), close: num(r[2]),
        high: num(r[3]), low: num(r[4]), volume: num(r[5])
      })).filter(x => x.close !== null);
      if (rows.length) {
        tencentBlockedUntil = 0;
        mark('qqKline', true, { rows: rows.length, sourceLabel: src.label, degraded: false, error: null, resumeAt: null });
        lastKlineSource = src.label;
        return rows;
      }
    } catch (e) { /* 换下一个 host */ }
  }
  tencentBlockedUntil = Date.now() + TENCENT_COOLDOWN_MS;
  mark('qqKline', false, {
    degraded: true,
    error: '腾讯日K两个域名均不可用（WAF 限流），已切换新浪不复权日K；冷却 2 分钟后自动探活',
    sourceLabel: SOURCE_META.sinaKline.label,
    resumeAt: new Date(tencentBlockedUntil).toISOString()
  });
  return [];
}

/** 新浪财经日K（备用源，不复权）：腾讯接口限流 / 故障时的降级口径 */
async function sinaKline(sym, limit) {
  try {
    const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=' + sym +
      '&scale=240&ma=no&datalen=' + Math.min(250, Math.max(30, limit));
    const txt = await timed('sinaKline', url, { referer: SOURCE_META.sinaKline.url });
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) { mark('sinaKline', false, '返回结构异常'); return []; }
    const rows = arr.map(r => ({
      date: String(r.day || '').slice(0, 10),
      open: num(r.open), close: num(r.close),
      high: num(r.high), low: num(r.low),
      volume: num(r.volume) === null ? null : +(num(r.volume) / 100).toFixed(0) // 股 → 手，与腾讯口径对齐
    })).filter(x => x.date && x.close !== null && x.high !== null && x.low !== null);
    mark('sinaKline', true, { rows: rows.length });
    if (rows.length) lastKlineSource = SOURCE_META.sinaKline.label;
    return rows;
  } catch (e) { return []; }
}

/**
 * 日K统一入口：腾讯前复权优先，失败自动降级新浪不复权，并如实返回口径。
 * 空结果不写入缓存（cached 的 validate），避免上游短时限流把空数据锁住 5 分钟。
 */
async function getKlineData(code, limit = 90) {
  const sym = qqSymbol(code);
  if (!sym) return { rows: [], source: null, adjusted: null, asOf: new Date().toISOString(), reason: '代码无法解析为行情符号' };
  // 各模块分别传 90 / 120 根，按原值建缓存键会对同一只股票重复拉两遍。
  // 归一化到固定档位（≤120 一律取 120 根），让 dashboard / pullback / backtest / dragon 共享缓存，
  // 单位时间内日K请求量减半，是避免再次触发腾讯 WAF 的关键。
  const L = limit <= 120 ? 120 : Math.min(250, limit);
  const result = await cached('klineData:' + sym + ':' + L, 600000, async () => {
    let rows = await tencentKline(sym, L);
    let source = rows.length ? (lastKlineSource || SOURCE_META.qqKline.label) : null;
    let adjusted = rows.length ? true : null;
    if (!rows.length) {
      rows = await sinaKline(sym, L);
      source = rows.length ? SOURCE_META.sinaKline.label : null;
      adjusted = rows.length ? false : null;
    }
    return {
      rows, source, adjusted, limit: L,
      asOf: new Date().toISOString(),
      reason: rows.length ? null : '腾讯与新浪日K接口均未返回数据（可能上游限流）'
    };
  }, v => v && Array.isArray(v.rows) && v.rows.length > 0);
  // 缓存命中也要更新来源：否则 meta 会停留在历史上最后一次成功的源，与实际口径不符
  if (result && result.source) {
    lastKlineSource = result.source;
    noteKlineSource(result.source);
  }
  return result;
}

/** 兼容既有调用：只返回日K数组 */
async function getKline(code, limit = 90) {
  return (await getKlineData(code, limit)).rows;
}

/**
 * 通用周期K线：day 复用 getKlineData（腾讯前复权+新浪降级），week/month 用腾讯 kline/kline 接口（不复权）。
 * kline/kline 与 fqkline 不同域路径，实测不受 fqkline 的 WAF 501 影响；周/月K本身无复权口径，如实标注 adjusted=false。
 */
const PERIOD_KLINE_HOSTS = [
  { host: 'web.ifzq.gtimg.cn', label: '腾讯证券周/月K(不复权)' },
  { host: 'ifzq.gtimg.cn', label: '腾讯证券周/月K(ifzq·不复权)' }
];
async function getPeriodKline(code, period = 'day', limit = 120) {
  const per = ['day', 'week', 'month'].includes(period) ? period : 'day';
  if (per === 'day') {
    const d = await getKlineData(code, limit);
    return { ...d, period: 'day' };
  }
  const sym = qqSymbol(code);
  if (!sym) return { rows: [], source: null, adjusted: null, asOf: new Date().toISOString(), period: per, reason: '代码无法解析为行情符号' };
  const L = Math.min(200, Math.max(20, limit));
  const result = await cached('periodKline:' + sym + ':' + per + ':' + L, 600000, async () => {
    for (const src of PERIOD_KLINE_HOSTS) {
      try {
        const url = 'https://' + src.host + '/appstock/app/kline/kline?param=' + sym + ',' + per + ',,,' + L;
        const txt = await timed('qqKline', url, { referer: SOURCE_META.qqKline.url });
        const j = JSON.parse(txt);
        if (j && j.code !== 0) continue;
        const d = j && j.data && j.data[sym];
        const arr = (d && (d[per] || d.day)) || [];
        const rows = arr.map(r => ({
          date: String(r[0]).slice(0, 10), open: num(r[1]), close: num(r[2]),
          high: num(r[3]), low: num(r[4]), volume: num(r[5])
        })).filter(x => x.date && x.close !== null && x.high !== null && x.low !== null);
        if (rows.length) return { rows, source: src.label, adjusted: false, period: per, asOf: new Date().toISOString(), reason: null };
      } catch (e) { /* 换下一个 host */ }
    }
    return { rows: [], source: null, adjusted: false, period: per, asOf: new Date().toISOString(), reason: '腾讯周/月K接口未返回数据（可能上游限流）' };
  }, v => v && Array.isArray(v.rows) && v.rows.length > 0);
  return result;
}

/** 近 1 分钟内实际使用的日K来源；混用多个源时如实列出，不再只报「最后一次」 */
function getKlineSource() {
  const es = Object.entries(klineRound.sources).sort((a, b) => b[1] - a[1]);
  if (!es.length) return lastKlineSource;
  if (es.length === 1) return es[0][0];
  return es[0][0] + '（混用 ' + es.slice(1).map(x => x[0] + '×' + x[1]).join('、') + '）';
}

/** 东财涨停/炸板/强势/跌停池 */
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const EM_POOLS = {
  zt: { path: 'getTopicZTPool', sort: 'fbt%3Aasc', label: '涨停池' },
  zb: { path: 'getTopicZBPool', sort: 'fbt%3Aasc', label: '炸板池' },
  qs: { path: 'getTopicQSPool', sort: 'zdp%3Adesc', label: '强势股池' },
  dt: { path: 'getTopicDTPool', sort: 'fund%3Aasc', label: '跌停池' }
};

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function fmtSealTime(v) {
  if (v === undefined || v === null) return null;
  const s = String(Math.floor(Number(v))).padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}

function normalizeEMPool(row, kind) {
  const code = String(row.c || '').padStart(6, '0');
  const price = num(row.p) === null ? null : +(num(row.p) / 1000).toFixed(2);
  const ztPrice = num(row.ztp) === null ? null : +(num(row.ztp) / 1000).toFixed(2);
  const ltsz = num(row.ltsz);
  const fund = num(row.fund);
  return {
    code,
    name: String(row.n || '').replace(/\s+/g, ''),
    price,
    limitUpPrice: ztPrice,
    pct: num(row.zdp),
    amount: num(row.amount),           // 元
    floatCap: ltsz === null ? null : +(ltsz / 1e8).toFixed(2),   // 亿元
    totalCap: num(row.tshare) === null ? null : +(num(row.tshare) / 1e8).toFixed(2),
    turnover: num(row.hs),
    boards: num(row.lbc) || 1,          // 连板数（涨停池）
    // 跌停池无 lbc，用 days 表示连续跌停天数；涨停池该字段含义不同，故只在 dt 口径映射
    downDays: kind === 'dt' ? (num(row.days) || 1) : null,
    firstSeal: fmtSealTime(row.fbt),
    lastSeal: fmtSealTime(row.lbt),
    sealFund: fund,                     // 封单额（元）
    sealFundRatio: (fund && ltsz) ? +(fund / ltsz * 100).toFixed(2) : null, // 封单/流通市值 %
    // 涨停/炸板池开板次数用 zbc；跌停池开板（撬板）次数在 oc 字段
    brokenCount: kind === 'dt' ? (num(row.oc) || 0) : (num(row.zbc) || 0),
    volRatio: num(row.lb),
    speed: num(row.zs),
    industry: row.hybk || '',
    statDays: row.zttj ? num(row.zttj.days) : null,
    statCount: row.zttj ? num(row.zttj.ct) : null,
    board: boardOf(code),
    isST: /ST/i.test(String(row.n || '')),
    kind,
    source: SOURCE_META.emPool.label
  };
}

async function fetchEMPool(kind, date) {
  const cfg = EM_POOLS[kind];
  if (!cfg) return [];
  const url = 'https://push2ex.eastmoney.com/' + cfg.path + '?ut=' + EM_UT +
    '&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=' + cfg.sort + '&date=' + date + '&_=' + Date.now();
  try {
    const txt = await timed('emPool', url, { referer: SOURCE_META.emPool.url });
    const j = JSON.parse(txt);
    const pool = j && j.data && Array.isArray(j.data.pool) ? j.data.pool : [];
    // 东财上游偶发返回完全重复的同一只票（同一 code 多条相同记录），按 code 去重，避免历史天梯 / 候选池重复显示
    const rows = pool.map(r => normalizeEMPool(r, kind));
    const seen = new Set();
    const uniq = rows.filter(x => { if (seen.has(x.code)) return false; seen.add(x.code); return true; });
    const dropped = rows.length - uniq.length;
    if (dropped > 0) mark('emPool', true, { dedup: dropped, kind, date });
    return { rows: uniq, total: uniq.length, qdate: j.data.qdate || date };
  } catch (e) { return { rows: [], total: 0, qdate: date, error: e.message }; }
}

/** 自动回溯最近一个有数据的交易日（周末 / 节假日 / 盘前） */
async function resolveTradeDate() {
  return cached('tradedate', 300000, async () => {
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const date = ymd(new Date(d.getTime() - i * 86400000));
      const r = await fetchEMPool('zt', date);
      if (r.rows && r.rows.length) return { date, qdate: r.qdate, checked: i + 1 };
    }
    return { date: ymd(d), qdate: ymd(d), checked: 12 };
  });
}

async function getPools() {
  const td = await resolveTradeDate();
  const date = td.date;
  return cached('pools:' + date, 20000, async () => {
    const kinds = Object.keys(EM_POOLS);
    const results = await Promise.all(kinds.map(k => fetchEMPool(k, date)));
    const out = { date, qdate: results[0].qdate || date, asOf: new Date().toISOString(), source: SOURCE_META.emPool.label };
    kinds.forEach((k, i) => { out[k] = results[i].rows; out[k + 'Total'] = results[i].total; });
    mark('emPool', true, { rows: out.zt.length });
    return out;
    // 上游偶发返回空名单时不要锁住整个 TTL，否则页面会连续 20 秒误判「无涨停」
  }, v => v && Array.isArray(v.zt) && v.zt.length > 0);
}

/* ─────────── 近 N 个交易日涨停池回溯（涨停回调候选池） ─────────── */
/**
 * 用途：为「涨停回调到支撑位」模块收敛候选代码，避免对全市场 5,000+ 只逐个拉日K。
 * 口径与边界：
 *  - 逐一请求东方财富涨停池历史日期（date=YYYYMMDD），只采信返回非空池的交易日；
 *  - 上游返回的 qdate 常为最新交易日而非请求日，故交易日以请求 date 为准并在 UI 标注；
 *  - 本结果只作「候选代码来源」，最终涨停日必须由腾讯前复权日K的当日涨幅交叉验证（分析层处理），
 *    不把历史池字段直接当作行情结论；
 *  - 缓存 10 分钟，避免每次页面刷新都重复回溯。
 */
async function getRecentLimitUpPools(tradingDays = 8) {
  const days = Math.max(3, Math.min(15, Number(tradingDays) || 8));
  return cached('ztHistory:' + days, 600000, async () => {
    const now = new Date();
    const probeDates = [];
    for (let i = 0; i < 30 && probeDates.length < days + 8; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probeDates.push(ymd(d));
    }
    const probes = [];
    for (let i = 0; i < probeDates.length; i += 5) {
      const batch = probeDates.slice(i, i + 5);
      const rs = await Promise.all(batch.map(date =>
        fetchEMPool('zt', date).then(r => ({ date, rows: r.rows || [] })).catch(() => ({ date, rows: [] }))
      ));
      probes.push(...rs);
      if (probes.filter(p => p.rows.length).length >= days) break;
    }
    const valid = probes.filter(p => p.rows.length).slice(0, days);
    const byCode = {};
    const dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, count: p.rows.length });
      for (const r of p.rows) {
        const prev = byCode[r.code];
        if (!prev || p.date > prev.date) {
          byCode[r.code] = {
            code: r.code, name: r.name, industry: r.industry,
            date: p.date, boards: r.boards, floatCap: r.floatCap,
            poolPrice: r.price, source: SOURCE_META.emPool.label
          };
        }
      }
    }
    mark('emPool', true, { rows: Object.keys(byCode).length });
    return {
      dates, byCode, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label,
      note: '历史涨停池仅用于收敛候选代码；上游 qdate 常返回最新交易日，交易日以请求 date 为准；最终涨停日由腾讯前复权日K涨幅交叉验证。'
    };
  });
}

/* ─────────── 回测用：近 N 个交易日涨停池完整明细 ─────────── */
/**
 * 与 getRecentLimitUpPools 的区别：按交易日保留完整名单（不做 byCode 去重），
 * 供历史回测按「基准日之前的涨停日」重建当日候选，避免同一只股票多次涨停只留最近一次。
 * 交易日以请求 date 为准（上游 qdate 常返回最新交易日），缓存 10 分钟。
 */
async function getLimitUpHistory(tradingDays = 22) {
  const days = Math.max(8, Math.min(30, Number(tradingDays) || 22));
  return cached('ztHistoryFull:' + days, 600000, async () => {
    const now = new Date();
    const probeDates = [];
    for (let i = 0; i < 70 && probeDates.length < days + 12; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probeDates.push(ymd(d));
    }
    const probes = [];
    for (let i = 0; i < probeDates.length; i += 5) {
      const batch = probeDates.slice(i, i + 5);
      const rs = await Promise.all(batch.map(date =>
        fetchEMPool('zt', date).then(r => ({ date, rows: r.rows || [] })).catch(() => ({ date, rows: [] }))
      ));
      probes.push(...rs);
      if (probes.filter(p => p.rows.length).length >= days) break;
    }
    const valid = probes.filter(p => p.rows.length).slice(0, days);
    const byDate = {}, dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, count: p.rows.length });
      byDate[p.date] = p.rows.map(r => ({
        code: r.code, name: r.name, industry: r.industry,
        amount: r.amount, floatCap: r.floatCap, boards: r.boards
      }));
    }
    return {
      dates, byDate, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label,
      note: '按交易日保留完整涨停名单（未按代码去重）；仅作候选来源，最终涨停日与价位一律以真实日K为准。'
    };
  }, v => v && Array.isArray(v.dates) && v.dates.length > 0);
}

/* ─────────── 龙头博弈用：近 N 个交易日涨停/炸板池完整明细 ─────────── */
/**
 * 与 getLimitUpHistory（回测用精简名单）的区别：保留封板时间、炸板次数、封单比、
 * 换手、成交额、行业、连板数等完整字段，供连板梯队演变 / 题材扩散 / 一致分歧量化使用。
 * 交易日以请求 date 为准（上游 qdate 常返回最新交易日），缓存 10 分钟，空结果不缓存。
 */
async function getPoolFullHistory(tradingDays = 7, withDt = false) {
  const days = Math.max(3, Math.min(15, Number(tradingDays) || 7));
  return cached('poolFullHistory:' + days + (withDt ? ':dt' : ''), 600000, async () => {
    const now = new Date();
    const probeDates = [];
    for (let i = 0; i < 60 && probeDates.length < days + 12; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probeDates.push(ymd(d));
    }
    const probes = [];
    for (let i = 0; i < probeDates.length; i += 5) {
      const batch = probeDates.slice(i, i + 5);
        const rs = await Promise.all(batch.map(async date => {
          const jobs = [fetchEMPool('zt', date), fetchEMPool('zb', date)];
          if (withDt) jobs.push(fetchEMPool('dt', date));
          const done = await Promise.all(jobs);
          return { date, zt: done[0].rows || [], zb: done[1].rows || [], dt: withDt ? (done[2].rows || []) : [], qdate: done[0].qdate || date };
        }));
      probes.push(...rs);
      if (probes.filter(p => p.zt.length).length >= days) break;
    }
    const valid = probes.filter(p => p.zt.length).slice(0, days);
    const byDate = {}, dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, zt: p.zt.length, zb: p.zb.length, ...(withDt ? { dt: p.dt.length } : {}) });
      byDate[p.date] = { zt: p.zt, zb: p.zb, ...(withDt ? { dt: p.dt } : {}) };
    }
    mark('emPool', true, { rows: dates.reduce((n, d) => n + d.zt, 0) });
    return {
      dates, byDate, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label, withDt,
      note: '按交易日保留涨停/炸板' + (withDt ? '/跌停' : '') + '池完整字段；交易日以请求 date 为准，上游 qdate 常返回最新交易日。封板时间为首次触板时间，非收盘封板状态。'
    };
  }, v => v && Array.isArray(v.dates) && v.dates.length > 0);
}

/* ─────────── 长周期涨停池历史：东财近 15 日 + 同花顺历史回补 ─────────── */
/**
 * 东方财富 getTopicZTPool 实测只保留最近约 15 个交易日，更早日期一律返回空池。
 * 为给「历史优势组合」等统计提供足够长的回溯窗口，更早的交易日由同花顺涨停池回补，
 * 并归一化成东财池字段结构（连板数按连续涨停序列重算，不采用「N天M板」的累计口径）。
 * 口径差异如实写入 note：早期日期无炸板池明细、题材分组用涨停原因首标签代替行业。
 */
const THS_POOL_FIELDS = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004';
const THS_POOL_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool';
const THS_HISTORY_MAX = 105;   // 最多回溯的有效交易日，覆盖 90 日窗口 + 连板 warm-up

/** 同花顺首封/末封是北京时间盘中的 Unix 秒，按 UTC+8 还原成 HH:MM:SS */
function thsSealTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000 + 8 * 3600000).toISOString().slice(11, 19);
}
/** high_days_value = 累计板数 << 16 | 统计天数，例如 131075 = 3天2板 */
function thsHighDays(row) {
  const v = Number(row.high_days_value);
  if (Number.isFinite(v) && v > 0) return { statDays: v & 0xffff, statCount: v >> 16 };
  const s = String(row.high_days || '');
  if (/首板/.test(s)) return { statDays: 1, statCount: 1 };
  const m = s.match(/(\d+)天(\d+)板/);
  return m ? { statDays: Number(m[1]), statCount: Number(m[2]) } : { statDays: 1, statCount: 1 };
}
function normalizeThsPool(row) {
  const code = String(row.code || '').padStart(6, '0');
  const cap = Number(row.currency_value) || 0;                 // 流通市值（元）
  const turnover = Number(row.turnover_rate);
  const sealFund = Number(row.order_amount);                   // 封单额（元）
  const hd = thsHighDays(row);
  const reason = String(row.reason_type || '').trim();
  return {
    code, name: String(row.name || '').replace(/\s+/g, ''),
    price: Number(row.latest) || null, pct: Number(row.change_rate) || 0,
    amount: cap > 0 && Number.isFinite(turnover) ? cap * turnover / 100 : null,
    floatCap: cap > 0 ? +(cap / 1e8).toFixed(2) : null,
    totalCap: cap > 0 ? +(cap / 1e8).toFixed(2) : null,
    turnover: Number.isFinite(turnover) ? turnover : null,
    boards: 1,                                                // 调用方按连续涨停序列重算
    statDays: hd.statDays, statCount: hd.statCount,
    firstSeal: thsSealTime(row.first_limit_up_time), lastSeal: thsSealTime(row.last_limit_up_time),
    sealFund: Number.isFinite(sealFund) ? sealFund : null,
    sealFundRatio: cap > 0 && Number.isFinite(sealFund) ? +(sealFund / cap * 100).toFixed(2) : null,
    brokenCount: Number(row.open_num) || 0,
    industry: reason ? reason.split(/[+＋、,，]/)[0].trim().slice(0, 20) : '未分类',
    board: boardOf(code), isST: /ST/i.test(String(row.name || '')),
    kind: 'zt', source: SOURCE_META.thsPool.label
  };
}
async function fetchThsPoolDay(date) {
  const url = THS_POOL_URL + '?page=1&limit=200&field=' + THS_POOL_FIELDS +
    '&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + date + '&_=' + Date.now();
  const txt = await timed('thsPool', url, { referer: SOURCE_META.thsPool.url, timeout: 12000 });
  const j = JSON.parse(txt);
  const info = j && j.data && Array.isArray(j.data.info) ? j.data.info : [];
  return info.map(normalizeThsPool).filter(x => /^\d{6}$/.test(x.code));
}
/** 一次性拉取并缓存足够长的同花顺历史（历史日期数据不变，缓存 30 分钟），各窗口共用 */
async function getThsPoolDays() {
  return cached('thsPoolDays:all', 1800000, async () => {
    const probe = [];
    for (let i = 0; i < 260 && probe.length < THS_HISTORY_MAX * 1.6 + 20; i++) {
      const d = new Date(Date.now() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probe.push(ymd(d));
    }
    const out = [];
    for (let i = 0; i < probe.length && out.length < THS_HISTORY_MAX; i += 6) {
      const batch = probe.slice(i, i + 6);
      const rs = await Promise.all(batch.map(async date => {
        try { return { date, rows: await fetchThsPoolDay(date) }; }
        catch (e) { return { date, rows: [] }; }
      }));
      rs.forEach(r => { if (r.rows.length) out.push(r); });
    }
    return out.slice(0, THS_HISTORY_MAX);
  }, v => Array.isArray(v) && v.length > 0);
}
async function getLongPoolHistory(tradingDays = 60) {
  const days = Math.max(5, Math.min(90, Number(tradingDays) || 60));
  return cached('poolLongHistory:' + days, 1800000, async () => {
    const em = await getPoolFullHistory(15).catch(() => ({ dates: [], byDate: {} }));
    const emDates = (em.dates || []).map(d => String(d.date));
    const emSet = new Set(emDates);
    // 窗口不超过东财覆盖范围时，直接用东财精确口径
    if (days <= emDates.length) {
      const dates = (em.dates || []).slice(0, days).map(d => ({
        date: String(d.date), zt: d.zt || 0, zb: d.zb || 0, dt: 0
      }));
      const byDate = {};
      dates.forEach(d => { byDate[d.date] = em.byDate[d.date] || { zt: [], zb: [], dt: [] }; });
      return {
        dates, byDate, asOf: new Date().toISOString(), source: SOURCE_META.emPool.label,
        sources: { emDays: dates.length, thsDays: 0 },
        note: '窗口内全部交易日来自东方财富涨停/炸板池，字段为原始口径。'
      };
    }
    const thsAll = await getThsPoolDays().catch(() => []);
    const ths = thsAll.slice(0, Math.min(thsAll.length, days + 12)); // 尾部额外天数仅用于连板 warm-up
    // 按时间正序重算连续涨停天数；未继续涨停的票连板归零
    const streak = new Map();
    const thsByDate = {};
    ths.slice().reverse().forEach(day => {
      const seen = new Set();
      thsByDate[day.date] = day.rows.map(r => {
        const n = (streak.get(r.code) || 0) + 1;
        streak.set(r.code, n); seen.add(r.code);
        return { ...r, boards: n };
      });
      [...streak.keys()].forEach(c => { if (!seen.has(c)) streak.delete(c); });
    });
    const allDates = [...new Set([...emDates, ...ths.map(x => x.date)])]
      .sort((a, b) => b.localeCompare(a)).slice(0, days);
    const dates = [], byDate = {};
    let emDays = 0, thsDays = 0;
    allDates.forEach(date => {
      if (emSet.has(date) && em.byDate[date]) {
        const day = em.byDate[date];
        dates.push({ date, zt: (day.zt || []).length, zb: (day.zb || []).length, dt: 0 });
        byDate[date] = { zt: day.zt || [], zb: day.zb || [], dt: [] };
        emDays++;
      } else {
        const rows = thsByDate[date] || [];
        dates.push({ date, zt: rows.length, zb: 0, dt: 0 });
        byDate[date] = { zt: rows, zb: [], dt: [] };
        thsDays++;
      }
    });
    mark('thsPool', true, { rows: thsDays });
    return {
      dates, byDate, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label + '（近 ' + emDays + ' 日）+ ' + SOURCE_META.thsPool.label + '（更早 ' + thsDays + ' 日）',
      sources: { emDays, thsDays, thsFrom: dates.length ? dates[dates.length - 1].date : null },
      note: '东方财富涨停池只保留最近约 15 个交易日，更早交易日由同花顺涨停池回补并归一化字段；' +
        '连板数按连续涨停序列重算（非「N天M板」累计口径），成交额按流通市值×换手率估算；' +
        '回补日期无炸板池明细，题材分组用涨停原因首标签代替行业。'
    };
  }, v => v && Array.isArray(v.dates) && v.dates.length > 0);
}

/* ─────────── 消息面：交易所公告 + 7×24 快讯 / 财经资讯 ─────────── */
/**
 * 三类来源，均为免费公开 HTTP 接口，非交易所官方推送：
 *   东方财富公告  np-anotice-stock.eastmoney.com  公告标题 / art_code / codes（精确关联个股）/ 披露时间
 *   新浪 7×24    zhibo.sina.com.cn              快讯正文 / ext.stocks（精确关联个股）/ 原文链接
 *   东财快讯     np-listapi.eastmoney.com       政策 / 宏观 / 行业资讯（无个股字段，按名称字面匹配）
 * 时间戳统一按北京时间解析为 ISO；所有条目保留 source / media / url 可追溯。
 */
const ANN_BASE = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const SINA_FLASH_BASE = 'https://zhibo.sina.com.cn/api/zhibo/feed';
const EM_FLASH_BASE = 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns';

/** 上游时间多为北京时间字符串；东财 display_time 的毫秒用冒号分隔（19:10:16:320） */
function toBJTime(s) {
  if (!s) return null;
  const t = String(s).trim().replace(' ', 'T').replace(/:(\d{3})$/, '.$1');
  const d = new Date(/([+-]\d{2}:?\d{2}|Z)$/.test(t) ? t : t + '+08:00');
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function cleanCodes(codes) {
  return [...new Set((codes || []).map(c => String(c || '').replace(/\D/g, ''))
    .filter(c => /^\d{6}$/.test(c)))].slice(0, 80);
}

async function fetchAnnBatch(codes, pageSize) {
  const qs = new URLSearchParams({
    sr: '-1', page_size: String(pageSize), page_index: '1',
    ann_type: 'A', client_source: 'web'
  });
  if (codes && codes.length) qs.set('stock_list', codes.join(','));
  const txt = await timed('emAnn', ANN_BASE + '?' + qs.toString(), { referer: SOURCE_META.emAnn.url });
  const j = JSON.parse(txt);
  const rows = (j && j.data && j.data.list) || [];
  mark('emAnn', true, { rows: rows.length });
  return rows.map(r => {
    const cs = (r.codes || []).map(c => ({
      code: String(c.stock_code || '').padStart(6, '0'), name: c.short_name || ''
    })).filter(c => /^\d{6}$/.test(c.code));
    const art = String(r.art_code || '');
    return {
      id: 'ann:' + art,
      kind: 'announcement', kindLabel: '交易所公告',
      title: String(r.title_ch || r.title || ''),
      text: '',
      time: toBJTime(r.display_time) || toBJTime(r.notice_date),
      timeText: String(r.display_time || r.notice_date || '').slice(0, 19),
      noticeDate: String(r.notice_date || '').slice(0, 10),
      columns: (r.columns || []).map(c => c.column_name).filter(Boolean),
      codes: cs,
      url: art ? 'https://data.eastmoney.com/notices/detail/' + (cs[0] ? cs[0].code : '') + '/' + art + '.html' : '',
      pdfUrl: art ? 'https://pdf.dfcfw.com/pdf/H2_' + art + '_1.pdf' : '',
      source: SOURCE_META.emAnn.label, sourceKey: 'emAnn',
      media: '上市公司公告（东方财富转载）'
    };
  }).filter(x => x.id !== 'ann:' && x.title);
}

/** 按候选代码批量拉最新公告；codes 为空时拉全市场最新公告 */
async function getAnnouncements(codes = [], limit = 60) {
  const clean = cleanCodes(codes);
  const n = Math.max(10, Math.min(120, Number(limit) || 60));
  return cached('ann:' + clean.join(',') + ':' + n, 45000, async () => {
    const batches = clean.length ? [] : [[]];
    for (let i = 0; i < clean.length; i += 30) batches.push(clean.slice(i, i + 30));
    const rs = await Promise.all(batches.map(async b => {
      try { return await fetchAnnBatch(b, Math.min(100, Math.max(20, n))); }
      catch (e) { return []; }
    }));
    const items = rs.flat().filter(Boolean).sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return {
      items: items.slice(0, n), codes: clean, asOf: new Date().toISOString(),
      source: SOURCE_META.emAnn.label, batches: batches.length
    };
  }, v => v && Array.isArray(v.items) && v.items.length > 0);
}

async function fetchSinaFlash(limit) {
  const u = SINA_FLASH_BASE + '?page=1&page_size=' + limit +
    '&zhibo_id=152&tag_id=0&dire=f&dpc=1&type=0&_=' + Date.now();
  const txt = await timed('sinaFlash', u, { referer: SOURCE_META.sinaFlash.url });
  const j = JSON.parse(txt);
  const list = (j && j.result && j.result.data && j.result.data.feed && j.result.data.feed.list) || [];
  mark('sinaFlash', true, { rows: list.length });
  return list.map(x => {
    let ext = {};
    try { ext = JSON.parse(x.ext || '{}'); } catch (_) { /* 无扩展字段时按纯文本处理 */ }
    const stocks = (ext.stocks || []).filter(s => s && s.market === 'cn').map(s => {
      const m = String(s.symbol || '').match(/(\d{6})$/);
      return m ? { code: m[1], name: String(s.key || '') } : null;
    }).filter(Boolean);
    const rich = String(x.rich_text || '');
    const head = rich.match(/^【([^】]+)】/);
    return {
      id: 'flash:' + x.id,
      kind: 'flash', kindLabel: '7×24 快讯',
      title: head ? head[1] : rich.slice(0, 42),
      text: rich,
      time: toBJTime(x.create_time),
      timeText: String(x.create_time || '').slice(0, 19),
      codes: stocks,
      tags: (x.tag || []).map(t => t.name).filter(Boolean),
      url: String(ext.docurl || x.docurl || 'https://finance.sina.com.cn/7x24/'),
      source: SOURCE_META.sinaFlash.label, sourceKey: 'sinaFlash', media: '新浪财经 7×24'
    };
  }).filter(x => x.title);
}

async function fetchEmFlash(limit) {
  const qs = new URLSearchParams({
    client: 'web', biz: 'web_news_col', column: '350', order: '1',
    needjump: 'false', pageindex: '1', pagesize: String(limit), req_trace: String(Date.now())
  });
  const txt = await timed('emFlash', EM_FLASH_BASE + '?' + qs.toString(), { referer: SOURCE_META.emFlash.url });
  const j = JSON.parse(txt);
  if (j && j.code === '0') throw new Error(j.message || '上游返回空');
  const list = (j && j.data && j.data.list) || [];
  mark('emFlash', true, { rows: list.length });
  return list.map(x => ({
    id: 'news:' + String(x.code || x.uniqueUrl || ''),
    kind: 'news', kindLabel: '财经资讯',
    title: String(x.title || ''),
    text: String(x.summary || ''),
    time: toBJTime(x.showTime),
    timeText: String(x.showTime || '').slice(0, 19),
    codes: [],
    url: String(x.uniqueUrl || x.url || '').replace(/^http:\/\//, 'https://'),
    source: SOURCE_META.emFlash.label, sourceKey: 'emFlash',
    media: String(x.mediaName || '东方财富')
  })).filter(x => x.id !== 'news:' && x.title);
}

/** 合并两类快讯；任一源失败时另一源照常返回，不编造数据 */
async function getFlashNews(limit = 40) {
  const n = Math.max(10, Math.min(80, Number(limit) || 40));
  return cached('flash:' + n, 30000, async () => {
    const [sina, em] = await Promise.all([
      fetchSinaFlash(Math.min(60, n)).catch(() => []),
      fetchEmFlash(Math.min(30, Math.max(10, Math.round(n / 2)))).catch(() => [])
    ]);
    const items = [...sina, ...em].filter(Boolean)
      .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return {
      items, asOf: new Date().toISOString(),
      sinaCount: sina.length, emCount: em.length,
      source: SOURCE_META.sinaFlash.label + ' + ' + SOURCE_META.emFlash.label
    };
  }, v => v && Array.isArray(v.items) && v.items.length > 0);
}

/** 主要指数实时快照 */
const INDEX_CODES = [
  { code: '000001', sym: 'sh000001', name: '上证指数' },
  { code: '399001', sym: 'sz399001', name: '深证成指' },
  { code: '399006', sym: 'sz399006', name: '创业板指' },
  { code: '000688', sym: 'sh000688', name: '科创50' },
  { code: '000300', sym: 'sh000300', name: '沪深300' },
  { code: '000905', sym: 'sh000905', name: '中证500' }
];

async function getIndices() {
  return cached('indices', 12000, async () => {
    const syms = INDEX_CODES.map(x => x.sym);
    const txt = await timed('qq', 'https://qt.gtimg.cn/q=' + syms.join(',') + '&_=' + Date.now(),
      { referer: SOURCE_META.qq.url, gbk: true });
    const map = parseQQQuotes(txt);
    return INDEX_CODES.map(x => {
      const q = map[x.code];
      return q ? { ...q, name: x.name } : null;
    }).filter(Boolean);
  });
}

/**
 * 全球主流行情：港股（恒生/恒生科技/国企）、美股（道指/纳指/标普500）、国际商品（黄金/原油/布油）。
 * 腾讯 qt.gtimg.cn 免费公开接口；指数为 `v_代码="名称~...~现价~...~涨跌~涨跌幅~..."`（~ 分隔），
 * 外盘商品为 `v_代码="现价,涨跌幅,...,昨收,...,日期,名称"`（逗号分隔）。两者字段结构不同，分开解析。
 * 非交易时段返回最近一笔成交，如实带出上游 tick 时间，不臆造实时性。
 */
const GLOBAL_MARKETS = [
  { key: 'hkHSI', label: '恒生指数', group: '港股' },
  { key: 'hkHSTECH', label: '恒生科技', group: '港股' },
  { key: 'hkHSCEI', label: '国企指数', group: '港股' },
  { key: 'usDJI', label: '道琼斯', group: '美股' },
  { key: 'usIXIC', label: '纳斯达克', group: '美股' },
  { key: 'usINX', label: '标普500', group: '美股' },
  // 日韩指数腾讯行情无对应代码，改走新浪全球指数接口（znb_ 前缀）
  { key: 'znb_NKY', label: '日经225', group: '日韩', sina: true },
  { key: 'znb_KOSPI', label: '韩国综合', group: '日韩', sina: true },
  { key: 'hf_GC', label: '纽约黄金', group: '商品' },
  { key: 'hf_CL', label: '纽约原油', group: '商品' },
  { key: 'hf_OIL', label: '布伦特原油', group: '商品' }
];

function parseGlobalQuotes(text) {
  const out = {};
  const lines = String(text || '').split(';');
  for (const line of lines) {
    const m = line.match(/v_([A-Za-z0-9_]+)\s*=\s*"([\s\S]*?)"/);
    if (!m) continue;
    const key = m[1], raw = m[2];
    if (raw.indexOf('~') >= 0) {
      // 指数：与 A 股快照同构（名称~代码~现价~昨收~今开~...~涨跌~涨跌幅~...~时间）
      const p = raw.split('~');
      if (p.length < 33) continue;
      const price = num(p[3]), prevClose = num(p[4]);
      out[key] = {
        price,
        prevClose,
        change: num(p[31]),
        pct: num(p[32]),
        ticktime: p[30] || null
      };
    } else {
      // 外盘商品：现价,涨跌幅,买,卖,高,低,时间,昨收,开盘,...,日期,名称
      const p = raw.split(',');
      if (p.length < 9) continue;
      const price = num(p[0]), prevClose = num(p[7]);
      const change = (price !== null && prevClose !== null) ? +(price - prevClose).toFixed(4) : null;
      out[key] = {
        price,
        prevClose,
        change,
        pct: num(p[1]),
        ticktime: (p[12] ? p[12] + ' ' : '') + (p[6] || '')
      };
    }
  }
  return out;
}

/** 新浪全球指数：`hq_str_znb_NKY="名称,现价,涨跌额,涨跌幅,美东时间,时间戳,日期,本地时间,开盘,昨收,最高,最低,0"` */
function parseSinaGlobalQuotes(text) {
  const out = {};
  for (const line of String(text || '').split(';')) {
    const m = line.match(/hq_str_([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (!m) continue;
    const p = m[2].split(',');
    if (p.length < 8) continue;
    const price = num(p[1]);
    if (price === null) continue;
    out[m[1]] = {
      price,
      prevClose: num(p[9]),
      change: num(p[2]),
      pct: num(p[3]),
      ticktime: (p[6] ? p[6] + ' ' : '') + (p[7] || p[4] || '')
    };
  }
  return out;
}

async function getGlobalMarkets() {
  return cached('globalMarkets', 15000, async () => {
    const qqSyms = GLOBAL_MARKETS.filter(x => !x.sina).map(x => x.key);
    const sinaSyms = GLOBAL_MARKETS.filter(x => x.sina).map(x => x.key);
    const [qqMap, sinaMap] = await Promise.all([
      timed('qq', 'https://qt.gtimg.cn/q=' + qqSyms.join(',') + '&_=' + Date.now(),
        { referer: SOURCE_META.qq.url, gbk: true }).then(parseGlobalQuotes),
      sinaSyms.length
        ? timed('sina', 'https://hq.sinajs.cn/list=' + sinaSyms.join(','),
          { referer: SOURCE_META.sina.url, gbk: true }).then(parseSinaGlobalQuotes).catch(() => ({}))
        : Promise.resolve({})
    ]);
    const map = Object.assign({}, qqMap, sinaMap);
    const rows = GLOBAL_MARKETS.map(x => {
      const q = map[x.key];
      return q && q.price !== null ? { key: x.key, name: x.label, group: x.group, ...q } : null;
    }).filter(Boolean);
    return {
      rows,
      source: '腾讯证券 / 新浪财经',
      asOf: new Date().toISOString(),
      note: '港股/美股/国际商品来自腾讯证券，日经225/韩国综合来自新浪财经全球指数；非交易时段显示最近一笔成交，可能与 A 股交易日不同步；仅供参考，不构成投资建议。'
    };
  }, v => v && Array.isArray(v.rows) && v.rows.length >= 6);
}

/* 东方财富股吧人气榜：榜单本身只返回前 100 名，未上榜个股改用单股接口查当前排名。
 * 返回 { 6位代码: { rank, change, calcTime } }，rank 越小越热门；上游异常时返回空对象，调用方静默降级。 */
const EM_POP_APP = { appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38', marketType: '' };
function emPopSymbol(code) {
  const c = String(code || '').replace(/\D/g, '').slice(0, 6).padStart(6, '0');
  if (!/^\d{6}$/.test(c)) return '';
  return /^(60|68|9)/.test(c) ? 'SH' + c : (/^(4|8)/.test(c) ? 'BJ' + c : 'SZ' + c);
}

async function getEastmoneyPopularity(codes) {
  const list = [...new Set((codes || []).map(x => String(x || '').replace(/\D/g, '').slice(0, 6))
    .filter(c => /^\d{6}$/.test(c)))].slice(0, 100);
  if (!list.length) return {};
  const t0 = Date.now();
  const top = await cached('emPopTop', 60000, async () => {
    try {
      const txt = await rawPost('https://emappdata.eastmoney.com/stockrank/getAllCurrentList',
        Object.assign({}, EM_POP_APP, { pageNo: 1, pageSize: 100 }));
      const j = JSON.parse(txt);
      const out = {};
      (j.data || []).forEach(x => {
        const c = String(x.sc || '').replace(/\D/g, ''), rk = Number(x.rk);
        if (c && Number.isFinite(rk) && rk > 0) out[c] = { rank: rk, change: Number(x.hisRc) || 0, calcTime: null };
      });
      mark('emPop', true, { latency: Date.now() - t0, rows: Object.keys(out).length });
      return out;
    } catch (e) { mark('emPop', false, e.message); return {}; }
  }).catch(() => ({}));
  const out = {};
  list.forEach(c => { if (top[c]) out[c] = top[c]; });
  const missing = list.filter(c => !out[c]);
  if (missing.length) {
    const rows = await mapLimit(missing, 6, c => cached('emPop:' + c, 120000, async () => {
      const sym = emPopSymbol(c); if (!sym) return null;
      try {
        const txt = await rawPost('https://emappdata.eastmoney.com/stockrank/getCurrentList',
          Object.assign({}, EM_POP_APP, { srcSecurityCode: sym }));
        const j = JSON.parse(txt), arr = j.data || [], last = arr[arr.length - 1];
        const rk = last && Number(last.rank);
        return rk > 0 ? { rank: rk, change: null, calcTime: last.calcTime || null } : null;
      } catch (e) { return null; }
    }).catch(() => null));
    rows.forEach((r, i) => { if (r) out[missing[i]] = r; });
  }
  if (!Object.keys(top).length && Object.keys(out).length) {
    mark('emPop', true, { latency: Date.now() - t0, rows: Object.keys(out).length });
  }
  return out;
}

function getHealth() {
  // standby 源（新浪日K）只在主源失败时启用，不参与「在线数」统计，避免误报故障
  return Object.values(health).map(h => ({ ...h, standby: !!SOURCE_META[h.key].standby }));
}

/**
 * 腾讯证券分时：每分钟价格 / 成交量(手) / 成交额(元)。
 * 只返回上游真实分钟数据；非交易时段返回最近一个交易日的完整分时，并如实标注日期。
 * 缓存 60 秒，避免弹窗反复拖动时打爆上游。
 */
async function getMinute(code) {
  const sym = qqSymbol(code);
  if (!sym) return { rows: [], source: null, date: null, reason: '代码无法解析为行情符号' };
  // 分时是分钟级数据：交易时段 12 秒缓存（配合前端 12 秒轮询，尽快捕捉新的一分钟），
  // 非交易时段 5 分钟（行情不再变动，避免无意义请求）。
  const hm = (() => { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.getUTCDay() === 0 || d.getUTCDay() === 6 ? -1 : d.getUTCHours() * 100 + d.getUTCMinutes(); })();
  const trading = hm >= 915 && hm <= 1130 || hm >= 1300 && hm <= 1500;
  return cached('minute:' + sym, trading ? 12000 : 300000, async () => {
    try {
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + sym;
      const txt = await timed('qqMinute', url, { referer: SOURCE_META.qqMinute.url });
      const j = JSON.parse(txt);
      const node = j && j.data && j.data[sym];
      const md = node && node.data;
      const arr = (md && md.data) || [];
      const rows = arr.map(s => {
        const p = String(s).trim().split(/\s+/);
        return p.length >= 3 ? {
          time: String(p[0]).replace(/(\d{2})(\d{2})/, '$1:$2'),
          price: num(p[1]), volume: num(p[2]),
          amount: p.length >= 4 ? num(p[3]) : null
        } : null;
      }).filter(x => x && Number.isFinite(x.price) && x.price > 0);
      return {
        rows,
        source: rows.length ? SOURCE_META.qqMinute.label : null,
        date: (md && md.date) || (node && node.date) || null,
        asOf: new Date().toISOString(),
        reason: rows.length ? null : '腾讯分时接口未返回数据（可能非交易时段或上游临时不可用）'
      };
    } catch (e) {
      return { rows: [], source: null, date: null, asOf: new Date().toISOString(), reason: '腾讯分时接口请求失败：' + (e && e.message || e) };
    }
  });
}

/**
 * 历史分时（混合源）：
 *  - 腾讯 day/query：最近 5 个交易日，每分钟精度（最优）；
 *  - 东财 push2his klt=5：约最近 31 个交易日，5 分钟精度（腾讯范围之外回退）。
 * 优先腾讯 1 分钟；超出其范围再取东财 5 分钟。字段名统一 {time,price,volume,amount}，
 * 并用 granularity(分钟) / intervalLabel 标注精度；超出所有可回溯范围时明确 reason，绝不编造数据。
 */
async function getMinuteHistory(code, date) {
  const sym = qqSymbol(code);
  const d = String(date || '').replace(/\D/g, '');
  if (!sym) return { rows: [], date: d, source: null, reason: '代码无法解析为行情符号' };
  if (!/^\d{8}$/.test(d)) return { rows: [], date: d, source: null, reason: '缺少有效的交易日 YYYYMMDD' };
  return cached('minuteHist2:' + sym + ':' + d, 300000, async () => {
    // ── 源1：腾讯 day/query，最近 5 个交易日，1 分钟精度 ──
    try {
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/day/query?code=' + sym;
      const txt = await timed('qqMinute', url, { referer: SOURCE_META.qqMinute.url });
      const j = JSON.parse(txt);
      const node = j && j.data && j.data[sym];
      const days = (node && node.data) || [];
      const available = days.map(x => String(x.date || '').replace(/\D/g, '')).filter(Boolean);
      const hit = days.find(x => String(x.date || '').replace(/\D/g, '') === d);
      if (hit) {
        const arr = hit.data || [];
        const rows = arr.map(s => {
          const p = String(s).trim().split(/\s+/);
          return p.length >= 3 ? {
            time: String(p[0]).replace(/(\d{2})(\d{2})/, '$1:$2'),
            price: num(p[1]), volume: num(p[2]),
            amount: p.length >= 4 ? num(p[3]) : null
          } : null;
        }).filter(x => x && Number.isFinite(x.price) && x.price > 0);
        if (rows.length) {
          return {
            rows, date: d, available, granularity: 1, intervalLabel: '1分钟',
            source: SOURCE_META.qqMinute.label, asOf: new Date().toISOString(), reason: null
          };
        }
      }
    } catch (e) { /* 腾讯取数失败则继续尝试东财 */ }

    // ── 源2：东财 push2his 5 分钟线，约最近 31 个交易日 ──
    let emAvailable = [], emErr = null;
    try {
      const c = String(code || '').replace(/\D/g, '');
      const market = /^(6|9)/.test(c) ? 1 : 0;
      const secid = market + '.' + c;
      const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=' + EM_UT +
        '&secid=' + secid + '&klt=5&fqt=0&beg=20200101&end=20991231' +
        '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
      const txt = await timed('emMinute', url, { referer: SOURCE_META.emMinute.url });
      const j = JSON.parse(txt);
      const klines = (j && j.data && j.data.klines) || [];
      const byDate = {};
      klines.forEach(line => {
        const p = String(line).split(',');
        const dt = String(p[0] || '');
        if (p.length < 7 || !/^\d{4}-\d{2}-\d{2}\s/.test(dt)) return;
        const day = dt.slice(0, 10).replace(/\D/g, '');
        const close = num(p[2]), vol = num(p[5]), amt = num(p[6]);
        // 东财时间形如 "09:35"，统一成 "09:35"（与腾讯一致）
        const time = String(p[0]).slice(11, 16);
        (byDate[day] || (byDate[day] = [])).push({
          time, price: close, volume: vol, amount: amt
        });
      });
      emAvailable = Object.keys(byDate).sort().reverse();
      const rows = byDate[d] || [];
      if (rows.length) {
        return {
          rows, date: d, available: emAvailable, granularity: 5, intervalLabel: '5分钟',
          source: SOURCE_META.emMinute.label, asOf: new Date().toISOString(), reason: null
        };
      }
    } catch (e) { emErr = e && e.message || String(e); }

    // 两个源都未命中：如实说明可回溯范围（优先展示更长东财列表）
    const all = emAvailable.length ? emAvailable : [];
    return {
      rows: [], date: d, source: null,
      available: all, granularity: null,
      reason: all.length
        ? '该日不在可回溯范围：本系统可查看最近约 ' + all.length + ' 个交易日的历史分时（' + all.slice(0, 3).join(' / ') + ' … ' + all.slice(-2).join(' / ') + '）；更早数据公开接口无法取得，系统不伪造。'
        : (emErr ? '历史分时上游暂不可用：' + emErr : '该交易日分时数据不可用')
    };
  });
}

/**
 * 五日分时（东方财富式"分时·五日"）：腾讯 day/query 一次即返回最近 5 个交易日
 * 的 1 分钟线，无需逐日请求。返回按交易日正序（早→晚）的 days，每天 {date, rows}。
 * 每日昨收由调用方用日K补齐（五日图每天以各自昨收为基准画涨跌幅），本函数不臆造昨收。
 */
async function getMinuteMultiDay(code) {
  const sym = qqSymbol(code);
  if (!sym) return { days: [], source: null, reason: '代码无法解析为行情符号' };
  return cached('minuteMulti:' + sym, 120000, async () => {
    try {
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/day/query?code=' + sym;
      const txt = await timed('qqMinute', url, { referer: SOURCE_META.qqMinute.url });
      const j = JSON.parse(txt);
      const node = j && j.data && j.data[sym];
      const raw = (node && node.data) || [];
      const days = raw.map(x => {
        const date = String(x.date || '').replace(/\D/g, '');
        const rows = (x.data || []).map(s => {
          const p = String(s).trim().split(/\s+/);
          return p.length >= 3 ? {
            time: String(p[0]).replace(/(\d{2})(\d{2})/, '$1:$2'),
            price: num(p[1]), volume: num(p[2]),
            amount: p.length >= 4 ? num(p[3]) : null
          } : null;
        }).filter(r => r && Number.isFinite(r.price) && r.price > 0);
        return { date, rows };
      }).filter(d => /^\d{8}$/.test(d.date) && d.rows.length);
      days.sort((a, b) => a.date.localeCompare(b.date)); // 交易日正序：早 → 晚
      return {
        days, source: days.length ? SOURCE_META.qqMinute.label : null,
        granularity: 1, intervalLabel: '1分钟',
        asOf: new Date().toISOString(),
        reason: days.length ? null : '腾讯五日分时接口未返回数据'
      };
    } catch (e) {
      return { days: [], source: null, asOf: new Date().toISOString(), reason: '腾讯五日分时请求失败：' + (e && e.message || e) };
    }
  });
}

/**
 * 新浪财经资金流向：
 *  - 行业板块净流入排行（ssl_bkzj_bk）
 *  - 全市场主力净流入汇总（由行业板块加总，避免额外请求）
 * 口径：新浪按特大单/大单/中单/小单拆分，netamount 为净流入额（元）。
 */
async function getFundFlow() {
  return cached('fundflow', 120000, async () => {
    const out = {
      boards: [], totalNet: null, upBoards: 0, downBoards: 0, concept: [],
      source: null, asOf: new Date().toISOString(), reason: null
    };
    // 主源：腾讯板块资金流排行（zljlr=主力净流入，单位万元；zdf=涨跌幅；lzg=领涨股）
    // 新浪 MoneyFlow 接口会因 UA/时段不稳定返回 {"__ERROR":1,"Input error"}，降级为备用。
    const fromQQ = async () => {
      const url = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&limit=200';
      const txt = await timed('qqFund', url, { referer: SOURCE_META.qq.url });
      const j = JSON.parse(txt);
      const list = (j && j.data && j.data.rank_list) || [];
      if (!list.length) throw new Error('腾讯板块资金流为空');
      const map = x => ({
        code: x.code || '', name: x.name || '',
        pct: num(x.zdf), net: num(x.zljlr) === null ? null : num(x.zljlr) * 10000, // 万元 → 元
        ratio: num(x.hsl), turnover: num(x.turnover),
        leader: (x.lzg && x.lzg.name) || null,
        leaderPct: (x.lzg && num(x.lzg.zdf)) || null,
        zljlr5: num(x.zljlr_d5), zljlr20: num(x.zljlr_d20)
      });
      out.boards = list.map(map).filter(x => x.name && Number.isFinite(x.net));
      // 概念板块资金流（同一接口 board_type=gn）
      try {
        const gurl = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=gn&sort_type=price&direct=down&offset=0&limit=200';
        const gtxt = await timed('qqFund', gurl, { referer: SOURCE_META.qq.url });
        const gj = JSON.parse(gtxt);
        out.concept = (((gj && gj.data && gj.data.rank_list) || []).map(map).filter(x => x.name && Number.isFinite(x.net)));
      } catch (e) { out.concept = []; }
      out.source = '腾讯证券板块资金流';
    };
    // 备用：新浪资金流（历史口径，可能因上游 Input error 不可用）
    const fromSina = async () => {
      const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=50&sort=netamount&asc=0&bankuai=&shichang=';
      const txt = await timed('sinaFund', url, { referer: 'https://vip.stock.finance.sina.com.cn/' });
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr) || !arr.length) throw new Error('新浪资金流为空');
      out.boards = arr.map(x => ({
        code: x.category || '', name: x.name || '',
        pct: num(x.avg_changeratio) === null ? null : +(num(x.avg_changeratio) * 100).toFixed(2),
        net: num(x.netamount),
        inAmount: num(x.inamount), outAmount: num(x.outamount),
        ratio: num(x.ratioamount) === null ? null : +(num(x.ratioamount) * 100).toFixed(2),
        leader: x.ts_name || null,
        leaderPct: num(x.ts_changeratio) === null ? null : +(num(x.ts_changeratio) * 100).toFixed(2)
      })).filter(x => x.name && Number.isFinite(x.net));
      out.source = SOURCE_META.sinaFund.label;
    };
    try {
      try { await fromQQ(); } catch (e1) {
        try { await fromSina(); } catch (e2) { throw new Error('腾讯:' + e1.message + ' / 新浪:' + e2.message); }
      }
      // 统一按主力净流入降序：腾讯源按涨跌幅(sort_type=price)返回、新浪源按 netamount 返回，
      // 这里重排以保证「净流入 Top / 净流出 Top」切片口径对所有来源一致（boards 元素经 filter 已保证 net 为有限数）。
      out.boards.sort((a, b) => b.net - a.net);
      if (Array.isArray(out.concept)) out.concept.sort((a, b) => b.net - a.net);
      out.upBoards = out.boards.filter(x => x.net > 0).length;
      out.downBoards = out.boards.filter(x => x.net < 0).length;
      const nets = out.boards.map(x => x.net).filter(Number.isFinite);
      out.totalNet = nets.length ? Math.round(nets.reduce((s, v) => s + v, 0)) : null;
      if (!out.boards.length) out.reason = '资金流接口未返回板块数据';
    } catch (e) {
      out.reason = '资金流接口失败：' + (e && e.message || e);
    }
    return out;
  });
}

/**
 * 个股资金流历史日线（东方财富 push2his）：
 * f51日期 f52主力净流入 f53小单 f54中单 f55大单 f56超大单
 * f57主力净占比 f58小单占比 f59中单占比 f60大单占比 f61超大单占比 f62收盘价 f63涨跌幅
 * 返回按日期升序，供日K/周K下方画资金柱。周K由日线按周聚合（真实日线加总，非估算）。
 */
async function getFundHistory(code, limit = 160) {
  const c = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(c)) return { rows: [], source: null, reason: '无效股票代码' };
  const m = (/^(6|9)/.test(c) ? 1 : 0); // 沪市/北交所=1，深市=0
  return cached('fundhist:' + c, 300000, async () => {
    const want = Math.min(600, Math.max(30, limit));
    // 主源：东方财富 push2his（主力净额=超大单+大单，口径最标准）
    // 注意：必须使用 /api/qt/stock/fflow/kline/get（返回6列 f51~f56）；
    // 旧 /fflow/daykline/get 在本机网络下握手即被中断（curl/node 均报 server closed abruptly），
    // 长期误降级到新浪 r0_net（仅超大单），会造成「东财实际净流出、系统显示净流入」的方向错误。
    let dayClose = null; // 东财 fflow 不含收盘价，用腾讯日K按日期补，避免误用新浪净值
    try {
      const dk = await getKlineData(c, want).catch(() => null);
      if (dk && dk.rows && dk.rows.length) {
        dayClose = new Map();
        dk.rows.forEach(r => { const d = String(r.date || '').replace(/\D/g, '').slice(0, 8); if (/^\d{8}$/.test(d) && Number.isFinite(r.close)) dayClose.set(d, r.close); });
      }
    } catch (e) { /* 收盘价仅用于展示，缺失不影响资金流数值 */ }
    try {
      const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=101&secid=' + m + '.' + c +
        '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
      const txt = await timed('emFund', url, { referer: SOURCE_META.emFund.url });
      const j = JSON.parse(txt);
      const lines = (j && j.data && j.data.klines) || [];
      const rows = lines.map(s => {
        const p = String(s).split(',');
        const d = String(p[0] || '').replace(/-/g, '');
        return {
          date: p[0], main: num(p[1]), small: num(p[2]), mid: num(p[3]),
          big: num(p[4]), huge: num(p[5]), mainPct: null,
          close: dayClose && dayClose.has(d) ? dayClose.get(d) : null, pct: null
        };
      }).filter(x => x.date && Number.isFinite(x.main));
      if (rows.length) return { rows: rows.slice(-want), source: SOURCE_META.emFund.label, name: (j.data && j.data.name) || null, reason: null, caliber: '主力净额=超大单+大单（东方财富口径）' };
    } catch (e) {
      mark('emFund', false, e.message);
    }
    // 备用：新浪个股资金流日线。东财 push2his 在本机网络下间歇性不可达，降级保证日K/周K资金柱不缺失。
    // 口径：新浪 r0_net 为超大单净额，与东财「超大单+大单」不同，必须如实标注，不伪装成东财口径。
    try {
      const sym = qqSymbol(c);
      if (!sym) throw new Error('代码无法解析为行情符号');
      const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?daima=' + sym +
        '&num=' + want + '&sort=opendate&asc=0';
      const txt = await timed('sinaFundHist', url, { referer: SOURCE_META.sinaFundHist.url });
      const j = JSON.parse(txt);
      if (!Array.isArray(j) || !j.length) throw new Error('新浪资金流日线为空');
      const rows = j.map(x => ({
        date: x.opendate,
        main: num(x.r0_net),          // 新浪 r0 = 超大单净额
        huge: num(x.r0_net),
        big: null, mid: null, small: null,
        mainPct: num(x.r0_ratio) === null ? null : +(num(x.r0_ratio) * 100).toFixed(2),
        close: num(x.trade),
        pct: num(x.changeratio) === null ? null : +(num(x.changeratio) * 100).toFixed(2)
      })).filter(x => x.date && Number.isFinite(x.main)).reverse(); // 接口倒序返回，反转为日期升序
      if (!rows.length) throw new Error('新浪资金流日线无有效记录');
      return { rows: rows.slice(-want), source: SOURCE_META.sinaFundHist.label, name: null, reason: null, caliber: '主力净额=超大单净额（新浪口径，非东财超大单+大单）' };
    } catch (e) {
      return { rows: [], source: null, reason: '东财/新浪资金流日线均不可用：' + (e && e.message || e) };
    }
  });
}

/** 周K资金：由真实日线按自然周加总（避免新接口与估算） */
function weeklyFund(daily) {
  const out = [];
  let cur = null;
  (daily || []).forEach(x => {
    const d = new Date(String(x.date).replace(/-/g, '/'));
    const day = d.getDay(), diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d.getTime() + diff * 86400000);
    const key = monday.toISOString().slice(0, 10);
    if (!cur || cur.week !== key) {
      cur = { week: key, date: x.date, main: 0, small: 0, mid: 0, big: 0, huge: 0, close: x.close, pct: null, days: 0 };
      out.push(cur);
    }
    cur.main += x.main || 0; cur.small += x.small || 0; cur.mid += x.mid || 0;
    cur.big += x.big || 0; cur.huge += x.huge || 0;
    cur.days++; cur.close = x.close;
  });
  return out;
}

/**
 * 个股当日资金快照（分时图顶部展示）：
 * 主源用东财实时资金流，f62 主力净额 = f66 超大单 + f72 大单，与日K/周K资金柱完全同口径；
 * 备用新浪快照。新浪 r0/r1 是成交额口径，净额必须由 *_in - *_out 计算，不能把 r0 当主力净额。
 */
async function getStockFundNow(code) {
  const c = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(c)) return { source: null, reason: '无效代码' };
  return cached('fundnow:' + c, 30000, async () => {
    // 主源：东方财富实时资金流
    try {
      const market = /^(6|9)/.test(c) ? 1 : 0;
      const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2' +
        '&fields=f12,f14,f62,f66,f69,f72,f75,f78,f81,f84,f87,f184&secids=' + market + '.' + c;
      const txt = await timed('emFundNow', url, { referer: SOURCE_META.emFundNow.url });
      const j = JSON.parse(txt);
      const d = j && j.data && Array.isArray(j.data.diff) ? j.data.diff[0] : null;
      const main = d ? num(d.f62) : null;
      if (main === null) throw new Error('东财实时资金流为空');
      return {
        main, net: main, huge: num(d.f66), big: num(d.f72), mid: num(d.f78), small: num(d.f84),
        mainPct: num(d.f184), hugePct: num(d.f69), bigPct: num(d.f75), ratio: num(d.f184),
        caliber: '东方财富：主力净额=超大单+大单（与日K资金柱同口径）',
        source: SOURCE_META.emFundNow.label, asOf: new Date().toISOString(), reason: null
      };
    } catch (e) {
      mark('emFundNow', false, e.message);
    }
    // 备用①：东财日线资金流的当日值。fflow/kline 在本机可达且最后一根即当日实时累计，
    // 与日K/支撑位资金柱完全同口径；避免直接掉到新浪「仅超大单」造成方向相反。
    try {
      const hist = await getFundHistory(c, 10);
      const x = hist && hist.rows && hist.rows[hist.rows.length - 1];
      if (x && Number.isFinite(x.main)) {
        return {
          main: x.main, net: x.main, huge: x.huge, big: x.big, mid: x.mid, small: x.small,
          mainPct: x.mainPct, ratio: x.mainPct,
          caliber: '东方财富：主力净额=超大单+大单（日线接口当日值，与日K资金柱同口径）',
          source: SOURCE_META.emFund.label + '（当日值）', asOf: new Date().toISOString(),
          reason: null
        };
      }
    } catch (e) { /* 继续降级新浪 */ }
    // 备用②：新浪资金快照，修正净额口径（特大单+大单主动买卖净额，非东财单笔口径）
    try {
      const sym = qqSymbol(c);
      if (!sym) throw new Error('代码无法解析为行情符号');
      const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssi_ssfx_flzjtj?daima=' + sym;
      const txt = await timed('sinaFund', url, { referer: SOURCE_META.sinaFund.url });
      const j = JSON.parse(txt);
      const netOf = (inn, out) => (num(inn) === null || num(out) === null) ? null : +(num(inn) - num(out)).toFixed(2);
      const huge = netOf(j.r0_in, j.r0_out), big = netOf(j.r1_in, j.r1_out);
      const mid = netOf(j.r2_in, j.r2_out), small = netOf(j.r3_in, j.r3_out);
      const main = (huge === null || big === null) ? num(j.netamount) : +(huge + big).toFixed(2);
      return {
        main, net: num(j.netamount), huge, big, mid, small,
        mainPct: num(j.r0x_ratio), ratio: num(j.r0x_ratio),
        caliber: '新浪：主力净额=特大单+大单主动买卖净额（与东财单笔口径不同，仅作降级备用）',
        source: SOURCE_META.sinaFund.label, asOf: new Date().toISOString(),
        reason: main === null ? '资金快照为空' : null
      };
    } catch (e) {
      return { source: null, reason: '个股资金快照失败：' + (e && e.message || e) };
    }
  });
}

module.exports = {
  SOURCE_META, boardOf, qqSymbol,
  getMinute, getMinuteHistory, getMinuteMultiDay, getFundFlow, getFundHistory, weeklyFund, getStockFundNow,
  getUniverse, getUniverseStale, getSectorBoards, getSectorMembers, getEastmoneyPopularity,
  getQQQuotes, getKline, getKlineData, getPeriodKline, getKlineSource, getPools, getIndices, getGlobalMarkets, resolveTradeDate,
  getRecentLimitUpPools, getLimitUpHistory, getPoolFullHistory, getLongPoolHistory,
  getAnnouncements, getFlashNews, toBJTime,
  getHealth, cached
};
