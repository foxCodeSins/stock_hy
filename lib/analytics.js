'use strict';
/**
 * 分析引擎 —— 纯函数，不产生任何行情数字。
 * 所有输入必须来自 datasource.js 的真实数据；本层只做「计算 / 打分 / 结构化判断」。
 *
 * 方法论依据：
 *  - market-state      市场档位 / 广度 / 状态切换信号
 *  - daily-briefing    复盘结构：事实 → 解读 → 映射 → 条件化操作
 *  - leader-game       涨停结构 / 连板梯队 / 断层 / 龙头地位
 *  - theme-lifecycle   题材阶段 / 结构分层 / 持续性评估
 *  - price-action-tools 多系统交叉验证（趋势 > 位置 > 短期信号）
 *  - trade-plan        位置判断 / 分仓 / 止损 / 失效条件
 */
const { boardOf } = require('./datasource');

const r2 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(2);
const r1 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

/* ────────────────────────── 通用筛选 ────────────────────────── */
/**
 * filters:
 *  board        主板|创业板|科创板|北交所|全部  (逗号分隔可多选)
 *  capMin/capMax 流通市值区间（亿元）
 *  sector       新浪行业/概念板块 node（由服务端解析为代码集合）
 *  industry     东财行业名（模糊包含匹配）
 *  pctMin/pctMax 涨跌幅区间 %
 *  turnoverMin/turnoverMax 换手率区间 %
 *  boardsMin    最低连板数
 *  excludeST    '1' 排除 ST
 *  keyword      代码 / 名称关键字
 *  sort         score|pct|amount|turnover|floatCap|boards|sealFundRatio
 *  limit        条数
 */
function applyFilters(list, f = {}, sectorSet = null) {
  const boards = f.board && f.board !== '全部' && f.board !== 'all'
    ? String(f.board).split(',').map(s => s.trim()).filter(Boolean) : null;
  const capMin = f.capMin === '' || f.capMin === undefined ? null : Number(f.capMin);
  const capMax = f.capMax === '' || f.capMax === undefined ? null : Number(f.capMax);
  const pctMin = f.pctMin === '' || f.pctMin === undefined ? null : Number(f.pctMin);
  const pctMax = f.pctMax === '' || f.pctMax === undefined ? null : Number(f.pctMax);
  const tMin = f.turnoverMin === '' || f.turnoverMin === undefined ? null : Number(f.turnoverMin);
  const tMax = f.turnoverMax === '' || f.turnoverMax === undefined ? null : Number(f.turnoverMax);
  const bMin = f.boardsMin === '' || f.boardsMin === undefined ? null : Number(f.boardsMin);
  const kw = String(f.keyword || '').trim().toLowerCase();
  const industry = String(f.industry || '').trim();

  let out = (list || []).filter(x => {
    if (!x || !x.code) return false;
    const b = x.board || boardOf(x.code);
    if (boards && !boards.includes(b)) return false;
    if (f.excludeST === '1' && (x.isST || /ST/i.test(x.name || ''))) return false;
    const cap = x.floatCap;
    if (capMin !== null && Number.isFinite(capMin) && (cap === null || cap < capMin)) return false;
    if (capMax !== null && Number.isFinite(capMax) && (cap === null || cap > capMax)) return false;
    const pct = x.pct;
    if (pctMin !== null && Number.isFinite(pctMin) && (pct === null || pct < pctMin)) return false;
    if (pctMax !== null && Number.isFinite(pctMax) && (pct === null || pct > pctMax)) return false;
    const tn = x.turnover;
    if (tMin !== null && Number.isFinite(tMin) && (tn === null || tn < tMin)) return false;
    if (tMax !== null && Number.isFinite(tMax) && (tn === null || tn > tMax)) return false;
    if (bMin !== null && Number.isFinite(bMin) && (x.boards === undefined || x.boards === null || x.boards < bMin)) return false;
    if (industry && !(String(x.industry || '').includes(industry) || String(x.sectorName || '').includes(industry))) return false;
    if (sectorSet && sectorSet.size && !sectorSet.has(x.code)) return false;
    if (kw && !(String(x.code).includes(kw) || String(x.name || '').toLowerCase().includes(kw))) return false;
    return true;
  });

  const sort = f.sort || 'score';
  const dir = String(f.sortDir || 'desc') === 'asc' ? 1 : -1;
  const key = {
    score: 'score', pct: 'pct', amount: 'amount', turnover: 'turnover',
    floatCap: 'floatCap', boards: 'boards', sealFundRatio: 'sealFundRatio',
    techScore: 'techScore', volRatio: 'volRatio', code: 'code', nearPct: 'nearPct'
  }[sort] || 'score';
  out.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
    return (av - bv) * dir;
  });
  const limit = clamp(Number(f.limit) || 60, 1, 300);
  return out.slice(0, limit);
}

/* ────────────────────────── 技术指标 ────────────────────────── */
function sma(arr, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}
function ema(arr, n) {
  const k = 2 / (n + 1), out = [];
  let prev = null;
  for (const v of arr) { prev = prev === null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}
function macd(closes) {
  if (closes.length < 26) return null;
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = e12.map((v, i) => v - e26[i]);
  const dea = ema(dif, 9);
  const hist = dif.map((v, i) => (v - dea[i]) * 2);
  const L = closes.length - 1;
  return {
    dif: r2(dif[L]), dea: r2(dea[L]), hist: r2(hist[L]),
    prevHist: r2(hist[L - 1]), prevDif: r2(dif[L - 1]), prevDea: r2(dea[L - 1]),
    goldenCross: dif[L - 1] <= dea[L - 1] && dif[L] > dea[L],
    deadCross: dif[L - 1] >= dea[L - 1] && dif[L] < dea[L],
    histExpanding: Math.abs(hist[L]) > Math.abs(hist[L - 1]) && hist[L] > 0
  };
}
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let up = 0, dn = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; up += Math.max(0, d); dn += Math.max(0, -d); }
  let au = up / n, ad = dn / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    au = (au * (n - 1) + Math.max(0, d)) / n;
    ad = (ad * (n - 1) + Math.max(0, -d)) / n;
  }
  return ad === 0 ? 100 : r1(100 - 100 / (1 + au / ad));
}
function kdj(kl, n = 9) {
  if (kl.length < n + 1) return null;
  let K = 50, D = 50;
  for (let i = n - 1; i < kl.length; i++) {
    const w = kl.slice(i - n + 1, i + 1);
    const hi = Math.max(...w.map(x => x.high)), lo = Math.min(...w.map(x => x.low));
    const rsv = hi === lo ? 50 : (kl[i].close - lo) / (hi - lo) * 100;
    K = (2 * K + rsv) / 3; D = (2 * D + K) / 3;
  }
  return { k: r1(K), d: r1(D), j: r1(3 * K - 2 * D) };
}
function boll(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const w = closes.slice(-n), m = avg(w);
  const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / n);
  return { mid: r2(m), upper: r2(m + k * sd), lower: r2(m - k * sd), width: r2((2 * k * sd / m) * 100) };
}
function atr(kl, n = 14) {
  if (kl.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < kl.length; i++) tr.push(Math.max(kl[i].high - kl[i].low, Math.abs(kl[i].high - kl[i - 1].close), Math.abs(kl[i].low - kl[i - 1].close)));
  return r2(avg(tr.slice(-n)));
}

/** 找到本轮连板起涨前的基准收盘价 */
function findBase(kl, boards, code) {
  if (!kl.length) return null;
  const limit = /^(300|301|688|689)/.test(code) ? 19.5 : (/^(8|4|920)/.test(code) ? 29.5 : 9.7);
  let idx = kl.length - 1;
  let counted = 0;
  while (idx > 0 && counted < Math.max(1, boards || 1)) {
    const prev = kl[idx - 1].close;
    const pct = prev ? (kl[idx].close - prev) / prev * 100 : 0;
    if (pct >= limit) { counted++; idx--; } else break;
  }
  return idx > 0 ? kl[idx - 1].close : kl[0].close;
}

/** 完整技术面分析（多系统交叉验证：趋势 > 位置 > 短期信号） */
function technicalAnalysis(kl, quote, poolRow) {
  const empty = { available: false, reason: '日K数据源未返回该标的的历史数据，技术面结论留空（不做推测）' };
  if (!kl || kl.length < 20) return empty;
  const closes = kl.map(x => x.close);
  const last = kl[kl.length - 1];
  const price = (quote && quote.price) || (poolRow && poolRow.price) || last.close;
  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
  const L = closes.length - 1;
  const m5 = ma5[L], m10 = ma10[L], m20 = ma20[L], m60 = ma60[L];
  const hi60 = Math.max(...kl.slice(-60).map(x => x.high));
  const lo20 = Math.min(...kl.slice(-20).map(x => x.low));
  const vols = kl.map(x => x.volume).filter(v => v !== null);
  const v5 = avg(vols.slice(-6, -1)), vNow = vols[vols.length - 1];
  const md = macd(closes), r14 = rsi(closes, 14), kd = kdj(kl), bo = boll(closes), atrv = atr(kl);
  const devMA5 = m5 ? (price - m5) / m5 * 100 : null;
  const fromHigh = hi60 ? (price - hi60) / hi60 * 100 : null;
  const fromLow = lo20 ? (price - lo20) / lo20 * 100 : null;
  const base = findBase(kl, poolRow && poolRow.boards, (poolRow && poolRow.code) || '');
  // 斐波那契回撤锚点固定为「当日涨停价」而非实时价：
  // 若每次刷新都按现价重算，低吸区间会随价格漂移，「是否回踩到位」永远无法成立。
  const fibAnchor = (quote && Number(quote.limitUp)) || (poolRow && Number(poolRow.limitUpPrice)) || price;
  const fib = base ? {
    base: r2(base), anchor: r2(fibAnchor),
    f382: r2(fibAnchor - (fibAnchor - base) * 0.382),
    f500: r2(fibAnchor - (fibAnchor - base) * 0.5),
    f618: r2(fibAnchor - (fibAnchor - base) * 0.618)
  } : null;
  const bullAlign = m5 !== null && m10 !== null && m20 !== null && m5 > m10 && m10 > m20;
  const aboveMA20 = m20 !== null && price > m20;
  const volSurge = v5 && vNow ? vNow / v5 : null;

  // 交易位置（trade-plan 五分类）
  let position, positionNote;
  if (devMA5 !== null && devMA5 > 12 && volSurge && volSurge > 1.5) {
    position = '高位加速'; positionNote = '股价远离5日线且放量，追高赔率差';
  } else if (aboveMA20 && bullAlign && fromLow !== null && fromLow < 12) {
    position = '低位启动'; positionNote = '均线转多头且距20日低点近';
  } else if (aboveMA20 && bullAlign) {
    position = '趋势中继'; positionNote = '上升趋势中，回踩均线为主要观察位';
  } else if (!aboveMA20 && m20 !== null && devMA5 !== null && devMA5 < 0) {
    position = '下跌反抽'; positionNote = '位于20日线与5日线下方，反弹持续性弱';
  } else {
    position = '高位震荡'; positionNote = '均线走平 / 高换手，方向未明';
  }

  // 趋势 / 位置 / 短期信号三层投票
  const votes = [];
  votes.push({ dim: '趋势', signal: bullAlign ? '多' : (aboveMA20 ? '中性偏多' : '空'), detail: bullAlign ? 'MA5>MA10>MA20 多头排列' : (aboveMA20 ? '站上MA20但均线未多头排列' : '跌破MA20，趋势转弱') });
  votes.push({ dim: 'MACD', signal: md ? (md.goldenCross ? '多' : md.deadCross ? '空' : (md.dif > md.dea ? '偏多' : '偏空')) : '无数据', detail: md ? `DIF ${md.dif} / DEA ${md.dea} / 柱 ${md.hist}${md.goldenCross ? '（金叉）' : md.deadCross ? '（死叉）' : ''}` : 'K线不足' });
  votes.push({ dim: 'RSI/KDJ', signal: r14 === null ? '无数据' : (r14 > 80 ? '超买' : r14 < 30 ? '超卖' : '中性'), detail: r14 === null ? 'K线不足' : `RSI14 ${r14}${kd ? ' / KDJ K ' + kd.k + ' D ' + kd.d : ''}` });
  votes.push({ dim: '量能', signal: volSurge === null ? '无数据' : (volSurge > 2 ? '显著放量' : volSurge < 0.7 ? '缩量' : '温和'), detail: volSurge === null ? '数据不足' : `最新量 / 前5日均量 = ${r2(volSurge)} 倍` });
  votes.push({ dim: '位置', signal: fromHigh !== null && fromHigh > -3 ? '接近60日高点' : (fromLow !== null && fromLow < 15 ? '接近20日低点' : '中部'), detail: `距60日高 ${r1(fromHigh)}% / 距20日低 ${r1(fromLow)}%` });

  return {
    available: true,
    bars: kl.length,
    lastDate: last.date,
    price: r2(price),
    ma: { ma5: r2(m5), ma10: r2(m10), ma20: r2(m20), ma60: r2(m60) },
    macd: md, rsi14: r14, kdj: kd, boll: bo, atr: atrv,
    bullAlign, aboveMA20, devMA5: r1(devMA5), fromHigh: r1(fromHigh), fromLow: r1(fromLow),
    volSurge: r2(volSurge), hi60: r2(hi60), lo20: r2(lo20),
    fib, base: fib ? fib.base : null,
    position, positionNote, votes,
    supports: [m5, m10, m20, fib && fib.f382, fib && fib.f500, fib && fib.f618]
      .filter(v => v !== null && v !== undefined && Number.isFinite(v)).map(v => r2(v)).sort((a, b) => b - a)
  };
}

/* ────────────────────────── 市场概览 / 情绪 ────────────────────────── */
function marketOverview(universe, indices, pools) {
  const list = universe.list || [];
  const up = list.filter(x => x.pct !== null && x.pct > 0).length;
  const down = list.filter(x => x.pct !== null && x.pct < 0).length;
  const flat = list.filter(x => x.pct !== null && x.pct === 0).length;
  const up5 = list.filter(x => x.pct !== null && x.pct >= 5).length;
  const down5 = list.filter(x => x.pct !== null && x.pct <= -5).length;
  const zt = pools.zt || [], zb = pools.zb || [], dt = pools.dt || [], qs = pools.qs || [];
  const limitUp = zt.length, limitDown = dt.length, broken = zb.length;
  const breakRate = limitUp + broken > 0 ? r1(broken / (limitUp + broken) * 100) : null;
  const maxBoard = zt.length ? Math.max(...zt.map(x => x.boards || 1)) : 0;
  const ladder = {};
  zt.forEach(x => { const b = x.boards || 1; ladder[b] = (ladder[b] || 0) + 1; });
  const spaceBoard = zt.filter(x => (x.boards || 1) === maxBoard);
  // 梯队断层：最高板 >= 4 但中间有空缺
  let gap = false;
  if (maxBoard >= 3) for (let b = 2; b < maxBoard; b++) if (!ladder[b]) gap = true;

  const breadth = up + down > 0 ? r1(up / (up + down) * 100) : null;
  const idxAvg = indices.length ? r1(avg(indices.map(x => x.pct).filter(v => v !== null))) : null;
  const strongBreadth = breadth !== null && breadth >= 60;
  const weakBreadth = breadth !== null && breadth < 40;

  // 市场档位：综合广度 / 指数 / 情绪（market-state）
  let tier, tierNote;
  if (strongBreadth && limitUp >= 40 && limitDown <= 5 && breakRate !== null && breakRate < 25) {
    tier = '进攻'; tierNote = '广度扩散、涨停家数充足、跌停少、封板稳定';
  } else if (weakBreadth && limitDown >= 10 || (breakRate !== null && breakRate > 45)) {
    tier = '防守'; tierNote = '广度恶化或负反馈显著，赚钱效应收缩';
  } else if (strongBreadth && idxAvg !== null && idxAvg < 0) {
    tier = '切换'; tierNote = '个股普涨但指数回落，风格切换中，结构未清晰';
  } else {
    tier = '震荡'; tierNote = '广度中性或结构分化，宜精选个股、控制总仓位';
  }

  // 情绪结构（leader-game）
  let emotion, emotionNote;
  if (maxBoard >= 6 && limitUp >= 40 && !gap) { emotion = '高潮'; emotionNote = '空间板高度充分、梯队完整，但需防一致性兑现'; }
  else if (gap || (breakRate !== null && breakRate > 35)) { emotion = '局部退潮'; emotionNote = '连板梯队出现断层或炸板率偏高，高位股负反馈加大'; }
  else if (maxBoard >= 3 && limitUp >= 25) { emotion = '修复/加强'; emotionNote = '空间板打开且有连板梯队，情绪处于修复或加强阶段'; }
  else { emotion = '冰点/低迷'; emotionNote = '连板高度有限、涨停家数偏少，情绪以试错为主'; }

  return {
    indices, up, down, flat, up5, down5, breadth, idxAvg,
    limitUp, limitDown, broken, breakRate, strongStocks: qs.length,
    maxBoard, ladder, gap, spaceBoard: spaceBoard.map(x => ({ code: x.code, name: x.name, boards: x.boards, industry: x.industry })),
    tier, tierNote, emotion, emotionNote,
    universeCount: list.length,
    universeExpected: universe.expected,
    asOf: universe.asOf,
    poolDate: pools.date,
    source: '市场广度=新浪财经全市场快照；涨停/炸板/跌停/强势股=东方财富涨停池；指数=腾讯证券实时行情'
  };
}

/* ────────────────────────── 题材聚合（量价结构推导） ────────────────────────── */
function buildThemes(pools, boards) {
  const zt = pools.zt || [], zb = pools.zb || [], dt = pools.dt || [];
  const groups = new Map();
  const keyOf = x => (x.industry || '').trim() || '未分类';
  for (const x of zt) {
    const k = keyOf(x);
    if (!groups.has(k)) groups.set(k, { name: k, members: [], broken: 0, down: 0 });
    groups.get(k).members.push(x);
  }
  for (const x of zb) { const k = keyOf(x); if (groups.has(k)) groups.get(k).broken++; }
  for (const x of dt) { const k = keyOf(x); if (groups.has(k)) groups.get(k).down++; }

  const industryBoards = (boards && boards.industry) || [];
  const conceptBoards = (boards && boards.concept) || [];
  const matchBoard = name => {
    if (!name) return null;
    const n = String(name).replace(/[ⅡⅢⅠ].*$/, '').trim();
    const cand = [...industryBoards, ...conceptBoards].filter(b => {
      const bn = String(b.name).replace(/行业|板块/g, '').trim();
      return bn && (bn.includes(n.slice(0, 2)) || n.includes(bn.slice(0, 2)));
    });
    return cand.length ? cand.sort((a, b) => (b.pct || 0) - (a.pct || 0))[0] : null;
  };

  const out = [];
  for (const g of groups.values()) {
    const m = g.members;
    const heights = m.map(x => x.boards || 1);
    const maxB = Math.max(...heights);
    const ladder = {};
    heights.forEach(b => ladder[b] = (ladder[b] || 0) + 1);
    let gapFlag = false;
    if (maxB >= 3) for (let b = 2; b < maxB; b++) if (!ladder[b]) gapFlag = true;
    const avgSeal = avg(m.map(x => x.sealFundRatio).filter(v => v !== null && v !== undefined));
    const negRate = m.length + g.broken > 0 ? g.broken / (m.length + g.broken) * 100 : 0;
    const b = matchBoard(g.name);

    // 阶段判断（theme-lifecycle）：依据涨停扩散、龙头高度、梯队、负反馈率
    let stage, stageBasis;
    if (m.length >= 5 && maxB >= 4 && !gapFlag) { stage = '高潮期'; stageBasis = `${m.length} 只涨停 + 最高 ${maxB} 板 + 梯队完整，跟风扩散`; }
    else if (m.length >= 3 && maxB >= 3) { stage = '发酵期'; stageBasis = `${m.length} 只涨停 + 最高 ${maxB} 板，龙头带动扩散`; }
    else if (m.length >= 2 && maxB >= 2) { stage = '启动期'; stageBasis = `${m.length} 只涨停，出现 ${maxB} 板龙头，板块初步形成`; }
    else if (m.length === 1) { stage = '预热/日内脉冲'; stageBasis = '板块仅 1 只涨停，尚未形成扩散'; }
    else { stage = '启动期'; stageBasis = `${m.length} 只涨停，梯队待建立`; }
    if (gapFlag || negRate > 45) { stage = '分歧期'; stageBasis += `；梯队断层或炸板率 ${r1(negRate)}%，后排开始掉队`; }
    if (g.down > 0 && g.down >= m.length / 2) { stage = '退潮期'; stageBasis += `；板块内出现 ${g.down} 只跌停，负反馈明确`; }

    // 持续性 / 预期
    let outlook, outlookScore, outlookBasis;
    const boardPct = b ? b.pct : null;
    if (stage === '退潮期') { outlook = '弱'; outlookScore = 1; outlookBasis = '龙头负反馈明确，题材进入退潮，等待调整后能否反包'; }
    else if (stage === '高潮期') { outlook = '一般'; outlookScore = 2; outlookBasis = '高度与扩散已充分，一致性越强次日兑现压力越大'; }
    else if (stage === '分歧期') { outlook = '一般'; outlookScore = 2; outlookBasis = '需观察龙头能否分歧转一致，否则高低切'; }
    else if (stage === '发酵期' && !gapFlag && negRate < 30) { outlook = '强'; outlookScore = 4; outlookBasis = '梯队完整 + 负反馈低 + 扩散初期，续航条件较好'; }
    else if (stage === '启动期') { outlook = '较强'; outlookScore = 3; outlookBasis = '龙头已现但扩散不足，能否发酵取决于次日首板数量'; }
    else { outlook = '一般'; outlookScore = 2; outlookBasis = '题材尚未形成板块效应，以个股行情为主'; }
    if (boardPct !== null && boardPct < -1 && outlookScore > 1) { outlookScore--; outlookBasis += `；对应板块当日 ${boardPct}%，整体承压`; }

    out.push({
      name: g.name, count: m.length, maxBoard: maxB, ladder, gap: gapFlag,
      broken: g.broken, down: g.down, negRate: r1(negRate),
      avgSealRatio: r1(avgSeal),
      stage, stageBasis, outlook, outlookScore, outlookBasis,
      boardRef: b ? { name: b.name, pct: b.pct, leaderName: b.leaderName, source: b.source || '新浪财经板块行情' } : null,
      members: m.map(x => x.code),
      watchPoints: [
        `龙头能否晋级：${m.filter(x => x.boards === maxB).map(x => x.name + '(' + x.code + ')').join('、') || '无'}`,
        `次日板块首板数量能否由 ${m.length} 只继续扩散`,
        `炸板/负反馈率能否从 ${r1(negRate)}% 回落`,
        '是否出现新的政策或产业催化（本系统不接入资讯数据，需自行核实）'
      ]
    });
  }
  return out.sort((a, b) => (b.outlookScore - a.outlookScore) || (b.count - a.count) || (b.maxBoard - a.maxBoard));
}

