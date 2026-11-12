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
dns.setDefaultResultOrder('ipv4first');

const ds = require('./lib/datasource');
const an = require('./lib/analytics');

// 默认 8899：8787 常与其它本地服务冲突；可用环境变量 PORT 覆盖
// 若目标端口被占用，启动时自动顺延到下一个可用端口（最多 15 次），并在控制台打印实际地址
const PREFERRED_PORT = Number(process.env.PORT) || 8899;
let ACTIVE_PORT = PREFERRED_PORT;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const DISCLAIMER = '以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。';

/* ─────────── 可选大模型配置（仅存内存：不落盘、不写日志、不回传密钥） ─────────── */
const aiConfig = { baseUrl: '', apiKey: '', model: '' };
const AI_SYSTEM_PROMPT = '你是严谨的 A 股短线复盘研究助手。严格遵守：1) 只能使用用户消息中提供的行情数据，禁止编造任何数字、公司、事件、新闻、政策或研报；2) 不预测指数涨跌方向，不使用「必涨/必跌」等绝对表述；3) 不给出具体买卖价位、仓位指令或收益承诺；4) 每个结论都要点明依据的数据字段；5) 明确指出数据边界（未接入新闻/公告/龙虎榜、非交易所官方推送）。输出用简体中文，结构清晰、克制、可执行的是观察框架而非交易指令。';

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
  lines.push('【数据边界】以下均为免费公开接口快照，非交易所官方推送；未接入新闻/公告/龙虎榜；不构成投资建议。');
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
const dashCache = { at: 0, value: null, key: '' };
const dashInflight = new Map();

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

  // 5) 涨停池个股日K（技术指标 / 反包板识别 / 接力评分共用；上游缓存 5 分钟）
  const ztCodes = (pools.zt || []).slice(0, 45).map(x => x.code);
  const klines = await limitedMap(ztCodes, 5, async c => ds.getKline(c, 90));
  const klineMap = {};
  ztCodes.forEach((c, i) => { klineMap[c] = klines[i] || []; });

  const ctx = { ov, themes, sectorSet };
  const filtersWithSet = { ...f, _sectorSet: sectorSet };

  // 6) 六个模块
  const [picks, lowbuy, opps] = await Promise.all([
    Promise.resolve(an.shortTermPicks(pools, universe, quotes, ctx, f)),
    Promise.resolve(an.boardLowBuy(pools, ov, themes, klineMap, quotes, filtersWithSet)),
    Promise.resolve(an.liveOpportunities(pools, boards, universe, quotes, filtersWithSet))
  ]);
  const relay = an.relayPicks(pools, ov, themes, klineMap, quotes, filtersWithSet);
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
    dataSourceNote: '全市场广度=新浪财经行情中心；实时快照/指数=腾讯证券行情；日K(前复权)=腾讯证券；涨停/炸板/强势/跌停池与连板数、封单、行业=东方财富涨停池。均为免费公开接口，非交易所官方推送，盘中可能有秒级延迟。',
    disclaimer: DISCLAIMER
  };

  return { meta, overview: ov, review, themes, picks, lowbuy, opportunities: opps, boards, relay, ai };
}

async function getDashboard(query, force) {
  const now = Date.now();
  const key = JSON.stringify(query);
  if (!force && dashCache.value && dashCache.key === key && now - dashCache.at < 9000) return dashCache.value;
  // 不同筛选条件各自持有 inflight，避免并发请求串数据
  if (dashInflight.has(key)) return dashInflight.get(key);
  const p = (async () => {
    try {
      const v = await buildDashboard(query);
      dashCache.value = v; dashCache.key = key; dashCache.at = Date.now();
      return v;
    } finally { dashInflight.delete(key); }
  })();
  dashInflight.set(key, p);
  return p;
}

/* ─────────── 路由 ─────────── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:' + ACTIVE_PORT);
  const q = Object.fromEntries(u.searchParams.entries());
  try {
    if (u.pathname === '/api/dashboard') return sendJson(res, await getDashboard(q, q.force === '1'));
    if (u.pathname === '/api/health') return sendJson(res, { ...beijingNow(), port: ACTIVE_PORT, health: ds.getHealth(), ai: aiStatus(), disclaimer: DISCLAIMER });
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
