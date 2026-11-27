'use strict';
/**
 * A股实时复盘与短线机会系统 —— 本地服务（Node.js 零第三方依赖）
 * 启动： node server.js   →   http://localhost:8899
 *
 * 所有行情均为免费公开接口实时拉取，服务端不内置、不缓存任何历史行情数字。
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
// Node 16.4+/14.18+ 才有该 API；低版本 Node 忽略即可（请求侧已显式指定 family: 4）
if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');

const ds = require('./lib/datasource');
const an = require('./lib/analytics');
const py = require('./lib/pinyin');

// 默认 8899：8787 常与其它本地服务冲突；可用环境变量 PORT 覆盖
// 若目标端口被占用，启动时自动顺延到下一个可用端口（最多 15 次），并在控制台打印实际地址
const PREFERRED_PORT = Number(process.env.PORT) || 8899;
let ACTIVE_PORT = PREFERRED_PORT;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const DISCLAIMER = '以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。';

/* ─────────── 可选大模型配置（仅存内存：不落盘、不写日志、不回传密钥） ─────────── */
const aiConfig = { baseUrl: '', apiKey: '', model: '' };
const AI_SYSTEM_PROMPT = '你是严谨的 A 股短线复盘研究助手。严格遵守：1) 只能使用用户消息中提供的行情数据，禁止编造任何数字、公司、事件、新闻、政策或研报；2) 不预测指数涨跌方向，不使用「必涨/必跌」等绝对表述；3) 不给出具体买卖价位、仓位指令或收益承诺；4) 每个结论都要点明依据的数据字段；5) 明确指出数据边界（本页结论仅由量价结构推导，公告/快讯消息面仅在「明日龙头」模块单独展示、未纳入本页评分，仍未接入龙虎榜，且均为非交易所官方推送的公开接口快照）。输出用简体中文，结构清晰、克制、可执行的是观察框架而非交易指令。';

function aiStatus() {
  return {
    configured: !!(aiConfig.baseUrl && aiConfig.apiKey),
    model: aiConfig.model || null,
    baseUrl: aiConfig.baseUrl || null
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 128 * 1024) reject(new Error('请求体过大')); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function postJson(url, headers, payload, timeout = 45000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('仅支持 http/https 接口'));
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method: 'POST', family: 4, timeout,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers)
    }, res => {
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('上游 HTTP ' + res.statusCode + '：' + text.slice(0, 300)));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('上游返回非 JSON：' + text.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('大模型响应超时')));
    req.on('error', reject);
    req.end(data);
  });
}

/** 只把真实行情数据摘要喂给模型，避免模型凭空补数据 */
function buildAiPrompt(d) {
  const ov = d.overview, rv = d.review;
  const lines = [];
  lines.push('【数据边界】以下均为免费公开接口快照，非交易所官方推送；公告/快讯消息面仅在「明日龙头」模块单独轮询展示（关键词规则归类），未纳入本页评分；仍未接入龙虎榜；不构成投资建议。');
  lines.push(`【时点】交易日 ${d.meta.poolDate}；腾讯实时快照 ${d.meta.quoteTick || '—'}；新浪全市场快照 ${d.meta.universeTick || '—'}；交易状态 ${d.meta.state}。`);
  lines.push(`【市场】档位「${ov.tier}」/情绪「${ov.emotion}」；${ov.up} 涨 / ${ov.down} 跌，广度 ${ov.breadth}%；涨幅≥5% ${ov.up5} 家、跌幅≥5% ${ov.down5} 家；指数均值 ${ov.idxAvg}%。`);
  lines.push(`【指数】${(ov.indices || []).map(i => i.name + ' ' + i.price + ' (' + (i.pct > 0 ? '+' : '') + i.pct + '%)').join('；')}`);
  lines.push(`【涨停结构】涨停 ${ov.limitUp}、跌停 ${ov.limitDown}、炸板 ${ov.broken}（炸板率 ${ov.breakRate}%）、最高 ${ov.maxBoard} 板、梯队 ${Object.keys(ov.ladder).sort((a, b) => b - a).map(b => b + '板×' + ov.ladder[b]).join('/')}、${ov.gap ? '有断层' : '无断层'}。`);
  lines.push(`【主线题材 Top5】${(d.themes || []).slice(0, 5).map(t => `${t.name}：${t.count} 只涨停 / 最高 ${t.maxBoard} 板 / ${t.stage} / 预期${t.outlook} / 炸板率 ${t.negRate}%`).join('；')}`);
  lines.push(`【明日接力候选（前12）】${((d.relay && d.relay.list) || []).slice(0, 12).map(x => `${x.name}(${x.code}) ${x.category} ${x.boards}板 评分${x.relayScore} ${x.level} 方式「${x.method.method}」题材${x.theme ? x.theme.name + '/' + x.theme.stage : '无'}`).join('；')}`);
  lines.push(`【连板低吸研判（前8）】${(d.lowbuy || []).slice(0, 8).map(x => `${x.name}(${x.code}) ${x.boards}板 技术${x.techScore} ${x.verdict.level} ${x.role.role} 题材预期${x.theme ? x.theme.outlook : '—'}`).join('；')}`);
  lines.push(`【短线评分 Top8】${(d.picks || []).slice(0, 8).map(x => `${x.name}(${x.code}) 评分${x.score} ${x.verdict} 涨幅${x.pct}% 换手${x.turnover}%`).join('；')}`);
  lines.push(`【已有复盘结论】${(rv && rv.facts ? rv.facts.map(f => f.label + '：' + f.value).join('；') : '')}`);
  lines.push('【输出要求】按 1 市场状态判断（含依据字段）2 主线题材与生命周期 3 明日最值得观察的 3 个变量 4 候选标的分层（重点观察/条件观察/回避）及理由 5 风险清单与失效条件 输出；不要新增任何未给出的数据。');
  return lines.join('\n');
}

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
// 统一缓存：inflight 按 key 去重，force 请求等旧任务结束后重算，不会被旧结果覆盖。
const CACHE_SLOTS = 16;
function createCache(ttl) { return { values: new Map(), inflight: new Map(), ttl }; }
function invalidateCache(c) { c.values.clear(); }
function cacheSet(c, key, value) {
  c.values.delete(key);
  c.values.set(key, { at: Date.now(), value });
  if (c.values.size > CACHE_SLOTS) c.values.delete(c.values.keys().next().value);
}
async function cachedCall(c, key, force, producer) {
  const started = Date.now();
  const hit = c.values.get(key);
  if (!force && hit && started - hit.at < c.ttl) {
    c.values.delete(key); c.values.set(key, hit); // 刷新 LRU 顺序
    return hit.value;
  }
  const running = c.inflight.get(key);
  if (running) {
    if (!force) return running;
    try { await running; } catch (e) { /* 旧任务失败不影响重算 */ }
    const fresh = c.values.get(key);
    if (fresh && fresh.at > started) return fresh.value;
  }
  const job = (async () => { const v = await producer(); cacheSet(c, key, v); return v; })();
  c.inflight.set(key, job);
  try { return await job; } finally { if (c.inflight.get(key) === job) c.inflight.delete(key); }
}
// 控制参数不参与缓存键，避免点一次刷新后缓存永久穿透
function cleanCacheKey(query) {
  const o = {};
  Object.keys(query || {}).sort().forEach(k => { if (k !== '_' && k !== 'force') o[k] = query[k]; });
  return JSON.stringify(o);
}
const dashCache = createCache(9000);

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
  const [universe, pools, indices, boards, prevHistory, fundFlow, globalMarkets] = await Promise.all([
    ds.getUniverse().catch(() => ({ list: [], count: 0, asOf: new Date().toISOString() })),
    ds.getPools().catch(() => ({ zt: [], qs: [], zb: [], dt: [], date: '', asOf: new Date().toISOString() })),
    ds.getIndices().catch(() => []),
    ds.getSectorBoards().catch(() => ({ industry: [], concept: [], asOf: new Date().toISOString() })),
    ds.getPoolFullHistory(15).catch(() => ({ dates: [], byDate: {}, note: '' })),
    ds.getFundFlow().catch(() => ({ boards: [], totalNet: null, reason: '资金流暂不可用' })),
    ds.getGlobalMarkets().catch(() => ({ rows: [], source: null, note: '全球行情暂不可用' }))
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

  // 3) 概念成分映射：用于「主线题材」按概念口径分组（与行业分组并列对比）
  //    取涨幅居前 + 覆盖面大的概念板块（排除宽基/指数类的泛概念），并发拉成分股；
  //    getSectorMembers 自带 2 分钟缓存，主看板刷新不会重复打接口。
  const conceptBoards = (boards.concept || []).filter(b => {
    const n = String(b.name || '');
    return !/指数|50|300|500|1000|MSCI|富时|标普|沪股通|深股通|融资融券|机构重仓|基金重仓|预盈|预增|输配电气/.test(n);
  });
  const byPct = (a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0);
  const candConcepts = [...new Map([
    ...[...conceptBoards].sort(byPct).slice(0, 10),
    ...[...conceptBoards].sort((a, b) => (Number(b.members) || 0) - (Number(a.members) || 0)).slice(0, 6)
  ].map(b => [b.node, b])).values()].slice(0, 14);
  const conceptSets = await limitedMap(candConcepts, 4, async b => {
    try { return { name: b.name, set: await ds.getSectorMembers(b.node) }; }
    catch (e) { return null; }
  });
  const conceptMap = {};
  conceptSets.forEach(m => {
    if (!m || !m.set || !m.set.size) return;
    m.set.forEach(c => { (conceptMap[c] = conceptMap[c] || []).push(m.name); });
  });

  // 4) 市场结构 / 题材 / 复盘
  const ov = an.marketOverview(universe, indices, pools);
  const themes = an.buildThemes(pools, boards);
  const conceptThemes = an.buildConceptThemes(pools, boards, conceptMap);
  const review = an.reviewPlan(ov, themes, pools);

  // 5) 需要实时快照的代码池
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

  // 6) 涨停池个股日K（技术指标 / 反包板识别 / 接力评分共用；上游缓存 5 分钟）
  const ztCodes = (pools.zt || []).slice(0, 45).map(x => x.code);
  const klines = await limitedMap(ztCodes, 5, async c => ds.getKline(c, 90));
  const klineMap = {};
  ztCodes.forEach((c, i) => { klineMap[c] = klines[i] || []; });

  const ctx = { ov, themes, sectorSet };
  const filtersWithSet = { ...f, _sectorSet: sectorSet };

  // 7) 六个模块
  const [picks, lowbuy, opps] = await Promise.all([
    Promise.resolve(an.shortTermPicks(pools, universe, quotes, ctx, f)),
    Promise.resolve(an.boardLowBuy(pools, ov, themes, klineMap, quotes, filtersWithSet)),
    Promise.resolve(an.liveOpportunities(pools, boards, universe, quotes, filtersWithSet))
  ]);
  // 连板天梯的历史优势组合标记：与「明日龙头」同一套地位 / 一致分歧规则，不参与任何评分
  const edgeStats = getEdgeStatsSnapshot(f.edgeDays);
  const dragonEdges = an.dragonEdgeMarks(pools, prevHistory, edgeStats && edgeStats.marks, edgeStats && edgeStats.smallMarks);
  // 标记同时挂到完整涨停池（天梯用），否则 top80 之外的高板位个股会丢失角标
  const ladderPool = opps.ladderZt || opps.zt || [];
  ladderPool.forEach(x => { if (dragonEdges[x.code]) x.dragonEdge = dragonEdges[x.code]; });
  // 首板龙头种子：最近历史回测的分档概率，挂到当日首板卡片（历史日期的天梯不误用当日标记）
  const seed = an.firstBoardSeedBacktest(prevHistory, pools, { asOf: beijingNow().now });
  ladderPool.forEach(x => { if (seed.marks[x.code]) x.seedMark = seed.marks[x.code]; });
  ladderPool.forEach(x => { if (seed.cumMarks && seed.cumMarks[x.code]) x.cumRate = seed.cumMarks[x.code]; });
  const relay = an.relayPicks(pools, ov, themes, klineMap, quotes, filtersWithSet);
  // 昨日连板天梯今日晋级情况：用已发生的历史池 + 今日快照，保守判定晋级 / 回封 / 断板
  const prevLadder = an.prevLadderProgress(prevHistory, pools, quotes);
  const ai = an.aiResearch({
    ov, themes, review, picks, lowbuy, relay,
    meta: { universeTick: universe.ticktime, quoteTick, poolDate: pools.date }
  });

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
    klineSource: ds.getKlineSource(),
    sectorLabel,
    filters: f,
    sources: Object.values(ds.SOURCE_META).map(s => ({ label: s.label, host: s.host })),
    health: ds.getHealth(),
    port: ACTIVE_PORT,
    aiConfigured: aiStatus().configured,
    aiModel: aiStatus().model,
    dataSourceNote: '全市场广度=新浪财经行情中心；实时快照/指数=腾讯证券行情；全球行情(港股/美股/国际商品)=腾讯证券行情，(日经225/韩国综合)=新浪财经全球指数；日K(前复权)=腾讯证券；涨停/炸板/强势/跌停池与连板数、封单、行业=东方财富涨停池。均为免费公开接口，非交易所官方推送，盘中可能有秒级延迟。',
    disclaimer: DISCLAIMER
  };

  // 概率随主看板一起下发（按所选窗口缓存；冷启动不阻塞，后台算完后下次刷新带上）
  return { meta, overview: ov, review, themes, conceptThemes, conceptNote: '按新浪概念板块成分股把当日涨停股重新分组（一只票可属多个概念），用与行业题材相同的量价规则判定生命周期；概念分组≥2只成分股涨停才计入。', picks, lowbuy, opportunities: opps, limitDownPool: pools.dt || [], boards, fundFlow, globalMarkets, relay, ai, prevLadder, firstBoardSeed: seed, edgeStats };
}