/* ────────────────────────── 复盘计划 ────────────────────────── */
function reviewPlan(ov, themes, pools) {
  const topThemes = themes.slice(0, 4);
  const ladderStr = Object.keys(ov.ladder).sort((a, b) => b - a)
    .map(b => `${b}板 ${ov.ladder[b]} 家`).join(' / ') || '无连板';
  const zt = pools.zt || [];
  const earlySeals = zt.filter(x => x.firstSeal && x.firstSeal <= '10:00:00').length;
  const strongSeal = zt.filter(x => x.sealFundRatio !== null && x.sealFundRatio >= 1).length;

  const facts = [
    { label: '市场档位', value: ov.tier, note: ov.tierNote },
    { label: '涨跌家数', value: `${ov.up} 涨 / ${ov.down} 跌`, note: `广度 ${ov.breadth}%（上涨占比），涨幅≥5% ${ov.up5} 家、跌幅≥5% ${ov.down5} 家` },
    { label: '指数表现', value: ov.indices.map(i => `${i.name} ${i.pct > 0 ? '+' : ''}${i.pct}%`).join(' · '), note: `主要指数均值 ${ov.idxAvg}%；指数与广度背离时需警惕少数权重支撑` },
    { label: '涨停结构', value: `${ov.limitUp} 涨停 / ${ov.limitDown} 跌停 / ${ov.broken} 炸板`, note: `炸板率 ${ov.breakRate}%；10:00 前封板 ${earlySeals} 家，封单/流通市值≥1% ${strongSeal} 家` },
    { label: '连板梯队', value: `最高 ${ov.maxBoard} 板，${ladderStr}`, note: ov.gap ? '梯队出现断层，属退潮前置信号' : '梯队无断层' },
    { label: '情绪定位', value: ov.emotion, note: ov.emotionNote }
  ];

  const focus = [
    { title: '空间板反馈', text: `观察 ${ov.spaceBoard.length ? ov.spaceBoard.map(x => x.name + '(' + x.code + ')').join('、') : '最高板个股'} 次日能否分歧转一致；若高开低走且炸板，则高位接力资金会快速退潮，需下调整体仓位。` },
    { title: '梯队完整度', text: ov.gap ? `当前 ${ov.maxBoard} 板与低位之间存在断层，明日重点看 2 板 / 3 板能否补齐；补不上则确认为退潮。` : `当前梯队无断层，明日重点看 1 进 2 的晋级率能否维持，这是情绪能否延续的先行指标。` },
    { title: '主线扩散或高低切', text: topThemes.length ? `主线候选：${topThemes.map(t => t.name + '(' + t.count + '家/' + t.stage + ')').join('、')}。看资金是继续在同一题材内做补涨，还是切向低位新方向。` : '涨停结构分散，暂无清晰主线，以观望为主。' }
  ];

  // 条件 → 动作 → 风险（trade-plan 框架，不写「必涨必跌」）
  const playbook = [
    {
      condition: `市场档位维持「${ov.tier}」且涨停家数 ≥ ${Math.max(20, ov.limitUp)}、炸板率 < 30%`,
      action: '可按原计划做低位首板 / 1进2 的试错仓（10–20%），优先主线题材内标的',
      risk: '若开盘一致性过强（大面积高开），反而要等分歧，不追高开秒板'
    },
    {
      condition: '最高板炸板或跌停、炸板率升至 40% 以上',
      action: '停止新开仓，持仓按「跌破前一日低点或 5 日线」执行技术止损，降低总仓位',
      risk: '退潮期低吸容易接在半山腰，反包需成交量确认，不能用「跌多了」当理由'
    },
    {
      condition: '指数与广度继续背离（指数横盘、下跌家数扩大）',
      action: '减少新进场，只保留主线核心，观察广度是否修复',
      risk: '广度恶化常先于指数回落，不要因指数没跌就加仓'
    }
  ];

  const risks = [
    `涨停 ${ov.limitUp} 家、跌停 ${ov.limitDown} 家、炸板率 ${ov.breakRate}%，${ov.breakRate > 35 ? '封板稳定性偏弱' : '封板稳定性尚可'}`,
    ov.gap ? '连板梯队存在断层，高位股接力风险上升' : '连板梯队暂无断层，但仍需次日晋级率确认',
    '本系统不接入新闻 / 公告 / 龙虎榜资讯，题材阶段完全由量价结构推导，重大消息面需自行核实',
    '所有数据为行情快照，非交易所官方推送，盘中可能存在秒级延迟'
  ];

  return { facts, focus, playbook, risks, ladderStr, earlySeals, strongSeal, topThemes };
}

/* ────────────────────────── 短线多因子打分 ────────────────────────── */
function shortTermScore(x, ctx) {
  const themes = ctx.themes || [];
  const theme = themes.find(t => t.members.includes(x.code)) || themes.find(t => t.name === x.industry);
  const maxB = ctx.ov ? ctx.ov.maxBoard : 5;
  const parts = [];
  let score = 0;

  // 1 动量（20）：涨幅适中偏强最好，极端追高扣分
  const p = x.pct === null ? 0 : x.pct;
  let v = 0;
  if (p >= 3 && p <= 10.5) v = 20; else if (p > 10.5) v = 13; else if (p > 0) v = 10; else v = 0;
  score += v; parts.push({ factor: '动量', got: v, max: 20, detail: `当日涨幅 ${r2(p)}%${p > 10.5 ? '（涨停/接近涨停，追高扣分）' : ''}` });

  // 2 题材热度（20）：所属行业涨停家数 + 题材预期
  const cnt = theme ? theme.count : 0;
  v = Math.min(12, cnt * 3) + (theme ? Math.max(0, theme.outlookScore - 1) * 2 : 0);
  score += v; parts.push({ factor: '题材热度', got: v, max: 20, detail: theme ? `${theme.name} 涨停 ${cnt} 家，阶段「${theme.stage}」，预期「${theme.outlook}」` : '无板块归属数据，不给分' });

  // 3 封板质量（20）：封单强度 / 炸板 / 首封时间
  v = 0; const det = [];
  if (x.sealFundRatio !== null && x.sealFundRatio !== undefined) {
    if (x.sealFundRatio >= 2) { v += 9; det.push('封单/流通市值≥2%'); }
    else if (x.sealFundRatio >= 0.5) { v += 6; det.push('封单/流通市值≥0.5%'); }
    else { v += 2; det.push('封单偏薄'); }
  }
  if ((x.brokenCount || 0) === 0) { v += 6; det.push('未炸板'); } else { v -= Math.min(8, x.brokenCount * 3); det.push(`炸板 ${x.brokenCount} 次`); }
  if (x.firstSeal && x.firstSeal <= '10:00:00') { v += 5; det.push('早盘封板'); }
  v = clamp(v, 0, 20); score += v; parts.push({ factor: '封板质量', got: v, max: 20, detail: det.join(' / ') || '无封板数据' });

  // 4 量能（15）：量比 / 换手
  v = 0;
  const vr = x.volRatio, tn = x.turnover;
  if (vr !== null && vr !== undefined) { if (vr >= 1 && vr <= 4) { v += 8; } else if (vr > 4) { v += 4; } else { v += 2; } }
  if (tn !== null && tn !== undefined) { if (tn >= 3 && tn <= 20) { v += 7; } else if (tn > 20) { v += 3; } else { v += 2; } }
  score += v; parts.push({ factor: '量能', got: v, max: 15, detail: `量比 ${vr === null || vr === undefined ? '—' : r2(vr)} / 换手 ${tn === null || tn === undefined ? '—' : r1(tn)}%` });

  // 5 市值与位置（15）：流通市值适中 + 连板高度
  v = 0; const cap = x.floatCap;
  if (cap !== null && cap !== undefined) { if (cap >= 20 && cap <= 200) { v += 8; } else if (cap < 20) { v += 3; } else { v += 4; } }
  const b = x.boards || 1;
  if (b === 1 || b === 2) { v += 7; } else if (b === 3) { v += 5; } else if (b <= maxB && maxB >= 5) { v += 1; } else { v += 3; }
  score += v; parts.push({ factor: '市值/位置', got: v, max: 15, detail: `流通市值 ${cap === null || cap === undefined ? '—' : r1(cap)} 亿 / ${b} 连板（全场最高 ${maxB} 板）` });

  // 6 趋势（10）：来自实时快照的价格与均价关系
  v = 0;
  if (x.avgPrice && x.price && x.price >= x.avgPrice) v = 10;
  else if (x.avgPrice && x.price) v = 4;
  else v = 5;
  score += v; parts.push({ factor: '日内强弱', got: v, max: 10, detail: x.avgPrice ? `现价 ${r2(x.price)} / 均价 ${r2(x.avgPrice)}` : '无均价数据，给中性分' });

  return { score: Math.round(clamp(score, 0, 100)), parts, theme };
}

function shortTermPicks(pools, universe, quotes, ctx, filters) {
  const zt = pools.zt || [], qs = pools.qs || [];
  const byCode = new Map((universe.list || []).map(x => [x.code, x]));
  const ztMap = new Map(zt.map(x => [x.code, x]));
  const qsMap = new Map(qs.map(x => [x.code, x]));
  const merged = new Map();
  // 强势股池不含连板数(lbc)与封单强度，若同码出现在涨停池，必须以涨停池字段为准
  // 因此先写 qs、再写 zt（后者覆盖前者），并对连板数取两者最大值
  for (const x of [...qs, ...zt]) {
    const base = byCode.get(x.code) || {};
    const q = quotes[x.code] || {};
    const prev = merged.get(x.code) || {};
    merged.set(x.code, {
      ...base, ...prev, ...x, ...q,
      code: x.code, name: x.name || base.name,
      board: x.board || base.board || boardOf(x.code),
      isST: x.isST || /ST/i.test(x.name || ''),
      boards: Math.max(prev.boards || 1, x.boards || 1),
      floatCap: x.floatCap !== null && x.floatCap !== undefined ? x.floatCap : (q.floatCap !== undefined ? q.floatCap : base.floatCap),
      turnover: x.turnover !== null && x.turnover !== undefined ? x.turnover : (q.turnover !== undefined ? q.turnover : base.turnover),
      amount: x.amount !== null && x.amount !== undefined ? x.amount : base.amount,
      sealFundRatio: (ztMap.get(x.code) && ztMap.get(x.code).sealFundRatio !== undefined)
        ? ztMap.get(x.code).sealFundRatio : x.sealFundRatio,
      firstSeal: (ztMap.get(x.code) && ztMap.get(x.code).firstSeal) || x.firstSeal,
      brokenCount: (ztMap.get(x.code) && ztMap.get(x.code).brokenCount !== undefined)
        ? ztMap.get(x.code).brokenCount : x.brokenCount,
      sealFund: (ztMap.get(x.code) && ztMap.get(x.code).sealFund !== undefined)
        ? ztMap.get(x.code).sealFund : x.sealFund,
      inZtPool: ztMap.has(x.code),
      inQsPool: qsMap.has(x.code)
    });
  }
  const all = [...merged.values()].map(x => {
    const s = shortTermScore(x, ctx);
    x.score = s.score; x.scoreParts = s.parts;
    x.themeName = s.theme ? s.theme.name : null;
    x.themeStage = s.theme ? s.theme.stage : null;
    x.themeOutlook = s.theme ? s.theme.outlook : null;
    // 风险标签（全部由数据条件触发）
    const risks = [];
    if ((x.brokenCount || 0) >= 2) risks.push(`日内炸板 ${x.brokenCount} 次`);
    if ((x.boards || 1) >= 5) risks.push('高位连板，接力赔率差');
    if (x.sealFundRatio !== null && x.sealFundRatio !== undefined && x.sealFundRatio < 0.3) risks.push('封单偏薄');
    if (x.floatCap !== null && x.floatCap < 15) risks.push('流通市值偏小，波动剧烈');
    if (x.turnover !== null && x.turnover > 30) risks.push('换手过高，分歧大');
    if (x.themeOutlook === '弱') risks.push('所属题材进入退潮期');
    x.risks = risks;
    x.verdict = x.score >= 72 && risks.length <= 1 ? '重点观察' : (x.score >= 58 ? '可跟踪' : '谨慎');
    return x;
  });
  return applyFilters(all, { ...filters, sort: filters.sort || 'score' }, ctx.sectorSet);
}

/* ────────────────────────── 连板低吸（核心模块） ────────────────────────── */
function roleJudge(x, theme, ov) {
  const b = x.boards || 1;
  const isSpace = ov && ov.spaceBoard.some(s => s.code === x.code) && b >= 3;
  const themeMax = theme ? theme.maxBoard : b;
  const cnt = theme ? theme.count : 1;
  let role, reason;
  if (isSpace) { role = '绝对龙头（空间板）'; reason = `全场最高 ${ov.maxBoard} 板，辨识度最高，但高位接力赔率最差`; }
  else if (theme && b >= themeMax && cnt >= 2 && b >= 2) { role = '题材龙头'; reason = `${theme.name} 板块内最高 ${b} 板，板块共 ${cnt} 只涨停，具备带动性`; }
  else if (theme && b >= 2 && x.sealFundRatio !== null && x.sealFundRatio >= 1) { role = '题材核心'; reason = `${b} 连板且封单/流通市值 ${r1(x.sealFundRatio)}%，板块内前排`; }
  else if (theme && b >= 2) { role = '题材前排'; reason = `${b} 连板，板块内有更高标的，属跟随梯队`; }
  else if (theme && cnt >= 3) { role = '板块跟风'; reason = `首板且板块共 ${cnt} 只涨停，需看能否晋级`; }
  else { role = '独立/噪音'; reason = '板块内涨停家数少，缺乏梯队支撑'; }
  if ((x.brokenCount || 0) >= 2 || (x.sealFundRatio !== null && x.sealFundRatio < 0.2)) {
    role = '后排/弱转强待验证'; reason += '；但封板质量偏弱（炸板多或封单薄），地位需次日验证';
  }
  return { role, reason, isCore: ['绝对龙头（空间板）', '题材龙头', '题材核心'].includes(role) };
}

function techScoreOf(x, t, theme) {
  if (!t.available) return { score: null, parts: [], note: t.reason };
  const parts = [];
  let s = 0, v;
  // 趋势 25
  v = 0;
  if (t.bullAlign) v += 15; else if (t.aboveMA20) v += 7; else v -= 8;
  if (t.macd) v += t.macd.goldenCross ? 6 : (t.macd.dif > t.macd.dea ? 4 : -4);
  if (t.aboveMA20) v += 4;
  v = clamp(v, -10, 25); s += v; parts.push({ factor: '趋势(均线/MACD)', got: v, max: 25, detail: t.bullAlign ? 'MA5>MA10>MA20 多头排列' : (t.aboveMA20 ? '仅站上MA20，均线未多头排列' : '处于MA20下方') });
  // 短期指标 15
  v = 0;
  const r = t.rsi14;
  if (r !== null) { if (r >= 40 && r <= 70) v += 10; else if (r > 70 && r <= 80) v += 4; else if (r > 80) v -= 5; else v += 5; }
  if (t.kdj) v += (t.kdj.j > 100 ? -3 : (t.kdj.k > t.kdj.d ? 5 : 0));
  v = clamp(v, -8, 15); s += v; parts.push({ factor: 'RSI/KDJ', got: v, max: 15, detail: `RSI14=${r === null ? '—' : r}${t.kdj ? '，KDJ J=' + t.kdj.j : ''}` });
  // 量能 15
  v = 0;
  const vs = t.volSurge;
  if (vs !== null) { if (vs >= 1 && vs <= 2.5) v += 12; else if (vs > 2.5 && vs <= 4) v += 6; else if (vs > 4) v += 1; else v += 7; }
  else v += 5;
  s += v; parts.push({ factor: '量能配合', got: v, max: 15, detail: `最新量/前5日均量 ${vs === null ? '—' : vs} 倍${vs > 4 ? '（过度放量，注意兑现）' : ''}` });
  // 位置 15
  v = 0;
  if (t.devMA5 !== null) { if (t.devMA5 <= 8) v += 8; else if (t.devMA5 <= 15) v += 3; else v -= 6; }
  if (t.fromHigh !== null && t.fromHigh > -3) v += 3;
  if (t.fromLow !== null && t.fromLow < 15) v += 4;
  v = clamp(v, -8, 15); s += v; parts.push({ factor: '价格位置', got: v, max: 15, detail: `偏离MA5 ${t.devMA5}%，距60日高 ${t.fromHigh}%，距20日低 ${t.fromLow}%` });
  // 封板质量 20
  v = 0;
  if (x.sealFundRatio !== null && x.sealFundRatio !== undefined) v += x.sealFundRatio >= 2 ? 10 : (x.sealFundRatio >= 0.5 ? 6 : 1);
  if ((x.brokenCount || 0) === 0) v += 6; else v -= Math.min(10, x.brokenCount * 4);
  if (x.firstSeal && x.firstSeal <= '10:00:00') v += 4;
  v = clamp(v, -10, 20); s += v; parts.push({ factor: '封板质量', got: v, max: 20, detail: `封单/流通市值 ${x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : x.sealFundRatio}%，炸板 ${x.brokenCount || 0} 次，首封 ${x.firstSeal || '—'}` });
  // 题材 10
  v = theme ? theme.outlookScore * 2.5 : 3;
  s += v; parts.push({ factor: '题材环境', got: +v.toFixed(1), max: 10, detail: theme ? `${theme.name}「${theme.stage}」，预期「${theme.outlook}」` : '无题材归属' });
  return { score: Math.round(clamp(s, 0, 100)), parts };
}

function lowBuyPlan(x, t, quote) {
  if (!t.available || !t.price) return null;
  // 与 technicalAnalysis 的斐波那契锚点保持一致：固定为当日涨停价。
  // 用实时价会导致每次刷新区间跟着现价漂移，实时「是否回踩到位」永远判不出来。
  const p = (t.fib && t.fib.anchor) || (quote && Number(quote.limitUp)) || t.price;
  const limitDown = quote && quote.limitDown ? quote.limitDown : p * 0.9;
  const ma5 = t.ma.ma5, ma10 = t.ma.ma10;
  const f382 = t.fib ? t.fib.f382 : null;
  const f500 = t.fib ? t.fib.f500 : null;
  const f618 = t.fib ? t.fib.f618 : null;
  // 低吸区间：0.382 回撤为上沿；下沿取 0.5 回撤，若 MA5 位于区间内则以更近的 MA5 为下沿
  // 区间宽度限制在现价的 1.5%–6%，避免把「腰斩位」当成低吸位
  let upper = f382 !== null ? f382 : (ma5 || p * 0.97);
  upper = clamp(upper, limitDown, p * 0.998);
  let lower = f500 !== null ? f500 : p * 0.95;
  if (ma5 && ma5 > lower && ma5 < upper) lower = ma5;
  lower = clamp(lower, Math.max(limitDown, upper * 0.94), upper * 0.985);
  if (upper - lower < p * 0.015) lower = Math.max(limitDown, upper - p * 0.02);
  lower = Math.min(lower, upper * 0.985);
  const stop = Math.max(limitDown, Math.min(lower * 0.98, (f618 || lower * 0.96)));
  const target = Math.max(p * 1.02, t.hi60 || p * 1.05);
  return {
    zone: [r2(lower), r2(upper)],
    stop: r2(stop),
    target: r2(target),
    zoneBasis: `锚点固定为当日涨停价 ${r2(p)}（不随实时价漂移），上沿取本轮起涨基准 ${t.base} 至涨停价的 0.382 回撤位；下沿取 0.5 回撤位${ma5 ? `，若 MA5 ${ma5} 落在区间内则上移至该更近支撑` : ''}；区间宽度机械限制在锚点价 1.5%–6%`,
    riskReward: r2((target - upper) / Math.max(0.0001, upper - stop)),
    note: '区间由日线技术位机械测算，仅用于研究参考；实际低吸需等待「缩量回踩不破位 + 分时不破前低」确认，不接放量破位'
  };
}

function verdictOf(x, score, t, theme, role, ov) {
  const veto = [];
  if ((x.brokenCount || 0) >= 3) veto.push(`日内炸板 ${x.brokenCount} 次，封板极不稳定`);
  if ((x.boards || 1) >= 6) veto.push(`${x.boards} 连板属高位加速，追高与低吸赔率均差（leader-game：高位龙头追涨赔率最差）`);
  if (t.available && t.rsi14 !== null && t.rsi14 > 88 && t.devMA5 > 20) veto.push(`RSI14 ${t.rsi14} 且偏离 MA5 ${t.devMA5}%，短线极度超买`);
  if (x.sealFundRatio !== null && x.sealFundRatio !== undefined && x.sealFundRatio < 0.15 && x.turnover > 25) veto.push('封单/流通市值 <0.15% 且换手 >25%，属烂板');
  if (x.floatCap !== null && x.floatCap !== undefined && x.floatCap < 10) veto.push('流通市值 <10 亿，流动性与波动风险过高');
  if (t.available && !t.aboveMA20 && t.macd && t.macd.deadCross) veto.push('跌破 MA20 且 MACD 死叉，趋势与指标同步转弱');
  if (theme && theme.stage === '退潮期' && !role.isCore) veto.push('题材进入退潮期且个股非核心地位');
  if (ov && ov.emotion === '局部退潮' && (x.boards || 1) >= 4) veto.push('市场处于局部退潮，高位连板负反馈风险大');

  let level, reason;
  if (veto.length) { level = '不推荐'; reason = `触发 ${veto.length} 项否决：${veto.join('；')}`; }
  else if (score === null) { level = '数据不足'; reason = '日K数据缺失，无法完成技术面验证，宁可等确认'; }
  else if (score >= 70 && role.isCore && theme && theme.outlookScore >= 3) {
    level = '推荐低吸'; reason = `技术评分 ${score}，题材地位为「${role.role}」，题材处于「${theme.stage}」且预期「${theme.outlook}」，三项条件共振`;
  } else if (score >= 60 && (role.isCore || (theme && theme.outlookScore >= 3))) {
    level = '谨慎观察'; reason = `技术评分 ${score}，地位「${role.role}」；需等待回踩到技术位且缩量企稳后再评估，不追价`;
  } else {
    level = '不推荐'; reason = `技术评分 ${score === null ? '—' : score}，地位「${role.role}」${theme ? `，题材「${theme.stage}」预期「${theme.outlook}」` : ''}；条件不足，宁可等确认`;
  }
  return { level, reason, veto };
}

