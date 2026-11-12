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
  emPool:  { label: '东方财富涨停池',     host: 'push2ex.eastmoney.com',      url: 'https://quote.eastmoney.com/ztb/detail' }
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

async function cached(key, ttl, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl && hit.value !== undefined) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      if (value !== undefined && value !== null) cache.set(key, { at: Date.now(), value });
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

/** 腾讯前复权日K；返回 [{date,open,close,high,low,volume}] 升序 */
async function getKline(code, limit = 90) {
  const sym = qqSymbol(code);
  if (!sym) return [];
  return cached('kline:' + sym + ':' + limit, 300000, async () => {
    try {
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,,,' + limit + ',qfq&_=' + Date.now();
      const txt = await timed('qqKline', url, { referer: SOURCE_META.qqKline.url });
      const j = JSON.parse(txt);
      const d = j && j.data && j.data[sym];
      if (!d) return [];
      const arr = d.qfqday || d.day || [];
      const rows = arr.map(r => ({
        date: r[0],
        open: num(r[1]),
        close: num(r[2]),
        high: num(r[3]),
        low: num(r[4]),
        volume: num(r[5])
      })).filter(x => x.close !== null);
      mark('qqKline', true, { rows: rows.length });
      return rows;
    } catch (e) { return []; }
  });
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
  return Object.values(health).map(h => ({ ...h }));
}

module.exports = {
  SOURCE_META, boardOf, qqSymbol,
  getUniverse, getSectorBoards, getSectorMembers,
  getQQQuotes, getKline, getPools, getIndices, resolveTradeDate,
  getHealth, cached
};