/* ─────────── 涨停回调到支撑位（独立模块，避免拖慢主看板） ─────────── */
const pullCache = createCache(180000);

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

/** 从东财涨停 / 炸板 / 跌停池提取个股当日封单快照（分时图用）；未入池返回 null
 *  跌停池同样带 fund（封单额）、fbt（首次封跌停）、oc（撬板次数），此前漏读导致跌停股无封单额 */
function stockSeal(pools, code) {
  const p = pools || {};
  const rows = [
    ...(Array.isArray(p.zt) ? p.zt : []),
    ...(Array.isArray(p.zb) ? p.zb : []),
    ...(Array.isArray(p.dt) ? p.dt : [])
  ];
  const x = rows.find(r => String(r && r.code) === code);
  if (!x) return null;
  return {
    code, date: p.date || null, kind: x.kind || null,
    price: x.price === undefined ? null : x.price,
    limitUpPrice: x.limitUpPrice === undefined ? null : x.limitUpPrice,
    sealFund: x.sealFund === undefined ? null : x.sealFund,
    sealFundRatio: x.sealFundRatio === undefined ? null : x.sealFundRatio,
    firstSeal: x.firstSeal || null, lastSeal: x.lastSeal || null,
    brokenCount: x.brokenCount === undefined ? null : x.brokenCount,
    boards: x.boards === undefined ? null : x.boards,
    downDays: x.downDays === undefined ? null : x.downDays,
    source: (x.kind === 'dt' ? '东方财富跌停池' : x.kind === 'zb' ? '东方财富炸板池' : p.source) || null
  };
}

/**
 * 个股K线弹窗聚合：一次性返回日K / 周K / 筹码峰 + 实时快照。
 * 筹码峰为模型估算，明确标注口径；所有K线数据来自 datasource，本函数不产生行情数字。
 */
async function getStockChart(query) {
  const code = String(query.code || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(code)) return { error: '缺少有效的 6 位股票代码', code: code || null };
  const t0 = Date.now();
  const dayLimit = 160, weekLimit = 80;
  const [day, week, quotes, minute, multiDay, fundHistory, fundNow, pools] = await Promise.all([
    ds.getKlineData(code, dayLimit).catch(() => ({ rows: [], source: null, adjusted: null })),
    ds.getPeriodKline(code, 'week', weekLimit).catch(() => ({ rows: [], source: null, adjusted: false })),
    ds.getQQQuotes([code]).catch(() => ({})),
    ds.getMinute(code).catch(() => ({ rows: [], source: null, reason: '分时接口暂不可用' })),
    ds.getMinuteMultiDay(code).catch(() => ({ days: [], source: null, reason: '五日分时接口暂不可用' })),
    ds.getFundHistory(code, 160).catch(() => ({ rows: [], source: null, reason: '资金流历史暂不可用' })),
    ds.getStockFundNow(code).catch(() => ({ source: null, reason: '资金快照暂不可用' })),
    ds.getPools().catch(() => ({}))
  ]);
  // 五日分时每天以各自昨收为基准画涨跌幅：用日K收盘按日期补 prevClose（早→晚，第 i 天昨收=第 i-1 日收盘）。
  // 日K缺某日时回溯该日前一根，仍缺则 prevClose=null，前端按当日首分钟价兜底并如实标注。
  const dayCloseByDate = new Map();
  (day.rows || []).forEach(r => { const d = String(r.date || '').replace(/\D/g, '').slice(0, 8); if (/^\d{8}$/.test(d) && Number.isFinite(r.close)) dayCloseByDate.set(d, r.close); });
  const dayDates = [...dayCloseByDate.keys()].sort();
  const multiDays = (multiDay.days || []).map(x => {
    let prevClose = null;
    const idx = dayDates.indexOf(x.date);
    if (idx > 0) prevClose = dayCloseByDate.get(dayDates[idx - 1]);
    else if (idx === 0 && (multiDay.days || []).length) {
      // 该日恰为日K首日：用五日窗口内更早一天的收盘兜底
      const earliest = (multiDay.days || []).find(d => d.date < x.date);
      if (earliest && earliest.rows.length) prevClose = earliest.rows[earliest.rows.length - 1].price;
    }
    return { date: x.date, prevClose, rows: x.rows };
  });
  const fundWeek = ds.weeklyFund(fundHistory.rows || []).slice(-weekLimit);
  const q = quotes[code] || {};
  const price = Number(q.price) > 0 ? Number(q.price) : (day.rows.length ? day.rows[day.rows.length - 1].close : null);
  const chipOpts = { price, floatCap: Number(q.floatCap) > 0 ? Number(q.floatCap) : null, period: 'day', limit: 120 };
  const chipDay = an.chipDistribution(day.rows, chipOpts);
  const chipWeek = an.chipDistribution(week.rows, { ...chipOpts, period: 'week', limit: 80 });
  // 解析名称：优先实时行情，其次从 universe/代码兜底，避免弹窗显示代码本身
  let name = q.name || null;
  if (!name) {
    try {
      const uni = await ds.getUniverse();
      const hit = (uni.list || []).find(x => x.code === code);
      if (hit) name = hit.name;
    } catch (e) { /* 名称非关键字段，失败不影响K线 */ }
  }
  return {
    code, name: name || code,
    quote: {
      price: Number.isFinite(price) ? price : null, pct: q.pct ?? null,
      floatCap: q.floatCap ?? null, turnover: q.turnover ?? null,
      high: q.high ?? null, low: q.low ?? null, open: q.open ?? null,
      prevClose: q.prevClose ?? null, asOf: q.ticktime || null,
      // 分时右侧信息栏所需的其余真实快照字段（来自同一份腾讯行情，不臆造）
      change: q.change ?? null, volume: q.volume ?? null, amountWan: q.amountWan ?? null,
      avgPrice: q.avgPrice ?? null, volRatio: q.volRatio ?? null, amplitude: q.amplitude ?? null,
      limitUp: q.limitUp ?? null, limitDown: q.limitDown ?? null, ticktime: q.ticktime ?? null,
      totalCap: q.totalCap ?? null, pe: q.pe ?? null, pb: q.pb ?? null
    },
    day: { rows: day.rows, source: day.source, adjusted: day.adjusted, asOf: day.asOf },
    week: { rows: week.rows, source: week.source, adjusted: week.adjusted, asOf: week.asOf, reason: week.reason || null },
    minute: { rows: minute.rows || [], source: minute.source || null, date: minute.date || null, asOf: minute.asOf || null, reason: minute.reason || null },
    multiDay: {
      days: multiDays, source: multiDay.source || null, granularity: multiDay.granularity || null,
      intervalLabel: multiDay.intervalLabel || null, asOf: multiDay.asOf || null, reason: multiDay.reason || null
    },
    seal: stockSeal(pools, code),
    fund: {
      day: { rows: fundHistory.rows || [], source: fundHistory.source || null, reason: fundHistory.reason || null, name: fundHistory.name || null },
      week: { rows: fundWeek, source: fundHistory.source || null, reason: fundHistory.reason || null },
      note: (fundHistory.caliber || '主力净流入=超大单+大单净额（东方财富口径）') +
        '；周线为真实日线按自然周加总。DDX/DDZ 为第三方专有算法指标，公开接口无法取得真实序列，系统不提供估算值。' +
        (fundHistory.source === ds.SOURCE_META.sinaFundHist.label ? ' 本次东财资金流接口不可用，已自动降级为新浪口径，数值与东财口径不可直接比较。' : ''),
      now: fundNow || {}
    },
    chip: { day: chipDay, week: chipWeek },
    method: {
      day: '日K：腾讯证券前复权优先，限流时自动降级新浪财经不复权；来源见各周期 source 字段。',
      week: '周K：腾讯证券 kline 接口（不复权），与日K复权口径不同，仅供趋势结构参考。',
      chip: an.chipDistribution && chipDay
        ? '筹码峰由' + chipDay.method + ' 换手口径：' + chipDay.turnoverModel + '。峰值/成本区间为模型估算，非交易所真实持仓成本分布，不构成买卖依据。'
        : '筹码峰数据不足（K线根数不够），本次不生成。'
    },
    meta: { ...beijingNow(), generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, disclaimer: DISCLAIMER }
  };
}

async function getPullback(query, force) {
  return cachedCall(pullCache, cleanCacheKey(query), force, () => buildPullback(query));
}

async function getDashboard(query, force) {
  return cachedCall(dashCache, cleanCacheKey(query), force, () => buildDashboard(query));
}

/* ─────────── 涨停回踩支撑 · 历史回溯（成功率） ─────────── */
const backtestCache = createCache(600000);
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