/** 连板低吸主函数：需外部传入 klineMap / quoteMap */
async function boardLowBuy(pools, ov, themes, klineMap, quoteMap, filters) {
  const zt = (pools.zt || []).filter(x => (x.boards || 1) >= 2);
  const themeOf = code => themes.find(t => t.members.includes(code));
  const all = zt.map(x => {
    const theme = themeOf(x.code);
    const q = quoteMap[x.code] || {};
    const t = technicalAnalysis(klineMap[x.code], q, x);
    const role = roleJudge(x, theme, ov);
    const ts = techScoreOf(x, t, theme);
    const plan = lowBuyPlan(x, t, q);
    const verdict = verdictOf(x, ts.score, t, theme, role, ov);
    return {
      ...x, ...q,
      code: x.code, name: x.name, board: x.board || boardOf(x.code),
      price: q.price !== undefined && q.price !== null ? q.price : x.price,
      floatCap: x.floatCap, turnover: x.turnover,
      technical: t,
      techScore: ts.score,
      techParts: ts.parts,
      role, theme: theme ? {
        name: theme.name, stage: theme.stage, outlook: theme.outlook,
        outlookScore: theme.outlookScore, basis: theme.outlookBasis,
        stageBasis: theme.stageBasis, count: theme.count, maxBoard: theme.maxBoard,
        ladder: theme.ladder, gap: theme.gap, negRate: theme.negRate,
        boardRef: theme.boardRef, watchPoints: theme.watchPoints
      } : null,
      lowBuy: plan,
      verdict,
      score: ts.score === null ? 0 : ts.score,
      entryFramework: {
        steps: [
          '试错仓 10–20%：仅在回踩至低吸区间且缩量不破位时考虑',
          '确认仓 +20–30%：分时企稳、重新站上均价线且板块未走弱',
          '不追高：高开一致性过强或秒板，放弃当日低吸计划'
        ],
        invalid: [
          '跌破低吸区间下沿或止损位，无条件退出',
          '龙头炸板/跌停、板块负反馈率上升',
          '放量破位且 MACD 死叉，趋势条件失效',
          '计划周期内未按预期反包，执行时间止损'
        ]
      }
    };
  });
  const sectorSet = filters && filters._sectorSet ? filters._sectorSet : null;
  return applyFilters(all, { ...filters, sort: filters.sort || 'techScore' }, sectorSet);
}

/* ────────────────────────── 实时机会 ────────────────────────── */
function liveOpportunities(pools, boards, universe, quotes, filters) {
  const byCode = new Map((universe.list || []).map(x => [x.code, x]));
  const decorate = (rows, kind) => rows.map(x => {
    const q = quotes[x.code] || {};
    const base = byCode.get(x.code) || {};
    return {
      ...base, ...x, ...q,
      code: x.code, name: x.name || base.name,
      board: x.board || base.board || boardOf(x.code),
      kind,
      amount: x.amount !== null && x.amount !== undefined ? x.amount : base.amount,
      signal: kind === 'zt' ? ((x.sealFundRatio >= 1 ? '封单强' : '封单一般') + (x.firstSeal && x.firstSeal <= '10:00:00' ? ' · 早盘封板' : ''))
        : kind === 'qs' ? (x.speed > 0 ? '涨速异动' : '强势震荡')
        : kind === 'zb' ? `炸板 ${x.brokenCount || 0} 次，注意负反馈`
        : '跌停，回避'
    };
  });
  const sectorSet = filters && filters._sectorSet;
  const zt = applyFilters(decorate(pools.zt || [], 'zt'), { ...filters, sort: filters.sort || 'sealFundRatio', limit: 80 }, sectorSet);
  const qs = applyFilters(decorate(pools.qs || [], 'qs'), { ...filters, sort: filters.sort || 'pct', limit: 60 }, sectorSet);
  const zb = applyFilters(decorate(pools.zb || [], 'zb'), { ...filters, sort: 'pct', limit: 40 }, sectorSet);
  const dt = applyFilters(decorate(pools.dt || [], 'dt'), { ...filters, sort: 'pct', limit: 30 }, sectorSet);
  const industry = ((boards && boards.industry) || []).slice(0, 60);
  const concept = ((boards && boards.concept) || []).slice(0, 80);
  return { zt, qs, zb, dt, industry, concept, strongCount: (pools.qs || []).length };
}

/* ────────────────────────── 反包板识别 ────────────────────────── */
/**
 * 反包板：前一交易日走弱（阴线 / 大阴 / 断板 / 长上影炸板），今日以涨停收复。
 * 判定只用腾讯前复权日K的真实 OHLCV + 东财涨停池的 zttj 统计，不引用资讯。
 */
function detectReverseBoard(kl, row) {
  const base = { isReverse: false, type: null, strength: null, evidence: null, reason: '' };
  if (!kl || kl.length < 3) return { ...base, reason: '日K样本不足，无法判定是否反包' };
  const t = kl[kl.length - 1], p = kl[kl.length - 2], pp = kl[kl.length - 3];
  if (!t.close || !p.close || !pp.close) return { ...base, reason: '日K收盘价缺失' };
  const pPct = (p.close - pp.close) / pp.close * 100;
  const tPct = (t.close - p.close) / p.close * 100;
  const yin = p.close < p.open;
  const upperShadow = (p.high - p.close) / p.close * 100;
  const coverHigh = p.high ? (t.close - p.high) / p.high * 100 : null;   // >0 为完全反包前日最高
  const bodyTop = Math.max(p.open, p.close);
  const coverBody = (t.close - bodyTop) / bodyTop * 100;
  const volConfirm = p.volume ? t.volume / p.volume : null;
  const recentLimit = (row && row.statCount || 0) >= 2 && (row && row.statDays || 0) <= 12;
  const evidence = {
    prevDate: p.date, prevOpen: r2(p.open), prevClose: r2(p.close),
    prevHigh: r2(p.high), prevLow: r2(p.low), prevPct: r1(pPct),
    prevYin: yin, prevUpperShadow: r1(upperShadow), todayPct: r1(tPct),
    coverHigh: r1(coverHigh), coverBody: r1(coverBody), volConfirm: r2(volConfirm),
    recentLimitStat: row ? `${row.statCount || 0} 次/${row.statDays || 0} 日` : null
  };
  // 今日必须确实是强势涨停日（与涨停池交叉校验，避免日K未更新到当日造成误判）
  if (tPct < 5) return { ...base, evidence, reason: '日K最新一根未体现涨停，可能数据未更新，不做反包判定' };

  let type = null, note = '';
  if (yin && pPct <= -5) { type = '大阴反包'; note = `前日收阴且跌 ${r1(pPct)}%，今日涨停收复`; }
  else if (yin && recentLimit && pPct < 0) { type = '断板反包'; note = `前日断板收阴且当日下跌 ${r1(pPct)}%（近 ${evidence.recentLimitStat} 有涨停），今日涨停反包`; }
  else if (upperShadow >= 4 && pPct >= 3) { type = '炸板/长上影反包'; note = `前日上影 ${r1(upperShadow)}% 冲高回落，今日涨停收复`; }
  else if (yin && coverBody > 0) { type = '阴线反包'; note = `前日收阴，今日涨停收盘越过前日实体上沿 ${r1(coverBody)}%`; }
  else return { ...base, evidence, reason: '前一日未出现走弱结构（阴线/大阴/长上影），不构成反包' };

  const fullCover = coverHigh !== null && coverHigh > 0;
  return {
    isReverse: true, type,
    strength: fullCover ? '完全反包（收盘过前日最高）' : '部分反包（收盘过前日实体上沿）',
    strengthPct: r1(fullCover ? coverHigh : coverBody),
    coverLabel: fullCover ? '收盘越过前日最高价' : '收盘越过前日实体上沿',
    volConfirm: r2(volConfirm),
    evidence,
    note: note + (fullCover ? '；收盘已越过前日最高价' : '；收盘未过前日最高价'),
    reason: note
  };
}

/* ────────────────────────── 明日接力推荐 ────────────────────────── */
function relayMethodOf(x, ov) {
  const b = x.boards || 1, seal = x.sealFundRatio, brk = x.brokenCount || 0;
  if (ov && (ov.tier === '防守' || ov.emotion === '局部退潮') && b >= 4)
    return { method: '不参与高位接力', note: '市场防守/退潮且已在高位，高位股次日开盘高度易被压制' };
  if (b >= 6) return { method: '只观察', note: '连板高度过高，接力赔率最差' };
  if (brk >= 3) return { method: '回避', note: `日内炸板 ${brk} 次，封板极不稳定` };
  if (x.reverse && x.reverse.isReverse)
    return { method: '竞价低吸 / 半路承接', note: '反包板次日重点看竞价承接与是否放量高开秒板，不追一致性高开' };
  if (seal !== null && seal !== undefined && seal >= 2 && brk === 0 && x.firstSeal && x.firstSeal <= '10:00:00')
    return { method: '打板（需竞价确认）', note: '封单强、早盘封板且未炸板，若次日竞价一致需等分歧回封' };
  if (seal !== null && seal !== undefined && seal >= 0.5)
    return { method: '回封接力', note: '封单中等，等分歧转一致的回封动作，不打首次触板' };
  return { method: '只观察', note: '封板质量或题材条件不足，等次日盘面确认' };
}

function relayPicks(pools, ov, themes, klineMap, quotes, filters) {
  const zt = pools.zt || [];
  const themeOf = code => themes.find(t => t.members.includes(code));
  const marketWeak = ov && (ov.tier === '防守' || ov.emotion === '局部退潮');

  const rows = zt.map(x => {
    const rev = detectReverseBoard(klineMap[x.code], x);
    return { ...x, reverse: rev };
  }).filter(x => (x.boards || 1) >= 2 || x.reverse.isReverse);

  const all = rows.map(x => {
    const q = quotes[x.code] || {};
    const theme = themeOf(x.code);
    const role = roleJudge(x, theme, ov);
    const t = technicalAnalysis(klineMap[x.code], q, x);
    const b = x.boards || 1;
    const parts = [];
    let s = 0, v;

    // 1 梯队与高度 20
    v = 0;
    if (b === 2 || b === 3) v = 14; else if (b === 4) v = 9; else if (b >= 5) v = 3; else v = 8;
    if (ov && ov.spaceBoard.some(z => z.code === x.code)) v += 3;
    if (ov && ov.gap) v -= 4;
    if (x.reverse.isReverse && b === 1) v += 4;
    v = clamp(v, 0, 20); s += v;
    parts.push({ factor: '梯队/高度', got: v, max: 20, detail: `${b} 连板${x.reverse.isReverse ? ' · ' + x.reverse.type : ''}${ov && ov.gap ? '；梯队有断层' : '；梯队无断层'}` });

    // 2 题材 20
    v = theme ? Math.min(10, theme.count * 2) + theme.outlookScore * 2.5 : 2;
    v = clamp(v, 0, 20); s += v;
    parts.push({ factor: '题材环境', got: +v.toFixed(1), max: 20, detail: theme ? `${theme.name} ${theme.count} 只涨停，「${theme.stage}」预期「${theme.outlook}」` : '无题材分组' });

    // 3 龙头地位 15
    v = role.role === '绝对龙头（空间板）' || role.role === '题材龙头' ? 15 : (role.isCore ? 11 : (role.role === '题材前排' ? 7 : 2));
    s += v; parts.push({ factor: '板块地位', got: v, max: 15, detail: role.role + '：' + role.reason });

    // 4 封板质量 20
    v = 0; const det = [];
    if (x.sealFundRatio !== null && x.sealFundRatio !== undefined) {
      if (x.sealFundRatio >= 2) { v += 10; det.push('封单≥2%'); }
      else if (x.sealFundRatio >= 0.5) { v += 6; det.push('封单≥0.5%'); }
      else { v += 1; det.push('封单薄'); }
    }
    if ((x.brokenCount || 0) === 0) { v += 6; det.push('未炸板'); } else { v -= Math.min(10, x.brokenCount * 4); det.push(`炸板${x.brokenCount}次`); }
    if (x.firstSeal && x.firstSeal <= '10:00:00') { v += 4; det.push('早盘封板'); }
    v = clamp(v, -10, 20); s += v;
    parts.push({ factor: '封板质量', got: v, max: 20, detail: det.join(' / ') || '无封板数据' });

    // 5 反包 / 量价 15
    v = 0;
    if (x.reverse.isReverse) {
      v += x.reverse.strengthPct > 0 ? 8 : 5;
      if (x.reverse.volConfirm !== null && x.reverse.volConfirm >= 0.8 && x.reverse.volConfirm <= 3) v += 4;
      else v += 1;
    } else {
      v += 6;
      if (t.available && t.volSurge !== null && t.volSurge >= 1 && t.volSurge <= 3) v += 4;
    }
    const tn = x.turnover;
    if (tn !== null && tn !== undefined) v += (tn >= 3 && tn <= 25) ? 3 : 0;
    v = clamp(v, 0, 15); s += v;
    parts.push({ factor: '反包/量价', got: v, max: 15, detail: x.reverse.isReverse
      ? `${x.reverse.type}，覆盖 ${x.reverse.strengthPct}%，量比确认 ${x.reverse.volConfirm === null ? '—' : x.reverse.volConfirm} 倍`
      : `换手 ${tn === null || tn === undefined ? '—' : r1(tn)}%，量能 ${t.available ? t.volSurge : '—'} 倍` });

    // 6 市场环境 10
    v = ov && ov.tier === '进攻' ? 10 : (ov && ov.tier === '震荡' ? 6 : 1);
    s += v; parts.push({ factor: '市场环境', got: v, max: 10, detail: `档位「${ov ? ov.tier : '—'}」/ 情绪「${ov ? ov.emotion : '—'}」` });

    const score = Math.round(clamp(s, 0, 100));
    const method = relayMethodOf(x, ov);
    const veto = [];
    if ((x.brokenCount || 0) >= 3) veto.push(`日内炸板 ${x.brokenCount} 次`);
    if (b >= 6) veto.push('6 板及以上，高位接力赔率最差');
    if (marketWeak && b >= 4) veto.push('市场防守/退潮 + 高位连板');
    if (x.sealFundRatio !== null && x.sealFundRatio !== undefined && x.sealFundRatio < 0.15 && x.turnover > 25) veto.push('封单极薄且换手过高');
    if (theme && theme.stage === '退潮期' && !role.isCore) veto.push('题材退潮且非核心标的');
    if (x.floatCap !== null && x.floatCap !== undefined && x.floatCap < 10) veto.push('流通市值 <10 亿');

    let level, levelReason;
    if (veto.length) { level = '回避'; levelReason = `触发否决：${veto.join('；')}`; }
    else if (score >= 72 && role.isCore && theme && theme.outlookScore >= 3)
      { level = '重点接力'; levelReason = `评分 ${score}，题材地位「${role.role}」，题材预期「${theme.outlook}」三项共振`; }
    else if (score >= 58) { level = '条件接力'; levelReason = `评分 ${score}，需竞价与板块承接确认后才有意义`; }
    else if (score >= 45) { level = '观察'; levelReason = `评分 ${score}，条件不足，只看不接`; }
    else { level = '回避'; levelReason = `评分 ${score}，结构与环境均不支持`; }

    const price = q.price !== undefined && q.price !== null ? q.price : x.price;
    const anchors = {
      todayLimitUp: q.limitUp || x.limitUpPrice || null,
      avgPrice: q.avgPrice || null,
      ma5: t.available ? t.ma.ma5 : null,
      auctionZone: price ? [r2(price * 0.98), r2(price * 1.02)] : null
    };
    const peers = zt.filter(z => z.code !== x.code && (theme ? theme.members.includes(z.code) : false))
      .sort((a, c) => (c.boards || 1) - (a.boards || 1)).slice(0, 3)
      .map(z => ({ code: z.code, name: z.name, boards: z.boards || 1 }));

    return {
      ...x, ...q,
      code: x.code, name: x.name, board: x.board || boardOf(x.code),
      price, floatCap: x.floatCap, turnover: x.turnover,
      category: (b >= 2 && x.reverse.isReverse) ? '连板+反包' : (x.reverse.isReverse ? '反包接力' : '连板接力'),
      reverse: x.reverse,
      theme: theme ? { name: theme.name, stage: theme.stage, outlook: theme.outlook, outlookScore: theme.outlookScore, count: theme.count, maxBoard: theme.maxBoard, gap: theme.gap } : null,
      role, technical: t.available ? {
        position: t.position, ma5: t.ma.ma5, ma10: t.ma.ma10, ma20: t.ma.ma20,
        rsi14: t.rsi14, volSurge: t.volSurge, devMA5: t.devMA5
      } : null,
      relayScore: score, scoreParts: parts, level, levelReason, veto,
      method, anchors, peers,
      ladderNote: `${b} 进 ${b + 1}：需龙头不炸板、板块首板数量继续扩散、竞价承接不低于 ${anchors.auctionZone ? anchors.auctionZone[0] : '—'} 元附近` ,
      invalidate: [
        '竞价低开超过测算区间下沿且无量承接',
        '龙头炸板/跌停，板块负反馈率上升',
        '高开一致性过强（秒板）后开板放量，视为兑现而非接力',
        '计划周期内未晋级，执行时间止损'
      ],
      score
    };
  });

  const sectorSet = filters && filters._sectorSet ? filters._sectorSet : null;
  const list = applyFilters(all, { ...filters, sort: filters.sort || 'relayScore', limit: filters.limit || 80 }, sectorSet);
  const summary = {
    total: all.length,
    shown: list.length,
    connected: all.filter(x => (x.boards || 1) >= 2).length,
    reverse: all.filter(x => x.reverse.isReverse).length,
    both: all.filter(x => x.category === '连板+反包').length,
    levels: all.reduce((a, x) => (a[x.level] = (a[x.level] || 0) + 1, a), {}),
    // 首板股必须靠日K才能判定反包；缺失时明确报数，避免「反包 0 只」被误读为市场没有反包
    klineMissing: zt.filter(x => (x.boards || 1) === 1 && (!klineMap[x.code] || klineMap[x.code].length < 20)).length
  };
  return { list, summary };
}

/* ────────────────────────── AI 综合研判（本地量化引擎） ────────────────────────── */
/**
 * 说明：默认模式为「本地量化研判引擎」——由规则 + 实时数据生成结构化结论，
 * 每个数字都能追溯到具体字段；不假装是大模型输出。
 * 若用户在页面配置 OpenAI 兼容 API，服务端会另走 /api/ai/analyze 生成增强文本并明确标注来源。
 */
function aiResearch(ctx) {
  const { ov, themes, review, picks, lowbuy, relay, meta } = ctx;
  const relayList = (relay && relay.list) || [];
  const merged = new Map();
  const put = (x, mod, sc, note) => {
    if (!x || !x.code) return;
    const e = merged.get(x.code) || {
      code: x.code, name: x.name, board: x.board || boardOf(x.code),
      price: x.price, pct: x.pct, floatCap: x.floatCap,
      theme: (x.theme && x.theme.name) || x.themeName || x.industry || null,
      modules: [], scores: [], notes: [], risks: []
    };
    if (e.price === undefined || e.price === null) e.price = x.price;
    e.modules.push(mod);
    if (sc !== null && sc !== undefined) e.scores.push(sc);
    if (note) e.notes.push(`【${mod}】${note}`);
    if (x.risks) x.risks.forEach(r => { if (e.risks.indexOf(r) < 0) e.risks.push(r); });
    if (x.veto) x.veto.forEach(r => { const t = '接力否决：' + r; if (e.risks.indexOf(t) < 0) e.risks.push(t); });
    if (x.verdict && x.verdict.veto) x.verdict.veto.forEach(r => { const t = '低吸否决：' + r; if (e.risks.indexOf(t) < 0) e.risks.push(t); });
    merged.set(x.code, e);
  };
  (picks || []).forEach(x => put(x, '短线推荐', x.score, `${x.verdict || '—'}，评分 ${x.score}${x.themeStage ? '，题材「' + x.themeStage + '」' : ''}`));
  (lowbuy || []).forEach(x => put(x, '连板低吸', x.techScore, `${x.verdict.level}，技术评分 ${x.techScore}，地位「${x.role.role}」`));
  relayList.forEach(x => put(x, '明日接力', x.relayScore, `${x.level}（${x.category}），评分 ${x.relayScore}，方式「${x.method.method}」`));

  const topPicks = [...merged.values()].map(e => {
    const base = e.scores.length ? avg(e.scores) : 0;
    const resonance = Math.min(3, e.modules.length - 1) * 4;
    e.composite = Math.round(clamp(base + resonance, 0, 100));
    e.resonance = e.modules.length;
    return e;
  }).sort((a, b) => b.resonance - a.resonance || b.composite - a.composite).slice(0, 8);

  const topThemes = (themes || []).slice(0, 3);
  const levelCnt = (relay && relay.summary && relay.summary.levels) || {};
  const sections = [
    {
      title: '市场状态与广度',
      body: `当前判定为「${ov.tier}」档、情绪「${ov.emotion}」。全市场 ${ov.up} 涨 / ${ov.down} 跌，广度 ${ov.breadth}%；涨幅≥5% ${ov.up5} 家、跌幅≥5% ${ov.down5} 家；主要指数均值 ${ov.idxAvg}%。${ov.tierNote}。`,
      basis: ['新浪财经全市场快照涨跌家数', '腾讯证券主要指数实时涨跌幅', '东方财富涨停/跌停/炸板池']
    },
    {
      title: '涨停结构与情绪',
      body: `涨停 ${ov.limitUp} 家、跌停 ${ov.limitDown} 家、炸板 ${ov.broken} 家（炸板率 ${ov.breakRate}%），最高 ${ov.maxBoard} 板，梯队 ${Object.keys(ov.ladder).sort((a, b) => b - a).map(b => b + '板×' + ov.ladder[b]).join(' / ') || '无'}，${ov.gap ? '存在断层' : '无断层'}。${ov.emotionNote}。`,
      basis: ['东方财富涨停池 lbc 连板数', '东方财富炸板池 zbc 炸板次数']
    },
    {
      title: '主线题材与生命周期',
      body: topThemes.length
        ? topThemes.map(t => `${t.name}（${t.count} 只涨停 / 最高 ${t.maxBoard} 板）处于「${t.stage}」，预期「${t.outlook}」：${t.outlookBasis}`).join('；') + '。'
        : '当前涨停结构分散，未形成清晰主线。',
      basis: ['东方财富涨停池 hybk 行业归属', '新浪财经行业/概念板块涨跌幅']
    },
    {
      title: '候选池交叉验证',
      body: `短线推荐 ${(picks || []).length} 只、连板低吸 ${(lowbuy || []).length} 只、明日接力 ${relayList.length} 只（连板 ${(relay && relay.summary && relay.summary.connected) || 0} / 反包 ${(relay && relay.summary && relay.summary.reverse) || 0}）。接力分层：重点 ${levelCnt['重点接力'] || 0}、条件 ${levelCnt['条件接力'] || 0}、观察 ${levelCnt['观察'] || 0}、回避 ${levelCnt['回避'] || 0}。跨模块共振 ${topPicks.filter(x => x.resonance >= 2).length} 只进入综合榜。`,
      basis: ['三套评分引擎输出（因子明细见各模块）']
    }
  ];

  const headline = `「${ov.tier}」档 / 「${ov.emotion}」情绪下，系统从三个候选池交叉验证出 ${topPicks.filter(x => x.resonance >= 2).length} 只共振标的；结论以条件化观察为主，不建议在高位一致性阶段追价。`;
  const riskAlerts = [
    ...(review && review.risks ? review.risks : []),
    `炸板率 ${ov.breakRate}%，${ov.breakRate > 35 ? '封板稳定性偏弱，次日开盘高度易被压制' : '封板稳定性尚可'}`,
    `接力候选 ${relayList.length} 只中「回避」${levelCnt['回避'] || 0} 只，占比 ${relayList.length ? Math.round((levelCnt['回避'] || 0) / relayList.length * 100) : 0}%`,
    '本引擎不接入新闻 / 公告 / 龙虎榜，题材阶段由量价结构机械推导；重大消息面需自行核实'
  ];
  const watchList = (review && review.focus ? review.focus : []).map(f => f.title + '：' + f.text);

  return {
    mode: 'local',
    modeLabel: '本地量化研判引擎（规则生成，可追溯）',
    headline, sections, topPicks, riskAlerts, watchList,
    sourceNote: `数据源时点：新浪全市场 ${(meta && meta.universeTick) || '—'} / 腾讯实时 ${(meta && meta.quoteTick) || '—'} / 东财涨停池交易日 ${(meta && meta.poolDate) || '—'}`,
    caveat: '本模块结论由确定性规则引擎基于实时行情生成，不是大模型生成内容；所有判断可追溯到上方数据字段，不含新闻与主观预测。'
  };
}

