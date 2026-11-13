'use strict';
/**
 * 数据接入层 —— 全部使用免费公开行情接口，无任何商业数据授权。
 *
 *  新浪财经行情中心  vip.stock.finance.sina.com.cn  全市场 A 股列表 / 行业 / 概念板块
 *  腾讯证券行情      qt.gtimg.cn                    实时快照（含流通市值、量比、涨跌停价）
 *  腾讯证券日K       web.ifzq.gtimg.cn              前复权日线（技术指标计算）
 *  东方财富涨停池    push2ex.eastmoney.com          涨停 / 强势 / 炸板 / 跌停池（含连板数、封单、行业）
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
  sinaKline: { label: '新浪财经日K(不复权·备用)', host: 'quotes.sina.cn', url: 'https://finance.sina.com.cn/', standby: true }
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

function rawGet(url, { referer, gbk = false, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      family: 4,
      method: 'GET',
      headers: {
        'User-Agent': UA,
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
    boards: num(row.lbc) || 1,          // 连板数
    firstSeal: fmtSealTime(row.fbt),
    lastSeal: fmtSealTime(row.lbt),
    sealFund: fund,                     // 封单额（元）
    sealFundRatio: (fund && ltsz) ? +(fund / ltsz * 100).toFixed(2) : null, // 封单/流通市值 %
    brokenCount: num(row.zbc) || 0,     // 炸板次数
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
    return { rows: pool.map(r => normalizeEMPool(r, kind)), total: j.data.tc || pool.length, qdate: j.data.qdate || date };
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
  });
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
async function getPoolFullHistory(tradingDays = 7) {
  const days = Math.max(3, Math.min(15, Number(tradingDays) || 7));
  return cached('poolFullHistory:' + days, 600000, async () => {
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
        const [zt, zb] = await Promise.all([fetchEMPool('zt', date), fetchEMPool('zb', date)]);
        return { date, zt: zt.rows || [], zb: zb.rows || [], qdate: zt.qdate || date };
      }));
      probes.push(...rs);
      if (probes.filter(p => p.zt.length).length >= days) break;
    }
    const valid = probes.filter(p => p.zt.length).slice(0, days);
    const byDate = {}, dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, zt: p.zt.length, zb: p.zb.length });
      byDate[p.date] = { zt: p.zt, zb: p.zb };
    }
    mark('emPool', true, { rows: dates.reduce((n, d) => n + d.zt, 0) });
    return {
      dates, byDate, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label,
      note: '按交易日保留涨停/炸板池完整字段；交易日以请求 date 为准，上游 qdate 常返回最新交易日。封板时间为首次触板时间，非收盘封板状态。'
    };
  }, v => v && Array.isArray(v.dates) && v.dates.length > 0);
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

function getHealth() {
  // standby 源（新浪日K）只在主源失败时启用，不参与「在线数」统计，避免误报故障
  return Object.values(health).map(h => ({ ...h, standby: !!SOURCE_META[h.key].standby }));
}

module.exports = {
  SOURCE_META, boardOf, qqSymbol,
  getUniverse, getSectorBoards, getSectorMembers,
  getQQQuotes, getKline, getKlineData, getKlineSource, getPools, getIndices, resolveTradeDate,
  getRecentLimitUpPools, getLimitUpHistory, getPoolFullHistory, getHealth, cached
};