/* ── 支撑位反转：回调 + 主力资金首次翻红 + 十字星/小阳线（回测 + 当日信号） ── */
// 按完整筛选条件缓存最近 8 份结果：来回切换板块 / 市值时不必重复拉几百只个股的日K与资金流
const supportRevCache = { values: new Map(), inflight: null, inflightKey: '' };
const srNumOrNull = v => {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// 主接口与样本分页接口必须共用同一套缓存键，避免拿错筛选条件下的样本
function supportRevKey(query) {
  return JSON.stringify({
    scan: query.scan || '', window: query.window || '', minDraw: query.minDraw || '',
    bandPct: query.bandPct || '', smallYang: query.smallYang || '', lookback: query.lookback || '',
    board: String(query.board || '全部').trim() || '全部',
    srBoard: String(query.srBoard || '全部').trim() || '全部',
    capMin: srNumOrNull(query.capMin), capMax: srNumOrNull(query.capMax)
  });
}
async function getSupportReversal(query, force) {
  // 全局筛选（市场板块 / 流通市值）与模块内「板块」下拉共同约束候选池，
  // 必须参与缓存 key，否则切换筛选会一直拿到上一次的回测结果。
  const numOrNull = srNumOrNull;
  const boardRaw = String(query.board || '全部').trim() || '全部';
  const globalBoards = boardRaw !== '全部' && boardRaw !== 'all'
    ? boardRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
  const srBoard = String(query.srBoard || '全部').trim() || '全部';
  const localBoard = srBoard !== '全部' && srBoard !== 'all' ? srBoard : null;
  const capMin = numOrNull(query.capMin), capMax = numOrNull(query.capMax);
  const key = supportRevKey(query);
  const cached = supportRevCache.values.get(key);
  if (!force && cached && Date.now() - cached.at < 600000) return cached.value;
  if (supportRevCache.inflight && supportRevCache.inflightKey === key) return supportRevCache.inflight;
  // 不同筛选条件并发时排队等待，不能把旧条件的扫描结果当成新条件返回
  if (supportRevCache.inflight) {
    try { await supportRevCache.inflight; } catch (e) { /* 旧请求失败不影响新条件 */ }
    return getSupportReversal(query, force);
  }
  const boardOk = b => (!globalBoards || globalBoards.includes(b)) && (!localBoard || b === localBoard);
  const allowBJ = !localBoard && !!globalBoards && globalBoards.includes('北交所');
  const capOk = x => {
    if (capMin === null && capMax === null) return true;
    const cap = Number(x && x.floatCap);
    if (!Number.isFinite(cap) || cap <= 0) return false;
    if (capMin !== null && cap < capMin) return false;
    if (capMax !== null && cap > capMax) return false;
    return true;
  };
  const baseOk = x => !!x && !!x.code && !x.isST && !/ST/i.test(x.name || '') &&
    (/^(60|00|30|68)/.test(x.code) || (allowBJ && /^(8|4|92)/.test(x.code))) &&
    Number(x.price) > 2 && Number(x.amount) > 2e7;
  const filterDesc = ['市场板块=' + (globalBoards ? globalBoards.join('/') : '全部')];
  if (localBoard) filterDesc.push('模块板块=' + localBoard);
  if (capMin !== null || capMax !== null) {
    filterDesc.push('流通市值=' + (capMin === null ? '0' : capMin) + '~' + (capMax === null ? '∞' : capMax) + '亿');
  }
  supportRevCache.inflightKey = key;
  const job = (async () => {
    const t0 = Date.now();
    try {
      const scan = Math.max(80, Math.min(1200, Number(query.scan) || 600));
      const [universe, hist] = await Promise.all([
        ds.getUniverse().catch(() => ({ list: [] })),
        ds.getRecentLimitUpPools(10).catch(() => ({ byCode: {} }))
      ]);
      const universeAll = universe.list || [];
      const uniMap = new Map(universeAll.map(x => [x.code, x]));
      // 候选：先按板块 / 流通市值筛选，再取成交额降序前 scan + 近 10 日涨停回踩池并集。
      // 两条来源必须走同一套筛选，否则历史涨停池会把被过滤掉的股票重新塞回回测。
      const pool = new Map();
      const eligible = universeAll
        .filter(x => baseOk(x) && boardOk(x.board || ds.boardOf(x.code)) && capOk(x))
        .sort((a, b) => (b.amount || 0) - (a.amount || 0));
      eligible.slice(0, scan).forEach(x => pool.set(x.code, x));
      let histAdded = 0;
      Object.values(hist.byCode || {}).forEach(x => {
        if (!x || pool.has(x.code) || /ST/i.test(x.name || '')) return;
        const u = uniMap.get(x.code);
        if (!u || !boardOk(u.board || ds.boardOf(u.code)) || !capOk(u)) return;
        pool.set(u.code, u); histAdded++;
      });
      const cand = [...pool.values()];
      // 低并发拉日K + 资金流历史（东财主力净额，失败降级新浪并如实标注）
      const kdata = await limitedMap(cand, 7, async x => ds.getKlineData(x.code, 130).catch(() => null));
      const fdata = await limitedMap(cand, 7, async x => ds.getFundHistory(x.code, 100).catch(() => ({ rows: [], source: null })));
      const inputs = [];
      const fundSources = new Map();
      let noKline = 0, noFund = 0;
      cand.forEach((x, i) => {
        const kd = kdata[i], fd = fdata[i];
        if (!kd || !kd.rows || kd.rows.length < 30) { noKline++; return; }
        if (!fd || !fd.rows || fd.rows.length < 8) { noFund++; return; }
        if (fd.source) fundSources.set(fd.source, (fundSources.get(fd.source) || 0) + 1);
        inputs.push({
          code: x.code, name: x.name, board: ds.boardOf(x.code), industry: x.industry || '',
          floatCap: Number.isFinite(Number(x.floatCap)) ? Number(x.floatCap) : null,
          klines: kd.rows, fund: fd.rows
        });
      });
      // 资金口径：优先东财（超大单+大单），若全为新浪则标注新浪口径
      const srcList = [...fundSources.entries()].sort((a, b) => b[1] - a[1]);
      const mainSrc = srcList.length ? srcList[0][0] : null;
      const caliber = mainSrc && /新浪/.test(mainSrc)
        ? '主力净额=超大单净额（新浪口径，非东财超大单+大单；东财不可用时的降级源）'
        : '主力净额=超大单+大单（东方财富口径）';
      const result = an.supportReversalBacktest(inputs, {
        window: query.window, minDraw: query.minDraw, bandPct: query.bandPct,
        smallYang: query.smallYang, lookback: query.lookback,
        fundSource: srcList.map(([s, n]) => s + ' ' + n + ' 只').join(' / ') || null,
        fundCaliber: caliber,
        klineSource: '腾讯证券前复权日K（失败降级新浪不复权并逐只标注）'
      });
      // 股吧实时人气：只查当日信号股，上游异常时置空由前端降级为资金排序
      const popMap = await ds.getEastmoneyPopularity((result.list || []).map(x => x.code)).catch(() => ({}));
      (result.list || []).forEach(x => {
        const p = popMap[x.code];
        x.popRank = p && Number(p.rank) > 0 ? Number(p.rank) : null;
        x.popChange = p ? p.change : null;
        x.popCalcTime = p ? p.calcTime : null;
      });
      const popCount = (result.list || []).filter(x => x.popRank !== null).length;
      // 全量历史信号只保留表格需要的字段，留在服务端缓存里按需分页；主响应仍只带前 120 条
      const allSamples = (result.samples || []).map(s => ({
        date: s.date, code: s.code, name: s.name, board: s.board || null,
        floatCap: s.floatCap === undefined ? null : s.floatCap,
        shape: s.shape, drawdown: s.drawdown, pct: s.pct, main: s.main,
        pending: !!s.pending,
        next: s.next ? {
          limitUp: !!s.next.limitUp, pct: s.next.pct, retOC: s.next.retOC, retCC: s.next.retCC
        } : null
      }));
      result.samples = allSamples.slice(0, 120);
      result.sampleTotal = allSamples.length;
      const meta = {
        scannedCandidates: cand.length, usedCodes: inputs.length, noKline, noFund,
        scan, elapsedMs: Date.now() - t0,
        fundSources: srcList.map(([source, n]) => ({ source, n })), fundCaliber: caliber,
        filters: { board: boardRaw, boards: globalBoards, srBoard, localBoard, capMin, capMax },
        universeCount: universeAll.length, eligibleCount: eligible.length, histAdded,
        sampleTotal: allSamples.length,
        popularityCount: popCount,
        popularityNote: popCount > 0
          ? '股吧人气=东方财富股吧实时人气榜排名（数字越小越热；前100取榜单接口，其余按个股实时排名，未上榜排末尾）'
          : '东方财富股吧人气暂不可用，信号股按主力净额排序',
        filterDesc: filterDesc.join(' · '),
        candidateNote: '候选=非ST A股按成交额降序前 ' + scan + ' 只 + 近10日涨停回踩池并集；成交额过滤 >2000万、股价>2元；当前生效筛选：' +
          filterDesc.join(' · ') + '（命中 ' + eligible.length + ' 只，历史池补入 ' + histAdded + ' 只）。' +
          '全市场盲扫请求量过大，故聚焦活跃股；筛选作用于候选池，KPI、分档、样本与最新信号股均基于筛选后的真实日K与资金流重算。',
        asOf: result.asOf, disclaimer: DISCLAIMER
      };
      const value = { ok: true, meta, result, allSamples };
      supportRevCache.values.set(key, { at: Date.now(), value });
      while (supportRevCache.values.size > 8) supportRevCache.values.delete(supportRevCache.values.keys().next().value);
      supportRevCache.inflight = null; supportRevCache.inflightKey = '';
      return value;
    } catch (e) {
      supportRevCache.inflight = null; supportRevCache.inflightKey = '';
      throw e;
    }
  })();
  supportRevCache.inflight = job;
  return job;
}

/** 历史信号样本分页：与主接口共用筛选条件，按信号日倒序逐页取更早的数据 */
async function getSupportReversalSamples(query) {
  const key = supportRevKey(query);
  let entry = supportRevCache.values.get(key);
  if (!entry || Date.now() - entry.at >= 600000) {
    try {
      await getSupportReversal(query, false);
      entry = supportRevCache.values.get(key);
    } catch (e) {
      return { ok: false, error: '回测尚未完成：' + String(e && e.message || e) };
    }
  }
  if (!entry) return { ok: false, error: '当前筛选的回测结果尚未生成，请点「重新回测」后重试' };
  const all = entry.value.allSamples || [];
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const limit = Math.max(10, Math.min(200, Math.floor(Number(query.limit) || 80)));
  return {
    ok: true, total: all.length, offset, limit,
    rows: all.slice(offset, offset + limit),
    asOf: entry.value.result && entry.value.result.asOf
  };
}

/* ── DDX首红精选：复刻东财 ddx1120 动态分组（DDX代理 + 实体<5% + 换手≥5% + 未炸板） ── */
const ddxCache = { values: new Map(), inflight: null, inflightKey: '' };
const ddxNumOrNull = v => (v === '' || v === undefined || v === null) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
function ddxKey(query) {
  return JSON.stringify({
    scan: query.scan || '', window: query.window || '',
    ddxMin: query.ddxMin || '', bodyMax: query.bodyMax || '', turnMin: query.turnMin || '',
    smooth: query.smooth || '',
    board: String(query.board || '全部').trim() || '全部',
    ddxBoard: String(query.ddxBoard || '全部').trim() || '全部',
    capMin: ddxNumOrNull(query.capMin), capMax: ddxNumOrNull(query.capMax)
  });
}

async function getDdxFirstRed(query, force) {
  const boardRaw = String(query.board || '全部').trim() || '全部';
  const globalBoards = boardRaw !== '全部' && boardRaw !== 'all' ? boardRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
  const ddxBoard = String(query.ddxBoard || '全部').trim() || '全部';
  const localBoard = ddxBoard !== '全部' && ddxBoard !== 'all' ? ddxBoard : null;
  const capMin = ddxNumOrNull(query.capMin), capMax = ddxNumOrNull(query.capMax);
  const key = ddxKey(query);
  const cached = ddxCache.values.get(key);
  if (!force && cached && Date.now() - cached.at < 600000) return cached.value;
  if (ddxCache.inflight && ddxCache.inflightKey === key) return ddxCache.inflight;
  if (ddxCache.inflight) { try { await ddxCache.inflight; } catch (e) { } return getDdxFirstRed(query, force); }

  const boardOk = b => (!globalBoards || globalBoards.includes(b)) && (!localBoard || b === localBoard);
  const allowBJ = !localBoard && !!globalBoards && globalBoards.includes('北交所');
  const capOk = x => {
    if (capMin === null && capMax === null) return true;
    const cap = Number(x && x.floatCap);
    if (!Number.isFinite(cap) || cap <= 0) return false;
    if (capMin !== null && cap < capMin) return false;
    if (capMax !== null && cap > capMax) return false;
    return true;
  };
  const baseOk = x => !!x && !!x.code && !x.isST && !/ST/i.test(x.name || '') &&
    (/^(60|00|30|68)/.test(x.code) || (allowBJ && /^(8|4|92)/.test(x.code))) &&
    Number(x.price) > 2 && Number(x.amount) > 2e7;
  const filterDesc = ['市场板块=' + (globalBoards ? globalBoards.join('/') : '全部')];
  if (localBoard) filterDesc.push('模块板块=' + localBoard);
  if (capMin !== null || capMax !== null) filterDesc.push('流通市值=' + (capMin === null ? '0' : capMin) + '~' + (capMax === null ? '∞' : capMax) + '亿');

  ddxCache.inflightKey = key;
  const job = (async () => {
    const t0 = Date.now();
    try {
      const scan = Math.max(100, Math.min(2000, Number(query.scan) || 900));
      const universe = await ds.getUniverse().catch(() => ({ list: [] }));
      const universeAll = universe.list || [];
      const eligible = universeAll
        .filter(x => baseOk(x) && boardOk(x.board || ds.boardOf(x.code)) && capOk(x) && Number(x.floatCap) > 0)
        .sort((a, b) => (b.amount || 0) - (a.amount || 0));
      // 全市场覆盖：腾讯批量行情取当日换手率，先按 turnMin 的 60% 快筛，
      // 避免只扫成交额前 N 只而漏掉武汉凡谷(#1098)/野马电池(#1011)这类中低成交额达标股。
      // 换手率是信号的硬条件之一（当日≥turnMin），快筛放宽到 60% 留余量，再由回测精确判定。
      const turnFloor = Math.max(1.5, (Number(query.turnMin) || 5) * 0.6);
      let quotes = {};
      try { quotes = await ds.getQQQuotes(eligible.map(x => x.code)); } catch (e) { /* 行情失败则回退成交额排序 */ }
      const hasQuote = Object.keys(quotes).length > 0;
      const fastFiltered = hasQuote
        ? eligible.filter(x => (Number((quotes[x.code] || {}).turnover) || 0) >= turnFloor)
        : eligible;
      const cand = fastFiltered.slice(0, scan);
      const kdata = await limitedMap(cand, 16, async x => ds.getKlineData(x.code, 130).catch(() => null));
      const fdata = await limitedMap(cand, 16, async x => ds.getFundHistory(x.code, 100).catch(() => ({ rows: [], source: null })));
      const inputs = [];
      const fundSources = new Map();
      let noKline = 0, noFund = 0;
      cand.forEach((x, i) => {
        const kd = kdata[i], fd = fdata[i];
        if (!kd || !kd.rows || kd.rows.length < 30) { noKline++; return; }
        if (!fd || !fd.rows || fd.rows.length < 8) { noFund++; return; }
        if (fd.source) fundSources.set(fd.source, (fundSources.get(fd.source) || 0) + 1);
        inputs.push({
          code: x.code, name: x.name, board: ds.boardOf(x.code), industry: x.industry || '',
          floatCap: Number(x.floatCap),
          klines: kd.rows, fund: fd.rows
        });
      });
      const srcList = [...fundSources.entries()].sort((a, b) => b[1] - a[1]);
      const mainSrc = srcList.length ? srcList[0][0] : null;
      const caliber = mainSrc && /新浪/.test(mainSrc)
        ? 'DDX近似=资金净额/流通市值×10000（新浪 netamount 含大单，方向接近东财；东财 push2his 本机不可达时的降级源）'
        : 'DDX近似=(超大单f66+大单f72)/流通市值×10000（东方财富口径，对齐 DDX=大单净买入量×10000/流通股本）';
      const result = an.ddxFirstRedBacktest(inputs, {
        window: query.window, ddxMin: query.ddxMin, bodyMax: query.bodyMax, turnMin: query.turnMin,
        smooth: query.smooth,
        fundSource: srcList.map(([s, n]) => s + ' ' + n + ' 只').join(' / ') || null,
        fundCaliber: caliber,
        klineSource: '腾讯证券前复权日K（失败降级新浪不复权并逐只标注）'
      });
      // 人气门槛只对当日信号生效（无历史序列）：标注排名，并默认按人气前500筛选
      const popMap = await ds.getEastmoneyPopularity((result.list || []).map(x => x.code)).catch(() => ({}));
      (result.list || []).forEach(x => {
        const p = popMap[x.code];
        x.popRank = p && Number(p.rank) > 0 ? Number(p.rank) : null;
        x.popTop500 = x.popRank !== null && x.popRank <= 500;
      });
      const popCount = (result.list || []).filter(x => x.popRank !== null).length;
      const allSamples = (result.samples || []).map(s => ({
        date: s.date, code: s.code, name: s.name, board: s.board || null, floatCap: s.floatCap,
        ddx: s.ddx, body: s.body, turnover: s.turnover, pct: s.pct, main: s.main,
        pending: !!s.pending,
        next: s.next ? { limitUp: !!s.next.limitUp, pct: s.next.pct, retOC: s.next.retOC, retCC: s.next.retCC } : null
      }));
      result.samples = allSamples.slice(0, 120);
      result.sampleTotal = allSamples.length;
      const meta = {
        scannedCandidates: cand.length, usedCodes: inputs.length, noKline, noFund, scan,
        elapsedMs: Date.now() - t0,
        fundSources: srcList.map(([source, n]) => ({ source, n })), fundCaliber: caliber,
        filters: { board: boardRaw, boards: globalBoards, ddxBoard, localBoard, capMin, capMax },
        universeCount: universeAll.length, eligibleCount: eligible.length,
        fastFilter: { enabled: hasQuote, turnFloor: +turnFloor.toFixed(2), passed: fastFiltered.length, used: cand.length },
        sampleTotal: allSamples.length, popularityCount: popCount,
        popularityNote: '股吧人气=东方财富股吧实时人气榜（数字越小越热）。人气前500为东财分组条件之一，但无历史序列，仅对最新信号标注并可选过滤，不参与历史回测。' +
          (popCount > 0 ? '' : ' 当前人气接口不可用，页面按 DDX代理强度排序。'),
        filterDesc: filterDesc.join(' · '),
        candidateNote: '候选=全市场非ST活跃股（' + eligible.length + '只）按当日换手率≥' + turnFloor.toFixed(1) + '%快筛，取前 ' + scan + ' 只拉历史。覆盖全市场而非仅成交额头部，避免漏掉中低成交额达标股。须有效流通市值（DDX近似与换手率依赖）；成交额>2000万、股价>2元。当前筛选：' + filterDesc.join(' · ') + '。',
        asOf: result.asOf, disclaimer: DISCLAIMER
      };
      const value = { ok: true, meta, result, allSamples };
      ddxCache.values.set(key, { at: Date.now(), value });
      while (ddxCache.values.size > 8) ddxCache.values.delete(ddxCache.values.keys().next().value);
      ddxCache.inflight = null; ddxCache.inflightKey = '';
      return value;
    } catch (e) {
      ddxCache.inflight = null; ddxCache.inflightKey = '';
      throw e;
    }
  })();
  ddxCache.inflight = job;
  return job;
}

async function getDdxFirstRedSamples(query) {
  const key = ddxKey(query);
  let entry = ddxCache.values.get(key);
  if (!entry || Date.now() - entry.at >= 600000) {
    try { await getDdxFirstRed(query, false); entry = ddxCache.values.get(key); }
    catch (e) { return { ok: false, error: '回测尚未完成：' + String(e && e.message || e) }; }
  }
  if (!entry) return { ok: false, error: '当前筛选的回测结果尚未生成，请点「重新回测」后重试' };
  const all = entry.value.allSamples || [];
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const limit = Math.max(10, Math.min(200, Math.floor(Number(query.limit) || 80)));
  return { ok: true, total: all.length, offset, limit, rows: all.slice(offset, offset + limit), asOf: entry.value.result && entry.value.result.asOf };
}

async function getBacktest(query, force) {
  const key = JSON.stringify({
    window: query.window || '', days: query.days || '',
    perDay: query.perDay || '', maxCodes: query.maxCodes || ''
  });
  return cachedCall(backtestCache, key, force, () => buildBacktest(query));
}

/* ─────────── 明日龙头 · 只做龙头 / 买在分歧卖在一致 ─────────── */
// 「历史优势组合」概率：按可回溯窗口逐日回放统计，每个窗口 10 分钟重算一次。
// 东财涨停池实测只保留约 15 个交易日，更早日期由 ds.getLongPoolHistory 用同花顺回补。
// 结果随主看板 /api/dashboard 与 /api/dragon 一起下发，前端不再写死概率常量。
const EDGE_DAYS_OPTIONS = [15, 30, 60, 90];
const EDGE_DAYS_DEFAULT = 60;
const edgeStatsCache = createCache(600000);
function edgeDaysOf(days) {
  const n = Math.floor(Number(days));
  return Number.isFinite(n) && n > 0 ? Math.min(90, Math.max(5, n)) : EDGE_DAYS_DEFAULT;
}
async function getEdgeStats(days, force) {
  const d = edgeDaysOf(days);
  return cachedCall(edgeStatsCache, d, force, async () => {
    const history = await ds.getLongPoolHistory(d).catch(() => ({ dates: [], byDate: {} }));
    return an.dragonEdgeStats(history, { days: d, maxCandidates: 200 });
  });
}
/** 主看板下发用：冷启动时先返回 null 不阻塞首屏，统计在后台跑，下次刷新自然带上 */
function getEdgeStatsSnapshot(days) {
  const d = edgeDaysOf(days);
  const hit = edgeStatsCache.values.get(d);
  if (hit && Date.now() - hit.at < 600000) return hit.value;
  if (!edgeStatsCache.inflight.has(d)) getEdgeStats(d, false).catch(() => { });
  return null;
}

const dragonCache = createCache(90000);

async function buildDragon(query) {
  const t0 = Date.now();
  const f = { ...query };
  delete f._; delete f.force;
  const days = Math.min(15, Math.max(5, Number(f.days) || 12));

  // 先单独拉当日池，再并发拉历史池 / 指数 / 板块：历史池每批会对 push2ex.eastmoney.com
  // 并发 10+ 个请求，与当日池同时发容易触发上游限流，使当日涨停池偶发返回空名单
  // （表现为整页「无龙头」）。空结果不缓存，故失败时立即重试一次。
  const emptyPools = { zt: [], zb: [], qs: [], dt: [], date: '' };
  let pools = await ds.getPools().catch(() => emptyPools);
  if (!(pools.zt || []).length) pools = await ds.getPools().catch(() => pools);
  const [history, indices, sectorBoards] = await Promise.all([
    ds.getPoolFullHistory(days).catch(() => ({ dates: [], byDate: {}, note: '' })),
    ds.getIndices().catch(() => []),
    ds.getSectorBoards().catch(() => ({ industry: [], concept: [] }))
  ]);

  // 题材理解补充：取当日涨幅居前的概念 / 行业板块，建立「成分股代码 → 板块名」映射
  // （东财 hybk 只有行业分类，覆盖不到跨行业概念与名称炒作）
  const byPct = (a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0);
  const allBoards = [...(sectorBoards.concept || []), ...(sectorBoards.industry || [])];
  // 盘前 / 收盘后板块涨跌幅全为 0，此时按涨幅排序只是列表默认顺序，选不出当日相关概念。
  // 因此混合三种选题：涨幅居前 + 与涨停股东财行业名相关的板块 + 成分覆盖面大的板块。
  const pctValid = allBoards.some(b => Number(b.pct) !== 0);
  const ztInds = [...new Set((pools.zt || []).map(x => String(x.industry || '').replace(/[ⅡⅢⅠ].*$/, '').trim()).filter(Boolean))];
  const related = allBoards.filter(b => {
    const bn = String(b.name).replace(/行业|板块|概念/g, '').trim();
    return bn && ztInds.some(ind => bn.includes(ind.slice(0, 2)) || ind.includes(bn.slice(0, 2)));
  }).slice(0, 8);
  const hot = pctValid ? [...allBoards].sort(byPct).slice(0, 8) : [];
  const broad = allBoards.filter(b => Number(b.members) >= 60)
    .sort((a, b) => (Number(b.members) || 0) - (Number(a.members) || 0)).slice(0, 4);
  const topBoards = [...new Map([...related, ...hot, ...broad].map(b => [b.node, b])).values()].slice(0, 16);
  // 分批并发，避免一次性向新浪板块接口打出几十个请求触发限流
  const memberSets = await limitedMap(topBoards, 4, async b => {
    try { return { name: b.name, set: await ds.getSectorMembers(b.node) }; }
    catch (e) { return null; }
  });
  const conceptMap = {};
  memberSets.forEach(m => {
    if (!m || !m.set || !m.set.size) return;
    m.set.forEach(c => { (conceptMap[c] = conceptMap[c] || []).push(m.name); });
  });

  // 上一交易日涨停股今日真实溢价：腾讯实时快照（历史池只提供名单，不提供今日涨跌）
  const prevDate = (history.dates || [])[1] && history.dates[1].date;
  const prevCodes = prevDate && history.byDate[prevDate]
    ? [...new Set(history.byDate[prevDate].zt.map(x => x.code))] : [];
  const quotes = prevCodes.length ? await ds.getQQQuotes(prevCodes).catch(() => ({})) : {};

  const options = {
    board: f.board, capMin: f.capMin, capMax: f.capMax, keyword: f.keyword,
    excludeST: f.excludeST, sort: f.sort, sortDir: f.sortDir, limit: f.limit,
    showAll: f.showAll, role: f.role, days
  };
  const g = an.dragonGame({ pools, history, quotes, indices, options, conceptMap });

  // 严重异动预测 + 交易风险标记：只用真实日K与个股公告，任何上游失败都如实标注「不可用」
  const riskRows = (g.list || []).slice(0, 60);
  const riskCodes = [...new Set(riskRows.map(x => String(x.code || '')).filter(c => /^\d{6}$/.test(c)))];
  let klines = {}, annItems = [], annAsOf = null, riskErr = null;
  try {
    const kv = await limitedMap(riskCodes, 4, async c => {
      try { return { code: c, data: await ds.getKlineData(c, 60) }; }
      catch (e) { return { code: c, data: null }; }
    });
    (kv || []).forEach(x => { if (x && x.data) klines[x.code] = x.data; });
    if (riskCodes.length) {
      const ann = await ds.getAnnouncements(riskCodes, Math.max(20, Math.min(100, riskCodes.length * 2))).catch(() => null);
      annItems = (ann && ann.items) || [];
      annAsOf = (ann && ann.asOf) || null;
    }
  } catch (e) { riskErr = String(e && e.message || e); }
  const risk = an.dragonRiskEngine({ rows: riskRows, klines, annItems });
  (g.list || []).forEach(x => { x.risk = risk.byCode[String(x.code)] || null; });
  (g.excluded || []).forEach(x => { x.risk = risk.byCode[String(x.code)] || null; });
  g.riskSummary = risk.summary;
  g.riskMethodology = risk.methodology;
  g.riskMeta = {
    codesCount: riskCodes.length, covered: riskCodes.length,
    truncated: (g.list || []).length > riskCodes.length,
    klineOk: risk.summary.klineOk, klineTotal: risk.summary.klineTotal,
    klineSources: risk.summary.klineSources,
    annItems: annItems.length, annAsOf, error: riskErr,
    note: risk.metaNote + (riskErr ? ' 本次部分数据获取失败：' + riskErr : '')
  };

  const qTimes = Object.values(quotes).map(x => x && x.ticktime).filter(Boolean).sort();
  const latestQT = qTimes.length ? qTimes[qTimes.length - 1] : null;
  const quoteTick = latestQT && String(latestQT).length >= 14
    ? String(latestQT).slice(8, 10) + ':' + String(latestQT).slice(10, 12) + ':' + String(latestQT).slice(12, 14) : null;

  const meta = {
    ...beijingNow(),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    poolDate: pools.date || null,
    prevPoolDate: prevDate || null,
    prevCodesCount: prevCodes.length,
    quotesOk: Object.keys(quotes).length,
    quoteTick,
    historyDates: history.dates || [],
    historyNote: history.note || '',
    health: ds.getHealth(), port: ACTIVE_PORT,
    sources: Object.values(ds.SOURCE_META).map(s => ({ label: s.label, host: s.host, standby: !!s.standby })),
    filters: options,
    empty: !(pools.zt || []).length,
    emptyReason: !(pools.zt || []).length
      ? '东方财富涨停池当前返回空名单（可能是非交易时段、上游临时不可用或当日无涨停），系统不会用推测数据填充。'
      : null,
    conceptBoardCount: topBoards.length,
    dataSourceNote: g.metaNote + '；实时溢价快照时点 ' + (quoteTick || '—') + '；指数：腾讯证券；题材理解补充：新浪财经概念 / 行业板块成分映射（' + topBoards.length + ' 个板块）与涨停股名称字面聚类；严重异动预测 = 日K累计涨幅（' + risk.summary.klineOk + '/' + risk.summary.klineTotal + ' 只可用）+ 个股公告风险词（' + annItems.length + ' 条）。',
    disclaimer: DISCLAIMER
  };
  const edgeStats = getEdgeStatsSnapshot(query.edgeDays);
  return { meta, ...g, edgeStats };
}

async function getDragon(query, force) {
  const key = JSON.stringify({
    edgeDays: query.edgeDays || '',
    days: query.days || '', board: query.board || '', capMin: query.capMin || '',
    capMax: query.capMax || '', keyword: query.keyword || '', excludeST: query.excludeST || '',
    sort: query.sort || '', sortDir: query.sortDir || '', limit: query.limit || '',
    showAll: query.showAll || '', role: query.role || ''
  });
  return cachedCall(dragonCache, key, force, () => buildDragon(query));
}

/* ─────────── 明日龙头 · 历史回放（逐日重放 + 事后晋级验证） ─────────── */
const dragonReviewCache = createCache(300000);

async function getDragonReview(query, force) {
  let date = String(query.date || '').replace(/\D/g, '');
  const days = Math.min(15, Math.max(5, Number(query.days) || 15));
  const key = JSON.stringify({
    date, days, showAll: query.showAll || '',
    sort: query.sort || '', sortDir: query.sortDir || '', role: query.role || '',
    limit: query.limit || '', board: query.board || '', capMin: query.capMin || '',
    capMax: query.capMax || '', excludeST: query.excludeST || '', keyword: query.keyword || ''
  });
  return cachedCall(dragonReviewCache, key, force, async () => {
    const t0 = Date.now();
    const history = await ds.getPoolFullHistory(days);
      if (!date && (history.dates || []).length) date = String(history.dates[0].date);
      const options = {
        date,
        board: query.board, capMin: query.capMin, capMax: query.capMax, keyword: query.keyword,
        excludeST: query.excludeST, sort: query.sort, sortDir: query.sortDir,
        limit: query.limit, showAll: query.showAll === undefined ? '1' : query.showAll, role: query.role,
        days
      };
      let g = an.dragonReview(history, options);
      if (g.error) {
        return { error: g.error, availableDates: g.availableDates || [], meta: { ...beijingNow(), port: ACTIVE_PORT } };
      }
      // 次日涨跌幅取真实日K：只有存在下一交易日时才拉（最新回放日无需请求），
      // 限流并发 3 并复用日K共享缓存，避免触发上游 WAF；失败时如实降级，不影响晋级验证。
      const perfCodes = g.review.nextDate
        ? [...new Set((g.review.outcome || []).map(o => String(o.code)).filter(Boolean))].slice(0, 60)
        : [];
      let klines = {};
      if (perfCodes.length) {
        const krs = await limitedMap(perfCodes, 3, async c => {
          const k = await ds.getKlineData(c, 60).catch(() => null);
          return (k && Array.isArray(k.rows) && k.rows.length)
            ? { code: c, rows: k.rows, source: k.source, adjusted: k.adjusted }
            : null;
        });
        krs.forEach(x => { if (x) klines[x.code] = x; });
      }
      g = an.attachReviewPerf(g, klines);
      const perf = (g.review.summary && g.review.summary.perf) || {};
      const meta = {
        ...beijingNow(),
        generatedAt: new Date().toISOString(),
        poolDate: g.review.date,
        nextDate: g.review.nextDate,
        historyDates: history.dates || [],
        historyNote: history.note || '',
        quoteTick: null, quotesOk: 0, prevCodesCount: 0,
        conceptBoardCount: 0,
        elapsedMs: Date.now() - t0,
        isReview: true,
        perfAvailable: perf.available || 0,
        perfTotal: perf.total || 0,
        perfSources: perf.sources || [],
        perfAdjusted: perf.adjustedModes || [],
        dataSourceNote: g.metaNote + '；历史回放不接实时快照 / 指数 / 概念映射，「昨日连板今日溢价」按中性计，与当日实时版温度不直接可比。',
        disclaimer: DISCLAIMER
      };
      return { meta, ...g };
  });
}

/* ─────────── 消息面实时监控（公告 + 7×24 快讯，独立短缓存与新增标记） ─────────── */
const newsCache = createCache(20000);
const newsSeen = new Map();     // 条目 ID → 服务端首次发现时间（ms），用于「新增」标记
let newsWarm = false;           // 首轮只建立基线，不把所有历史消息都标成新增

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : def;
}