/* ────────────────────────── 涨停回调到支撑位（划线引擎） ────────────────────────── */
/**
 * 方法论：price-action-tools（趋势 > 关键位置 > 短期信号，多系统交叉验证）
 *        + trade-plan（位置判断 / 条件化入场 / 止损 / 失效条件）
 *        + leader-game（涨停后不追高，只评估回调结构）
 *
 * 输入必须全部来自 datasource.js 的真实前复权日K与实时快照；本层只做结构化计算，
 * 不内置、不推测任何行情数字。每条划线都带「生成依据 + 触碰次数」，可逐条解释。
 */
const limitThreshold = code => /^(300|301|688|689)/.test(String(code || '')) ? 19.3
  : (/^(8|4|920)/.test(String(code || '')) ? 29.3 : 9.6);

const fmtD = d => String(d || '').replace(/-/g, '');
const shortDate = d => String(d || '').slice(5);

/** 分形高低点聚类：把 ±1.2% 内的历史高低点合并成一条水平位 */
function pivotClusters(kl, lookback = 75) {
  const pts = [];
  const s = Math.max(2, kl.length - lookback);
  for (let i = s; i < kl.length - 2; i++) {
    const w = kl.slice(i - 2, i + 3);
    if (kl[i].high >= Math.max(...w.map(x => x.high))) pts.push({ price: kl[i].high, date: kl[i].date, kind: '高点' });
    if (kl[i].low <= Math.min(...w.map(x => x.low))) pts.push({ price: kl[i].low, date: kl[i].date, kind: '低点' });
  }
  const groups = [];
  for (const p of pts.sort((a, b) => a.price - b.price)) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(p.price - g.price) / g.price <= 0.012) {
      g.points.push(p);
      g.price = avg(g.points.map(x => x.price));
    } else groups.push({ price: p.price, points: [p] });
  }
  return groups.filter(g => g.points.length >= 2).map(g => ({
    price: r2(g.price),
    pivots: g.points.length,
    lastDate: g.points[g.points.length - 1].date,
    kinds: [...new Set(g.points.map(x => x.kind))].join('/')
  }));
}

/** 有效触碰次数：只统计「局部极值」触及该水平位（影线测试并折返），不是简单穿越 */
function countTouches(kl, level, tol = 0.008) {
  let n = 0, lastDate = null;
  for (let i = 1; i < kl.length - 1; i++) {
    const b = kl[i];
    const lowTouch = b.low <= level * (1 + tol) && b.low >= level * (1 - tol) && b.low <= kl[i - 1].low && b.low <= kl[i + 1].low;
    const highTouch = b.high >= level * (1 - tol) && b.high <= level * (1 + tol) && b.high >= kl[i - 1].high && b.high >= kl[i + 1].high;
    if (lowTouch || highTouch) { n++; lastDate = b.date; }
  }
  return { n, lastDate };
}

/** 价格相近（≤0.6%）的划线合并，保留全部依据，图上用短名 */
function mergeLevels(arr) {
  const out = [];
  for (const l of [...arr].sort((a, b) => a.price - b.price)) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(l.price - prev.price) / prev.price <= 0.006) {
      prev.price = r2((prev.price + l.price) / 2);
      prev.basis += '；' + l.basis;
      prev.types.push(l.type);
      if (prev.short.length > l.short.length) prev.short = l.short;
    } else out.push({ ...l, types: [l.type] });
  }
  return out;
}

/**
 * 单只标的的「涨停回调 → 支撑位」划线与判定
 * @param kl    腾讯前复权日K（升序，≥30 根）
 * @param quote 腾讯实时快照（可为空）
 * @param pool  东财历史涨停池标记（只用于交叉校验与展示，不作为行情结论）
 * @param ctx   { code, ov }
 */
function pullbackAnalysis(kl, quote, pool, ctx) {
  const code = (ctx && ctx.code) || (pool && pool.code) || '';
  // 日K口径由取数层如实传入（腾讯前复权 / 新浪不复权降级），不能写死
  const klineSource = (ctx && ctx.klineSource) || '腾讯证券前复权日K';
  const empty = reason => ({ available: false, reason });
  if (!kl || kl.length < 30) return empty('日K样本不足 30 根，无法计算支撑压力位（不做推测）');

  const closes = kl.map(x => x.close);
  const last = kl[kl.length - 1];
  const price = (quote && Number(quote.price)) || last.close;
  if (!(price > 0)) return empty('现价缺失，无法计算划线相对位置');

  // 1) 涨停日以真实日K涨幅识别（不从历史池字段推断）
  const th = limitThreshold(code);
  let z = -1;
  for (let i = kl.length - 1; i >= Math.max(1, kl.length - 12); i--) {
    const prev = kl[i - 1].close;
    if (!prev) continue;
    if ((kl[i].close - prev) / prev * 100 >= th) { z = i; break; }
  }
  if (z < 0) return empty('近 12 根日K内未识别到涨停日（涨幅阈值 ' + th + '%），不属于涨停回调结构');
  if (z > kl.length - 3) return empty('最近一根日K仍为涨停，尚未进入回调观察窗');
  // 回调窗口内若又出现涨停，说明已反包/再启动，不属于「回踩支撑」结构
  for (let i = z + 1; i < kl.length; i++) {
    const prev = kl[i - 1].close;
    if (prev && (kl[i].close - prev) / prev * 100 >= th) return empty('回调窗口内再度涨停，已不是回踩支撑结构');
  }

  const ztBar = kl[z];
  const sinceZt = kl.length - 1 - z;                     // 涨停后交易日数
  const lowFrom = Math.max(0, z - 8);
  const preWindow = kl.slice(lowFrom, z + 1);
  const L = Math.min(...preWindow.map(x => x.low));      // 起涨波段低点
  let H = -Infinity, hiIdx = z;
  for (let i = z; i < kl.length; i++) if (kl[i].high > H) { H = kl[i].high; hiIdx = i; }
  if (!(H > L) || !(L > 0)) return empty('波段高低点异常，无法计算斐波那契回撤');

  const drawdown = r1((H - price) / H * 100);            // 距阶段高点回撤 %
  const retrace = r1((H - price) / (H - L) * 100);       // 回撤占本轮涨幅比例 %
  const ma5Arr = sma(closes, 5), ma10Arr = sma(closes, 10), ma20Arr = sma(closes, 20), ma60Arr = sma(closes, 60);
  const E = kl.length - 1;
  const ma5 = ma5Arr[E], ma10 = ma10Arr[E], ma20 = ma20Arr[E], ma60 = ma60Arr[E];
  const r14 = rsi(closes, 14);
  const pivots = pivotClusters(kl);
  const prevBar = kl[z - 1];

  // 2) 生成可解释的划线（每条都带生成依据与真实数字）
  const rawS = [], rawR = [];
  const add = (arr, kind, short, name, val, basis, type) => {
    if (val !== null && val !== undefined && Number.isFinite(val) && val > 0)
      arr.push({ kind, short, name, price: r2(val), basis, type });
  };
  // 支撑：跳空缺口下沿（涨停日低点高于前一日高点）
  if (ztBar.low > prevBar.high) {
    add(rawS, 'support', '缺口下沿', '涨停跳空缺口下沿', prevBar.high,
      shortDate(prevBar.date) + ' 最高 ' + r2(prevBar.high) + ' → 涨停日 ' + shortDate(ztBar.date) + ' 最低 ' + r2(ztBar.low) + '，中间形成未回补跳空缺口，缺口下沿构成支撑', 'gap');
  }
  add(rawS, 'support', '涨停日低点', '涨停日最低价', ztBar.low,
    shortDate(ztBar.date) + ' 涨停日最低 ' + r2(ztBar.low) + '（开 ' + r2(ztBar.open) + ' / 收 ' + r2(ztBar.close) + '），为当日多方成本下沿', 'ztLow');
  add(rawS, 'support', '涨停日开盘', '涨停日开盘价', ztBar.open,
    shortDate(ztBar.date) + ' 开盘 ' + r2(ztBar.open) + '，涨停实体起点', 'ztOpen');
  add(rawS, 'support', '起涨低点', '本轮起涨波段低点', L,
    '涨停日前 8 根至涨停日的最低价 ' + r2(L) + '，跌破即本轮结构破坏', 'swingLow');
  for (const p of pivots.filter(p => p.price < price * 1.005 && p.price > L * 0.9).slice(-3)) {
    add(rawS, 'support', '前高转支撑', '前期高点突破后转支撑', p.price,
      '近 75 根日K中 ' + p.pivots + ' 个' + p.kinds + '分型聚集于 ' + r2(p.price) + '（末次 ' + shortDate(p.lastDate) + '），突破后回踩常转为支撑', 'pivot');
  }
  [0.382, 0.5, 0.618].forEach((f, i) => {
    const v = H - (H - L) * f;
    add(rawS, 'support', ['0.382', '0.5', '0.618'][i] + '回撤', '斐波那契 ' + (f * 100).toFixed(1) + '% 回撤', v,
      '本轮起涨低点 ' + r2(L) + ' → 阶段高点 ' + r2(H) + '，回撤 ' + (f * 100).toFixed(1) + '% = ' + r2(v), 'fib');
  });
  // 均线是动态曲线，不作为水平划线参与「主支撑」竞争，改由图上折线 + 参考位列表展示
  // 压力
  add(rawR, 'resistance', '阶段高点', '涨停后阶段最高价', H,
    shortDate(kl[hiIdx].date) + ' 阶段最高 ' + r2(H) + '，为上方最直接压力', 'swingHigh');
  if (ztBar.high < H * 0.999) add(rawR, 'resistance', '涨停日高点', '涨停日最高价', ztBar.high,
    shortDate(ztBar.date) + ' 涨停日最高 ' + r2(ztBar.high), 'ztHigh');
  for (const p of pivots.filter(p => p.price > price * 1.005).slice(0, 3)) {
    add(rawR, 'resistance', '前期高点', '前期分型高点压力', p.price,
      '近 75 根日K中 ' + p.pivots + ' 个' + p.kinds + '分型聚集于 ' + r2(p.price) + '（末次 ' + shortDate(p.lastDate) + '）', 'pivot');
  }
  const maRefs = [
    ma5 ? { name: 'MA5', price: r2(ma5), note: '动态均线，图上以折线展示，非固定水平位' } : null,
    ma10 ? { name: 'MA10', price: r2(ma10), note: '动态均线，图上以折线展示，非固定水平位' } : null,
    ma20 ? { name: 'MA20', price: r2(ma20), note: '动态均线，常作回踩参考，随行情滚动变化' } : null
  ].filter(Boolean);

  // 支撑压力互换：静态位若已位于现价上方，不能再当支撑，改列压力并说明
  const rawSClean = [];
  for (const l of rawS) {
    if (l.price > price * 1.005) {
      rawR.push({
        ...l, kind: 'resistance', short: l.short + '·转压力',
        basis: l.basis + '；该位当前位于现价 ' + r2(price) + ' 上方，按支撑/压力互换原则视为压力'
      });
    } else rawSClean.push(l);
  }

  // 反向互换：原本的压力位若已被站上、落到现价下方，改列支撑
  const rawRClean = [];
  for (const l of rawR) {
    if (l.price < price * 0.995) {
      rawSClean.push({
        ...l, kind: 'support', short: l.short + '·转支撑',
        basis: l.basis + '；该位当前位于现价 ' + r2(price) + ' 下方，按支撑/压力互换原则视为支撑'
      });
    } else rawRClean.push(l);
  }

  const decorate = (arr, prefix) => mergeLevels(arr).map((l, i) => {
    const t = countTouches(kl, l.price);
    const bonus = (l.types.includes('gap') || l.types.includes('pivot') || l.types.includes('ztLow')) ? 1 : 0;
    const strength = clamp(1 + (t.n >= 7 ? 2 : t.n >= 3 ? 1 : 0) + bonus, 1, 3);
    return {
      id: prefix + (i + 1), kind: l.kind, short: l.short, name: l.name,
      price: l.price, basis: l.basis, types: l.types,
      touches: t.n, lastTouch: t.lastDate, strength,
      distPct: r1((l.price - price) / price * 100),
      source: klineSource + '（本系统按规则计算）'
    };
  });
  const supAsc = decorate(rawSClean, 'S');
  const resAsc = decorate(rawRClean, 'R');

  // 3) 主支撑 / 主压力：取现价下方最近的一条支撑，与上方最近的一条压力
  const below = supAsc.filter(s => s.price <= price);
  const ps = below.length ? below[below.length - 1] : (supAsc[0] || null);
  const above = resAsc.filter(s => s.price > price * 1.005);
  const pr = above.length ? above[0] : (resAsc[resAsc.length - 1] || null);
  if (!ps) return empty('未识别出有效支撑位');

  const nearPct = r1((price - ps.price) / ps.price * 100);
  const broken = last.close < ps.price * 0.985;
  let status;
  if (broken || nearPct < -2) status = '跌破支撑';
  else if (nearPct <= 2) status = '已回踩到位';
  else if (nearPct <= 4.5) status = '接近支撑';
  else status = '反弹偏离';
  const recentTouched = kl.slice(-3).some(b => b.low <= ps.price * 1.012 && b.close >= ps.price * 0.985);

  // 4) 量能：回调段均量 / 涨停段均量（缩量回调是核心确认项）
  const upVols = kl.slice(Math.max(0, z - 2), z + 1).map(x => x.volume).filter(v => Number.isFinite(v) && v > 0);
  const downVols = kl.slice(z + 1).map(x => x.volume).filter(v => Number.isFinite(v) && v > 0);
  const volRatio = upVols.length && downVols.length ? r2(avg(downVols) / avg(upVols)) : null;

  // 5) 条件化交易框架（trade-plan：位置 / 区间 / 止损 / 目标 / 失效条件）
  // 止损 = 主支撑下方 3%（机械、可复核）；起涨低点单独作为「结构破坏线」，不与止损混用
  const stop = r2(ps.price * 0.97);
  const structBreak = r2(L * 0.99);
  // 目标 = 距现价 ≥2% 的最近压力位；若压力都贴着现价，则取本轮阶段高点（均为真实日K价位）
  const roomR = resAsc.find(s => s.price > price * 1.02);
  const target = roomR ? roomR.price : r2(H);
  const rr = price > stop ? r2(Math.max(0, (target - price) / (price - stop))) : 0;
  const roomPct = r1((target - price) / price * 100);
  const aboveMA20 = ma20 !== null && price > ma20;

  // 6) 多系统评分（0–100）
  const parts = [];
  let score = 0, v;
  v = clamp(Math.round(ps.strength * 6 + (ps.touches >= 5 ? 7 : ps.touches >= 2 ? 4 : 0)), 0, 25);
  score += v; parts.push({ factor: '支撑质量', got: v, max: 25, detail: '主支撑「' + ps.short + '」' + ps.price + ' 元，强度 ' + ps.strength + '/3，历史触碰 ' + ps.touches + ' 次，类型 ' + ps.types.join('+') });
  v = nearPct <= 1 ? 20 : nearPct <= 2 ? 16 : nearPct <= 3.5 ? 11 : nearPct <= 5 ? 6 : 2;
  score += v; parts.push({ factor: '回踩贴合度', got: v, max: 20, detail: '现价 ' + r2(price) + ' 距主支撑 ' + nearPct + '%，状态「' + status + '」' });
  v = volRatio === null ? 5 : (volRatio <= 0.7 ? 15 : volRatio <= 0.95 ? 11 : volRatio <= 1.3 ? 6 : volRatio <= 2 ? 2 : 0);
  score += v; parts.push({ factor: '缩量回调', got: v, max: 15, detail: '回调段均量 / 涨停段均量 = ' + (volRatio === null ? '—' : volRatio) + ' 倍' + (volRatio !== null && volRatio > 1.3 ? '（放量下跌，警惕抛压）' : '') });
  v = (broken ? 0 : 6) + (aboveMA20 ? 4 : 0) + (retrace >= 25 && retrace <= 75 ? 5 : retrace >= 15 && retrace <= 90 ? 3 : 0);
  score += v; parts.push({ factor: '结构完整度', got: v, max: 15, detail: '收盘' + (broken ? '已破位' : '未破位') + '，' + (aboveMA20 ? '站上' : '跌破') + ' MA20，回撤比例 ' + retrace + '%' });
  v = rr >= 2 ? 15 : rr >= 1.5 ? 11 : rr >= 1 ? 6 : 2;
  score += v; parts.push({ factor: '上方空间/盈亏比', got: v, max: 15, detail: '目标 ' + r2(target) + '（+' + roomPct + '%）/ 止损 ' + r2(stop) + '，盈亏比 ' + rr });
  const tier = ctx && ctx.ov ? ctx.ov.tier : null;
  v = tier === '进攻' ? 10 : tier === '震荡' ? 6 : tier === '切换' ? 4 : tier === '防守' ? 2 : 5;
  score += v; parts.push({ factor: '市场环境', got: v, max: 10, detail: '市场档位「' + (tier || '未取得') + '」' });
  score = Math.round(clamp(score, 0, 100));

  const veto = [];
  if (broken) veto.push('最新收盘 ' + r2(last.close) + ' 已跌破主支撑 ' + ps.price + '（低于 1.5%）');
  if (retrace > 95) veto.push('回撤比例 ' + retrace + '%，几乎吞没本轮涨停涨幅，结构破坏');
  if (volRatio !== null && volRatio > 2) veto.push('回调段均量为涨停段的 ' + volRatio + ' 倍，属放量下跌');
  if (price <= L * 0.99) veto.push('现价已低于起涨波段低点 ' + r2(L));
  if (sinceZt > 10) veto.push('涨停后已 ' + sinceZt + ' 个交易日，超出短线回调观察窗');

  let level, reason;
  if (veto.length) score = Math.min(score, 45);   // 触发否决时压低排序分，避免「高分但已失效」的视觉矛盾
  if (veto.length) { level = '已失效'; reason = '触发 ' + veto.length + ' 项否决：' + veto.join('；'); }
  else if (score >= 70 && nearPct <= 2.5 && (volRatio === null || volRatio <= 1.15) && rr >= 1.3)
    { level = '重点观察'; reason = '评分 ' + score + '，现价距「' + ps.short + '」仅 ' + nearPct + '%，缩量回调且盈亏比 ' + rr + '，条件共振'; }
  else if (score >= 55) { level = '条件观察'; reason = '评分 ' + score + '，状态「' + status + '」；需等待缩量企稳与分时不破前低确认，不追价'; }
  else { level = '仅跟踪'; reason = '评分 ' + score + '，距支撑 ' + nearPct + '%、量能 ' + (volRatio === null ? '—' : volRatio) + ' 倍，条件不足，宁可等确认'; }

  const crossDate = pool && pool.date ? String(pool.date) : null;
  const klDate = fmtD(ztBar.date);
  const crossNote = !crossDate ? '本次由日K独立识别涨停日（历史池未标记该代码）'
    : crossDate === klDate ? '东财历史涨停池标记日与日K识别的涨停日一致（' + ztBar.date + '）'
      : '东财历史池最近标记为 ' + crossDate + '，日K识别最近涨停日为 ' + klDate + '；按数据一致性原则以真实日K为准';

  // 7) 图表数据：近 60 根 + 均线 + 精选划线 + 回踩观察区
  //     完整支撑/压力列表在解释区逐条列出；图上只标注最重要的 4 支撑 + 3 压力，避免线条糊成一片
  const W = Math.min(60, kl.length);
  const cut = kl.length - W;
  const supDesc = supAsc.slice().reverse();
  const pickS = [ps];
  for (const s of supDesc) {
    if (pickS.length >= 4) break;
    if (!pickS.some(x => x.id === s.id) && s.price > ps.price * 0.88) pickS.push(s);
  }
  const pickR = [];
  const nearR = r => r.price <= price * 1.18;   // 远端压力不画进图，避免压缩K线可视高度（解释区仍完整列出）
  if (pr && nearR(pr)) pickR.push(pr);
  for (const r of resAsc) {
    if (pickR.length >= 3) break;
    if (!nearR(r)) continue;
    if (!pickR.some(x => x.id === r.id)) pickR.push(r);
  }
  const swingHighLine = resAsc.find(r => r.types.includes('swingHigh') && nearR(r));
  if (swingHighLine && !pickR.some(x => x.id === swingHighLine.id)) {
    if (pickR.length >= 3) pickR[2] = swingHighLine; else pickR.push(swingHighLine);
  }
  const lines = [...pickS, ...pickR];
  return {
    available: true,
    code,
    ztDate: ztBar.date, sinceZt, ztSourceNote: crossNote,
    poolDate: crossDate,
    swingLow: r2(L), swingHigh: r2(H), swingHighDate: kl[hiIdx].date,
    drawdown, retrace, price: r2(price), lastClose: r2(last.close), lastDate: last.date,
    ma: { ma5: r2(ma5), ma10: r2(ma10), ma20: r2(ma20), ma60: r2(ma60) },
    rsi14: r14, aboveMA20, volRatio,
    primarySupport: ps, primaryResistance: pr,
    nearPct, status, broken, recentTouched,
    supports: supAsc.slice().reverse(), resistances: resAsc, maRefs,
    structBreak, roomPct,
    score, scoreParts: parts, level, reason, veto,
    plan: {
      zone: [r2(ps.price * 0.99), r2(ps.price * 1.02)],
      stop, structBreak, target: r2(target), rr,
      basis: '观察区以主支撑「' + ps.short + '」' + ps.price + ' 元为中心 −1%~+2%；止损 = 主支撑 ×0.97 = ' + r2(stop) + '；上方目标取「' + (roomR ? roomR.short : '阶段高点') + '」' + r2(target) + '（距现价 +' + roomPct + '%）；起涨低点结构破坏线 ' + r2(structBreak),
      conditions: [
        '回踩至观察区且成交量继续萎缩（回调段均量/涨停段均量 ≤ 1）',
        '日线收盘不跌破 ' + ps.price + ' 元，分时不破最近 3 日低点',
        '所属板块未出现龙头负反馈，市场档位未切换至「防守」',
        '出现缩量十字/锤子线等企稳K线后再评估，不接放量破位'
      ],
      steps: [
        '试错仓 10–20%：仅在回踩观察区且缩量企稳时考虑',
        '确认仓 +20–30%：重新站上均价线且板块未走弱',
        '不追高：若直接放量拉升远离支撑，放弃本次回踩计划'
      ],
      invalid: [
        '日线收盘跌破主支撑 ' + ps.price + ' 元（或 ' + r2(stop) + ' 元止损位）',
        '跌破起涨波段低点结构破坏线 ' + r2(structBreak) + ' 元，本轮涨停结构破坏',
        '放量破位且 MACD/均线同步转弱',
        '3 个交易日内未按预期企稳反包，执行时间止损'
      ]
    },
    chart: {
      bars: kl.slice(cut).map(b => ({ date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, volume: b.volume })),
      ma5: ma5Arr.slice(cut).map(r2), ma10: ma10Arr.slice(cut).map(r2), ma20: ma20Arr.slice(cut).map(r2),
      ztDate: cut <= z ? ztBar.date : null,
      highDate: cut <= hiIdx ? kl[hiIdx].date : null,
      lines, zone: [r2(ps.price * 0.99), r2(ps.price * 1.02)],
      price: r2(price),
      source: klineSource, asOf: last.date, barsCount: W
    },
    klineSource,
    sourceNote: '日K/划线=' + klineSource + '（截至 ' + last.date + '）；基准价=' + ((ctx && ctx.priceSource) || '腾讯证券实时快照') + '；候选代码=东方财富涨停池'
  };
}

/** 模块口径说明（静态规则文字，不含任何行情数字） */
const PULLBACK_METHOD = {
  title: '涨停回调到支撑位 · 识别口径',
  steps: [
    { name: '① 找涨停日', text: '候选代码来自东方财富近 8 个交易日涨停池；逐只拉日K（腾讯前复权优先，限流时自动降级新浪不复权并在页面标注口径），以「当日收盘较前收盘涨幅 ≥ 板块涨停阈值（主板 9.6% / 创业板·科创板 19.3% / 北交所 29.3%）」交叉验证涨停日，并以真实日K为准；要求涨停后至少 2 根回调K线。' },
    { name: '② 定波段', text: '起涨低点 = 涨停日前 8 根至涨停日的最低价；阶段高点 = 涨停日至最新一根K线的最高价。两者构成回撤计算的基准区间。' },
    { name: '③ 划支撑', text: '按五类规则生成静态水平位：涨停跳空缺口下沿、涨停日最低价/开盘价、本轮起涨低点、前期分型高点突破后转支撑、斐波那契 0.382/0.5/0.618 回撤。价格相差 ≤0.6% 的线合并，并统计「局部极值触碰」次数（影线测试该价位后折返计 1 次）。MA5/10/20 属动态曲线，单独以折线画在图上，不参与水平划线与主支撑竞争。' },
    { name: '④ 划压力', text: '阶段最高价、涨停日最高价、前期分型高点聚集区；静态位若已位于现价上方，按支撑/压力互换原则改列压力（如跌破涨停日开盘价后，该位由支撑转为压力）。每条线都带生成依据、触碰次数与相对现价的距离。' },
    { name: '⑤ 判回踩', text: '主支撑 = 现价下方最近的一条支撑；现价距其 ≤2% 记为「已回踩到位」，≤4.5% 记为「接近支撑」，收盘跌破 1.5% 记为「跌破支撑」。同时要求回调段均量相对涨停段缩量、回撤未吞没本轮涨幅、收盘未破起涨低点。' },
    { name: '⑥ 给结论', text: '按支撑质量 25 + 回踩贴合度 20 + 缩量 15 + 结构完整度 15 + 上方空间/盈亏比 15 + 市场环境 10 打分；止损 = 主支撑×0.97，上方目标 = 距现价 ≥2% 的最近真实压力位（否则取阶段高点），据此算盈亏比。输出「重点观察 / 条件观察 / 仅跟踪 / 已失效」四档条件化结论，并给出回踩观察区、止损参考、上方目标与失效条件。触发否决时评分压至 45 以下。' }
  ],
  caveat: '所有价位均由上述规则从真实前复权日K机械计算，不是交易所公布的支撑压力位，也不是预测；划线数量为算法生成，可能互相重叠，图上只标注最重要的 4 支撑 + 3 压力，完整列表见划线解释区。放量破位、题材退潮、消息面变化都会使技术位失效。'
};

/* ─────────── 涨停回踩支撑 · 历史回溯（无未来函数） ─────────── */
/**
 * 用基准日之后的真实日K判定一次条件化计划的结果。
 * 判定顺序保守：同一根K线同时触及目标与止损时按「先止损」计失败。
 * 窗口未走完标「观察中」，不计入成功率分母。
 */
function backtestOutcome(kl, entryIdx, plan, window = 5) {
  const w = clamp(Math.round(Number(window) || 5), 1, 20);
  const entryBar = kl && kl[entryIdx];
  if (!entryBar || !plan) return null;
  const entry = Number(entryBar.close);
  const target = Number(plan.target), stop = Number(plan.stop);
  if (!(entry > 0 && target > 0 && stop > 0) || target <= entry || stop >= entry) return null;
  const future = kl.slice(entryIdx + 1, entryIdx + 1 + w);
  let result = '未触发', exitPrice = null, hitDay = null;
  let maxHigh = -Infinity, minLow = Infinity;
  for (let i = 0; i < future.length; i++) {
    const b = future[i];
    if (Number.isFinite(b.high)) maxHigh = Math.max(maxHigh, b.high);
    if (Number.isFinite(b.low)) minLow = Math.min(minLow, b.low);
    if (b.low <= stop) { result = '止损'; exitPrice = stop; hitDay = i + 1; break; }
    if (b.high >= target) { result = '达标'; exitPrice = target; hitDay = i + 1; break; }
  }
  const last = future[future.length - 1] || entryBar;
  // 已触及目标/止损时结果已确定，无需等窗口走满；只有「尚未触发」且窗口未满才算观察中
  const complete = future.length >= w || result !== '未触发';
  if (!complete) result = '观察中';
  if (exitPrice === null) exitPrice = last.close;
  return {
    result, complete, bars: future.length, window: w, hitDay,
    entry: r2(entry), target: r2(target), stop: r2(stop), exit: r2(exitPrice),
    returnPct: r2((exitPrice - entry) / entry * 100),
    mfe: Number.isFinite(maxHigh) ? r2((maxHigh - entry) / entry * 100) : null,
    mae: Number.isFinite(minLow) ? r2((minLow - entry) / entry * 100) : null,
    windowHigh: Number.isFinite(maxHigh) ? r2(maxHigh) : null,
    windowLow: Number.isFinite(minLow) ? r2(minLow) : null,
    lastClose: r2(last.close), lastDate: last.date
  };
}

/** 汇总：成功率分母只含窗口已走完的样本；按结论档位分组，可检验评分是否真的有区分度 */
function summarizeBacktest(rows) {
  const rate = (a, b) => b ? r1(a / b * 100) : null;
  const mean = arr => arr.length ? r1(arr.reduce((s, x) => s + x, 0) / arr.length) : null;
  const build = list => {
    const done = list.filter(x => x.outcome && x.outcome.complete);
    const win = done.filter(x => x.outcome.result === '达标');
    const loss = done.filter(x => x.outcome.result === '止损');
    const timeout = done.filter(x => x.outcome.result === '未触发');
    const rets = done.map(x => x.outcome.returnPct).filter(v => Number.isFinite(v));
    return {
      total: list.length, completed: done.length,
      watching: list.length - done.length,
      success: win.length, stopped: loss.length, timeout: timeout.length,
      winRate: rate(win.length, done.length), stopRate: rate(loss.length, done.length),
      avgReturn: mean(rets),
      avgMfe: mean(done.map(x => x.outcome.mfe).filter(v => Number.isFinite(v))),
      avgMae: mean(done.map(x => x.outcome.mae).filter(v => Number.isFinite(v))),
      best: rets.length ? r1(Math.max(...rets)) : null,
      worst: rets.length ? r1(Math.min(...rets)) : null
    };
  };
  const byLevel = {};
  ['重点观察', '条件观察', '仅跟踪', '已失效'].forEach(l => {
    byLevel[l] = build(rows.filter(x => x.level === l));
  });
  return { ...build(rows), byLevel };
}

/** 历史回溯口径说明（静态规则文字，不含行情数字） */
const BACKTEST_METHOD = {
  title: '历史回溯 · 成功率口径',
  rules: [
    { name: '① 无未来函数', text: '每个基准日只用「该日及之前」的日K切片重跑完整划线与评分逻辑；目标价、止损价、结论档位全部由切片内数据计算。之后的日K只用于判定结果，不参与任何计算。候选股票仅来自该基准日之前已公布的涨停池，不使用之后才出现的涨停名单（避免幸存者偏差）。' },
    { name: '② 价格口径', text: '历史时点没有实时快照，基准价取该交易日日K收盘价；划线口径与实时模块一致（腾讯前复权优先，限流时降级新浪不复权并逐只标注）。市值、换手、实时市场档位无法回溯，评分中的「市场环境」因子固定按默认 5 分，因此历史评分与当次实盘评分不完全等价。' },
    { name: '③ 成功判定', text: '观察窗口内逐根检查真实日K：最高价 ≥ 目标价且此前未先破止损 = 达标；最低价 ≤ 止损价 = 止损；窗口走完两者都未触及 = 未触发。同一根K线同时触及目标与止损时，按「先止损」保守判为失败。' },
    { name: '④ 统计口径', text: '成功率 = 达标数 ÷（达标 + 止损 + 未触发），窗口尚未走完的样本标「观察中」，不计入分母。收益按 目标价 / 止损价 / 窗口末收盘 相对基准日收盘价计算；未模拟挂单成交、滑点、手续费、涨跌停无法成交与仓位管理。' },
    { name: '⑤ 解读边界', text: '这是「触及型」判定：目标取距现价最近的上方压力（常为 +2%~+8%），止损为主支撑下方 3%，两者距离不对称，盘中触及目标比跌破止损更容易，因此成功率天然偏高，不等于真实交易胜率，必须同时看平均收益与止损率。同一只标的会在多个基准日重复出现，样本并不独立；评分档位样本量小时波动更大，档位与成功率不呈单调关系是正常现象。' },
    { name: '⑥ 数据边界', text: '东方财富历史涨停池仅可回溯约 15 个交易日，越早的基准日可用涨停日越少、候选样本随之下降；样本量小的日期成功率波动大，不能据此推断策略长期胜率。' }
  ],
  caveat: '这是对既有规则的历史回放，不是策略优化，也不是未来收益预测。样本受涨停池回溯深度、日K复权口径、停牌、上游可用性与重复取样影响，小样本成功率不具备统计显著性。'
};

/* ═══════════════ 明日龙头 · 只做龙头 / 买在分歧卖在一致 ═══════════════ */
/**
 * 纯函数：只吃真实池数据，不预测明日价格。
 * ctx = { pools, history, quotes, indices, options }
 *  - pools:   东方财富当日涨停/炸板/强势/跌停池（getPools）
 *  - history: 近 N 个交易日涨停/炸板池完整字段（getPoolFullHistory，dates 降序）
 *  - quotes:  上一交易日涨停股的今日实时快照（getQQQuotes），用于算真实连板溢价
 *  - indices: 主要指数快照
 * 输出的是「明日盘前观察清单」：情绪 / 梯队 / 题材 / 龙头地位 / 一致分歧 / 条件化剧本。
 */
const DRAGON_METHOD = {
  title: '明日龙头 · 只做龙头，买在分歧卖在一致',
  rules: [
    { name: '① 只做龙头（含 N天N板）', text: '地位由真实字段机械判定，覆盖连续与累计两种口径：空间板 = 当日最高「连续」连板；累计板龙 = 东财 zttj 近 N 日涨停 M 次，要求 M≥3、M>连续板数、密度 M/N≥0.34，且满足「全场累计最高 / 累计次数 ≥ 全场最高连板+1 / 行业内有板块效应且为行业累计最高」之一，用于把 5天3板、8天5板 这类断板反包型龙头纳入，而不因连续板数低被误判为后排；题材龙 = 同一东财行业分类内连板最高且该行业有 ≥2 只涨停；卡位股 = 最高板下一档；中军 = 成交额位于当日涨停池前 25% 且流通市值 ≥80 亿但连板 ≤2；其余按补涨/后排处理。后排与孤立涨停不进入龙头候选，这是筛选纪律，不是收益保证。' },
    { name: '② 一致度', text: '由首次封板时间（折算连续交易分钟）、炸板次数、封单额/流通市值、换手率、首次与最后封板间隔五项加权计算 0~100 分。早封 + 零炸板 + 高封单比 + 低换手 = 一致（一字/秒板）。' },
    { name: '③ 分歧度', text: '由炸板次数、换手率、封板时点偏晚、封单比偏低、相对成交额放量五项加权计算 0~100 分。另区分「良性分歧」（放量换手但收盘仍封住、封单比 ≥0.3%、最后封板早于 14:45、炸板 ≤8 次）与「恶性分歧」（尾盘偷袭板 / 封单极弱 / 反复炸板）。' },
    { name: '④ 买在分歧，卖在一致', text: '高一致通常意味着筹码未充分交换、次日高开兑现压力大，本模块把它标为「兑现风险」而非买点；良性高分歧才是观察对象，但必须等次日「弱转强」信号确认（竞价不极端、开盘放量回封、板块有承接），分歧本身不是买入理由。所有剧本均为「条件 → 观察结论」，不含买入指令或目标价。' },
    { name: '⑤ 情绪与阶段', text: '情绪温度计由涨停数、跌停数、炸板率、最高连板、梯队断层、昨日连板股今日真实溢价（腾讯实时快照）与晋级率加权得出，分主升 / 修复 / 高位震荡 / 分歧退潮 / 冰点。题材阶段由近 5 个交易日该行业涨停家数序列、最高板变化与今日一字占比判定预热 / 启动 / 发酵 / 高潮 / 分歧 / 退潮。' },
    { name: '⑥ 明日优先级', text: '按 地位 30 + 分歧质量 25 + 题材强度 20 + 情绪环境 15 − 风险扣减 10 排序，每只给出逐项得分依据。这是「明日观察优先级」，不是收益预测，也不是买入建议；高一致加速的一字板会被扣分而非加分。' },
    { name: '⑦ 历史验证', text: '对近 N 个交易日逐日重跑同一套地位与一致/分歧规则，把龙头分为「良性分歧组」与「高一致组」，统计次日是否再次涨停（晋级率）。仅用当日及之前数据分类、次日数据只用于判定，无未来函数；仅衡量晋级，不衡量收益。' },
    { name: '⑧ 数据边界', text: '封板时间为东方财富池的首次触板时间（不是收盘封板状态），封单比 = 封单额 ÷ 流通市值；「N天N板」来自东财 zttj 字段（近 N 个交易日内涨停 M 次的统计，非连续连板，也不等同于区间涨幅），连续连板数来自 lbc；两者口径不同，展示时分别标注。本模块没有龙虎榜席位数据，因此不对「某某游资买入」做任何推断。东财行业分类为上游字段，分类较细，可能与市场俗称的题材口径不同。明日剧本不含竞价/盘口实时数据，也不预测次日涨跌。' },
    { name: '⑨ 晋级率怎么读', text: '历史验证只统计「次日是否再次涨停且连板数增加」，晋级率不等于收益率，更不等于可交易胜率：一字/秒板的一致加速股次日继续涨停概率天然更高，但往往买不进或只能在涨停价成交，一旦分歧回撤幅度也最大。「卖在一致」讲的是赔率与兑现风险，不是「次日一定不涨」。良性分歧样本在短回溯窗口内通常极少，样本不足时本模块只展示计数、不下结论，也不能用它反推「分歧无效」。' },
    { name: '⑩ 题材理解三层口径', text: '题材识别分三层：① 东财行业分类 hybk（原有，粒度较细）；② 新浪财经概念板块成分股映射（取当日涨幅居前的概念板块，补上跨行业题材）；③ 名称 / 玄学字面共振（规则词典覆盖生肖祥瑞、方位天象、吉祥富贵、玄学意象，同一触发词需 ≥2–3 只涨停股共享才算共振；另对涨停股名称做 2 字子串自动聚类、排除通用工商与行业后缀，≥3 只共享才提示）。名称共振只说明「字面共同」，不代表基本面关联，不推断炒作原因或消息催化；A 股名称 / 玄学炒作常无业绩支撑、扩散快退潮也快，必须自行核实消息面。' }
  ],
  caveat: '「只做龙头，买在分歧卖在一致」是短线博弈框架，不是策略胜率保证。高位龙头追高赔率最差，分歧后也可能直接退潮；历史晋级率样本少、同一标的跨日重复出现、且仅统计是否再涨停（不含跌停、亏损、滑点与无法成交的情形），不具统计显著性。所有结论均为基于公开行情数据的条件化观察，不构成投资建议。'
};

/** 把 HH:MM:SS 折算为「09:25 起算的连续交易分钟」，午休压缩 */
function sealMinute(s) {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(String(s || ''))) return null;
  const p = String(s).split(':').map(Number);
  const t = p[0] * 60 + p[1] + p[2] / 60;
  if (t <= 690) return Math.max(0, t - 565);      // 09:25→0, 09:30→5, 11:30→125
  return 125 + Math.max(0, t - 780);              // 13:00→130, 14:56→241, 15:00→245
}
function sealProfile(row, medAmount) {
  const fm = sealMinute(row.firstSeal), lm = sealMinute(row.lastSeal);
  const broken = Number(row.brokenCount) || 0;
  const sealRatio = Number(row.sealFundRatio) || 0;
  const turn = Number(row.turnover) || 0;
  const amount = Number(row.amount) || 0;
  const early = clamp(100 - (fm === null ? 120 : fm) / 2.45, 0, 100);
  const noBreak = broken === 0 ? 100 : clamp(100 - broken * 22, 0, 100);
  const sealP = clamp(sealRatio / 3 * 100, 0, 100);
  const lowTurn = clamp(100 - turn * 2.2, 0, 100);
  const gap = (fm !== null && lm !== null) ? Math.max(0, lm - fm) : null;
  const stable = gap === null ? 60 : clamp(100 - gap * 2, 0, 100);
  const consensus = r1(early * .25 + noBreak * .28 + sealP * .22 + lowTurn * .15 + stable * .10);

  const breakP = clamp(broken * 18, 0, 100);
  const turnP = clamp(turn * 2.6 - 5, 0, 100);
  const lateP = clamp((fm === null ? 120 : fm) / 2.4, 0, 100);
  const weakSeal = clamp(100 - sealRatio / 2.5 * 100, 0, 100);
  const amtP = medAmount > 0 ? clamp(amount / medAmount / 2 * 100, 0, 100) : 50;
  const divergence = r1(breakP * .30 + turnP * .28 + lateP * .18 + weakSeal * .16 + amtP * .08);

  let dtype = '中性';
  if (consensus >= 72 && divergence < 40) dtype = '一致加速';
  else if (divergence >= 55 && sealRatio >= 0.3 && lm !== null && lm <= 230 && broken <= 8) dtype = '良性分歧';
  else if (divergence >= 55) dtype = '恶性分歧';
  else if (divergence >= 40) dtype = '分歧偏弱';
  return {
    consensus, divergence, dtype, firstMinute: fm, lastMinute: lm, gap,
    consensusParts: [
      { name: '首次封板时间', got: r1(early), weight: 25, detail: '首封 ' + (row.firstSeal || '—') + '（折算 ' + (fm === null ? '—' : r1(fm)) + ' 分钟）' },
      { name: '未炸板', got: r1(noBreak), weight: 28, detail: '炸板 ' + broken + ' 次' },
      { name: '封单强度', got: r1(sealP), weight: 22, detail: '封单/流通市值 ' + r2(sealRatio) + '%' },
      { name: '锁筹（低换手）', got: r1(lowTurn), weight: 15, detail: '换手 ' + r2(turn) + '%' },
      { name: '封板稳定', got: r1(stable), weight: 10, detail: gap === null ? '缺少最后封板时间' : '首末封板间隔 ' + r1(gap) + ' 分钟' }
    ],
    divergenceParts: [
      { name: '炸板反复', got: r1(breakP), weight: 30, detail: '炸板 ' + broken + ' 次' },
      { name: '换手放大', got: r1(turnP), weight: 28, detail: '换手 ' + r2(turn) + '%' },
      { name: '封板偏晚', got: r1(lateP), weight: 18, detail: '首封 ' + (row.firstSeal || '—') },
      { name: '封单偏弱', got: r1(weakSeal), weight: 16, detail: '封单比 ' + r2(sealRatio) + '%' },
      { name: '相对放量', got: r1(amtP), weight: 8, detail: '成交额 ' + (amount / 1e8).toFixed(2) + ' 亿 / 当日池中位数 ' + (medAmount / 1e8).toFixed(2) + ' 亿' }
    ],
    benignRule: '良性分歧判定：分歧度 ≥55、封单比 ≥0.3%、最后封板早于 14:45、炸板 ≤8 次且当日收盘仍封住'
  };
}