function dragonCandidates(dg, codes) {
  const rows = [...(dg.allRoles || []), ...(dg.list || []), ...(dg.excluded || [])];
  const byCode = new Map();
  for (const r of rows) if (r && r.code && !byCode.has(String(r.code))) byCode.set(String(r.code), r);
  const out = [];
  for (const c of codes) {
    const r = byCode.get(String(c));
    if (!r) continue;
    out.push({
      code: String(r.code), name: r.name, boards: r.boards, boardLabel: r.boardLabel,
      role: r.role, dtype: r.dtype, isLeader: !!r.isLeader,
      consensus: r.consensus, divergence: r.divergence
    });
  }
  return out;
}

async function buildNews(query) {
  const t0 = Date.now();
  const windowHours = clampNum(query.window, 1, 336, 48);
  const limit = clampNum(query.limit, 10, 120, 60);
  const scope = query.scope === 'pool' ? 'pool' : 'leaders';
  const explicit = [...new Set(String(query.codes || '').split(',')
    .map(c => String(c).replace(/\D/g, '')).filter(c => /^\d{6}$/.test(c)))].slice(0, 80);

  let dg = { list: [], allRoles: [], excluded: [], meta: {} };
  let dgErr = null;
  try {
    dg = await getDragon({ showAll: scope === 'pool' ? '1' : '0', limit: '60', days: '12' }, false);
  } catch (e) { dgErr = String(e && e.message || e); }

  const codes = explicit.length ? explicit : (dg.list || []).map(x => String(x.code)).filter(Boolean);
  const candidates = dragonCandidates(dg, codes);
  const [ann, flash] = await Promise.all([
    ds.getAnnouncements(codes, Math.max(20, limit)),
    ds.getFlashNews(Math.max(20, Math.min(60, limit)))
  ]);
  const mon = an.newsMonitor({ ann, flash, candidates, windowHours });
  const hs = ds.getHealth().filter(h => ['emAnn', 'sinaFlash', 'emFlash'].indexOf(h.key) >= 0);

  return {
    mon,
    meta: {
      windowHours, scope, limit,
      codesCount: codes.length, candidatesCount: candidates.length,
      poolDate: (dg.meta && dg.meta.poolDate) || null,
      generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      annCount: (ann && ann.items ? ann.items.length : 0),
      flashCount: (flash && flash.items ? flash.items.length : 0),
      annAsOf: (ann && ann.asOf) || null, flashAsOf: (flash && flash.asOf) || null,
      sources: hs.map(h => ({ key: h.key, label: h.label, ok: h.ok, rows: h.rows, error: h.error, latency: h.latency })),
      sourcesOnline: hs.filter(h => h.ok).length, sourcesTotal: hs.length,
      empty: mon.items.length === 0,
      note: (dgErr ? '龙头候选获取失败（' + dgErr + '），本次退化为全市场公告与快讯，未做个股关联；' : '') +
        (codes.length ? '按 ' + codes.length + ' 只候选代码查询公告' : '当前无候选代码，展示全市场最新公告') +
        '；消息源为免费公开接口的定时轮询，不是交易所官方推送。'
    }
  };
}