/** 情绪温度计 + 连板梯队 */
function dragonSentiment(pools, history, quotes, indices) {
  const zt = pools.zt || [], zb = pools.zb || [], dt = pools.dt || [];
  const ztCount = zt.length, zbCount = zb.length, dtCount = dt.length;
  const brokenRate = (ztCount + zbCount) ? r1(zbCount / (ztCount + zbCount) * 100) : null;
  const maxBoards = zt.reduce((m, x) => Math.max(m, Number(x.boards) || 1), 0);
  const ladder = [];
  for (let b = maxBoards; b >= 1; b--) {
    const rows = zt.filter(x => (Number(x.boards) || 1) === b);
    ladder.push({ boards: b, count: rows.length, codes: rows.slice(0, 6).map(x => x.code), names: rows.slice(0, 6).map(x => x.name) });
  }
  const gaps = ladder.filter(l => l.count === 0 && l.boards >= 2).map(l => l.boards);

  // 上一交易日涨停股今日真实溢价 / 晋级率（quotes 为腾讯实时快照）
  const dates = (history && history.dates) || [];
  const prevDate = dates.length > 1 ? dates[1].date : null;
  const prevZt = prevDate && history.byDate[prevDate] ? history.byDate[prevDate].zt : [];
  const todayCodes = new Set(zt.map(x => x.code));
  const prevHigh = prevZt.filter(x => (Number(x.boards) || 1) >= 2);
  const prem = [], promoted = [];
  prevZt.forEach(x => {
    const q = quotes[x.code];
    if (q && Number.isFinite(Number(q.pct))) prem.push(Number(q.pct));
    promoted.push(todayCodes.has(x.code) ? 1 : 0);
  });
  const highPrem = [];
  prevHigh.forEach(x => { const q = quotes[x.code]; if (q && Number.isFinite(Number(q.pct))) highPrem.push(Number(q.pct)); });
  const prevPremium = avg(highPrem) === null ? avg(prem) : avg(highPrem);
  const promoteRate = promoted.length ? r1(promoted.reduce((s, x) => s + x, 0) / promoted.length * 100) : null;
  const prevBroken = dates.length > 1 && dates[1].zb !== undefined
    ? r1(dates[1].zb / Math.max(1, dates[1].zb + dates[1].zt) * 100) : null;

  const fZt = clamp(ztCount / 80 * 100, 0, 100);
  const fBreak = brokenRate === null ? 50 : clamp(100 - brokenRate * 1.35, 0, 100);
  const fHeight = clamp(maxBoards / 7 * 100, 0, 100);
  const fPrem = clamp(50 + (prevPremium === null ? 0 : prevPremium * 5), 0, 100);
  const fDt = clamp(100 - dtCount * 6, 0, 100);
  const fPromo = clamp((promoteRate === null ? 15 : promoteRate) * 1.8, 0, 100);
  const temperature = r1(fZt * .18 + fBreak * .24 + fHeight * .14 + fPrem * .20 + fDt * .12 + fPromo * .12);
  let phase = '冰点';
  if (temperature >= 70) phase = '主升';
  else if (temperature >= 55) phase = '修复/进攻';
  else if (temperature >= 42) phase = '高位震荡';
  else if (temperature >= 28) phase = '分歧退潮';
  // 高位反馈恶化优先于温度分：炸板率环比抬升 ≥20pct 或昨日连板今日平均溢价为负，情绪至少降一档
  const deteriorating = (prevBroken !== null && brokenRate !== null && brokenRate - prevBroken >= 20)
    || (prevPremium !== null && prevPremium < 0);
  if (deteriorating && (phase === '主升' || phase === '修复/进攻' || phase === '高位震荡')) phase = '分歧退潮（高位负反馈）';
  const stance = temperature >= 65 && !deteriorating ? '进攻' : temperature >= 50 && !deteriorating ? '精选' : temperature >= 35 ? '控制' : '观望';

  const idxNote = (indices || []).slice(0, 3).map(i => i.name + ' ' + (i.pct === null || i.pct === undefined ? '—' : (i.pct > 0 ? '+' : '') + r2(i.pct) + '%')).join(' · ');
  return {
    date: pools.date || null, ztCount, zbCount, dtCount, brokenRate, prevBroken,
    maxBoards, ladder, gaps, ladderComplete: gaps.length === 0,
    prevDate, prevZtCount: prevZt.length, prevHighCount: prevHigh.length,
    prevPremium: prevPremium === null ? null : r2(prevPremium),
    promoteRate, temperature, phase, stance, idxNote, deteriorating,
    deteriorateNote: deteriorating
      ? '高位负反馈：' + (prevBroken !== null && brokenRate !== null && brokenRate - prevBroken >= 20
        ? '炸板率由 ' + prevBroken + '% 升至 ' + brokenRate + '%（+ ' + r1(brokenRate - prevBroken) + 'pct）'
        : '昨日连板股今日平均溢价 ' + r2(prevPremium) + '% 为负') + '，情绪档位已按「看高位反馈」规则下调。'
      : null,
    parts: [
      { name: '涨停家数', value: ztCount, score: r1(fZt), weight: 18, detail: ztCount + ' 家（80 家记满分）' },
      { name: '炸板率', value: brokenRate, score: r1(fBreak), weight: 24, detail: (brokenRate === null ? '—' : brokenRate + '%') + '（越低分越高）' },
      { name: '最高连板', value: maxBoards, score: r1(fHeight), weight: 14, detail: maxBoards + ' 板（7 板记满分）' },
      { name: '昨日连板今日溢价', value: prevPremium === null ? null : r2(prevPremium), score: r1(fPrem), weight: 20, detail: prevHigh.length + ' 只昨日连板股今日实时涨幅均值' + (prevPremium === null ? '（快照缺失，按中性计）' : '') },
      { name: '跌停家数', value: dtCount, score: r1(fDt), weight: 12, detail: dtCount + ' 家' },
      { name: '昨日涨停晋级率', value: promoteRate, score: r1(fPromo), weight: 12, detail: (promoteRate === null ? '—' : promoteRate + '%') + '（昨日涨停股今日仍涨停）' }
    ],
    note: '情绪温度为规则加权分，不是交易所发布的情绪指标；昨日连板溢价取腾讯实时快照的今日涨跌幅，盘后为收盘涨幅。'
  };
}

/** 题材强度与生命周期（真实行业分类 + 近 5 日扩散序列） */
function dragonThemes(zt, history, sentiment) {
  const byInd = new Map();
  zt.forEach(x => {
    const k = x.industry || '未分类';
    if (!byInd.has(k)) byInd.set(k, []);
    byInd.get(k).push(x);
  });
  const histDates = ((history && history.dates) || []).slice(0, 5).map(d => d.date).reverse(); // 由远及近
  const out = [];
  byInd.forEach((rows, industry) => {
    const maxBoards = rows.reduce((m, x) => Math.max(m, Number(x.boards) || 1), 0);
    // 累计口径：东财 zttj = 近 N 个交易日内涨停 M 次（非连续），用于识别「N天N板」反包型龙头
    const cumOf = x => Number(x.statCount) || Number(x.boards) || 1;
    const maxCumBoards = rows.reduce((m, x) => Math.max(m, cumOf(x)), 0);
    const cumLeaderCode = rows.slice().sort((a, b) =>
      cumOf(b) - cumOf(a) || (Number(b.boards) || 1) - (Number(a.boards) || 1) ||
      String(a.firstSeal || '').localeCompare(String(b.firstSeal || '')))[0].code;
    const amountSum = rows.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const avgSeal = avg(rows.map(x => Number(x.sealFundRatio) || 0)) || 0;
    const oneWord = rows.filter(x => x.firstSeal === '09:25:00' && (Number(x.brokenCount) || 0) === 0).length;
    const series = histDates.map(d => {
      const list = (history.byDate[d] && history.byDate[d].zt) || [];
      const mine = list.filter(x => (x.industry || '未分类') === industry);
      return { date: d, count: mine.length, maxBoards: mine.reduce((m, x) => Math.max(m, Number(x.boards) || 1), 0) };
    });
    const counts = series.map(s => s.count);
    const rising = counts.length >= 3 && counts[counts.length - 1] > counts[0];
    const peakBefore = counts.length >= 3 && Math.max(...counts.slice(0, -1)) > counts[counts.length - 1];
    let stage = '预热';
    if (counts.length >= 2) {
      if (peakBefore && maxBoards <= 2) stage = '退潮';
      else if (peakBefore) stage = '分歧';
      else if (rows.length >= 4 && oneWord >= 2) stage = '高潮';
      else if (rising || rows.length >= 3) stage = '发酵';
      else stage = '启动';
    }
    const strength = r1(clamp(rows.length / 6 * 30, 0, 30)
      + clamp(maxBoards / 6 * 25, 0, 25)
      + clamp((rising ? 20 : rows.length >= 2 ? 12 : 5), 0, 20)
      + clamp(amountSum / 5e9 * 15, 0, 15)
      + clamp(10 - (sentiment.brokenRate || 0) / 10, 0, 10));
    out.push({
      industry, count: rows.length, maxBoards, maxCumBoards, cumLeaderCode,
      amountSum, avgSeal: r2(avgSeal), oneWord,
      codes: rows.map(x => x.code), names: rows.map(x => x.name),
      series, rising, peakBefore, stage, strength,
      leaderCode: rows.slice().sort((a, b) => (b.boards - a.boards) || (String(a.firstSeal || '').localeCompare(String(b.firstSeal || ''))))[0].code
    });
  });
  out.sort((a, b) => b.strength - a.strength || b.count - a.count);
  return out;
}

/* ───────── 题材理解补充：名称 / 玄学共振 + 概念板块归属 ───────── */
/** 字面语义词典（规则，不是行情数据）：同一触发词需多只涨停股共享才算「共振」，避免单只股票牵强附会 */
const NAME_LEXICON = [
  { group: '生肖祥瑞', words: [{ w: '龙', min: 2 }, { w: '凤', min: 2 }, { w: '麒麟', min: 2 }, { w: '鹤', min: 2 }, { w: '鹿', min: 2 }, { w: '虎', min: 3 }, { w: '兔', min: 3 }, { w: '蛇', min: 3 }, { w: '马', min: 3 }, { w: '牛', min: 3 }] },
  { group: '方位天象', words: [{ w: '东方', min: 2 }, { w: '日出', min: 2 }, { w: '紫', min: 3 }, { w: '太极', min: 2 }, { w: '乾坤', min: 2 }, { w: '北斗', min: 2 }, { w: '星辰', min: 2 }, { w: '日月', min: 2 }] },
  { group: '吉祥富贵', words: [{ w: '福', min: 3 }, { w: '瑞', min: 2 }, { w: '祥', min: 2 }, { w: '鸿', min: 2 }, { w: '禄', min: 3 }, { w: '寿', min: 3 }, { w: '宝', min: 3 }, { w: '如意', min: 2 }, { w: '锦', min: 3 }, { w: '旺', min: 3 }] },
  { group: '玄学意象', words: [{ w: '玄', min: 3 }, { w: '道', min: 3 }, { w: '禅', min: 2 }, { w: '易', min: 3 }, { w: '灵', min: 3 }, { w: '神', min: 3 }, { w: '仙', min: 2 }] }
];
/** 名称聚类时跳过的通用工商后缀 / 行业词，避免把「科技」「股份」当成题材 */
const NAME_STOP = ['股份', '科技', '集团', '发展', '实业', '电子', '生物', '医药', '材料', '智能', '信息', '新材', '能源', '环保', '建设', '控股', '国际', '有限', '装备', '制品', '工业', '产业', '文化', '传媒', '网络', '数据', '软件', '系统', '技术', '工程', '机械', '化工', '食品', '农业', '旅游', '商业', '贸易', '置业', '地产', '资源', '电力', '交通', '物流', '金融', '证券', '投资', '高新', '中国', '中华'];

function cleanStockName(s) {
  return String(s || '').replace(/[\s*]/g, '').replace(/^(S?ST|退)/i, '').toUpperCase();
}
function themeHitSummary(hit) {
  return {
    count: hit.length,
    codes: hit.map(x => x.code), names: hit.map(x => x.name),
    maxBoards: Math.max(...hit.map(x => Number(x.boards) || 1)),
    maxCum: Math.max(...hit.map(x => Number(x.statCount) || Number(x.boards) || 1)),
    leaders: hit.slice().sort((a, b) => (Number(b.statCount) || Number(b.boards) || 1) - (Number(a.statCount) || Number(a.boards) || 1)).slice(0, 3)
      .map(x => ({ code: x.code, name: x.name, boards: Number(x.boards) || 1, label: boardLabelOf(x) }))
  };
}

function dragonNameThemes(zt, conceptMap) {
  const out = [], seen = new Set();
  // ① 词典法：玄学 / 名字炒作，同一触发词需 >=min 只涨停股共享
  for (const g of NAME_LEXICON) {
    for (const item of g.words) {
      const hit = zt.filter(x => cleanStockName(x.name).includes(item.w));
      if (hit.length < item.min || seen.has(item.w)) continue;
      seen.add(item.w);
      out.push({
        kind: '玄学名字', group: g.group, trigger: item.w, label: '「' + item.w + '」字辈',
        ...themeHitSummary(hit),
        basis: hit.length + ' 只涨停股名称均含「' + item.w + '」字（' + g.group + '），按名称字面聚类识别。A 股存在名称 / 玄学共振炒作现象，本系统不接入资讯，无法判定是否存在真实催化。',
        caveat: '仅名称字面共振，不代表基本面关联或题材真实性；此类炒作常无业绩支撑、扩散快退潮也快，务必自行核实消息面。'
      });
    }
  }
  // ② 数据驱动：涨停股名称 2 字子串共振（≥3 只），用于捕捉词典外的名字主线
  const grams = new Map();
  zt.forEach(x => {
    const s = cleanStockName(x.name), set = new Set();
    for (let i = 0; i + 2 <= s.length; i++) {
      const g = s.slice(i, i + 2);
      if (!/^[\u4e00-\u9fa5]{2}$/.test(g)) continue;
      if (NAME_STOP.some(w => g.includes(w))) continue;
      set.add(g);
    }
    set.forEach(g => { if (!grams.has(g)) grams.set(g, []); grams.get(g).push(x); });
  });
  grams.forEach((hit, g) => {
    if (hit.length < 3 || seen.has(g)) return;
    seen.add(g);
    out.push({
      kind: '名称共振', group: '字面聚类', trigger: g, label: '「' + g + '」共振',
      ...themeHitSummary(hit),
      basis: '当日涨停股名称中「' + g + '」共出现 ' + hit.length + ' 次，由名称 2 字子串自动聚类得到（已排除通用工商与行业后缀）。',
      caveat: '纯字面聚类，可能为巧合；不推断炒作原因、不关联基本面，需自行核实。'
    });
  });
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === '玄学名字' ? -1 : 1) || b.count - a.count || b.maxCum - a.maxCum);

  // ③ 概念板块归属：补上东财行业分类覆盖不到的跨行业题材
  const cg = new Map();
  zt.forEach(x => ((conceptMap && conceptMap[x.code]) || []).forEach(c => {
    if (!cg.has(c)) cg.set(c, []);
    cg.get(c).push(x);
  }));
  const concepts = [...cg.entries()].filter(([, hit]) => hit.length >= 2).map(([name, hit]) => ({
    name, ...themeHitSummary(hit), basis: ''
  })).sort((a, b) => b.count - a.count || b.maxCum - a.maxCum).slice(0, 10);
  concepts.forEach(c => { c.basis = '当日涨停股中有 ' + c.count + ' 只属于新浪概念板块「' + c.name + '」，用于补充东财行业分类覆盖不到的跨行业题材。'; });

  return {
    list: out.slice(0, 10), concepts,
    note: '题材理解分三层：东财行业分类（原有）＋ 新浪概念板块成分映射 ＋ 名称 / 玄学字面共振。后两层为字面或分类口径，不代表基本面关联。',
    caveat: '名称 / 玄学共振由规则词典与名称聚类机械生成，不接入新闻与公告，不推断炒作原因；A 股名称炒作常无业绩支撑，请独立核实。'
  };
}

/** 统一的板型标签：连续连板 vs N天N板（累计涨停） */
function boardLabelOf(x) {
  const b = Number(x.boards) || 1, cum = Number(x.statCount) || b, days = Number(x.statDays) || 0;
  if (days > 0 && cum > b && cum >= 2) return days + '天' + cum + '板';
  return b + '连板';
}

/** 龙头地位分层：依据必须可量化 */
function dragonRole(x, maxBoards, theme, medAmount, highAmountCut, extra) {
  const b = Number(x.boards) || 1;
  const cum = Number(x.statCount) || b;
  const cumDays = Number(x.statDays) || 0;
  const density = cumDays > 0 ? cum / cumDays : 0;
  const maxCum = (extra && extra.maxCumBoards) || maxBoards;
  const amount = Number(x.amount) || 0;
  const cap = Number(x.floatCap) || 0;
  const isSole = !theme || theme.count === 1;
  const indName = theme ? theme.industry : '—';
  // 空间板：全场最高连板（≥2 板才谈得上空间）
  if (b >= maxBoards && maxBoards >= 2) return { role: '空间板', rank: 1, reason: '当日最高连板 ' + b + ' 板（全场最高），行业「' + indName + '」' };
  // 累计板龙（N天N板）：连续板数不高、但近 N 日累计涨停次数领先的反包型龙头
  // 东财 zttj = days 日内 ct 次涨停；要求 ct>=3、ct>连续板、密度>=0.34，且在累计口径下具备地位
  const cumType = cum >= 3 && cum > b && density >= 0.34;
  const cumQualified = cumType && (
    (cum >= maxCum && maxCum >= 3) ||
    cum >= maxBoards + 1 ||
    (theme && theme.count >= 2 && x.code === theme.cumLeaderCode)
  );
  if (cumQualified) {
    const rank = (cum >= maxCum && maxCum >= 3) ? 2 : 3;
    return {
      role: '累计板龙', rank,
      reason: '近 ' + cumDays + ' 日 ' + cum + ' 次涨停（密度 ' + r2(density) + '，连续仅 ' + b + ' 板），按累计口径' +
        (cum >= maxCum ? '为全场累计最高' : (cum >= maxBoards + 1 ? '已超过全场最高连板 ' + maxBoards + ' 板' : '为行业「' + indName + '」内累计最高')) +
        '；属反包 / 断板再板的 N天N板 龙头，不能只按连续连板数排除'
    };
  }
  // 卡位股：最高板下一档，梯队关键位（游资语境里的「卡位」优先于题材内排名）
  if (b === maxBoards - 1 && maxBoards >= 3) return { role: '卡位股', rank: 3, reason: b + ' 板，位于空间板 ' + maxBoards + ' 板下一档；行业「' + indName + '」内最高 ' + (theme ? theme.maxBoards : '—') + ' 板' };
  // 题材龙：必须 ≥2 板，且同行业至少 2 只涨停形成板块效应，并是行业内连板最高
  if (theme && theme.count >= 2 && b >= 2 && x.code === theme.leaderCode) return { role: '题材龙', rank: 2, reason: '行业「' + indName + '」内连板最高 ' + b + ' 板，同行业涨停 ' + theme.count + ' 家（有板块效应）' };
  if (amount >= highAmountCut && cap >= 80 && b <= 2) return { role: '容量中军', rank: 4, reason: '成交额 ' + (amount / 1e8).toFixed(2) + ' 亿（当日池前 25%）、流通市值 ' + r1(cap) + ' 亿，但仅 ' + b + ' 板' };
  if (isSole) return { role: '孤立涨停', rank: 6, reason: '行业「' + indName + '」当日仅此 1 只涨停，无板块效应，' + b + ' 板；不满足「板块内最高 + 有跟风」的龙头条件' };
  return { role: '后排/补涨', rank: 5, reason: b + ' 板（<2 板或不是行业内最高），同行业最高 ' + (theme ? theme.maxBoards : '—') + ' 板 / 共 ' + (theme ? theme.count : 0) + ' 家涨停；成交额 ' + (amount / 1e8).toFixed(2) + ' 亿（池内中位数 ' + (medAmount / 1e8).toFixed(2) + ' 亿）' };
}