async function getNews(query, force) {
  const key = JSON.stringify({ window: query.window || '', scope: query.scope || '', codes: query.codes || '', limit: query.limit || '' });
  const data = await cachedCall(newsCache, key, force, () => buildNews(query));

  // 每轮按服务端首次发现时间重算「新增」，首轮只建基线
  const nowMs = Date.now();
  const fresh = new Set();
  for (const it of data.mon.items) {
    if (!newsSeen.has(it.id)) {
      newsSeen.set(it.id, nowMs);
      if (newsWarm) fresh.add(it.id);
    }
    it.firstSeenAt = new Date(newsSeen.get(it.id)).toISOString();
    it.isNew = fresh.has(it.id);
  }
  newsWarm = true;
  for (const [id, t] of newsSeen) if (nowMs - t > 7 * 86400000) newsSeen.delete(id);

  const sinceMs = query.since ? Date.parse(String(query.since)) : NaN;
  const newCount = Number.isFinite(sinceMs)
    ? data.mon.items.filter(x => Date.parse(x.firstSeenAt) > sinceMs).length
    : fresh.size;

  return {
    meta: {
      ...data.meta,
      generatedAt: new Date(nowMs).toISOString(),
      since: query.since || null, newCount, freshCount: fresh.size,
      seenCount: newsSeen.size, pollIntervalSec: 30,
      disclaimer: DISCLAIMER
    },
    summary: { ...data.mon.summary, newCount },
    alerts: data.mon.alerts,
    items: data.mon.items,
    methodology: data.mon.methodology,
    disclaimer: DISCLAIMER
  };
}