/** 条件化明日剧本：只给「条件 → 观察结论」，不给买卖指令或目标价 */
function dragonScript(x, sentiment, theme) {
  const b = Number(x.boards) || 1;
  const themeName = theme ? theme.industry : '所属题材';
  const broken = Number(x.brokenCount) || 0;
  const isLeader = x.roleRank <= 3;
  if (x.dtype === '一致加速' && b >= 2) {
    return {
      type: 'consensus', title: '卖在一致 · 兑现风险', tone: 'warn',
      thesis: '首封 ' + (x.firstSeal || '—') + '、炸板 ' + broken + ' 次、封单比 ' + r2(x.sealFundRatio) + '%、换手 ' + r2(x.turnover) + '%，一致度 ' + x.consensus + '（0~100），属于典型缩量一致/一字加速。一致性越强，筹码越没换手，次日高开越容易成为兑现盘出口，追高赔率最差。',
      triggers: [
        { condition: '次日大幅高开后开板、封单快速衰减且放量', action: '按「卖在一致」理解为兑现信号，不视为加仓机会' },
        { condition: '继续一字/秒板、封单额不减', action: '一致性延续，但仍不属于「买在分歧」的低吸观察对象' },
        { condition: '同梯队更高位龙头炸板或跌停', action: '一致性瓦解，整体降级为退潮观察' }
      ],
      invalidation: ['若次日出现放量分歧后重新回封，则状态已从「一致」切换为「分歧」，需按分歧剧本重新判定', '本剧本不预测次日开盘价，不含竞价数据'],
      risk: '高位一致加速后的首次分歧往往幅度最大；一字板可能出现无法买入或次日无法卖出的流动性风险。'
    };
  }
  if (!isLeader) {
    return {
      type: 'avoid', title: '只做龙头 · 不参与', tone: 'muted',
      thesis: x.roleReason + '。地位分层得分 ' + (x.scoreParts[0] ? x.scoreParts[0].got : 0) + '/30，「只做龙头」纪律下不进入明日核心观察清单。',
      triggers: [
        { condition: '该股次日晋级且带动同行业 ≥2 只跟风涨停', action: '地位升级为新的题材龙后再重新评估' },
        { condition: '现有空间板/题材龙全部断板', action: '属于新老龙头切换窗口，需重新跑一次龙头识别，而非直接接力后排' }
      ],
      invalidation: ['后排补涨的持续性依赖龙头不倒，龙头负反馈时后排通常先跌'],
      risk: '后排与孤立涨停缺乏板块承接，是这套打法明确回避的对象。'
    };
  }
  if (x.dtype === '良性分歧') {
    return {
      type: 'divergence', title: '买在分歧 · 观察弱转强', tone: 'primary',
      thesis: '今日炸板 ' + broken + ' 次、换手 ' + r2(x.turnover) + '%、封单比 ' + r2(x.sealFundRatio) + '%、最后封板 ' + (x.lastSeal || '—') + '，分歧度 ' + x.divergence + ' 且满足良性分歧条件：放量换手但收盘仍封住。分歧代表筹码交换，只有次日资金重新买回「一致」才构成打法的观察点，分歧本身不是买入理由。',
      triggers: [
        { condition: '竞价不出现极端高开（> +7%）或大幅低开（< −5%），开盘 30 分钟内放量翻红并重新封板', action: '视为「分歧转一致 / 弱转强」信号，进入重点观察（非买入指令）' },
        { condition: '「' + themeName + '」有 ≥1 只跟风股同步走强，且昨日连板股整体溢价回正', action: '板块承接仍在，信号可信度提升' },
        { condition: '缩量小幅高开后长时间横盘不破开盘价', action: '属于分歧后承接观察，等待放量方向选择，不提前下结论' }
      ],
      invalidation: [
        '低开超过 −5% 且 30 分钟内未回补缺口',
        '同梯队更高位龙头炸板 / 跌停，或跌停家数继续增加',
        '炸板率维持或高于今日 ' + (sentiment.brokenRate === null ? '—' : sentiment.brokenRate + '%') + ' 的水平',
        '「' + themeName + '」阶段由「' + (theme ? theme.stage : '—') + '」转向退潮'
      ],
      risk: '分歧之后也可能直接转退潮，回封失败即证伪；' + b + ' 板高位股回撤空间大，本剧本不含任何仓位与价位建议。'
    };
  }
  if (x.dtype === '恶性分歧') {
    return {
      type: 'weak', title: '分歧质量不足 · 只观察不跟进', tone: 'warn',
      thesis: '分歧度 ' + x.divergence + '，但 ' + (x.lastMinute !== null && x.lastMinute > 230 ? '最后封板 ' + (x.lastSeal || '—') + ' 属尾盘偷袭板' : r2(x.sealFundRatio) + '% 的封单比偏弱或炸板过于反复') + '，不满足良性分歧条件。放量不等于有承接，尾盘回封常是次日的抛压来源。',
      triggers: [
        { condition: '次日竞价明显转强且开盘快速回封，封单比显著高于今日', action: '分歧质量改善，可重新按「弱转强」条件评估' },
        { condition: '低开后无回封动作', action: '确认为恶性分歧，剔除观察' }
      ],
      invalidation: ['若同题材出现新的更早封板、更高连板标的，龙头地位可能已切换'],
      risk: '尾盘板与弱封单的次日负反馈概率高，不属于「买在分歧」的适用范围。'
    };
  }
  return {
    type: 'relay', title: (x.role === '卡位股' ? '梯队卡位 · 需龙头不倒' : '中继观察 · 等信号') , tone: 'blue',
    thesis: x.roleReason + '。一致度 ' + x.consensus + ' / 分歧度 ' + x.divergence + '，状态为「' + x.dtype + '」，既未达到「卖在一致」的缩量加速条件，也未形成「买在分歧」的良性大分歧，信号不充分。',
    triggers: [
      { condition: '空间板继续晋级且「' + themeName + '」涨停家数不减少', action: '梯队 intact 时卡位逻辑才成立' },
      { condition: '自身出现放量分歧后回封', action: '状态切换为「良性分歧」，按弱转强条件重新评估' }
    ],
    invalidation: ['空间板断板或断层扩大', '题材阶段转向退潮'],
    risk: '信号不足时「宁可等确认」；卡位股依赖龙头不倒，龙头负反馈时回撤更快。'
  };
}

function dragonGame(ctx) {
  const pools = ctx.pools || {}, history = ctx.history || {}, quotes = ctx.quotes || {};
  const zt = (pools.zt || []).slice();
  const sentiment = dragonSentiment(pools, history, quotes, ctx.indices);
  const amounts = zt.map(x => Number(x.amount) || 0).sort((a, b) => a - b);
  const medAmount = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
  const highAmountCut = amounts.length ? amounts[Math.floor(amounts.length * 0.75)] : 0;
  const themes = dragonThemes(zt, history, sentiment);
  const themeByInd = new Map(themes.map(t => [t.industry, t]));
  const cumOf = x => Number(x.statCount) || Number(x.boards) || 1;
  const maxCumBoards = zt.length ? Math.max(...zt.map(cumOf)) : 0;
  // 题材理解补充：名称 / 玄学共振 + 新浪概念板块成分映射
  const nameInfo = dragonNameThemes(zt, ctx.conceptMap || {});
  const sortWhite = ['score', 'boards', 'cumBoards', 'consensus', 'divergence', 'amount', 'sealFundRatio', 'turnover', 'code'];
  const opt = ctx.options || {};
  const sort = sortWhite.includes(opt.sort) ? opt.sort : 'score';

  let rows = zt.map(x => {
    const theme = themeByInd.get(x.industry || '未分类') || null;
    const prof = sealProfile(x, medAmount);
    const role = dragonRole(x, sentiment.maxBoards, theme, medAmount, highAmountCut, { maxCumBoards });
    const stage = theme ? theme.stage : '未分类';
    const roleScore = { 1: 30, 2: 25, 3: 18, 4: 12, 5: 6, 6: 3 }[role.rank] || 0;
    let divScore = 12;
    if (prof.dtype === '良性分歧') divScore = 25;
    else if (prof.dtype === '恶性分歧') divScore = 8;
    else if (prof.dtype === '一致加速') divScore = 5;
    else if (prof.dtype === '分歧偏弱') divScore = 16;
    const themeScore = r1((theme ? theme.strength : 15) / 100 * 20);
    const envScore = r1(sentiment.temperature / 100 * 15);
    let risk = 0;
    const riskNotes = [];
    if (x.isST) { risk += 4; riskNotes.push('ST 股'); }
    if (prof.dtype === '一致加速' && (Number(x.boards) || 1) >= 3) { risk += 3; riskNotes.push('高位一致加速'); }
    if (prof.lastMinute !== null && prof.lastMinute > 230) { risk += 2; riskNotes.push('尾盘回封'); }
    if ((Number(x.sealFundRatio) || 0) < 0.3) { risk += 2; riskNotes.push('封单比 <0.3%'); }
    if (theme && theme.count === 1) { risk += 2; riskNotes.push('孤立涨停'); }
    risk = Math.min(10, risk);
    const score = r1(clamp(roleScore + divScore + themeScore + envScore - risk, 0, 100));
    const scoreParts = [
      { name: '龙头地位', got: roleScore, max: 30, detail: role.role + '：' + role.reason },
      { name: '分歧质量', got: divScore, max: 25, detail: prof.dtype + '（一致度 ' + prof.consensus + ' / 分歧度 ' + prof.divergence + '）；良性分歧给满分，一致加速计 5 分' },
      { name: '题材强度', got: themeScore, max: 20, detail: (theme ? '「' + theme.industry + '」强度 ' + theme.strength + '，阶段 ' + theme.stage : '题材未分类，按 15 分基准') },
      { name: '情绪环境', got: envScore, max: 15, detail: '情绪温度 ' + sentiment.temperature + '（' + sentiment.phase + '）' },
      { name: '风险扣减', got: -risk, max: 0, detail: riskNotes.length ? riskNotes.join('、') : '无额外风险扣减' }
    ];
    const row = {
      code: x.code, name: x.name, board: x.board || boardOf(x.code), isST: !!x.isST,
      industry: x.industry || '未分类', price: x.price, pct: x.pct,
      boards: Number(x.boards) || 1, statDays: x.statDays, statCount: x.statCount,
      boardLabel: boardLabelOf(x), cumBoards: cumOf(x), cumDays: Number(x.statDays) || 0,
      cumDensity: (Number(x.statDays) || 0) > 0 ? r2(cumOf(x) / Number(x.statDays)) : null,
      isCumLeader: role.role === '累计板龙',
      nameThemes: nameInfo.list.filter(t => t.codes.includes(x.code)).map(t => t.label),
      conceptThemes: nameInfo.concepts.filter(t => t.codes.includes(x.code)).map(t => t.name),
      firstSeal: x.firstSeal, lastSeal: x.lastSeal, brokenCount: Number(x.brokenCount) || 0,
      sealFund: x.sealFund, sealFundRatio: x.sealFundRatio, turnover: x.turnover,
      amount: x.amount, floatCap: x.floatCap,
      role: role.role, roleRank: role.rank, roleReason: role.reason,
      theme: theme ? { industry: theme.industry, count: theme.count, maxBoards: theme.maxBoards, stage: theme.stage, strength: theme.strength, series: theme.series } : null,
      consensus: prof.consensus, divergence: prof.divergence, dtype: prof.dtype,
      firstMinute: prof.firstMinute, lastMinute: prof.lastMinute,
      consensusParts: prof.consensusParts, divergenceParts: prof.divergenceParts,
      benignRule: prof.benignRule,
      score, scoreParts,
      isLeader: role.rank <= 3,
      sourceNote: '东方财富涨停池 ' + (pools.date || '—') + '（首封/炸板/封单比/换手/连板均为池内字段）'
    };
    row.script = dragonScript(row, sentiment, theme);
    row.watch = [
      '竞价与开盘 30 分钟是否出现「' + (prof.dtype === '一致加速' ? '开板放量兑现' : '放量回封 / 弱转强') + '」',
      '同题材「' + (theme ? theme.industry : '—') + '」跟风股数量与最高板变化',
      '全场炸板率能否低于今日 ' + (sentiment.brokenRate === null ? '—' : sentiment.brokenRate + '%') + '，跌停 ' + sentiment.dtCount + ' 家是否收敛'
    ];
    return row;
  });

  // 「只做龙头」默认只显示有地位的标的；showAll=1 时展示全池用于对照
  const showAll = String(opt.showAll || '0') === '1';
  let list = showAll ? rows.slice() : rows.filter(r => r.isLeader);
  if (String(opt.excludeST || '1') === '1') list = list.filter(r => !r.isST);
  if (opt.board && opt.board !== '全部') list = list.filter(r => r.board === opt.board);
  if (opt.capMin && Number(opt.capMin) > 0) list = list.filter(r => (Number(r.floatCap) || 0) >= Number(opt.capMin));
  if (opt.capMax && Number(opt.capMax) > 0) list = list.filter(r => (Number(r.floatCap) || 0) <= Number(opt.capMax));
  if (opt.keyword) {
    const k = String(opt.keyword).toLowerCase();
    list = list.filter(r => r.code.includes(k) || String(r.name).toLowerCase().includes(k) || String(r.industry).toLowerCase().includes(k));
  }
  if (opt.role && opt.role !== '全部') list = list.filter(r => r.role === opt.role);
  const dir = opt.sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => dir * ((Number(a[sort]) || 0) - (Number(b[sort]) || 0)) || b.score - a.score);
  const limit = Math.min(60, Math.max(1, Number(opt.limit) || 24));
  list = list.slice(0, limit);

  // 明日核心变量（由真实数据生成，不给预测）
  const focus = [];
  const space = rows.filter(r => r.role === '空间板').sort((a, b) => b.score - a.score)[0];
  if (space) {
    const question = space.dtype === '一致加速' ? '一字/缩量加速后是否放量兑现（而非继续追高）'
      : space.dtype === '良性分歧' ? '能否放量回封完成「分歧转一致」'
        : space.dtype === '恶性分歧' ? '尾盘弱封单能否在竞价被承接（否则确认为退潮）'
          : '能否给出明确的方向信号';
    focus.push('空间板 ' + space.name + '（' + space.code + '，' + space.boards + ' 板，炸板 ' + space.brokenCount + ' 次，' + space.dtype + '）明日' + question + '，是判断情绪能否延续的第一变量。');
  }
  focus.push('炸板率 ' + (sentiment.brokenRate === null ? '—' : sentiment.brokenRate + '%') + '（上一交易日 ' + (sentiment.prevBroken === null ? '—' : sentiment.prevBroken + '%') + '）与跌停 ' + sentiment.dtCount + ' 家能否收敛；连板梯队' + (sentiment.ladderComplete ? '目前无断层' : '在 ' + sentiment.gaps.join('/') + ' 板出现断层（退潮信号）') + '。');
  if (themes.length) focus.push('最强题材「' + themes[0].industry + '」（今日 ' + themes[0].count + ' 家涨停 / 最高 ' + themes[0].maxBoards + ' 板 / 阶段 ' + themes[0].stage + '）能否继续扩散，决定后排补涨是否有承接。');
  if (nameInfo.list.length) {
    const nt = nameInfo.list[0];
    focus.push('名称 / 玄学共振提示：' + nt.label + ' 今日有 ' + nt.count + ' 只涨停股共享（' + nt.names.slice(0, 4).join('、') + '），其中累计最高 ' + nt.maxCum + ' 板；这是字面聚类而非基本面题材，不推断炒作原因，需自行核实消息面，并注意此类主线退潮快。');
  }

  // 历史验证：只用当日数据分类，次日数据仅判晋级
  const validation = dragonValidation(history);

  const dtypeCount = {};
  rows.forEach(r => { dtypeCount[r.dtype] = (dtypeCount[r.dtype] || 0) + 1; });
  const roleCount = {};
  rows.forEach(r => { roleCount[r.role] = (roleCount[r.role] || 0) + 1; });
  const summary = {
    poolCount: rows.length, leaderCount: rows.filter(r => r.isLeader).length, shown: list.length,
    dtypeCount, roleCount, showAll,
    leaderList: rows.filter(r => r.isLeader).map(r => ({ code: r.code, name: r.name, role: r.role, boards: r.boards, dtype: r.dtype, score: r.score })),
    maxBoards: sentiment.maxBoards, maxCumBoards, temperature: sentiment.temperature, phase: sentiment.phase,
    cumPoolCount: rows.filter(r => r.cumBoards >= 3 && r.cumBoards > r.boards).length,
    cumLeaderCount: rows.filter(r => r.isCumLeader).length,
    nameThemeCount: nameInfo.list.length, conceptThemeCount: nameInfo.concepts.length,
    topTheme: themes.length ? { industry: themes[0].industry, count: themes[0].count, stage: themes[0].stage, strength: themes[0].strength } : null,
    historyDays: (history.dates || []).length
  };
  const excluded = rows.filter(r => !r.isLeader).map(r => ({
    code: r.code, name: r.name, boards: r.boards, boardLabel: r.boardLabel, role: r.role, roleReason: r.roleReason,
    dtype: r.dtype, consensus: r.consensus, divergence: r.divergence, industry: r.industry,
    firstSeal: r.firstSeal, brokenCount: r.brokenCount
  })).sort((a, b) => b.boards - a.boards || b.divergence - a.divergence);
  return {
    sentiment, ladder: sentiment.ladder, themes, list, excluded, focus, validation, summary,
    nameThemes: nameInfo.list, conceptThemes: nameInfo.concepts,
    themeUnderstanding: { note: nameInfo.note, caveat: nameInfo.caveat },
    methodology: DRAGON_METHOD,
    metaNote: '数据来源：东方财富涨停/炸板/跌停池（' + (pools.date || '—') + '）+ 近 ' + (history.dates || []).length + ' 个交易日历史涨停池 + 腾讯证券实时快照（昨日连板溢价）'
  };
}

/** 历史晋级率验证：用同一套规则对历史每日龙头分类，看次日是否再涨停 */
function dragonValidation(history) {
  const dates = (history && history.dates) || [];
  const byDate = history.byDate || {};
  const byDay = [];
  let dN = 0, dP = 0, cN = 0, cP = 0, aN = 0, aP = 0;
  const dtypeStats = {};
  const bands = {
    '高分歧(≥50)': { n: 0, p: 0 },
    '中分歧(30~50)': { n: 0, p: 0 },
    '低分歧(<30)': { n: 0, p: 0 }
  };
  // dates 降序：dates[i] 为基准日，dates[i-1] 为其下一交易日
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i].date, next = dates[i - 1].date;
    const zt = (byDate[d] && byDate[d].zt) || [];
    const nextZt = (byDate[next] && byDate[next].zt) || [];
    if (!zt.length || !nextZt.length) continue;
    const nextMap = new Map(nextZt.map(x => [x.code, Number(x.boards) || 1]));
    const amounts = zt.map(x => Number(x.amount) || 0).sort((a, b) => a - b);
    const med = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
    const highCut = amounts.length ? amounts[Math.floor(amounts.length * 0.75)] : 0;
    const maxB = zt.reduce((m, x) => Math.max(m, Number(x.boards) || 1), 0);
    const themes = dragonThemes(zt, { dates: dates.slice(i), byDate }, { brokenRate: null });
    const tm = new Map(themes.map(t => [t.industry, t]));
    const buckets = { '良性分歧': { n: 0, p: 0 }, '一致加速': { n: 0, p: 0 } };
    zt.forEach(x => {
      const theme = tm.get(x.industry || '未分类');
      const role = dragonRole(x, maxB, theme, med, highCut);
      if (role.rank > 3) return;                 // 只统计龙头
      const prof = sealProfile(x, med);
      const nb = nextMap.get(x.code);
      const promoted = nb !== undefined && nb > (Number(x.boards) || 1) ? 1 : 0;
      aN++; aP += promoted;
      const band = prof.divergence >= 50 ? '高分歧(≥50)' : prof.divergence >= 30 ? '中分歧(30~50)' : '低分歧(<30)';
      bands[band].n++; bands[band].p += promoted;
      if (!dtypeStats[prof.dtype]) dtypeStats[prof.dtype] = { n: 0, p: 0 };
      dtypeStats[prof.dtype].n++; dtypeStats[prof.dtype].p += promoted;
      const key = prof.dtype === '良性分歧' ? '良性分歧' : (prof.dtype === '一致加速' ? '一致加速' : null);
      if (!key) return;
      buckets[key].n++; buckets[key].p += promoted;
    });
    dN += buckets['良性分歧'].n; dP += buckets['良性分歧'].p;
    cN += buckets['一致加速'].n; cP += buckets['一致加速'].p;
    byDay.push({
      date: d, nextDate: next, poolCount: zt.length, maxBoards: maxB,
      divergenceN: buckets['良性分歧'].n, divergencePromoted: buckets['良性分歧'].p,
      consensusN: buckets['一致加速'].n, consensusPromoted: buckets['一致加速'].p
    });
  }
  const rate = (p, n) => n ? r1(p / n * 100) : null;
  const byDtype = Object.entries(dtypeStats).map(([k, v]) => ({ dtype: k, n: v.n, promoted: v.p, rate: rate(v.p, v.n) }))
    .sort((a, b) => b.n - a.n);
  return {
    days: byDay.length,
    overall: { n: aN, promoted: aP, rate: rate(aP, aN) },
    divergence: { n: dN, promoted: dP, rate: rate(dP, dN) },
    consensus: { n: cN, promoted: cP, rate: rate(cP, cN) },
    byDtype, byDay,
    byDivergenceBand: Object.entries(bands).map(([k, v]) => ({ band: k, n: v.n, promoted: v.p, rate: rate(v.p, v.n) })),
    insufficient: dN < 20 || cN < 20,
    note: '次日晋级 = 基准日龙头在下一交易日仍涨停且连板数增加。只判晋级、不判收益；不含跌停、亏损、滑点与无法成交的情形。同一标的会跨日重复计入，样本不独立；历史池仅可回溯约 15 个交易日，样本量小，不具统计显著性。'
  };
}

/* ═══════════════ 龙场悟道 · 多方法历史回测选优 ═══════════════ */
/**
 * 目标：不预设「哪种短线方法最好」，而是用同一段真实行情把若干可量化方法
 * 各跑一遍，按样本门槛与次日收益选出区间内最优，再映射到当前实时涨停池。
 * 严格无未来函数：方法分类只用 T 日涨停池字段（及 T 日之前的已知信息），
 * T+1 的真实日K只用于判定结果，不参与任何分类或排序。
 */