/* ─────────── 龙场悟道 · 多方法回测选优 ─────────── */
const enlightenCache = createCache(600000);

async function buildEnlightenment(query) {
  const t0 = Date.now();
  const q = { ...query };
  delete q._; delete q.force;
  const days = Math.min(12, Math.max(5, Number(q.days) || 8));
  const perDay = Math.min(24, Math.max(8, Number(q.perDay) || 12));
  const minSamples = Math.min(60, Math.max(5, Number(q.minSamples) || 10));

  const [pools, history, universe, indices, boards] = await Promise.all([
    ds.getPools().catch(() => ({ zt: [], zb: [], qs: [], dt: [], date: '' })),
    ds.getPoolFullHistory(days + 2).catch(() => ({ dates: [], byDate: {}, note: '' })),
    ds.getUniverse().catch(() => ({ list: [], count: 0, expected: 0, asOf: new Date().toISOString() })),
    ds.getIndices().catch(() => []),
    ds.getSectorBoards().catch(() => ({ industry: [], concept: [] }))
  ]);

  const ov = an.marketOverview(universe, indices, pools);
  const themes = an.buildThemes(pools, boards);
  const allDates = (history.dates || []).map(d => d.date);
  const baseDates = allDates.slice(0, days);
  const byDate = history.byDate || {};

  // 当前实时快照：候选展示用
  const nowCodes = (pools.zt || []).map(x => x.code);
  const quotes = nowCodes.length ? await ds.getQQQuotes(nowCodes).catch(() => ({})) : {};

  // 历史候选代码去重：每个基准日按成交额取前 perDay 只，控制日K请求量
  const codeStat = new Map();
  for (const d of baseDates) {
    const zt = (byDate[d] && byDate[d].zt) || [];
    zt.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, perDay)
      .forEach(x => {
        if (!x || !x.code) return;
        const s = codeStat.get(x.code) || { code: x.code, hits: 0, amount: 0 };
        s.hits++; s.amount = Math.max(s.amount, Number(x.amount) || 0);
        codeStat.set(x.code, s);
      });
  }
  const codes = [...codeStat.values()].sort((a, b) => b.hits - a.hits || b.amount - a.amount)
    .slice(0, 120).map(x => x.code);
  // 低并发 + 批间微延迟：回测一次会请求上百只日K，瞬时高并发出触发腾讯 WAF 限流，
  // 进而把整个系统降级到不复权口径。已有缓存的代码不会重复请求。
  const kdata = await limitedMap(codes, 2, async c => {
    const r = await ds.getKlineData(c, 120).catch(() => null);
    await new Promise(res => setTimeout(res, 40));
    return r;
  });
  const kByCode = new Map();
  codes.forEach((c, i) => {
    if (kdata[i] && kdata[i].rows && kdata[i].rows.length) {
      kByCode.set(c, { rows: kdata[i].rows, source: kdata[i].source, adjusted: kdata[i].adjusted });
    }
  });

  const g = an.enlightenmentBacktest({
    history, kByCode, baseDates, pools, quotes, overview: ov, themes, minSamples
  });

  const klineSources = [...new Set([...kByCode.values()].map(k => k.source).filter(Boolean))];
  const qTimes = Object.values(quotes).map(x => x && x.ticktime).filter(Boolean).sort();
  const latestQT = qTimes.length ? qTimes[qTimes.length - 1] : null;
  const quoteTick = latestQT && String(latestQT).length >= 14
    ? String(latestQT).slice(8, 10) + ':' + String(latestQT).slice(10, 12) + ':' + String(latestQT).slice(12, 14) : null;

  const meta = {
    ...beijingNow(), generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
    poolDate: pools.date || null, quoteTick, days, perDay, minSamples,
    historyDays: allDates.length, historyRange: [allDates[allDates.length - 1] || null, allDates[0] || null],
    baseDates, codesRequested: codes.length, klineOk: kByCode.size, klineSources,
    fallback: klineSources.some(s => /新浪/.test(s)),
    health: ds.getHealth(), port: ACTIVE_PORT,
    methodology: an.ENLIGHTEN_METHOD,
    empty: !baseDates.length,
    emptyReason: !baseDates.length ? '东方财富历史涨停池未返回可用交易日，无法回测；系统不填充推测数据。' : null,
    dataSourceNote: g.metaNote,
    disclaimer: DISCLAIMER
  };
  return { meta, ...g };
}

async function getEnlightenment(query, force) {
  const key = JSON.stringify({ days: query.days || '', perDay: query.perDay || '', minSamples: query.minSamples || '' });
  return cachedCall(enlightenCache, key, force, () => buildEnlightenment(query));
}

/* ─────────── 集合竞价 · 首板封板概率（历史回测） ─────────── */
const auctionCache = createCache(600000);

async function buildAuction(query) {
  const t0 = Date.now();
  const f = { ...query };
  delete f._; delete f.force;
  const days = Math.min(15, Math.max(5, Number(f.days) || 10));
  const history = await ds.getPoolFullHistory(days).catch(() => ({ dates: [], byDate: {}, note: '' }));
  const dates = history.dates || [];
  if (!dates.length) {
    return {
      meta: { generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, poolDates: [], klineSource: ds.getKlineSource(), health: ds.getHealth(), disclaimer: DISCLAIMER },
      available: false, reason: '东方财富历史涨停池未返回可用交易日，无法回测竞价首板概率；系统不填充推测数据。',
      buckets: [], list: [], validation: null, method: an.AUCTION_METHOD
    };
  }
  // 收集所有交易日首板（含炸板）代码，去重后并发拉日K（供竞价 gap 计算）
  const codes = new Set();
  dates.forEach(d => {
    const day = history.byDate[d.date] || {};
    (day.zt || []).concat(day.zb || []).forEach(x => {
      if (x && !x.isST && (Number(x.boards) || 1) === 1 && x.code) codes.add(x.code);
    });
  });
  const codeList = [...codes];
  const kdata = await limitedMap(codeList, 5, async c => {
    // 位置因子（距20日高/均线多头/近5日涨幅）需至少21根日K，取60根留足余量
    try { return [c, await ds.getKline(c, 60)]; } catch (e) { return [c, []]; }
  });
  const klinesMap = {};
  kdata.forEach(pair => { if (pair && pair[0]) klinesMap[pair[0]] = pair[1] || []; });

  const g = an.auctionFirstBoard(history, klinesMap, { minN: 3, smooth: 1 });
  const klinesOk = codeList.filter(c => Array.isArray(klinesMap[c]) && klinesMap[c].length > 1).length;
  const meta = {
    ...beijingNow(),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    poolDates: dates.map(d => d.date),
    days,
    candidates: codeList.length,
    klinesOk,
    klineSource: ds.getKlineSource(),
    health: ds.getHealth(),
    methodology: an.AUCTION_METHOD,
    factors: an.AUCTION_FACTORS,
    rolling: g.validation ? g.validation.rolling : null,
    empty: !g.available,
    emptyReason: g.available ? null : (g.reason || '样本不足'),
    dataSourceNote: '候选与封板标签=东方财富涨停池 / 炸板池（首板、剔除ST）；特征=腾讯前复权日K（限流时降级新浪不复权）的竞价高开、位置/涨幅、昨日量能 + 历史池上榜热度，全部盘前可知；概率=多因子 WoE 评分卡（等价分档逻辑回归）在训练样本上的拟合，最近1日样本外 + 多日滚动验证。均为免费公开接口快照，非交易所官方推送。',
    disclaimer: DISCLAIMER
  };
  return { meta, ...g };
}

async function getAuction(query, force) {
  const key = JSON.stringify({ days: query.days || '' });
  return cachedCall(auctionCache, key, force, () => buildAuction(query));
}


/* ─────────── 集合竞价 · 9:25 首板预测（落盘 / 回填 / 校准） ─────────── */
const PRED_DIR = path.join(__dirname, 'data', 'predictions');
try { fs.mkdirSync(PRED_DIR, { recursive: true }); } catch (e) { /* 只读环境忽略 */ }
const predictCache = createCache(300000);
const predR1 = x => Math.round(x * 10) / 10;   // 保留1位小数
const predBoardOf = code => { const c = String(code || ''); if (/^(30|68[89])/.test(c)) return '创业板/科创'; if (/^[48]/.test(c) || /^92/.test(c)) return '北交所'; return '主板'; };
const PRED_CALIB_MIN_DAYS = 20;

function predFilePath(date) {
  const d = String(date || '').replace(/\D/g, '');
  return path.join(PRED_DIR, d + '.json');
}
function readPrediction(date) {
  try {
    const txt = fs.readFileSync(predFilePath(date), 'utf8');
    return JSON.parse(txt);
  } catch (e) { return null; }
}
function writePrediction(date, obj) {
  try {
    fs.writeFileSync(predFilePath(date), JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) { return false; }
}
function listPredictionDates() {
  try {
    return fs.readdirSync(PRED_DIR).filter(f => /^\d{8}\.json$/.test(f)).map(f => f.slice(0, 8)).sort();
  } catch (e) { return []; }
}

/** 从回填记录计算各信号分档实测封板率；满20交易日才返回校准表 */
function buildCalibration() {
  const dates = listPredictionDates();
  const bucketAgg = {};
  let filledDays = 0, totalSamples = 0, sealedTotal = 0;
  const bounds = [[0, 50], [50, 60], [60, 70], [70, 80], [80, 101]];
  dates.forEach(d => {
    const rec = readPrediction(d);
    if (!rec || !rec.list || !rec.backfilled) return;
    let hasResult = false;
    rec.list.forEach(x => {
      if (x.result === null || x.result === undefined) return;
      hasResult = true; totalSamples++;
      if (x.result === 1) sealedTotal++;
      const b = bounds.find(r => x.score >= r[0] && x.score < r[1]);
      if (!b) return;
      const key = b[0] + '_' + b[1];
      if (!bucketAgg[key]) bucketAgg[key] = { min: b[0], max: b[1], sealed: 0, n: 0 };
      bucketAgg[key].n++; if (x.result === 1) bucketAgg[key].sealed++;
    });
    if (hasResult) filledDays++;
  });
  const overallRate = totalSamples ? predR1(sealedTotal / totalSamples * 100) : null;
  const buckets = Object.values(bucketAgg).map(b => ({
    min: b.min, max: b.max, n: b.n,
    prob: b.n >= 5 ? predR1((b.sealed + 0.5) / (b.n + 1) * 100) : null,
    rate: predR1(b.sealed / b.n * 100)
  }));
  return {
    filledDays, totalSamples, overallRate, buckets,
    ready: filledDays >= PRED_CALIB_MIN_DAYS,
    minDays: PRED_CALIB_MIN_DAYS
  };
}

/** 该交易日是否已经收盘、可以回填：历史日恒可；当天仅盘后可；未来日不可（避免未来函数） */
function canBackfill(tradeDate) {
  const d = String(tradeDate || '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(d)) return false;
  const bj = beijingNow();
  const today = bj.date.replace(/-/g, '');
  if (d > today) return false;
  if (d < today) return true;
  return bj.state === '盘后'; // 当天：收盘后才回填
}

/** T 日收盘回填：按 tradeDate 取对应交易日的涨停池(首板)/炸板池判定候选是否封住。
 *  历史日从完整历史池按日期取，当天取实时池；上游该日池为空时保持"待回填"，不误判为未封。 */
async function backfillPrediction(tradeDate) {
  const d = String(tradeDate || '').replace(/\D/g, '');
  const rec = readPrediction(d);
  if (!rec || !rec.list || rec.backfilled) return rec;
  if (!canBackfill(d)) return rec;                 // 未收盘：继续待回填
  const today = beijingNow().date.replace(/-/g, '');
  let zt = [], zb = [], poolDate = d, poolSource = '';
  if (d === today) {
    const pools = await ds.getPools().catch(() => ({}));
    zt = pools.zt || pools.limitUp || [];
    zb = pools.zb || pools.broken || [];
    poolDate = pools.date || d;
    poolSource = '当日涨停/炸板池';
  } else {
    const hist = await ds.getPoolFullHistory(15, true).catch(() => ({ byDate: {} }));
    const day = (hist.byDate || {})[d] || {};
    zt = day.zt || [];
    zb = day.zb || [];
    poolSource = '历史涨停/炸板池';
  }
  // 上游该交易日池数据不可用：如实保持待回填，不用"未封"污染样本
  if (!zt.length && !zb.length) {
    rec.backfillReason = poolSource + '暂不可用（' + d + '），保持待回填';
    return rec;
  }
  const sealed = new Set(zt.filter(x => x && (Number(x.boards) || 1) === 1 && !x.isST).map(x => String(x.code).padStart(6, '0')));
  const broken = new Set(zb.filter(x => x && (Number(x.boards) || 1) === 1 && !x.isST).map(x => String(x.code).padStart(6, '0')));
  let n = 0;
  rec.list.forEach(x => {
    const code = String(x.code || '').padStart(6, '0');
    if (sealed.has(code)) { x.result = 1; x.resultLabel = '封住首板'; n++; }
    else if (broken.has(code)) { x.result = 0; x.resultLabel = '炸板未封'; n++; }
    else { x.result = 0; x.resultLabel = '未封'; n++; }
  });
  rec.backfilled = true;
  rec.backfillAt = new Date().toISOString();
  rec.backfillPool = { date: poolDate, source: poolSource, zt: zt.length, zb: zb.length };
  delete rec.backfillReason;
  rec.stat = { total: rec.list.length, withResult: n, sealed: rec.list.filter(x => x.result === 1).length };
  writePrediction(d, rec);
  // 回填后让预测缓存失效，保证下次读取拿到带结果的快照
  invalidateCache(predictCache);
  return rec;
}

/** 近期涨停池 code→industry 映射，补候选行业热度（零额外请求、盘前可知） */
function buildIndustryMap(history) {
  const map = {};
  ((history && history.dates) || []).slice(-3).forEach(d => {
    const day = (history && history.byDate && history.byDate[d.date]) || {};
    ((day.zt || []).concat(day.zb || [])).forEach(x => {
      if (x && x.code && x.industry) {
        if (!map[x.code]) map[x.code] = x.industry;
      }
    });
  });
  return map;
}

async function buildPredict(query) {
  const t0 = Date.now();
  const f = { ...query }; delete f._; delete f.force; delete f.mode;
  const replayDate = f.date ? String(f.date).replace(/\D/g, '') : null;

  // 校准数据（满20日才用实测概率）
  const calib = buildCalibration();

  // 回放：直接读落盘快照；若已被覆盖为"待回填"但当日已收盘，则实时拉取对应日池数据回填
  if (replayDate) {
    let rec = readPrediction(replayDate);
    if (!rec) {
      return { meta: { ...beijingNow(), generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, disclaimer: DISCLAIMER },
        available: false, reason: '该交易日无预测快照记录（预测从系统启用日起每日落盘）；系统不填充推测数据。' };
    }
    if (!rec.backfilled && canBackfill(replayDate)) {
      rec = await backfillPrediction(replayDate) || rec;
    }
    const freshCalib = buildCalibration();
    const g = an.auctionPredict([], {}, { dates: [], byDate: {} }, { tradeDate: replayDate });
    g.list = rec.list || [];
    g.summary = rec.summary || g.summary;
    g.tradeDate = replayDate;
    g.baseRate = rec.baseRate || g.baseRate;
    g.calibration = {
      ...(rec.calibration || g.calibration),
      mode: freshCalib.ready ? 'empirical' : 'heuristic',
      days: freshCalib.filledDays,
      label: freshCalib.ready ? '已用 ' + freshCalib.filledDays + ' 日实测校准' : '经验估计（待积累实测）',
      note: freshCalib.ready ? '概率已按累计 ' + freshCalib.filledDays + ' 交易日的真实回填结果分档校准'
        : '累计真实回填满 ' + freshCalib.minDays + ' 个交易日后切换为实测概率；当前已回填 ' + freshCalib.filledDays + ' 日'
    };
    g.stat = rec.stat || null;
    g.backfillPool = rec.backfillPool || null;
    g.replay = true;
    g.note = '历史预测快照回放（9:25 落盘的原始预测，未被后续结果污染）；' + (rec.backfilled ? '已回填当日真实结果。' : (rec.backfillReason || '尚未回填结果。'));
    return { meta: { ...beijingNow(), generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, replay: true, backfilled: !!rec.backfilled, calibration: freshCalib, disclaimer: DISCLAIMER }, ...g };
  }

  // 实时/回演：抓全市场竞价快照
  const uni = await ds.getUniverse(true).catch(() => ({ list: [] }));
  const snapAll = (uni.list || []).filter(r => Number.isFinite(Number(r.open)) && Number(r.prevClose) > 0 && Number(r.open) > 0)
    .map(r => ({ code: String(r.code || '').padStart(6, '0'), name: r.name, open: Number(r.open), prevClose: Number(r.prevClose), floatCap: r.floatCap }));
  const cand0 = snapAll.filter(r => {
    const gap = (r.open / r.prevClose - 1) * 100;
    return gap >= 1.5 && gap <= 9.8 && !/ST|退/i.test(r.name || '');
  });
  // 竞价量比 + 竞价成交额（腾讯快照；9:15~9:30 为真实竞价数据，盘后退化为全天，禁用竞价额）
  const qq = await ds.getQQQuotes(cand0.map(r => r.code), { ttl: 8000 }).catch(() => ({}));
  const sessionState = beijingNow().state;
  const inAuction = sessionState === '集合竞价';
  cand0.forEach(r => {
    const q = qq[r.code];
    if (q) {
      r.volRatio = q.volRatio; r.industry = ''; r.board = '';
      // 竞价成交额：仅集合竞价时段的快照成交额是竞价额；盘后为全天成交额，不可当竞价额用
      r.auctionAmount = (inAuction && Number.isFinite(q.amountWan) && q.amountWan > 0)
        ? q.amountWan * 1e4 : null;
    } else {
      r.auctionAmount = null;
    }
  });
  // 候选日K（昨日量能）
  const km = {};
  const kd = await limitedMap(cand0.map(r => r.code), 6, async c => {
    try { return [c, await ds.getKline(c, 60)]; } catch (e) { return [c, []]; }
  });
  kd.forEach(p => { if (p && p[0]) km[p[0]] = p[1] || []; });
  // 历史池（题材热度 + 行业映射）
  const history = await ds.getPoolFullHistory(12).catch(() => ({ dates: [], byDate: {} }));
  const indMap = buildIndustryMap(history);
  cand0.forEach(r => {
    if (indMap[r.code]) r.industry = indMap[r.code];
    if (!r.board) r.board = predBoardOf(r.code);
  });

  const tradeDate = beijingNow().date.replace(/-/g, '');
  const g = an.auctionPredict(cand0, km, history, {
    tradeDate,
    baseRate: (calib.ready && calib.overallRate !== null) ? calib.overallRate : 8,
    calibratedBuckets: calib.ready ? calib.buckets : null,
    calibratedDays: calib.filledDays
  });
  // 落盘（只保留必要字段，避免快照过大）
  const rec = {
    tradeDate, generatedAt: new Date().toISOString(),
    baseRate: g.baseRate, calibration: g.calibration, summary: g.summary,
    list: g.list.map(x => ({
      code: x.code, name: x.name, industry: x.industry, board: x.board,
      gap: x.gap, volRatio: x.volRatio, floatCap: x.floatCap,
      auctionAmount: x.auctionAmount, auctionTurnover: x.auctionTurnover, auctionUsable: x.auctionUsable,
      baseScore: x.baseScore,
      score: x.score, tier: x.tier, tierLabel: x.tierLabel, expProb: x.expProb, probLabel: x.probLabel,
      oneWord: x.oneWord, signals: x.signals, rank: x.rank
    })),
    backfilled: false
  };
  const saved = writePrediction(tradeDate, rec);
  // 收盘后"生成当前"也实时回填一次：拉取当日涨停/炸板池，把真实结果并入返回列表
  let filled = rec, gList = g.list;
  if (canBackfill(tradeDate)) {
    filled = await backfillPrediction(tradeDate) || rec;
    if (filled.backfilled) {
      const resByCode = {};
      filled.list.forEach(x => { resByCode[String(x.code).padStart(6, '0')] = x; });
      gList = g.list.map(x => {
        const r = resByCode[String(x.code).padStart(6, '0')];
        return r ? { ...x, result: r.result, resultLabel: r.resultLabel } : x;
      });
    }
  }
  const state = beijingNow();
  // 回填可能刚完成，重算校准累计，避免展示天数滞后一天
  const freshCalib = filled.backfilled ? buildCalibration() : calib;
  const gCal = { ...g.calibration,
    mode: freshCalib.ready ? 'empirical' : 'heuristic',
    days: freshCalib.filledDays,
    label: freshCalib.ready ? '已用 ' + freshCalib.filledDays + ' 日实测校准' : '经验估计（待积累实测）',
    note: freshCalib.ready ? '概率已按累计 ' + freshCalib.filledDays + ' 交易日的真实回填结果分档校准'
      : '累计真实回填满 ' + freshCalib.minDays + ' 个交易日后切换为实测概率；当前已回填 ' + freshCalib.filledDays + ' 日'
  };
  const meta = {
    ...state, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
    tradeDate, universeCount: snapAll.length, candidates: cand0.length,
    auctionState: sessionState, auctionAmountEnabled: inAuction,
    backfilled: !!filled.backfilled, backfillPool: filled.backfillPool || null,
    klinesOk: cand0.filter(r => Array.isArray(km[r.code]) && km[r.code].length > 1).length,
    klineSource: ds.getKlineSource(),
    saved, predictionFile: 'data/predictions/' + tradeDate + '.json',
    calibration: freshCalib,
    methodology: an.AUCTION_PREDICT_METHOD,
    dataSourceNote: '候选=新浪全市场竞价快照（开盘价÷前收）筛高开1.5~9.8%；量比=腾讯实时快照（9:25~9:30为竞价量比，盘后为全天量比）；竞价成交额=腾讯快照成交额（仅集合竞价时段取值，盘后禁用，作惩罚项）；昨日量能/题材热度=腾讯日K与东方财富历史涨停池。概率=经验估计（基准约8%），每日落盘回填，满20日切换实测。均为免费公开快照。',
    disclaimer: DISCLAIMER
  };
  return { meta, ...g, calibration: gCal, list: gList, stat: filled.stat || null, note: filled.backfillReason || (filled.backfilled ? '已实时拉取当日真实封板结果回填。' : g.note) };
}

async function getPredict(query, force) {
  const key = JSON.stringify({ date: query.date || '', mode: query.mode || '' });
  return cachedCall(predictCache, key, force, () => buildPredict(query));
}

/* ─────────── 路由 ─────────── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:' + ACTIVE_PORT);
  const q = Object.fromEntries(u.searchParams.entries());
  try {
    if (u.pathname === '/api/dashboard') return sendJson(res, await getDashboard(q, q.force === '1'));
    if (u.pathname === '/api/ai/status') return sendJson(res, aiStatus());
    if (u.pathname === '/api/ai/config' && req.method === 'POST') {
      const b = await readJsonBody(req);
      if (b.clear) {
        aiConfig.baseUrl = ''; aiConfig.apiKey = ''; aiConfig.model = '';
      } else {
        const base = String(b.baseUrl || '').trim();
        const key = String(b.apiKey || '').trim();
        if (!/^https?:\/\//i.test(base)) return sendJson(res, { error: '接口地址需以 http:// 或 https:// 开头' }, 400);
        if (!key) return sendJson(res, { error: 'API Key 不能为空' }, 400);
        aiConfig.baseUrl = base.replace(/\/+$/, '');
        aiConfig.apiKey = key;
        aiConfig.model = String(b.model || 'gpt-4o-mini').trim();
      }
      return sendJson(res, { ok: true, ...aiStatus() });
    }
    if (u.pathname === '/api/ai/analyze' && req.method === 'POST') {
      const st = aiStatus();
      if (!st.configured) return sendJson(res, { error: '未配置大模型，当前展示的是本地量化研判引擎结果' }, 400);
      try {
        const d = await getDashboard({}, false);
        const out = await postJson(st.baseUrl + '/chat/completions',
          { 'Authorization': 'Bearer ' + aiConfig.apiKey },
          {
            model: st.model, temperature: 0.3, max_tokens: 2200,
            messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: buildAiPrompt(d) }]
          });
        const text = out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
        if (!text) throw new Error('模型返回内容为空：' + JSON.stringify(out).slice(0, 300));
        return sendJson(res, {
          text, model: st.model, generatedAt: new Date().toISOString(),
          basedOn: { poolDate: d.meta.poolDate, quoteTick: d.meta.quoteTick, universeTick: d.meta.universeTick },
          caveat: '以上为大模型基于本页真实行情摘要生成的文本，可能包含不准确内容，请以数据表格与交易所公告为准；不构成投资建议。'
        });
      } catch (e) {
        return sendJson(res, { error: '大模型调用失败：' + String(e && e.message || e) + '。可检查接口地址 / Key / 模型名，或继续使用本地量化研判引擎。' }, 502);
      }
    }
    if (u.pathname === '/api/pullback') return sendJson(res, await getPullback(q, q.force === '1'));
    if (u.pathname === '/api/support-reversal') {
      const v = await getSupportReversal(q, q.force === '1');
      return sendJson(res, { ok: v.ok, meta: v.meta, result: v.result });
    }
    if (u.pathname === '/api/support-reversal/samples') return sendJson(res, await getSupportReversalSamples(q));
    if (u.pathname === '/api/ddx-first-red') {
      const v = await getDdxFirstRed(q, q.force === '1');
      return sendJson(res, { ok: v.ok, meta: v.meta, result: v.result });
    }
    if (u.pathname === '/api/ddx-first-red/samples') return sendJson(res, await getDdxFirstRedSamples(q));
    if (u.pathname === '/api/backtest') return sendJson(res, await getBacktest(q, q.force === '1'));
    if (u.pathname === '/api/dragon') return sendJson(res, await getDragon(q, q.force === '1'));
    if (u.pathname === '/api/dragon/edge-stats') {
      const v = await getEdgeStats(q.days || q.edgeDays, q.force === '1');
      return sendJson(res, { ...v, daysOptions: EDGE_DAYS_OPTIONS, days: edgeDaysOf(q.days || q.edgeDays) });
    }
    if (u.pathname === '/api/dragon/review') return sendJson(res, await getDragonReview(q, q.force === '1'));
    if (u.pathname === '/api/news') return sendJson(res, await getNews(q, q.force === '1'));
    if (u.pathname === '/api/enlightenment') return sendJson(res, await getEnlightenment(q, q.force === '1'));
    if (u.pathname === '/api/auction') return sendJson(res, await getAuction(q, q.force === '1'));
    if (u.pathname === '/api/predict') {
      if (q.mode === 'backfill') return sendJson(res, { ok: true, result: await backfillPrediction(q.date || beijingNow().date.replace(/-/g, '')) });
      return sendJson(res, await getPredict(q, q.force === '1'));
    }
    if (u.pathname === '/api/health') return sendJson(res, { ...beijingNow(), port: ACTIVE_PORT, health: ds.getHealth(), ai: aiStatus(), disclaimer: DISCLAIMER });
    if (u.pathname === '/api/search') {
      const kw = String(q.q || '').trim();
      if (!kw) return sendJson(res, { list: [], total: 0 });
      const uni = await ds.getUniverseStale().catch(() => ({ list: [] }));
      const k = kw.toLowerCase();
      const numeric = /^\d+$/.test(k);
      const pyMode = /^[a-z]+$/.test(k); // 纯字母：按拼音首字母匹配（含 ST 前缀）
      // 打分：精确 > 前缀 > 包含；每只股票只算一次分，排序直接复用，避免比较器里重复算首字母
      const rows = [];
      for (const x of (uni.list || [])) {
        const code = String(x.code || ''), name = String(x.name || '').toLowerCase();
        let s = 0;
        if (code === k) s = 8;
        else if (name === k) s = 7;
        else if (numeric) s = code.includes(k) ? (code.startsWith(k) ? 6 : 3) : 0;
        else if (pyMode) {
          const ini = py.initialsOf(name);
          s = ini === k ? 7 : (ini.startsWith(k) ? 6 : (ini.includes(k) ? 4 : 0));
        } else if (name.includes(k)) s = code.startsWith(k) ? 6 : 4;
        else s = code.includes(k) ? 3 : 0;
        if (s > 0) rows.push({ x, s, pct: Number(x.pct) || 0 });
      }
      rows.sort((a, b) => b.s - a.s || b.pct - a.pct);
      const list = rows.slice(0, 12).map(r => ({
        code: r.x.code, name: r.x.name, price: r.x.price, pct: r.x.pct,
        board: r.x.board, industry: r.x.industry || null, floatCap: r.x.floatCap
      }));
      return sendJson(res, { list, total: list.length, asOf: uni.asOf || null, source: ds.SOURCE_META.sina.label });
    }
    if (u.pathname === '/api/ladder') {
      const hist = await ds.getPoolFullHistory(15, true).catch(() => ({ dates: [], byDate: {} }));
      const dates = (hist.dates || []).map(x => x.date);
      const wanted = /^\d{8}$/.test(q.date || '') ? q.date : (dates[0] || null);
      const zt = ((wanted && (hist.byDate[wanted] || {}).zt) || []).slice();
      const zb = (wanted && (hist.byDate[wanted] || {}).zb) || [];
      const dt = (wanted && (hist.byDate[wanted] || {}).dt) || [];
      // 历史回放标记：只用截至该日的历史窗口统计概率，不含该日之后的任何结果，避免未来函数
      const idx = dates.indexOf(wanted);
      const histUpTo = idx >= 0
        ? { dates: (hist.dates || []).slice(idx), byDate: hist.byDate, source: hist.source }
        : hist;
      const dayPools = { zt, zb, dt, date: wanted };
      let seedStat = null, seedMarks = {}, cumMarks = {}, dragonEdges = {};
      try {
        const seed = an.firstBoardSeedBacktest(histUpTo, dayPools, { asOf: wanted });
        seedMarks = seed.marks || {};
        cumMarks = seed.cumMarks || {};
        seedStat = {
          days: seed.days, samples: seed.samples, baseRate: seed.baseRate,
          dragonBaseRate: seed.dragonBaseRate, tiers: seed.tiers,
          cumBase: seed.cumBase, cumTiers: seed.cumTiers, cumCountTiers: seed.cumCountTiers,
          factors: seed.factors, note: seed.note, asOf: wanted
        };
      } catch (e) { console.warn('[ladder] 首板种子标记失败：' + e.message); }
      const edgeSnapshot = getEdgeStatsSnapshot(q.edgeDays);
      try { dragonEdges = an.dragonEdgeMarks(dayPools, histUpTo, edgeSnapshot && edgeSnapshot.marks, edgeSnapshot && edgeSnapshot.smallMarks); }
      catch (e) { console.warn('[ladder] 历史优势组合标记失败：' + e.message); }
      const markedZt = zt.map(x => Object.assign({}, x, {
        seedMark: seedMarks[x.code] || null,
        cumRate: cumMarks[x.code] || null,
        dragonEdge: dragonEdges[x.code] || null
      }));
      return sendJson(res, {
        date: wanted, dates: dates.map(d => {
          const row = hist.byDate[d] || {};
          return { date: d, count: (row.zt || []).length, dtCount: (row.dt || []).length };
        }),
        zt: markedZt, zbCount: zb.length, dt, firstBoardSeed: seedStat,
        source: ds.SOURCE_META.emPool.label, asOf: new Date().toISOString()
      });
    }
    if (u.pathname === '/api/fundflow') return sendJson(res, await ds.getFundFlow());
    if (u.pathname === '/api/boards') return sendJson(res, await ds.getSectorBoards());
    if (u.pathname === '/api/pools') return sendJson(res, await ds.getPools());
    if (u.pathname === '/api/quotes') {
      const codes = String(q.codes || '').split(',').filter(Boolean).slice(0, 200);
      return sendJson(res, { quotes: await ds.getQQQuotes(codes), asOf: new Date().toISOString(), source: '腾讯证券实时行情' });
    }
    if (u.pathname === '/api/kline') return sendJson(res, { code: q.code, kline: await ds.getKline(q.code, Number(q.limit) || 90), source: '腾讯证券日K(前复权)' });
    if (u.pathname === '/api/stock/chart') return sendJson(res, await getStockChart(q));
    if (u.pathname === '/api/stock/minute') {
      const code = String(q.code || '').replace(/\D/g, '').slice(0, 6);
      if (!/^\d{6}$/.test(code)) return sendJson(res, { error: '缺少有效的 6 位股票代码' }, 400);
      const date = String(q.date || '').replace(/\D/g, '');
      if (date) {
        // 历史某日分时：腾讯 day/query 仅回溯最近 5 个交易日；当日封单/资金快照不可张冠李戴，历史模式不返回
        const minute = await ds.getMinuteHistory(code, date).catch(() => ({ rows: [], date, source: null, reason: '历史分时接口暂不可用' }));
        const quotes = await ds.getQQQuotes([code]).catch(() => ({}));
        return sendJson(res, {
          code, date, minute, quote: quotes[code] || {}, seal: null, historical: true,
          fund: { now: null }, asOf: new Date().toISOString()
        });
      }
      const [minute, quotes, pools, fundNow] = await Promise.all([
        ds.getMinute(code).catch(() => ({ rows: [], source: null, reason: '上游不可用' })),
        ds.getQQQuotes([code]).catch(() => ({})),
        ds.getPools().catch(() => ({})),
        ds.getStockFundNow(code).catch(() => ({ source: null, reason: '资金快照暂不可用' }))
      ]);
      return sendJson(res, {
        code, minute, quote: quotes[code] || {}, seal: stockSeal(pools, code),
        fund: { now: fundNow }, asOf: new Date().toISOString()
      });
    }
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
// 启动时后台预热默认窗口统计，避免用户首次打开明日龙头时等长历史拉取
setTimeout(() => { getEdgeStats(EDGE_DAYS_DEFAULT, false).catch(() => { }); }, 800);