const ENLIGHTEN_METHOD = {
  title: '龙场悟道 · 次日买入机会计划口径',
  rules: [
    { name: '① 候选与分类', text: '候选=东方财富近 N 个交易日每日涨停池完整字段（连板数、首封时间、炸板次数、封单/流通市值、换手、zttj 累计涨停、行业）。六种方法全部由「T 日及之前」字段机械判定，不使用 T 日之后的名单或价格，避免幸存者偏差与未来函数；ST 股剔除。T 日是「选股与制定计划日」，不是买入日。' },
    { name: '② 次日买入计划（核心）', text: 'T 日收盘价记为 C，仅用 C 推算计划参数：回踩买入价 C×0.98、破位放弃价 C×0.95、高开放弃价 C×1.05。T+1 用真实日K判定是否触发：开盘 > C×1.05 → 高开过度放弃；开盘 ≤ C×0.95 → 跳空破位放弃；最低 ≤ C×0.95 → 盘中破位放弃；最低 > C×0.98 → 未给回踩机会、不追价；否则以 C×0.98 成交。**买入发生在 T+1 盘中，不是 T 日涨停价**。' },
    { name: '③ 卖出与 T+1 制度', text: 'A 股 T+1：T+1 买入当天不能卖出，统一按 **T+2 收盘价** 卖出。收益 = (T+2 收盘 − C×0.98) / (C×0.98)；MFE/MAE 取 T+1 与 T+2 两根日K的最高/最低价相对买入价。不模拟盘中止损（承认无法及时离场），破位只在触发阶段作为「放弃买入」条件。T+1 或 T+2 日K缺失的样本标「观察中」，不计入分母。' },
    { name: '④ 消除次日溢价偏差', text: '旧口径把「T 日涨停价买入 → T+1 收盘卖出」当收益，等于用已涨停的结果解释次日溢价，且违反 T+1 制度，没有指导意义。新口径下未触发（高开过度 / 破位 / 未回踩）是「没机会就不做」的纪律结果：不计入收益分母，但计入触发率与放弃原因。选优不看单笔收益，看 **每候选期望值 = 成交后平均收益 × 触发率**。' },
    { name: '⑤ 选优规则', text: '只有「成交笔数 ≥门槛」的方法参与选优，按每候选期望值降序取第一，并与全池基准比较超额；样本不足的方法只展示数据、不下结论。超额 <0.5 个百分点判「无显著优势」；一字/秒板对照方法判「流动性偏差」。结果仅描述历史区间，不代表未来最优。' },
    { name: '⑥ 统计边界', text: '不含手续费、滑点、涨跌停无法卖出、隔夜跳空、仓位管理与资金曲线；同一标的会在连续涨停日重复取样，样本不独立；回溯窗口受东财历史涨停池深度限制，且需要 T+2 日K，可用基准日比旧口径少一天。为控制请求量，每个基准日按成交额取前 N 只拉日K，存在大成交额偏向；未取得日K的样本跳过并如实计数。' },
    { name: '⑦ 复权口径', text: '日K优先用腾讯前复权；若触发 WAF 限流会自动降级「新浪不复权」并在页眉标注。不复权数据在除权/除息日会产生价格跳变，可能污染买入价与收益；使用备用源期间数值可靠性低于前复权口径。' },
    { name: '⑧ 当前输出', text: '把胜出方法的选股条件应用到最新交易日涨停池，输出的是**明日买入计划**：基准价、回踩买入价、破位放弃价、高开放弃价、触发条件与 T+2 卖出规则。这是条件化观察清单，不是买入指令，也不预测明日涨跌；排序分只用于排序。' }
  ],
  caveat: '本模块是「次日买入机会计划」的历史回放与横向比较，不是策略优化、不是收益预测，更不是投资建议。历史表现不预示未来；短线博弈风险极高，请独立判断。'
};

const ENLIGHTEN_METHODS = [
  {
    id: 'M1', name: '早盘首板', kind: '打板',
    desc: '首板（连续 1 板）+ 10:00 前首封 + 零炸板 + 封单/流通市值 ≥1%',
    match: x => (Number(x.boards) || 1) === 1 && !!x.firstSeal && x.firstSeal <= '10:00:00' &&
      (Number(x.brokenCount) || 0) === 0 && (Number(x.sealFundRatio) || 0) >= 1
  },
  {
    id: 'M2', name: '低位连板接力', kind: '接力',
    desc: '2~3 连板 + 零炸板 + 封单比 ≥0.5%（排除高位加速）',
    match: x => { const b = Number(x.boards) || 1; return b >= 2 && b <= 3 && (Number(x.brokenCount) || 0) === 0 && (Number(x.sealFundRatio) || 0) >= 0.5; }
  },
  {
    id: 'M3', name: '良性分歧低吸', kind: '分歧',
    desc: '连板 ≥2 + 炸板 1~3 次 + 封单比 ≥0.3% + 换手 ≥5%（分歧后回封）',
    match: x => { const br = Number(x.brokenCount) || 0; return (Number(x.boards) || 1) >= 2 && br >= 1 && br <= 3 && (Number(x.sealFundRatio) || 0) >= 0.3 && (Number(x.turnover) || 0) >= 5; }
  },
  {
    id: 'M4', name: 'N天N板反包', kind: '反包',
    desc: 'zttj 近 N 日涨停 M 次：M≥3、M>连续板数、密度 M/N≥0.34',
    match: x => {
      const b = Number(x.boards) || 1, c = Number(x.statCount) || b, d = Number(x.statDays) || 0;
      return c >= 3 && c > b && d > 0 && c / d >= 0.34;
    }
  },
  {
    id: 'M5', name: '高位一致加速（对照）', kind: '对照',
    desc: '连板 ≥2 + 09:25 一字首封 + 零炸板 + 封单比 ≥2%（实盘常买不进）',
    match: x => (Number(x.boards) || 1) >= 2 && x.firstSeal === '09:25:00' &&
      (Number(x.brokenCount) || 0) === 0 && (Number(x.sealFundRatio) || 0) >= 2
  },
  {
    id: 'M0', name: '全池基准（对照）', kind: '基准',
    desc: '当日全部非 ST 涨停股，作为「不做任何筛选」的参照线',
    match: x => !x.isST
  }
];

const ENLIGHTEN_PLAN = {
  dipPct: 0.98, stopPct: 0.95, maxOpenPct: 1.05,
  label: '次日回踩低吸 · T+1 买入 / T+2 收盘卖出',
  desc: 'T 日收盘价 C → 回踩 C×0.98 买入；高开 >C×1.05 或跌破 C×0.95 放弃；A 股 T+1 制度下 T+2 收盘才能卖出'
};
function toKDate(d) {
  const s = String(d || '');
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
}
function limitUpCut(code) {
  if (/^(300|301|688|689)/.test(String(code))) return 19.5;
  if (/^(8|4|920)/.test(String(code))) return 29.5;
  return 9.7;
}

/** 计划参数只由 T 日收盘价推算，不含任何 T+1 信息（无未来函数） */
function enlightenPlan(C, code) {
  const c = Number(C);
  if (!(c > 0)) return null;
  return {
    code: code || '', base: r2(c),
    entry: r2(c * ENLIGHTEN_PLAN.dipPct),
    stop: r2(c * ENLIGHTEN_PLAN.stopPct),
    maxOpen: r2(c * ENLIGHTEN_PLAN.maxOpenPct),
    dipPct: ENLIGHTEN_PLAN.dipPct, stopPct: ENLIGHTEN_PLAN.stopPct,
    maxOpenPct: ENLIGHTEN_PLAN.maxOpenPct
  };
}

/**
 * T+1 判定是否触发买入、T+2 收盘卖出。
 * 只用 T+1/T+2 的真实日K做触发与结果判定，绝不参与分类或计划参数计算。
 */
function enlightenPlanOutcome(kd, date) {
  const kl = kd && kd.rows;
  if (!kl || kl.length < 3) return null;
  const idx = kl.findIndex(b => b.date === toKDate(date));
  if (idx < 0) return null;
  const t = kl[idx], d1 = kl[idx + 1], d2 = kl[idx + 2];
  if (!d1 || !d2) return { status: '观察中', plan: enlightenPlan(t.close, kd.code) };
  const plan = enlightenPlan(t.close, kd.code);
  if (!plan) return null;
  const o = Number(d1.open), l = Number(d1.low), c1 = Number(d1.close);
  const skip = reason => ({ status: '未触发', reason, plan, buyDate: d1.date, sellDate: d2.date, nextPct: r2((c1 - Number(t.close)) / Number(t.close) * 100) });
  if (o > plan.maxOpen) return skip('高开过度（一致性过强，放弃追高）');
  if (o <= plan.stop) return skip('跳空低开破位');
  if (l <= plan.stop) return skip('盘中破位（回踩过深，放弃）');
  if (l > plan.entry) return skip('未给回踩机会（不追价）');
  const exit = Number(d2.close);
  if (!(exit > 0)) return { status: '观察中', plan };
  const hi = Math.max(Number(d1.high) || 0, Number(d2.high) || 0);
  const lo = Math.min(l, Number(d2.low) || l);
  return {
    status: '成交', reason: '回踩到位成交', plan,
    buyDate: d1.date, sellDate: d2.date,
    entry: plan.entry, exit: r2(exit),
    ret: r2((exit - plan.entry) / plan.entry * 100),
    mfe: r2((hi - plan.entry) / plan.entry * 100),
    mae: r2((lo - plan.entry) / plan.entry * 100),
    nextPct: r2((c1 - Number(t.close)) / Number(t.close) * 100),
    promoted: (c1 - Number(t.close)) / Number(t.close) * 100 >= limitUpCut(kd.code || ''),
    source: kd.source, adjusted: kd.adjusted
  };
}

/** 汇总：未触发是「没机会就不做」，计入触发率但不进收益分母 */
function enlightenSummary(samples) {
  const n = samples.length;
  const done = samples.filter(s => s.out.status === '成交');
  const mean = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;
  const mean2 = a => a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null;
  const skipReasons = {};
  samples.forEach(s => {
    if (s.out.status === '成交') return;
    const k = s.out.status === '未触发' ? (s.out.reason || '未触发') : s.out.status;
    skipReasons[k] = (skipReasons[k] || 0) + 1;
  });
  const rets = done.map(s => s.out.ret).filter(Number.isFinite);
  const wins = rets.filter(v => v > 0), losses = rets.filter(v => v < 0);
  const gain = wins.reduce((s, v) => s + v, 0), loss = -losses.reduce((s, v) => s + v, 0);
  const avgRet = mean2(rets);
  const triggerRate = n ? r1(done.length / n * 100) : null;
  return {
    n, triggered: done.length, triggerRate, skipReasons,
    avgRet, winRate: rets.length ? r1(wins.length / rets.length * 100) : null,
    promoteRate: n ? r1(samples.filter(s => s.out.promoted).length / n * 100) : null,
    avgMfe: mean(done.map(s => s.out.mfe).filter(Number.isFinite)),
    avgMae: mean(done.map(s => s.out.mae).filter(Number.isFinite)),
    best: rets.length ? r1(Math.max(...rets)) : null,
    worst: rets.length ? r1(Math.min(...rets)) : null,
    profitFactor: loss > 0 ? r2(gain / loss) : (gain > 0 ? null : 0),
    // 每候选期望值：把「有多少时候根本没机会」算进去，才是可比较的方法价值
    expectancy: (avgRet !== null && triggerRate !== null) ? r2(avgRet * triggerRate / 100) : null,
    klineSources: [...new Set(done.map(s => s.out.source).filter(Boolean))]
  };
}

function enlightenCandidateScore(x, themeMap) {
  let s = 0;
  s += clamp((Number(x.sealFundRatio) || 0) * 4, 0, 16);
  if (x.firstSeal && /^\d{2}:\d{2}:\d{2}$/.test(x.firstSeal)) {
    const h = Number(x.firstSeal.slice(0, 2)), m = Number(x.firstSeal.slice(3, 5));
    s += clamp(14 - Math.max(0, (h * 60 + m - 565) / 12), 0, 14);
  }
  s -= Math.min(12, (Number(x.brokenCount) || 0) * 4);
  const th = themeMap.get(x.industry);
  if (th) s += Math.min(12, (th.count || 0) * 3) + Math.min(8, (th.outlookScore || 0) * 2);
  const cap = Number(x.floatCap) || 0;
  s += (cap >= 20 && cap <= 200) ? 8 : 2;
  if ((Number(x.statCount) || 0) > (Number(x.boards) || 1)) s += 4;
  return Math.round(clamp(s, 0, 100));
}

function enlightenmentBacktest(ctx) {
  const history = ctx.history || {}, kByCode = ctx.kByCode || new Map();
  const baseDates = (ctx.baseDates || []).slice();
  const pools = ctx.pools || {}, quotes = ctx.quotes || {}, ov = ctx.overview || {};
  const themes = ctx.themes || [], minSamples = Number(ctx.minSamples) || 20;
  const themeMap = new Map(themes.map(t => [t.name, t]));
  const byDate = history.byDate || {};
  const skipped = { noKline: 0, noT2Bar: 0, noPlan: 0, noPool: 0 };
  const samplesByMethod = new Map(ENLIGHTEN_METHODS.map(m => [m.id, []]));
  const daily = [];

  for (const date of baseDates) {
    const day = byDate[date];
    const zt = (day && day.zt) || [];
    if (!zt.length) { skipped.noPool++; daily.push({ date, poolCount: 0, completed: 0 }); continue; }
    let completed = 0;
    for (const x of zt) {
      if (!x || !x.code || x.isST) continue;
      const kd = kByCode.get(x.code);
      if (!kd || !kd.rows || !kd.rows.length) { skipped.noKline++; continue; }
      const out = enlightenPlanOutcome({ ...kd, code: x.code }, date);
      if (!out || out.status === '观察中') { skipped.noT2Bar++; continue; }
      if (!out.plan) { skipped.noPlan++; continue; }
      completed++;
      const sample = { date, code: x.code, name: x.name, industry: x.industry, boards: x.boards, out };
      for (const m of ENLIGHTEN_METHODS) {
        try { if (m.match(x)) samplesByMethod.get(m.id).push(sample); } catch (e) { /* 规则异常跳过 */ }
      }
    }
    daily.push({ date, poolCount: zt.length, completed });
  }

  const methods = ENLIGHTEN_METHODS.map(m => {
    const s = enlightenSummary(samplesByMethod.get(m.id));
    // 门槛看「成交笔数」而不是候选数：没触发的计划不产生可交易样本
    return { id: m.id, name: m.name, kind: m.kind, desc: m.desc, ...s, sampleOK: s.triggered >= minSamples };
  }).sort((a, b) => (Number(b.expectancy) || -999) - (Number(a.expectancy) || -999));

  const baseline = methods.find(m => m.id === 'M0') || null;
  methods.forEach(m => {
    m.edge = (m.expectancy !== null && baseline && baseline.expectancy !== null) ? r2(m.expectancy - baseline.expectancy) : null;
    // 只有负的 MAE（真实浮亏）才扣风险；正的 MAE 表示买入后未回到成本下方，是强势而非风险
    m.riskAdj = (m.expectancy !== null) ? r2(m.expectancy + 0.3 * Math.min(0, Number(m.avgMae) || 0) * (Number(m.triggerRate) || 0) / 100) : null;
    m.caveat = m.id === 'M0' ? '参照线（不做筛选）'
      : (m.id === 'M5' ? '一字/秒板次日往往不给回踩机会，触发率天然低' : '');
  });
  const eligible = methods.filter(m => m.sampleOK && m.id !== 'M0');
  const insufficientStrong = methods.filter(m =>
    !m.sampleOK && m.triggered >= 4 && m.id !== 'M0' && m.id !== 'M5' && m.expectancy !== null &&
    baseline && baseline.expectancy !== null && m.expectancy > baseline.expectancy + 0.3
  ).sort((a, b) => b.expectancy - a.expectancy);

  let best = null, bestReason, verdict;
  if (!eligible.length) {
    verdict = 'insufficient';
    bestReason = '回溯窗口内没有任何筛选方法达到成交样本门槛（≥' + minSamples + ' 笔），按纪律不下「最佳机会计划」结论；下方展示各方法原始统计，请自行判断。';
  } else {
    best = eligible.slice().sort((a, b) => b.expectancy - a.expectancy)[0];
    const desc = '「' + best.name + '」候选 ' + best.n + ' 次、实际触发买入 ' + best.triggered + ' 次（触发率 ' +
      best.triggerRate + '%），成交后平均收益 ' + best.avgRet + '%、胜率 ' + best.winRate +
      '%，**每候选期望值 ' + best.expectancy + '%**（已把「没机会就不做」计入）';
    if (best.id === 'M5') {
      verdict = 'illiquid';
      bestReason = desc + '。但一字/秒板次日通常不给回踩机会或高开过度被计划过滤，样本极少且不代表可复制机会，不应据此追高。';
    } else if (best.edge !== null && best.edge < 0.3) {
      verdict = 'no-edge';
      bestReason = desc + '，相对「全池基准」' + (baseline ? baseline.expectancy : '—') +
        '% 的超额只有 ' + best.edge + ' 个百分点。因此本区间没有证据表明该选股方法提供了稳定优势，正确结论是「与不筛选基本持平」，而不是「找到了最佳战法」。' +
        (insufficientStrong.length ? ' 另有 ' + insufficientStrong.map(m => m.name + '（期望 ' + m.expectancy + '% / 成交 ' + m.triggered + ' 笔）').join('、') + ' 数字更高但成交样本不足 ' + minSamples + ' 笔，只列为待验证观察项。' : '');
    } else {
      verdict = 'edge';
      bestReason = desc + '，相对全池基准超额 ' + best.edge +
        ' 个百分点，为本区间样本达标方法中最优；仅代表该历史区间的「机会计划」表现，不预示未来。' +
        (insufficientStrong.length ? ' 另有 ' + insufficientStrong.map(m => m.name + '（期望 ' + m.expectancy + '% / 成交 ' + m.triggered + ' 笔）').join('、') + ' 数字更高但样本不足，待验证。' : '');
    }
  }

  // 当前池映射：同一套判定条件，不用回测结果去「预测」涨跌。
  // 若无方法达到成交样本门槛，回退到「全池基准」生成明日计划（不做优选），并如实标注。
  const ztNow = (pools.zt || []).filter(x => !x.isST);
  let bestDef = best ? ENLIGHTEN_METHODS.find(m => m.id === best.id) : null;
  const planFallback = !bestDef;
  if (!bestDef) bestDef = ENLIGHTEN_METHODS.find(m => m.id === 'M0');
  if (planFallback) {
    bestReason += ' 因无筛选方法达标，下方「明日买入机会计划」按全池基准（不做优选）生成，仅作为条件观察清单，不代表任何方法优势。';
  }
  const matched = bestDef ? ztNow.filter(x => { try { return bestDef.match(x); } catch (e) { return false; } }) : [];
  const candidates = matched.map(x => {
    const q = quotes[x.code] || {}, th = themeMap.get(x.industry);
    const C = q.price !== undefined && q.price !== null ? q.price : x.price;
    const plan = enlightenPlan(C, x.code);
    const risks = [];
    if ((Number(x.brokenCount) || 0) >= 2) risks.push('炸板 ' + x.brokenCount + ' 次');
    if ((Number(x.boards) || 1) >= 5) risks.push('高位连板，接力赔率差');
    if ((Number(x.statCount) || 0) >= 5) risks.push('累计 ' + x.statCount + ' 板（' + (x.statDays || '—') + ' 天），位置偏高');
    if ((Number(x.sealFundRatio) || 0) < 0.3) risks.push('封单偏薄');
    if ((Number(x.floatCap) || 0) < 10) risks.push('流通市值 <10 亿');
    if (th && th.stage === '退潮期') risks.push('题材进入退潮期');
    if (th && th.outlook === '弱') risks.push('题材预期弱');
    return {
      code: x.code, name: x.name, board: x.board || boardOf(x.code), industry: x.industry,
      price: q.price !== undefined && q.price !== null ? q.price : x.price,
      pct: q.pct !== undefined && q.pct !== null ? q.pct : x.pct,
      boards: x.boards, boardLabel: boardLabelOf(x),
      firstSeal: x.firstSeal, brokenCount: x.brokenCount, sealFundRatio: x.sealFundRatio,
      turnover: x.turnover, floatCap: x.floatCap, amount: x.amount,
      statDays: x.statDays, statCount: x.statCount,
      theme: th ? { name: th.name, stage: th.stage, outlook: th.outlook, count: th.count } : null,
      score: enlightenCandidateScore(x, themeMap), risks,
      // 明日买入机会计划：价位全部由今日收盘价推算，不含次日任何信息
      plan: plan ? {
        base: plan.base, entry: plan.entry, stop: plan.stop, maxOpen: plan.maxOpen,
        dipPct: plan.dipPct, stopPct: plan.stopPct, maxOpenPct: plan.maxOpenPct
      } : null,
      planSteps: plan ? [
        'T（今日）收盘价记为 C；选股条件：' + (bestDef ? bestDef.desc : '—') + '（每只标的的 C 与具体价位见上表）',
        'T+1 开盘 ≤ C×1.05（高开超过 +5% 放弃追高）',
        'T+1 最低价回踩至 C×0.98 附近，且全程未跌破 C×0.95',
        '满足才在 C×0.98 附近观察买入（条件单思路，不是市价追单）',
        'T+2 收盘卖出（A 股 T+1：买入当日不能卖）'
      ] : [],
      invalidations: plan ? [
        '开盘 > C×1.05：一致性过强，放弃',
        '开盘 ≤ C×0.95 或盘中跌破 C×0.95：破位放弃',
        '全天最低价 > C×0.98：未给回踩机会，不追价',
        '龙头炸板 / 题材转弱 / 跌停家数扩大：整体放弃'
      ] : [],
      reason: '排序分 ' + enlightenCandidateScore(x, themeMap) + '（仅用于排序，不是收益预测）'
    };
  }).sort((a, b) => b.score - a.score).slice(0, 20);

  const market = {
    poolDate: (pools && pools.date) || null,
    limitUp: ov.limitUp, limitDown: ov.limitDown, broken: ov.broken, breakRate: ov.breakRate,
    up: ov.up, down: ov.down, breadth: ov.breadth, maxBoard: ov.maxBoard,
    tier: ov.tier, emotion: ov.emotion, idxAvg: ov.idxAvg,
    indices: (ov.indices || []).map(i => ({ name: i.name, price: i.price, pct: i.pct }))
  };

  return {
    methods, best, bestReason, verdict, baseline, insufficientStrong,
    minSamples, daily, skipped, market, candidates, planFallback,
    planRules: ENLIGHTEN_PLAN,
    candidateMethod: bestDef ? { id: bestDef.id, name: bestDef.name, desc: bestDef.desc, fallback: planFallback } : null,
    methodology: ENLIGHTEN_METHOD,
    metaNote: '候选与分类=东方财富历史/实时涨停池；T+1 触发与 T+2 结果判定=' +
      [...new Set([...kByCode.values()].map(k => k.source).filter(Boolean))].join(' / ') +
      '；市场广度=新浪财经全市场快照；指数=腾讯证券实时行情。'
  };
}

module.exports = {
  ENLIGHTEN_METHOD, ENLIGHTEN_METHODS, ENLIGHTEN_PLAN, enlightenmentBacktest,
  enlightenPlan, enlightenPlanOutcome,
  applyFilters, technicalAnalysis,
  marketOverview, buildThemes, reviewPlan,
  shortTermPicks, shortTermScore,
  boardLowBuy, roleJudge, liveOpportunities,
  detectReverseBoard, relayPicks, aiResearch,
  pullbackAnalysis, pivotClusters, countTouches, PULLBACK_METHOD,
  backtestOutcome, summarizeBacktest, BACKTEST_METHOD,
  dragonGame, dragonSentiment, dragonThemes, dragonValidation, sealProfile, DRAGON_METHOD,
  dragonNameThemes, boardLabelOf,
  indicators: { sma, ema, macd, rsi, kdj, boll, atr }
};
