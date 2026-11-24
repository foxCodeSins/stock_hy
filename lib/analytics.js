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
/**
 * 题材内龙头排序（龙一/龙二/龙三）：与连板天梯「板块龙头=连板最高且封单最强」同口径。
 * 排序键：连板数降序 → 封单比降序 → 首封时间升序 → 累计涨停数降序 → 代码升序。
 * 纯量价结构机械排名，不含未来函数，不代表次日表现。
 */
function rankThemeDragons(members) {
  const seal = x => { const v = Number(x.sealFundRatio); return Number.isFinite(v) ? v : -1; };
  const firstSeal = x => String(x.firstSeal || '99:99:99');
  const cum = x => Number(x.statCount) || Number(x.boards) || 1;
  const sorted = (members || []).slice().sort((a, b) =>
    ((Number(b.boards) || 1) - (Number(a.boards) || 1)) ||
    (seal(b) - seal(a)) ||
    (firstSeal(a) < firstSeal(b) ? -1 : firstSeal(a) > firstSeal(b) ? 1 : 0) ||
    (cum(b) - cum(a)) ||
    String(a.code).localeCompare(String(b.code))
  ).slice(0, 3);
  const labels = ['龙一', '龙二', '龙三'];
  return sorted.map((x, i) => ({
    rank: i + 1, label: labels[i],
    code: x.code, name: x.name,
    boards: Number(x.boards) || 1,
    sealRatio: r2(x.sealFundRatio),
    firstSeal: x.firstSeal || null,
    statCount: x.statCount || null,
    isST: !!x.isST
  }));
}

/** 题材分组 → 生命周期卡片（行业 / 概念共用同一套量价判定，口径一致、可对比） */
function themeGroupToCard(g, matchBoard, kind) {
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
  else if (m.length === 1) { stage = '预热/日内脉冲'; stageBasis = '仅 1 只成分股涨停，尚未形成扩散'; }
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

  return {
    name: g.name, kind: kind || 'industry', count: m.length, maxBoard: maxB, ladder, gap: gapFlag,
    broken: g.broken, down: g.down, negRate: r1(negRate),
    avgSealRatio: r1(avgSeal),
    stage, stageBasis, outlook, outlookScore, outlookBasis,
    boardRef: b ? { name: b.name, pct: b.pct, leaderName: b.leaderName, source: b.source || '新浪财经板块行情' } : null,
    members: m.map(x => x.code),
    memberNames: m.map(x => x.name),
    dragons: rankThemeDragons(m),
    dragonBasis: '题材内按连板高度→封单比→首封时间→累计涨停数机械排名（与连板天梯板块龙头同口径），非交易所认定、不代表次日表现',
    watchPoints: [
      `龙头能否晋级：${m.filter(x => x.boards === maxB).map(x => x.name + '(' + x.code + ')').join('、') || '无'}`,
      `次日板块首板数量能否由 ${m.length} 只继续扩散`,
      `炸板/负反馈率能否从 ${r1(negRate)}% 回落`,
      '是否出现新的政策或产业催化（量价评分不纳入资讯数据，消息面见「明日龙头」模块独立监控，需自行核实）'
    ]
  };
}

/** 板块行情匹配器（行业 + 概念合并，取涨幅最高的同名板块） */
function makeBoardMatcher(boards) {
  const industryBoards = (boards && boards.industry) || [];
  const conceptBoards = (boards && boards.concept) || [];
  return name => {
    if (!name) return null;
    const n = String(name).replace(/[ⅡⅢⅠ].*$/, '').trim();
    const cand = [...industryBoards, ...conceptBoards].filter(b => {
      const bn = String(b.name).replace(/行业|板块/g, '').trim();
      return bn && (bn.includes(n.slice(0, 2)) || n.includes(bn.slice(0, 2)));
    });
    return cand.length ? cand.sort((a, b) => (b.pct || 0) - (a.pct || 0))[0] : null;
  };
}

const themeSort = (a, b) => (b.outlookScore - a.outlookScore) || (b.count - a.count) || (b.maxBoard - a.maxBoard);

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

  const matchBoard = makeBoardMatcher(boards);
  const out = [];
  for (const g of groups.values()) out.push(themeGroupToCard(g, matchBoard, 'industry'));
  return out.sort(themeSort);
}

/**
 * 概念主线：按新浪概念板块成分股把涨停股重新分组（一只票可属多个概念），
 * 复用与行业题材完全相同的生命周期判定，便于「行业 / 概念」并列对比。
 * conceptMap: { code: [概念名, ...] }，由服务端从概念板块成分股建立。
 */
function buildConceptThemes(pools, boards, conceptMap) {
  const zt = pools.zt || [], zb = pools.zb || [], dt = pools.dt || [];
  if (!conceptMap || !Object.keys(conceptMap).length) return [];
  const groups = new Map();
  const add = (x, field) => {
    const cs = conceptMap[x.code] || [];
    cs.forEach(c => {
      if (!groups.has(c)) groups.set(c, { name: c, members: [], broken: 0, down: 0 });
      if (field === 'member') groups.get(c).members.push(x);
      else groups.get(c)[field]++;
    });
  };
  zt.forEach(x => add(x, 'member'));
  zb.forEach(x => add(x, 'broken'));
  dt.forEach(x => add(x, 'down'));
  const matchBoard = makeBoardMatcher(boards);
  // 概念分组至少 2 只成分股涨停才算「主线」，避免单只票牵强归为概念题材
  const out = [];
  for (const g of groups.values()) if (g.members.length >= 2) out.push(themeGroupToCard(g, matchBoard, 'concept'));
  return out.sort(themeSort);
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
    '本页量价评分不纳入新闻 / 公告 / 龙虎榜数据（消息面见「明日龙头」模块独立监控），题材阶段完全由量价结构推导，重大事项仍需核实公告原文',
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
        ? topThemes.map(t => {
            const dragons = (t.dragons || []).map(d => `${d.label}${d.name}(${d.boards}板)`).join('、');
            return `${t.name}（${t.count} 只涨停 / 最高 ${t.maxBoard} 板${dragons ? ' / 龙头 ' + dragons : ''}）处于「${t.stage}」，预期「${t.outlook}」：${t.outlookBasis}`;
          }).join('；') + '。'
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
    '本引擎评分不纳入新闻 / 公告 / 龙虎榜数据（消息面见「明日龙头」模块独立监控），题材阶段由量价结构机械推导；重大事项需核实公告原文'
  ];
  const watchList = (review && review.focus ? review.focus : []).map(f => f.title + '：' + f.text);

  return {
    mode: 'local',
    modeLabel: '本地量化研判引擎（规则生成，可追溯）',
    headline, sections, topPicks, riskAlerts, watchList,
    sourceNote: `数据源时点：新浪全市场 ${(meta && meta.universeTick) || '—'} / 腾讯实时 ${(meta && meta.quoteTick) || '—'} / 东财涨停池交易日 ${(meta && meta.poolDate) || '—'}`,
    caveat: '本模块结论由确定性规则引擎基于实时行情生成，不是大模型生成内容；所有判断可追溯到上方数据字段；评分不纳入消息面（另见「明日龙头」模块独立监控），也不含主观预测。'
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
        basis: hit.length + ' 只涨停股名称均含「' + item.w + '」字（' + g.group + '），按名称字面聚类识别。A 股存在名称 / 玄学共振炒作现象，量价引擎不据此判定是否存在真实催化，消息面请见「明日龙头」模块独立监控。',
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
    caveat: '名称 / 玄学共振由规则词典与名称聚类机械生成，评分不纳入新闻与公告（消息面见「明日龙头」模块），不推断炒作原因；A 股名称炒作常无业绩支撑，请独立核实。'
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

/* ═══════════════ 明日龙头：严重异常波动预测 + 交易风险标记 ═══════════════ */
/**
 * 口径（沪深交易所公开交易规则的常见标准，仅作研究参考，不等于交易所认定）：
 *   · 异常波动：连续 3 个交易日收盘价涨跌幅偏离值累计 ±20%（主板）/ ±30%（创业板、科创板）/ ±12%（ST）。
 *   · 严重异常波动：连续 10 个交易日累计 +100%、连续 30 个交易日累计 +200%，
 *     或连续 10 个交易日内多次出现同向异常波动。
 * 本系统只有个股日K、没有基准指数历史日K，故用「N 日累计涨幅」近似「偏离值累计」，
 * 未扣除同期指数涨跌幅（通常略高于交易所口径）；日K降级为不复权时除权跳变也会带来偏差。
 * 输出只是「距离阈值的量化提示」，不预测是否会被认定、是否停牌，也不预测次日涨跌。
 */
const DRAGON_RISK_METHOD = {
  title: '严重异动预测 · 交易风险标记口径',
  rules: [
    { name: '① 预测什么', text: '只用真实日K收盘价算「近 3 / 10 / 30 个交易日累计涨幅」，与交易所异常波动、严重异常波动的常见阈值比较，给出「已达 / 即将 / 临近 / 累计偏高」四档提示。这是阈值距离推算，不是对交易所是否认定、公司是否停牌核查的预测，也不是次日涨跌预测。' },
    { name: '② 阈值与板块', text: '异常波动（3 日累计偏离值）：主板 ±20%、创业板 / 科创板 / 北交所 ±30%、ST ±12%；严重异常波动：10 日 +100%、30 日 +200%。板块按证券代码前缀机械划分，ST 按涨停池字段判断；不同板块与时期的细则存在差异，以交易所现行规则为准。' },
    { name: '③ 关键近似', text: '交易所口径是「单日涨跌幅减去基准指数涨跌幅后的偏离值累计」，本系统没有指数历史日K，只能用「N 日累计涨幅」近似，未扣除基准指数；因此数值可能高于交易所口径，临界标的请以交易所与公司公告为准。日K优先用腾讯前复权，WAF 限流时降级新浪不复权，除权日跳变可能污染累计涨幅，来源与口径在每只标的下方标注。' },
    { name: '④ 什么叫「即将」', text: '按该股涨停幅度（主板 10%、创业板/科创板 20%、ST 5%、北交所 30%）计算：当前 10 日累计涨幅再涨 1 个涨停即达到 +100%，标为「即将严重异动」；需 2 个涨停标为「临近」；已达 +100% 标为「已达严重异动区间」；累计涨幅 ≥50% 或近 10 日涨停 ≥3 次标为「累计波动偏高」。所需涨停数向上取整，不含任何中途回撤假设。' },
    { name: '⑤ 多次同向波动', text: '近 10 个交易日内，滚动 3 日窗口累计涨幅达到该板块异常波动阈值的次数 ≥3，或近 10 日涨停次数 ≥3，作为「10 日内多次同向异常波动」的近似信号。交易所按公告与偏离值认定，本系统只是滚动窗口计数，可能高估，不作认定结论。' },
    { name: '⑥ 交易风险来源', text: '三类证据合并：① 个股公告（东财公告接口，按 codes 精确关联）——监管立案 / 退市、严重异动与停牌核查、异常波动与风险提示、减持解禁质押、业绩经营风险、事项终止；② 量价结构——ST、高位一致加速、尾盘回封、封单比偏低、炸板次数、孤立涨停、累计板数偏高、流通市值偏小、换手过高；③ 严重异动预测本身。每条都标出来源与命中依据，可点公告原文核实。公告证据随龙头数据刷新（服务端短缓存）更新，不是实时推送；盘中新增消息请看「消息面 · 实时监控」面板的轮询与「新增」标记。' },
    { name: '⑦ 分级与不改写评分', text: '高危公告、已达或即将严重异动 → 交易风险「高」；一般公告、临近严重异动、多项量价风险 → 「中」；其余「低」。风险标记只是观察提示，不参与也不改写明日龙头评分、一致度 / 分歧度与明日剧本，不改变「只做龙头」筛选纪律。' },
    { name: '⑧ 能力边界', text: '未接入交易所认定结果、停牌决定、龙虎榜席位与公告全文语义解析；关键词机械匹配可能把「风险提示公告」这类常规披露与实质风险混同，也可能漏掉未命中词典的事项。公告为东方财富转载、快讯为媒体二次来源，重大事项务必点开原文 / PDF 核实。所有标签不构成投资建议。' }
  ],
  caveat: '严重异动预测是对公开日K与公告的规则化整理，不是交易所认定，也不是收益或涨跌预测。累计涨幅未扣除基准指数、前复权与不复权口径可能混用，临界判断可能与交易所口径不一致；公告与快讯可能滞后、被修订或误匹配。请以上市公司在交易所披露的公告原文与交易所现行规则为准。'
};

/** 交易风险公告词典：按证据强度分组，命中即挂标签（不是对事件性质的认定） */
const TRADE_RISK_RULES = [
  { tag: '监管立案 / 退市', severity: 'high', words: ['立案调查', '被立案', '行政处罚', '处罚决定', '监管函', '警示函', '问询函', '关注函', '通报批评', '纪律处分', '涉嫌违规', '违规担保', '退市风险', '终止上市', '暂停上市', '失信', '被执行'] },
  { tag: '严重异动 / 停牌核查', severity: 'high', words: ['严重异常波动', '严重异动', '停牌核查', '核查停牌', '暂停交易', '停牌'] },
  { tag: '异常波动 / 风险提示', severity: 'medium', words: ['股票交易异常波动', '异常波动公告', '异常波动', '风险提示公告', '风险提示', '澄清公告', '澄清', '交易风险提示', '炒作风险', '非理性炒作', '股价异动', '市盈率'] },
  { tag: '减持解禁 / 质押', severity: 'medium', words: ['减持', '解禁', '质押', '平仓', '被动减持', '股份冻结', '司法冻结'] },
  { tag: '业绩 / 经营风险', severity: 'medium', words: ['业绩预亏', '预亏', '亏损', '业绩下修', '业绩修正', '商誉减值', '计提减值', '债务逾期', '重大诉讼', '诉讼', '担保'] },
  { tag: '事项终止 / 协议解除', severity: 'medium', words: ['终止重大资产重组', '终止重大重组', '终止重组', '终止收购', '终止筹划', '未达成一致', '解除协议', '拟终止', '终止发行股份购买资产'] }
];

/** 按代码前缀划分板块与涨停幅度（只用于阈值推算，不是交易所口径认定） */
function riskBoardOf(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (/^(30|68)/.test(c)) return { name: '创业板 / 科创板', limitPct: 0.20, abnormal3: 30 };
  if (/^(8|4)/.test(c)) return { name: '北交所', limitPct: 0.30, abnormal3: 30 };
  return { name: '沪深主板', limitPct: 0.10, abnormal3: 20 };
}

/** 当前累计涨幅再涨几个涨停能到目标；0 表示已达，null 表示数据不足 */
function severeBoardsNeeded(cumPct, targetPct, limitPct) {
  if (cumPct === null || cumPct === undefined || !Number.isFinite(cumPct)) return null;
  const base = 1 + cumPct / 100, tgt = 1 + targetPct / 100;
  if (base >= tgt) return 0;
  if (base <= 0) return null;
  return Math.max(1, Math.ceil(Math.log(tgt / base) / Math.log(1 + limitPct)));
}

/** 纯函数：只吃真实日K，输出严重异动阈值距离（无任何未来数据） */
function severeVolatilityForecast(klData, row) {
  const nodata = (reason) => ({
    level: 'nodata', label: '异动数据不可用', reason,
    cum3: null, cum10: null, cum30: null, need10: null, need3: null,
    limitUps10: null, rolling3Hits: null, abnormal3: 'nodata',
    source: null, adjusted: null, asOf: null, evidence: [], action: reason,
    caveat: '日K接口未返回数据，系统不会用推测数据填充阈值距离。'
  });
  const raw = klData && Array.isArray(klData.rows) ? klData.rows : [];
  if (raw.length < 4) return nodata('日K不足 4 根，无法计算累计涨幅');
  const s = raw.slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .map(r => ({ date: String(r.date || '').slice(0, 10), close: Number(r.close) }))
    .filter(r => r.date && Number.isFinite(r.close) && r.close > 0);
  if (s.length < 4) return nodata('日K收盘价无效，无法计算累计涨幅');

  const b = riskBoardOf(row.code);
  const limitPct = row.isST ? 0.05 : b.limitPct;
  const th3 = row.isST ? 12 : b.abnormal3;
  const last = s[s.length - 1].close;
  const cum = n => s.length > n ? r1((last / s[s.length - 1 - n].close - 1) * 100) : null;
  const cum3 = cum(3), cum10 = cum(10), cum30 = cum(30);
  const need10 = severeBoardsNeeded(cum10, 100, limitPct);
  const need3 = severeBoardsNeeded(cum3, th3, limitPct);

  // 近 10 个交易日的涨停次数（按该板块涨停幅度的 90% 容错识别）
  const recent = s.slice(-11);
  let limitUps10 = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close / recent[i - 1].close - 1 >= limitPct * 0.9) limitUps10++;
  }
  // 近 10 日内滚动 3 日窗口达到异常波动阈值的次数（「多次同向波动」的近似）
  let rolling3Hits = 0;
  for (let i = Math.max(0, s.length - 10); i <= s.length - 3; i++) {
    if (!s[i] || !s[i + 3]) continue;
    if ((s[i + 3].close / s[i].close - 1) * 100 >= th3) rolling3Hits++;
  }

  let level = 'normal', label = '未见严重异动信号';
  if (cum10 !== null && cum10 >= 100) { level = 'triggered'; label = '已达严重异动区间'; }
  else if (need10 !== null && need10 <= 1) { level = 'imminent'; label = '即将严重异动'; }
  else if (need10 !== null && need10 <= 2) { level = 'near'; label = '临近严重异动'; }
  else if ((cum10 !== null && cum10 >= 50) || limitUps10 >= 3 || rolling3Hits >= 3) { level = 'watch'; label = '累计波动偏高'; }

  const abnormal3 = cum3 === null ? 'nodata'
    : (cum3 >= th3 ? 'triggered' : (need3 !== null && need3 <= 1 ? 'imminent' : 'normal'));
  const limitLabel = Math.round(limitPct * 100) + '%';
  const evidence = [
    { label: '近 3 日累计涨幅', value: cum3 === null ? '—' : (cum3 > 0 ? '+' : '') + cum3 + '%', threshold: '±' + th3 + '%', note: abnormal3 === 'triggered' ? '已达异常波动阈值' : (abnormal3 === 'imminent' ? '再涨 1 个涨停接近阈值' : '未达阈值') },
    { label: '近 10 日累计涨幅', value: cum10 === null ? '—' : (cum10 > 0 ? '+' : '') + cum10 + '%', threshold: '+100%', note: need10 === null ? '样本不足' : (need10 === 0 ? '已达' : '还需 ' + need10 + ' 个涨停') },
    { label: '近 30 日累计涨幅', value: cum30 === null ? '—' : (cum30 > 0 ? '+' : '') + cum30 + '%', threshold: '+200%', note: cum30 !== null && cum30 >= 200 ? '已达' : '未达' },
    { label: '近 10 日涨停次数', value: limitUps10 + ' 次', threshold: '≥3 次提示', note: limitUps10 >= 3 ? '多次同向波动' : '未达提示线' },
    { label: '3 日滚动达标窗口', value: rolling3Hits + ' 个', threshold: '≥3 个提示', note: '按累计涨幅近似，非交易所认定' },
    { label: '本股涨停幅度', value: limitLabel, threshold: '—', note: b.name + (row.isST ? ' · ST 5%' : '') }
  ];
  const action = level === 'triggered'
    ? '10 日累计涨幅已达 +100% 附近，核实公司是否已披露异常波动 / 严重异常波动公告及是否停牌核查；勿把「已达阈值」当作继续上涨的理由。'
    : level === 'imminent'
      ? '若明日再涨停（约 +' + limitLabel + '），按本口径 10 日累计涨幅将接近或达到 +100%，需留意公司发布异常波动公告、停牌核查与交易所重点监控的可能。这是条件化提示，不是涨跌预测。'
      : level === 'near'
        ? '按本口径还需约 ' + need10 + ' 个涨停接近 +100% 阈值，留意高位加速后的核查与情绪降温风险。'
        : level === 'watch'
          ? '累计涨幅或近 10 日涨停次数偏高，尚未接近 +100% 阈值，但高位波动与分歧回撤风险仍需自行控制。'
          : '按现有日K未接近严重异动阈值；阈值判断使用近似口径，仅供参考。';

  return {
    level, label, abnormal3,
    cum3, cum10, cum30, need10, need3, limitUps10, rolling3Hits,
    threshold3: th3, threshold10: 100, threshold30: 200, limitPct, board: b.name,
    source: klData.source || null, adjusted: klData.adjusted === undefined ? null : klData.adjusted,
    asOf: klData.asOf || null, klineCount: s.length, lastDate: s[s.length - 1].date,
    evidence, action,
    caveat: '用「N 日累计涨幅」近似交易所「涨跌幅偏离值累计」，未扣除基准指数涨跌幅；' +
      (klData.adjusted === false ? '当前为新浪不复权日K，除权跳变可能污染累计涨幅；' : '') +
      '不预测是否被交易所认定 / 停牌，也不预测次日涨跌，以交易所规则与公司公告原文为准。'
  };
}

/** 纯函数：个股公告 + 量价字段 + 异动预测 → 交易风险清单 */
function tradeRiskFlags(row, anns, severe) {
  const flags = [];
  for (const rule of TRADE_RISK_RULES) {
    const matched = (anns || []).filter(a => {
      const text = [String(a.title || ''), (a.columns || []).join(' ')].join(' ');
      return rule.words.some(w => text.indexOf(w) >= 0);
    });
    if (!matched.length) continue;
    flags.push({
      kind: 'announcement', tag: rule.tag, severity: rule.severity,
      detail: matched.slice(0, 2).map(a => a.title).join('；'),
      count: matched.length,
      links: matched.slice(0, 3).map(a => ({ title: a.title, url: a.url || '', pdfUrl: a.pdfUrl || '', time: a.timeText || '' }))
    });
  }
  const push = (tag, severity, detail) => flags.push({ kind: 'market', tag, severity, detail });
  if (row.isST) push('ST / 风险警示', 'high', 'ST 股涨跌幅限制 5%，流动性与退市风险高于普通标的');
  if (severe.level === 'triggered' || severe.level === 'imminent') {
    push('严重异动阈值临近', 'high', severe.label + '：10 日累计涨幅 ' + (severe.cum10 === null ? '—' : severe.cum10 + '%') + '，' + severe.action);
  }
  if (severe.abnormal3 === 'triggered') push('已达 3 日异常波动阈值', 'medium', '近 3 日累计涨幅 ' + severe.cum3 + '%，达到 ' + severe.threshold3 + '% 提示线');
  if (row.dtype === '一致加速' && (Number(row.boards) || 1) >= 3) push('高位一致加速', 'medium', '缩量加速后兑现压力大，且买不进 / 卖不出的流动性风险上升');
  if (row.lastMinute !== null && row.lastMinute !== undefined && Number(row.lastMinute) > 230) push('尾盘回封', 'medium', '最后封板偏晚，封板稳定性弱');
  if (Number(row.brokenCount) >= 2) push('日内反复炸板', 'medium', '炸板 ' + row.brokenCount + ' 次，分歧剧烈');
  if (Number(row.sealFundRatio) < 0.3) push('封单偏薄', 'medium', '封单 / 流通市值 ' + row.sealFundRatio + '%，承接力弱');
  if (Number(row.cumBoards) >= 5) push('累计板数偏高', 'medium', '近 ' + row.statDays + ' 天 ' + row.cumBoards + ' 板，位置偏高');
  if (row.theme && Number(row.theme.count) === 1) push('孤立涨停', 'medium', '所属题材当日仅 1 只涨停，缺乏板块承接');
  if (Number(row.floatCap) > 0 && Number(row.floatCap) < 15) push('流通市值偏小', 'medium', '流通市值 ' + row.floatCap + ' 亿，波动剧烈');
  if (Number(row.turnover) > 30) push('换手过高', 'medium', '换手率 ' + row.turnover + '%，筹码交换剧烈');

  const hasHigh = flags.some(f => f.severity === 'high');
  const level = hasHigh ? 'high'
    : (flags.length >= 2 || severe.level === 'near' || severe.level === 'watch' || severe.abnormal3 === 'imminent') ? 'medium'
      : 'low';
  return { level, levelLabel: level === 'high' ? '高' : (level === 'medium' ? '中' : '低'), flags, flagCount: flags.length };
}

/** 汇总：把异动预测与交易风险挂到每只候选，输出可展示的徽标与统计 */
function dragonRiskEngine({ rows = [], klines = {}, annItems = [] } = {}) {
  const annByCode = new Map();
  for (const it of (annItems || [])) {
    for (const c of (it.codes || [])) {
      const code = String(c.code || '').padStart(6, '0');
      if (!/^\d{6}$/.test(code)) continue;
      if (!annByCode.has(code)) annByCode.set(code, []);
      annByCode.get(code).push(it);
    }
  }
  const byCode = {};
  const counts = { triggered: 0, imminent: 0, near: 0, watch: 0, normal: 0, nodata: 0, tradeHigh: 0, tradeMedium: 0, tradeLow: 0 };
  const severeLabels = { triggered: '已达严重异动', imminent: '即将严重异动', near: '临近严重异动', watch: '累计波动偏高' };
  for (const row of rows) {
    const code = String(row.code || '');
    const severe = severeVolatilityForecast(klines[code], row);
    const trade = tradeRiskFlags(row, annByCode.get(code) || [], severe);
    const badges = [];
    if (severeLabels[severe.level]) badges.push({
      kind: 'severe', level: severe.level, label: severeLabels[severe.level],
      title: severe.label + '：10 日累计涨幅 ' + (severe.cum10 === null ? '—' : severe.cum10 + '%') +
        '，距 +100% 阈值还需 ' + (severe.need10 === null ? '—' : severe.need10) + ' 个涨停（近似口径）'
    });
    if (trade.level !== 'low') badges.push({
      kind: 'trade', level: trade.level, label: '交易风险 · ' + trade.levelLabel,
      title: trade.flags.slice(0, 4).map(f => f.tag).join('、') || '多项量价风险'
    });
    byCode[code] = {
      code, name: row.name, severe, trade, badges,
      annCount: (annByCode.get(code) || []).length,
      riskLevel: trade.level === 'high' ? 'high' : (trade.level === 'medium' ? 'medium' : (severe.level === 'triggered' || severe.level === 'imminent' ? 'high' : 'low'))
    };
    counts[severe.level] = (counts[severe.level] || 0) + 1;
    counts['trade' + trade.level.charAt(0).toUpperCase() + trade.level.slice(1)]++;
  }
  const klineCodes = Object.keys(klines || {});
  return {
    byCode,
    summary: {
      ...counts, total: rows.length,
      flagged: rows.filter(r => byCode[String(r.code)] && byCode[String(r.code)].badges.length > 0).length,
      klineOk: klineCodes.filter(c => klines[c] && (klines[c].rows || []).length >= 4).length,
      klineTotal: klineCodes.length,
      annItems: (annItems || []).length,
      klineSources: [...new Set(klineCodes.map(c => klines[c] && klines[c].source).filter(Boolean))]
    },
    methodology: DRAGON_RISK_METHOD,
    metaNote: '严重异动预测输入：腾讯前复权日K（WAF 限流时降级新浪不复权）；交易风险公告输入：东方财富公告接口按 codes 精确关联。'
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

/* ═══════════ 明日龙头 · 历史回放（逐日重放当日分析 + 事后晋级验证） ═══════════ */
/**
 * 用历史某日的涨停 / 炸板池，按与实时完全相同的 dragonGame 规则重放「那一天的明日龙头分析」，
 * 再用下一交易日的真实涨停池验证当日龙头是否晋级。严格无未来函数：
 *   · 当日分析只吃 byDate[date]（当日池）与 dates 中更早的交易日（题材扩散 / 梯队演变），
 *     实时快照 quotes 传空、指数传空、概念映射传空——故「昨日连板今日溢价」为 null，情绪温度该项按中性计。
 *   · 「次日晋级」是事后验证字段，单独挂在 outcome 顶级，绝不回填进当日 sentiment / list / focus。
 * options.date 必填（YYYYMMDD）；options.limit/role/showAll 等透传给 dragonGame。
 */
const DRAGON_REVIEW_METHOD = {
  title: '历史回放 · 口径与边界',
  rules: [
    { name: '① 回放的是什么', text: '选一个历史交易日 D，用与「明日龙头」实时版完全相同的规则，重放「站在 D 日收盘时」看到的情绪温度、连板梯队、题材强度、龙头候选与明日核心变量。它回答的是「那天收盘如果按这套规则看，会选出谁」，不是重算收益。' },
    { name: '② 无未来函数', text: '当日分析的输入只有 D 日涨停 / 炸板池与 D 日之前的历史池；不读取 D 日之后的任何池数据。实时溢价快照、实时指数、当日概念成分映射在历史回放中不可用，一律传空并按中性处理，页面明确标注。' },
    { name: '③ 一项降级', text: '「昨日连板今日溢价」依赖个股当日实时 / 收盘快照，历史池不提供历史日个股涨跌幅，故该项在回放中为「—」，情绪温度按中性 50 计。因此回放温度与当日实时版可能有差异，两者不直接可比。' },
    { name: '④ 次日晋级是事后验证', text: '页面下方的「次日兑现」是 D 日龙头在下一交易日的真实连板结果，仅用于复盘当日判断质量；它不参与、也不改写当日评分、情绪与候选。晋级指下一交易日仍涨停且连板数增加，不含收益、滑点与能否成交。' },
    { name: '⑤ 样本与边界', text: '历史池由公开接口回溯约 15 个交易日，交易日以请求 date 为准；无当前 D 日之后的交易数据时，「次日兑现」显示为「尚无后续数据」。同一标的跨日重复出现，样本不独立，小样本不具统计显著性。' },
    { name: '⑥ 次日涨跌幅口径', text: '次日涨跌幅取真实历史日K：收盘 / 开盘 / 最高 / 最低涨幅均以「回放日收盘价」为基准计算，负值表示下跌（页面涨红跌绿）。它与「晋级率」是两个不同维度：晋级只看是否继续涨停，涨跌幅看价格兑现幅度。一字 / 秒板往往买不进，涨幅不等于可交易收益；日K为前复权或不复权（页面标注来源），相邻两日比值不受复权基准影响，但期间除权除息仍可能造成偏差。' }
  ],
  note: '历史回放是量化规则的复盘工具，不是收益回测，也不构成投资建议。所有涨幅、连板、封单数据来自公开涨停池；题材与评分为量价结构机械推导。'
};

function dragonReview(history, options) {
  const opt = options || {};
  const dates = ((history && history.dates) || []).slice();       // 降序：[最新, ..., 最早]
  const byDate = (history && history.byDate) || {};
  const target = String(opt.date || '').replace(/\D/g, '');
  const idx = dates.findIndex(d => String(d.date).replace(/\D/g, '') === target);
  if (idx < 0) {
    return { error: '所选交易日不在可回溯范围内', availableDates: dates.map(d => ({ date: String(d.date), zt: d.zt, zb: d.zb })) };
  }
  const date = String(dates[idx].date);
  const day = byDate[date] || { zt: [], zb: [] };
  const zt = day.zt || [], zb = day.zb || [];
  // 常规回放默认最多 60 只候选；长周期统计可通过 maxCandidates 放宽到全池
  const maxCandidates = Math.min(200, Math.max(1, Number(opt.maxCandidates) || 60));

  // 当日分析：截断历史到 [D, D 之前...]，保证不含未来数据
  const slicedHistory = { dates: dates.slice(idx), byDate, note: (history && history.note) || '' };
  const pools = { zt, zb, dt: [], date };                        // 历史池无跌停明细，dt 传空
  const game = dragonGame({
    pools, history: slicedHistory, quotes: {}, indices: [],
    options: {
      ...opt,
      showAll: opt.showAll === undefined ? '1' : opt.showAll,    // 回放默认全池，便于回看所有候选
      limit: Math.min(maxCandidates, Math.max(1, Number(opt.limit) || maxCandidates))
    },
    conceptMap: {}                                               // 概念成分映射为当日快照，历史回放不接
  });

  // 事后验证：D 的下一交易日 = 降序数组中 D 的前一项（索引 idx-1）
  const nextDate = idx > 0 ? String(dates[idx - 1].date) : null;
  const nextDay = nextDate && byDate[nextDate] ? byDate[nextDate] : null;
  const nextZt = nextDay ? (nextDay.zt || []) : [];
  const nextMap = new Map(nextZt.map(x => [x.code, Number(x.boards) || 1]));
  const nextBrokenSet = new Set((nextDay && nextDay.zb || []).map(x => x.code));

  const leaderCodes = new Set((game.list || []).map(x => x.code));
  const outcome = [];
  (game.list || []).forEach(x => {
    const nb = nextMap.get(x.code);
    const curB = Number(x.boards) || 1;
    const promoted = nb !== undefined && nb > curB;
    const stillZt = nb !== undefined;
    const brokenNext = nextBrokenSet.has(x.code);
    outcome.push({
      code: x.code, name: x.name, role: x.role, dtype: x.dtype,
      boards: curB, score: x.score, theme: x.theme && x.theme.industry,
      nextDate, nextBoards: nb === undefined ? null : nb,
      result: !nextDay ? 'pending' : (promoted ? 'promoted' : (stillZt ? 'held' : (brokenNext ? 'broken' : 'dropped'))),
      resultLabel: !nextDay ? '尚无后续数据' : (promoted ? '晋级' : (stillZt ? '连板数持平' : (brokenNext ? '炸板' : '未再涨停')))
    });
  });
  const counted = outcome.filter(o => o.result !== 'pending');
  const promotedN = counted.filter(o => o.result === 'promoted').length;
  const heldN = counted.filter(o => o.result === 'held').length;
  const outcomeSummary = {
    date, nextDate,
    hasNext: !!nextDay,
    candidates: outcome.length,
    counted: counted.length,
    promoted: promotedN,
    held: heldN,
    promoteRate: counted.length ? r1(promotedN / counted.length * 100) : null,
    surviveRate: counted.length ? r1((promotedN + heldN) / counted.length * 100) : null
  };
  const byDtype = {};
  counted.forEach(o => {
    const k = o.dtype || '未分类';
    if (!byDtype[k]) byDtype[k] = { n: 0, promoted: 0 };
    byDtype[k].n++;
    if (o.result === 'promoted') byDtype[k].promoted++;
  });
  outcomeSummary.byDtype = Object.entries(byDtype).map(([k, v]) => ({ dtype: k, n: v.n, promoted: v.promoted, rate: r1(v.promoted / v.n * 100) }))
    .sort((a, b) => b.n - a.n);

  return {
    ...game,
    review: {
      date, nextDate,
      isReview: true,
      availableDates: dates.map(d => ({ date: String(d.date), zt: d.zt, zb: d.zb })),
      outcome, summary: outcomeSummary,
      leaderCodes: [...leaderCodes],
      caveat: '当日分析无未来函数；「次日兑现」为事后验证，不参与当日评分。历史回放无实时溢价快照 / 指数 / 概念映射，「昨日连板今日溢价」按中性计。'
    },
    methodology: DRAGON_REVIEW_METHOD,
    metaNote: '历史回放 ' + date + '：东方财富涨停 / 炸板池（当日 + 更早历史池，无未来数据）；次日兑现取 ' + (nextDate || '—') + ' 真实涨停 / 炸板池。'
  };
}

/* ─────────── 历史回放 · 次日涨跌幅（真实日K事后验证，不进入当日评分） ─────────── */
/**
 * 把真实历史日K算出的「次日价格表现」挂到 dragonReview 结果的 outcome 上。
 * 纯函数：不修改入参，返回新对象。klines 形如 { code: { rows, source, adjusted } }。
 * 所有涨跌幅均以回放日收盘为基准，属于事后验证字段，绝不回填进当日 sentiment / list / focus。
 */
function attachReviewPerf(reviewResult, klines) {
  const src = reviewResult || {};
  const rv = src.review;
  if (!rv || !Array.isArray(rv.outcome)) return src;
  const km = klines || {};
  const dash = s => {
    const x = String(s == null ? '' : s).replace(/\D/g, '');
    return x.length === 8 ? x.slice(0, 4) + '-' + x.slice(4, 6) + '-' + x.slice(6, 8) : '';
  };
  const r2 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(2);
  const pctOf = (v, base) => (Number.isFinite(v) && Number.isFinite(base) && base > 0) ? +((v / base - 1) * 100).toFixed(2) : null;
  const d0 = dash(rv.date), d1 = dash(rv.nextDate);

  const outcome = rv.outcome.map(o => {
    const k = km[o.code] || km[String(o.code)] || null;
    const rows = (k && Array.isArray(k.rows)) ? k.rows : [];
    const pos = new Map(rows.map((r, i) => [String(r && r.date || '').slice(0, 10), i]));
    const i0 = pos.get(d0), i1 = d1 ? pos.get(d1) : -1;
    const p0 = i0 >= 0 ? rows[i0] : null, p1 = i1 >= 0 ? rows[i1] : null;
    const source = (k && k.source) || null, adjusted = k ? !!k.adjusted : null;
    if (!p0 || !p1) {
      const reason = !rv.nextDate ? '尚无下一交易日' : (!rows.length ? '日K不可用' : (!p0 ? '日K缺少回放日数据' : '日K缺少次日数据（可能停牌）'));
      return { ...o, perf: { available: false, reason, source, adjusted } };
    }
    const base = Number(p0.close);
    const open = Number(p1.open), high = Number(p1.high), low = Number(p1.low), close = Number(p1.close);
    return {
      ...o,
      perf: {
        available: true, date: d0, nextDate: d1,
        prevClose: r2(base), open: r2(open), high: r2(high), low: r2(low), close: r2(close),
        closePct: pctOf(close, base), openPct: pctOf(open, base),
        highPct: pctOf(high, base), lowPct: pctOf(low, base),
        ampPct: (Number.isFinite(high) && Number.isFinite(low) && base > 0) ? r2((high - low) / base * 100) : null,
        source, adjusted
      }
    };
  });

  const valid = outcome.filter(o => o.perf && o.perf.available && Number.isFinite(o.perf.closePct));
  const col = key => valid.map(o => o.perf[key]).filter(Number.isFinite);
  const avg = a => a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null;
  const med = a => {
    if (!a.length) return null;
    const b = a.slice().sort((x, y) => x - y), m = b.length >> 1;
    return r2(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2);
  };
  const closes = col('closePct');
  const pick = cmp => {
    if (!valid.length) return null;
    return valid.reduce((best, o) => (best === null || cmp(o.perf.closePct, best.perf.closePct)) ? o : best, null);
  };
  const bestRow = pick((a, b) => a > b), worstRow = pick((a, b) => a < b);
  const perfSummary = {
    total: outcome.length, available: valid.length,
    coverage: outcome.length ? r2(valid.length / outcome.length * 100) : null,
    avgClosePct: avg(closes), medianClosePct: med(closes),
    avgOpenPct: avg(col('openPct')), avgHighPct: avg(col('highPct')), avgLowPct: avg(col('lowPct')),
    winRate: closes.length ? r2(closes.filter(v => v > 0).length / closes.length * 100) : null,
    best: bestRow && { code: bestRow.code, name: bestRow.name, closePct: bestRow.perf.closePct },
    worst: worstRow && { code: worstRow.code, name: worstRow.name, closePct: worstRow.perf.closePct },
    sources: [...new Set(valid.map(o => o.perf.source).filter(Boolean))],
    adjustedModes: [...new Set(valid.map(o => o.perf.adjusted))],
    note: '次日涨跌幅 =（次日收盘 / 回放日收盘 − 1）；开盘 / 最高 / 最低涨幅同理，均以回放日收盘为基准。来自真实日K，仅作事后验证，不进入当日评分。'
  };
  const byDtype = ((rv.summary && rv.summary.byDtype) || []).map(b => {
    const cs = valid.filter(o => (o.dtype || '未分类') === b.dtype).map(o => o.perf.closePct).filter(Number.isFinite);
    return {
      ...b, perfN: cs.length, avgClosePct: avg(cs),
      winRate: cs.length ? r2(cs.filter(v => v > 0).length / cs.length * 100) : null
    };
  });

  return {
    ...src,
    review: {
      ...rv, outcome,
      summary: { ...(rv.summary || {}), perf: perfSummary, byDtype },
      caveat: (rv.caveat || '') + ' 次日涨跌幅取真实日K（收盘 / 开盘 / 最高 / 最低，均以回放日收盘为基准），属事后验证，不参与当日评分；一字 / 秒板往往买不进，涨幅不等于可交易收益。'
    },
    methodology: {
      ...(src.methodology || {}),
      rules: (src.methodology && src.methodology.rules || []).concat(
        (src.methodology && src.methodology.rules || []).some(r => r.name === '⑥ 次日涨跌幅口径') ? [] :
        [{ name: '⑥ 次日涨跌幅口径', text: '真实日K计算次日收盘 / 开盘 / 最高 / 最低相对回放日收盘的涨跌幅（涨红跌绿）。晋级率看是否继续涨停，涨跌幅看价格兑现幅度，两者不可互替。买入价与能否成交不由收盘价决定，一字 / 秒板涨幅不等于可交易收益；日K复权口径在页面标注，相邻两日比值不受复权基准影响，但除权除息仍可能带来偏差。' }]
      )
    },
    metaNote: (src.metaNote || '') + (perfSummary.sources.length ? ' 次日涨跌幅来自真实日K（' + perfSummary.sources.join(' / ') + '，' + (perfSummary.adjustedModes.every(Boolean) ? '前复权' : perfSummary.adjustedModes.some(Boolean) ? '复权口径混用' : '不复权') + '）。' : ' 次日涨跌幅暂不可用。')
  };
}

/* ─────────── 消息面监控：公告 / 快讯的实时归类与个股关联预警 ─────────── */
/**
 * 输入全部是 datasource 拉到的真实上游条目。本层只做「关键词机械归类 + 精确/字面关联」，
 * 不做语义理解、不生成消息内容、不预测股价；每条结论都带命中词与依据，可点原文核实。
 * 归类顺序：高危利空 > 一般利空 > 利多 > 中性（风险优先，利多词不抵消风险词）。
 */
const NEWS_LEXICON = [
  { group: '监管与合规风险', tone: 'bear', severity: 'high', words: ['立案调查', '被立案', '立案', '行政处罚', '处罚决定', '监管函', '警示函', '问询函', '关注函', '通报批评', '纪律处分', '涉嫌违规', '涉嫌', '违规担保', '冻结', '被执行', '失信'] },
  { group: '交易异动与澄清', tone: 'bear', severity: 'high', words: ['股票交易异常波动', '异常波动公告', '异常波动', '停牌核查', '风险提示公告', '风险提示', '澄清公告', '澄清', '媒体报道', '否认', '无应披露而未披露', '终止重大资产重组', '终止重大重组', '终止筹划', '终止发行股份购买资产', '终止收购', '终止重组', '终止上市', '解除协议', '未达成一致', '拟终止'] },
  { group: '减持解禁与质押', tone: 'bear', severity: 'high', words: ['减持计划', '拟减持', '清仓式减持', '减持', '解禁', '限售股上市流通', '股份质押', '平仓风险', '被动减持', '大宗交易减持'] },
  { group: '经营与业绩风险', tone: 'bear', severity: 'high', words: ['业绩预亏', '预亏', '由盈转亏', '亏损', '退市风险', '退市', '债务逾期', '诉讼', '仲裁', '计提减值', '商誉减值', '停产', '减产', '召回', '下调评级'] },
  { group: '一般偏空', tone: 'bear', severity: 'normal', words: ['净利润下降', '同比下降', '业绩下滑', '低于预期', '延期回复', '暂缓', '中止', '撤回', '终止', '降价'] },
  { group: '订单业绩与资本运作', tone: 'bull', severity: 'normal', words: ['中标', '重大合同', '签订合同', '重大订单', '框架协议', '战略合作', '合作协议', '业绩预增', '预增', '扭亏为盈', '扭亏', '净利润增长', '增持计划', '增持', '回购', '员工持股', '股权激励', '分红', '派息', '获批', '注册生效', '取得批复', '专利', '新产品', '量产', '投产', '提价', '涨价', '收购', '资产注入', '控制权变更'] }
];

const NEWS_TONE_LABEL = { bull: '利多', bear: '利空', neutral: '中性' };

function classifyNews(item) {
  const title = String(item.title || '');
  const cols = (item.columns || []).join(' ');
  const body = String(item.text || '');
  // 快讯正文很长且常含「同比增长 / 下降」等泛化表述，只取标题 + 摘要前 120 字，
  // 公告则用标题 + 公告分类 + 正文前 200 字，避免把宏观新闻机械标成个股利多/利空。
  const text = item.kind === 'announcement'
    ? [title, cols, body.slice(0, 200)].join(' ')
    : [title, body.slice(0, 120), cols].join(' ');
  const hits = [];
  for (const g of NEWS_LEXICON) {
    const words = g.words.filter(w => text.indexOf(w) >= 0);
    if (words.length) hits.push({ group: g.group, tone: g.tone, severity: g.severity, words });
  }
  const high = hits.find(h => h.tone === 'bear' && h.severity === 'high');
  const bear = hits.find(h => h.tone === 'bear');
  const bull = hits.find(h => h.tone === 'bull');
  const picked = high || bear || bull || null;
  const tone = picked ? picked.tone : 'neutral';
  const severity = picked ? picked.severity : 'normal';
  let basis = picked
    ? '命中「' + picked.group + '」关键词：' + picked.words.join('、') + '，按规则归为' + NEWS_TONE_LABEL[tone] + (severity === 'high' ? '（高危）' : '')
    : '未命中预设利多 / 利空关键词，归为中性；需阅读原文自行判断';
  if (picked && picked.tone === 'bear' && bull)
    basis += '；同时命中利多词「' + bull.words.join('、') + '」，按风险优先原则不抵消';
  basis += '。关键词机械匹配，非语义理解，也不代表事件已被证实或已兑现。';
  return { tone, toneLabel: NEWS_TONE_LABEL[tone], severity, hits, basis };
}

/** 关联方式：公告 codes / 快讯 ext.stocks 为精确匹配，名称出现在标题正文为字面匹配（可能误匹配） */
function matchNewsCandidates(item, candidates) {
  const byCode = new Map(candidates.map(c => [String(c.code), c]));
  const out = [];
  const exactMethod = item.kind === 'announcement' ? '公告 codes 精确匹配' : '快讯 ext.stocks 精确匹配';
  for (const c of (item.codes || [])) {
    const cand = byCode.get(String(c.code));
    if (cand) out.push({
      code: String(c.code), name: cand.name || c.name || '', method: exactMethod, confidence: '精确'
    });
  }
  const text = [item.title, String(item.text || '').slice(0, 300)].join(' ');
  for (const c of candidates) {
    const nm = String(c.name || '');
    if (!nm || nm.length < 2 || out.some(o => o.code === String(c.code))) continue;
    if (text.indexOf(nm) >= 0) out.push({
      code: String(c.code), name: nm, method: '名称字面匹配', confidence: '字面（可能误匹配）'
    });
  }
  return out;
}

/** 条件化影响：把消息放进龙头博弈框架，而不是只贴利好/利空标签 */
function newsImpact(item) {
  const notes = [];
  const byCode = new Map((item.matched || []).map(m => [m.code, m]));
  for (const c of (item.leaderCandidates || []).slice(0, 2)) {
    const m = byCode.get(String(c.code));
    if (!m) continue;
    const who = c.name + '（' + c.code + '，' + (c.boardLabel || (c.boards + ' 板')) + '，' + (c.role || '候选') + '）';
    if (item.tone === 'bear') {
      if (c.dtype === '良性分歧')
        notes.push(who + ' 正处于「良性分歧→次日弱转强」观察状态，出现' + item.toneLabel + '类消息属于该剧本的证伪信号；按纪律应放弃剧本，而不是把消息当成低吸理由。');
      else if (c.role === '空间板')
        notes.push(who + ' 是全场空间板，风险类消息容易放大情绪负反馈，需同步观察梯队是否出现断层。');
      else
        notes.push(who + ' 命中风险类消息，先核实公告原文的事实与金额，再决定是否保留在观察清单；本系统不据此改变量价评分。');
    } else if (item.tone === 'bull') {
      if (c.dtype === '一致加速')
        notes.push(who + ' 处于「一致加速」阶段，按「卖在一致」更应关注利好兑现风险；一字/缩量加速时利好常被盘面提前定价，不构成追高理由。');
      else
        notes.push(who + ' 出现潜在催化，但仍需次日盘面弱转强与板块承接确认；单一消息不单独构成买入依据。');
    }
    if (m.confidence !== '精确')
      notes.push('该条与 ' + c.name + ' 为「名称字面匹配」，可能误匹配同名词语，务必核对原文。');
  }
  if (item.kind === 'announcement' && /异常波动|澄清|风险提示/.test(item.title + (item.columns || []).join('')))
    notes.push('异动 / 澄清类公告常包含「不存在应披露而未披露信息」表述，对高位连板更多是情绪降温信号，不等同于基本面利空，也不代表一定下跌。');
  notes.push('以上为规则生成的条件化观察，不是买卖建议；消息可能已被盘面提前定价，最终以交易所公告原文与次日盘面为准。');
  return notes;
}

const NEWS_METHOD = {
  title: '消息面实时监控口径',
  rules: [
    { name: '① 数据来源', text: '交易所公告来自东方财富公告接口（上市公司公告的转载，含标题、披露时间、公告分类、精确股票代码与原文链接）；快讯来自新浪财经 7×24（部分带精确关联个股代码与原文链接）与东方财富财经快讯（政策 / 宏观 / 行业，无个股字段）。三者均为免费公开接口轮询，不是交易所官方推送。' },
    { name: '② 归类规则', text: '按六组关键词词典机械匹配：监管与合规风险 / 交易异动与澄清 / 减持解禁与质押 / 经营与业绩风险（以上为高危利空）、一般偏空、订单业绩与资本运作（利多）。命中顺序为「高危利空 > 一般利空 > 利多 > 中性」，利多词不抵消风险词；每条都列出命中词与归类依据。公告匹配标题 + 公告分类 + 正文前 200 字，快讯只匹配标题 + 摘要前 120 字（长正文里的「同比增长 / 下降」等泛化表述不参与判定）。市场面消息单独标注，不计入个股倾向统计。' },
    { name: '③ 关联方式', text: '公告 codes 与快讯 ext.stocks 为精确代码匹配（标注「精确」）；标题 / 正文出现候选股全称时为名称字面匹配（标注「字面，可能误匹配」）。市场 / 政策类快讯不做个股关联，仅作为消息流展示，不进入个股预警。' },
    { name: '④ 预警分级', text: '事件级：命中龙头的高危利空、显著利多进入预警区；盘中按轮询间隔（15 / 30 / 60 秒）刷新，服务端记录首次发现时间并标记「新增」。消息面不参与龙头评分，也不改写一致度 / 分歧度与明日剧本。' },
    { name: '⑤ 影响解读', text: '按「买在分歧卖在一致」给条件化提示：良性分歧遇风险消息 = 剧本证伪信号；一致加速遇利好 = 兑现风险；空间板风险消息 = 情绪负反馈放大。异动 / 澄清公告常含「无应披露信息」，是情绪降温而非基本面结论。' },
    { name: '⑥ 时效口径', text: '所有时间按北京时间解析并标注原始时间字符串；默认展示近 48 小时（可切 6 / 24 / 48 / 72 / 168 小时）。非交易日仍可能有公告与资讯。公告本身存在披露时点差异，轮询频率不等于消息发生时刻。' },
    { name: '⑦ 来源质量', text: '交易所公告为一手信息（本系统经东方财富转载，重要决策请点原文 / PDF 核对）；7×24 快讯与财经资讯为媒体二次来源，须核实原文，可能与公告存在时点或表述差异。不同来源可能重复报道同一事件，本系统只按条目 ID 去重。' },
    { name: '⑧ 能力边界', text: '未接入龙虎榜席位、交易所官方推送、公告全文语义解析与大模型判断；无法识别反讽、否定、条件句与「利空出尽」。利多 / 利空标签只是关键词规则的结果，不是对事件性质的认定，更不是收益预测。' }
  ],
  caveat: '消息面监控是对公开信息的规则化整理，不是投资建议。公告与快讯可能滞后、被修订或存在误匹配；关键词归类无法替代阅读原文。任何决策请以上市公司在交易所披露的公告原文为准，并结合个人风险承受能力独立判断。'
};

/** 纯函数：把上游公告 / 快讯整理为可展示、可追溯、可预警的消息流 */
function newsMonitor({ ann, flash, candidates = [], windowHours = 48, now } = {}) {
  const annItems = Array.isArray(ann) ? ann : ((ann && ann.items) || []);
  const flashItems = Array.isArray(flash) ? flash : ((flash && flash.items) || []);
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const hours = Math.max(1, Math.min(336, Number(windowHours) || 48));
  const cutoff = nowMs - hours * 3600000;
  const seen = new Set();
  const items = [];

  for (const raw of [...annItems, ...flashItems]) {
    if (!raw || !raw.id || !raw.title || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const t = raw.time ? Date.parse(raw.time) : NaN;
    if (!Number.isFinite(t) || t < cutoff || t > nowMs + 3600000) continue;
    const cls = classifyNews(raw);
    const matched = matchNewsCandidates(raw, candidates);
    const candByCode = new Map(candidates.map(c => [String(c.code), c]));
    const leaderCandidates = matched.filter(m => m.confidence === '精确')
      .map(m => candByCode.get(m.code)).filter(Boolean);
    const item = {
      ...raw,
      ...cls,
      scope: raw.kind === 'announcement' ? '个股公告'
        : ((raw.codes || []).length ? '个股快讯' : '市场 / 政策面'),
      matched,
      leaderCandidates: leaderCandidates.map(c => ({
        code: c.code, name: c.name, boards: c.boards, boardLabel: c.boardLabel,
        role: c.role, dtype: c.dtype, isLeader: !!c.isLeader
      })),
      isLeader: leaderCandidates.length > 0,
      exactMatch: matched.some(m => m.confidence === '精确'),
      firstSeenAt: null, isNew: false
    };
    item.impact = newsImpact(item);
    items.push(item);
  }

  items.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const byTone = { bull: 0, bear: 0, neutral: 0 };
  const byToneLeader = { bull: 0, bear: 0, neutral: 0 };
  const byKind = {};
  const leaderCodes = new Set();
  let highRisk = 0, leaderHits = 0;
  for (const x of items) {
    byTone[x.tone] = (byTone[x.tone] || 0) + 1;
    if (x.isLeader) byToneLeader[x.tone] = (byToneLeader[x.tone] || 0) + 1;
    byKind[x.kind] = (byKind[x.kind] || 0) + 1;
    if (x.severity === 'high' && x.tone === 'bear') highRisk++;
    if (x.isLeader) {
      leaderHits++;
      x.leaderCandidates.forEach(c => leaderCodes.add(c.code));
    }
  }
  const alerts = items.filter(x => x.isLeader && (x.tone === 'bear' || x.tone === 'bull'))
    .sort((a, b) => (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0) || String(b.time).localeCompare(String(a.time)))
    .slice(0, 30);

  return {
    items, alerts,
    summary: {
      total: items.length, byTone, byToneLeader, byKind, highRisk, leaderHits,
      leaderCodes: [...leaderCodes], leaderCount: leaderCodes.size,
      exactMatchCount: items.filter(x => x.exactMatch).length,
      marketOnlyCount: items.filter(x => !x.isLeader && !x.matched.length).length,
      newestAt: items.length ? items[0].time : null,
      windowHours: hours, candidatesCount: candidates.length
    },
    methodology: NEWS_METHOD,
    generatedAt: new Date(nowMs).toISOString()
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

/* ─────────── 昨日连板天梯 · 今日晋级情况（已发生事实，不是买入信号） ─────────── */
/**
 * 用「上一交易日涨停池的连板股」∩「今日涨停池 + 今日实时快照」统计晋级：
 * 晋级＝今日仍在涨停池且连板数高于昨日；回封＝今日涨停但连板数未增加；
 * 断板＝今日未涨停（按今日涨跌幅分收红 / 收绿 / 跌停）。
 * 只用已经发生的行情，不预测、不给出可交易指令。
 */
function prevLadderProgress(history, pools, quotes) {
  const dates = ((history && history.dates) || []).map(d => d && (d.date || d));
  const byDate = (history && history.byDate) || {};
  if (dates.length < 2) {
    return { available: false, reason: '历史涨停池不足 2 个交易日，无法回溯昨日连板表现' };
  }
  const prevDate = dates[0] > dates[1] ? dates[1] : dates[0];
  const currDate = dates[0] > dates[1] ? dates[0] : dates[1];
  const prevRows = (((byDate[prevDate] || {}).zt) || []).filter(x => x && x.code && (Number(x.boards) || 1) >= 2);
  if (!prevRows.length) {
    return { available: true, prevDate, currDate, total: 0, tiers: [], summary: {}, reason: '上一交易日没有连板（≥2 板）标的' };
  }
  const todayMap = new Map(((pools && pools.zt) || []).map(x => [x.code, x]));
  const cut = code => (/^(300|301|688|689)/.test(String(code)) ? 19.5 : (/^(8|4|920)/.test(String(code)) ? 29.5 : 9.7));
  const tierMap = new Map();
  const all = [];
  prevRows.forEach(x => {
    const prevB = Number(x.boards) || 1;
    const q = (quotes || {})[x.code] || {};
    const t = todayMap.get(x.code);
    const pct = (q.pct !== null && q.pct !== undefined) ? Number(q.pct) : null;
    let status, cls, currB = null;
    if (t && (Number(t.boards) || 1) > prevB) { status = '晋级'; cls = 'up'; currB = Number(t.boards) || 1; }
    else if (t) { status = '回封'; cls = 'warn'; currB = Number(t.boards) || 1; }
    else if (pct !== null && pct <= -cut(x.code) + 0.3) { status = '跌停'; cls = 'down'; }
    else if (pct !== null && pct > 0) { status = '断板收红'; cls = 'flat'; }
    else { status = '断板收绿'; cls = 'down'; }
    const row = {
      code: x.code, name: x.name || (q.name || x.code), industry: x.industry || q.industry || '—',
      prevBoards: prevB, currBoards: currB, pct, status, cls,
      sealRatio: t ? (Number(t.sealFundRatio) || 0) : null,
      firstSeal: t ? (t.firstSeal || null) : null
    };
    if (!tierMap.has(prevB)) tierMap.set(prevB, []);
    tierMap.get(prevB).push(row);
    all.push(row);
  });
  const tiers = [...tierMap.keys()].sort((a, b) => b - a).map(b => {
    const list = tierMap.get(b);
    const promoted = list.filter(x => x.status === '晋级').length;
    const pcts = list.map(x => x.pct).filter(v => Number.isFinite(v));
    return {
      boards: b, total: list.length, promoted,
      rate: list.length ? r1(promoted / list.length * 100) : null,
      avgPct: pcts.length ? r1(pcts.reduce((s, v) => s + v, 0) / pcts.length) : null,
      limitDown: list.filter(x => x.status === '跌停').length,
      stocks: list.slice().sort((a, c) => (c.pct === null ? -999 : c.pct) - (a.pct === null ? -999 : a.pct))
    };
  });
  const promoted = all.filter(x => x.status === '晋级').length;
  const pcts = all.map(x => x.pct).filter(v => Number.isFinite(v));
  const summary = {
    total: all.length, promoted,
    rate: all.length ? r1(promoted / all.length * 100) : null,
    relimit: all.filter(x => x.status === '回封').length,
    up: all.filter(x => x.status === '断板收红').length,
    down: all.filter(x => x.status === '断板收绿').length,
    limitDown: all.filter(x => x.status === '跌停').length,
    avgPct: pcts.length ? r1(pcts.reduce((s, v) => s + v, 0) / pcts.length) : null,
    best: pcts.length ? r1(Math.max(...pcts)) : null,
    worst: pcts.length ? r1(Math.min(...pcts)) : null
  };
  return {
    available: true, prevDate, currDate, total: all.length, tiers, summary,
    note: '已发生的晋级事实：以昨日涨停池的连板股为样本，用今日涨停池与实时快照判定结果，不涉及任何买入计划或收益预测。'
  };
}

/** 首页连板天梯用：复用明日龙头的地位 + 一致分歧规则，给涨停池个股打历史优势组合标记 */
function dragonEdgeMarks(pools, history) {
  const zt = (pools && pools.zt) || [];
  if (!zt.length) return {};
  const g = dragonGame({
    pools,
    history: history || { dates: [], byDate: {} },
    quotes: {}, indices: [], conceptMap: {},
    options: { showAll: '1', excludeST: '0', limit: Math.min(60, zt.length), sort: 'score' }
  });
  const marks = {};
  (g.list || []).forEach(r => {
    if (r.dtype !== '一致加速') return;
    if (!['空间板', '累计板龙', '题材龙'].includes(r.role)) return;
    marks[r.code] = {
      role: r.role, dtype: r.dtype, boards: r.boards,
      consensus: r.consensus, divergence: r.divergence
    };
  });
  return marks;
}

/**
 * 「历史优势组合 · 彩色边框标记」的实时概率统计。
 * 用当前可回溯窗口逐日重放「明日龙头」当日规则（dragonReview），再用下一交易日真实涨停池验证，
 * 按「地位 × 一致分歧状态」统计所有组合的次日晋级率，不再使用前端写死的历史常量。
 * 纯计算：history 由 getPoolFullHistory 提供，服务端按 10 分钟缓存，不额外请求行情。
 */
function dragonEdgeStats(history, options) {
  const opt = options || {};
  const allDates = ((history && history.dates) || []).slice();  // 降序：[最新, ..., 最早]
  const requestedDays = Math.max(1, Math.floor(Number(opt.days) || allDates.length));
  const dates = allDates.slice(0, requestedDays);               // 只统计窗口内的交易日
  const maxCandidates = Math.min(200, Math.max(1, Number(opt.maxCandidates) || 200));
  const limit = Math.min(maxCandidates, Math.max(1, Number(opt.limit) || maxCandidates));
  const minSample = Number(opt.minSample) || 8;
  const round1 = v => Math.round(v * 10) / 10;
  const bucket = () => ({ n: 0, promoted: 0, held: 0, broken: 0 });
  const combos = {}, byRole = {}, byDtype = {};
  const perDay = [];
  let totalN = 0, totalP = 0;
  const put = (map, key, o) => {
    if (!map[key]) map[key] = bucket();
    const b = map[key];
    b.n++;
    if (o.result === 'promoted') b.promoted++;
    else if (o.result === 'held') b.held++;
    else if (o.result === 'broken') b.broken++;
  };
  dates.forEach(d => {
    const date = String(d.date);
    const g = dragonReview(history, { date, days: dates.length, showAll: '1', limit, maxCandidates });
    if (g.error || !g.review) {
      perDay.push({ date, nextDate: null, counted: 0, promoted: 0, error: g.error || '回放不可用' });
      return;
    }
    const outcome = (g.review.outcome || []).filter(o => o.result !== 'pending');
    outcome.forEach(o => {
      const role = String(o.role || '未分类'), dtype = String(o.dtype || '未分类');
      put(combos, role + '|' + dtype, o);
      put(byRole, role, o);
      put(byDtype, dtype, o);
      totalN++;
      if (o.result === 'promoted') totalP++;
    });
    perDay.push({
      date, nextDate: g.review.nextDate || null,
      counted: outcome.length,
      promoted: outcome.filter(o => o.result === 'promoted').length
    });
  });
  const finish = b => ({
    n: b.n, promoted: b.promoted, held: b.held, broken: b.broken,
    rate: b.n ? round1(b.promoted / b.n * 100) : null,
    surviveRate: b.n ? round1((b.promoted + b.held) / b.n * 100) : null,
    brokenRate: b.n ? round1(b.broken / b.n * 100) : null,
    smallSample: b.n < minSample
  });
  const combosObj = {};
  Object.keys(combos).forEach(k => { combosObj[k] = finish(combos[k]); });
  const toRows = map => Object.entries(map).map(([key, b]) => ({ key, ...finish(b) })).sort((a, b) => b.n - a.n);
  return {
    available: dates.length > 0,
    generatedAt: new Date().toISOString(),
    window: {
      from: dates.length ? String(dates[dates.length - 1].date) : null,
      to: dates.length ? String(dates[0].date) : null,
      tradingDays: dates.length,
      countedDays: perDay.filter(d => d.counted > 0).length,
      requestedDays,
      source: (history && history.source) || null,
      sources: (history && history.sources) || null,
      sourceNote: (history && history.note) || null
    },
    total: { n: totalN, promoted: totalP, rate: totalN ? round1(totalP / totalN * 100) : null },
    combos: combosObj,
    byRole: toRows(byRole),
    byDtype: toRows(byDtype),
    perDay,
    marks: ['空间板|一致加速', '累计板龙|一致加速', '题材龙|一致加速'],
    minSample,
    method: '逐日重放「明日龙头」当日规则（dragonReview，showAll=1、最多 ' + limit +
      ' 只候选），用下一交易日真实涨停池验证；晋级 = 次日仍涨停且连板数增加；分母排除尚无次日数据的样本。',
    note: '样本来自公开涨停池 ' + dates.length + ' 个交易日' +
      ((history && history.sources && history.sources.thsDays > 0)
        ? '（近 ' + history.sources.emDays + ' 日东方财富原始口径 + 更早 ' + history.sources.thsDays + ' 日同花顺回补）' : '') +
      '，同一标的跨日重复计入、样本不独立；晋级率不等于收益率或可交易胜率，一字 / 秒板往往买不进。' +
      '彩色边框只是复盘识别标记，不构成买卖信号。' + ((history && history.note) ? ' 数据口径：' + history.note : '')
  };
}

/* ═══════════════ 支撑位反转：回调 + 主力资金首次翻红 + 十字星/小阳线 ═══════════════ */
/**
 * 回答「回调到支撑附近、主力资金由净流出首次转为净流入、且当日收出十字星/小阳线（未涨停）的票，
 * 次日涨停概率与收益如何」。这是「支撑位低吸」的可量化版本。
 *
 * 严格无未来函数：信号只用 D 日及之前的日K与资金流；次日涨停/收益只用 D+1 真实数据。
 * DDX 为第三方专有指标，公开源取不到真实值 —— 本模块用「主力净额（东财=超大单+大单，
 * 降级新浪=超大单）由负转正首日」作为可回测的替代口径，并如实标注源，绝不伪装成真 DDX。
 *
 * 单票信号条件（D 日）：
 *  ① 回调到位：收盘距近 20 日高点回撤 ≥ minDraw%（默认 4%），且处于支撑带内（见 supportZone）
 *  ② 资金首次红：fund[D-1].main < 0 且 fund[D].main > 0，且此前 lookback 日内均为净流出或零（首次）
 *  ③ 未涨停：D 日涨幅 < 涨停阈值 - 0.5
 *  ④ K线形态：十字星（实体/全幅 ≤ 0.3）或小阳线（0 < 涨幅 ≤ smallYang%，实体为正且实体/全幅 ≤ 0.6）
 *
 * nextOutcome（D+1）：
 *  - limitUp：D+1 收盘涨幅 ≥ 涨停阈值（按该股板块）
 *  - retOpenClose = (D+1收 - D+1开)/D+1开 （次日开盘买入、收盘卖出，可实际成交、无未来函数）
 *  - retCloseClose = (D+1收 - D收)/D收 （含隔夜跳空）
 */
const SUPPORT_REVERSAL_METHOD = {
  title: '支撑位反转 · 回调后主力资金首次翻红',
  points: [
    { name: '① 为什么叫支撑位反转', text: '低吸逻辑：股价从阶段高点回调、靠近支撑（近期波段低点 / 涨停日低点 / 斐波那契回撤 / 分型密集区），同时主力资金由净流出转为净流入首日，K线收出止跌形态（十字星 / 小阳线），次日若资金延续则可能冲高。' },
    { name: '② DDX 口径（重要）', text: 'DDX / DDZ 是第三方专有算法指标，免费公开接口无法取得真实序列，系统不提供估算值。本模块用「主力净额由净流出首次转净流入」作为可回测替代：东财口径=超大单+大单，东财不可用时降级新浪口径=超大单（数值不可直接比较）。资金源见每次结果 realSource / fundCaliber 字段，绝不伪装成真 DDX。' },
    { name: '③ 信号条件（D 日，严格盘后可见）', text: '回调：收盘距近 20 日高点回撤 ≥ 阈值且落入支撑带（最近支撑位 ±3%，或距阶段高点回撤达到浅/中/深档）；资金：D-1 主力净额<0、D>0，且此前若干日为净流出；形态：十字星（实体≤全幅30%）或小阳线（涨幅 0~3%、实体≤全幅60%）；且 D 日未涨停。' },
    { name: '④ 次日验证（D+1 真实数据）', text: '次日涨停：D+1 收盘涨幅≥该股涨停阈值（主板9.6%/创业科创19.3%/北交29.3%）。收益：①次日开盘买→收盘卖=(D+1收−D+1开)/D+1开，可实际成交、不依赖涨停封单；②信号日收盘买→次日收盘卖=(D+1收−D收)/D收，含隔夜跳空。两套并列展示。' },
    { name: '⑤ 分档对比', text: '按形态（十字星/小阳线）与回调深度（浅4-8%/中8-15%/深≥15%）分层统计次日涨停率与平均收益，样本不足（<8）的档只显示计数、不显示概率，避免小样本误判。' },
    { name: '⑥ 样本率与边界', text: 'signalRate=触发信号的样本/有效样本；次日涨停率的分母为有 D+1 数据的信号样本（最新信号日无次日，计 pending）。免费源资金流为日频快照非逐笔，主力资金可由大单拆单影响；概率为历史统计，非承诺，不构成投资建议。' }
  ]
};

/** 单票在 D 日的信号判定；返回 {ok, shape, drawdown, support, ...} 或 {ok:false} */
function supportReversalSignal(kl, fund, i, opt) {
  const bar = kl[i];
  if (!bar || i < 21 || i >= kl.length - 0) return { ok: false };
  const code = bar.code || '';
  const th = limitThreshold(code);
  const prevClose = kl[i - 1].close;
  const pct = prevClose > 0 ? (bar.close - prevClose) / prevClose * 100 : 0;
  // ③ 未涨停
  if (pct >= th - 0.5) return { ok: false };
  // ① 回调到位：距近 20 日高点回撤
  const win = kl.slice(Math.max(0, i - 19), i + 1);
  const hi = Math.max(...win.map(x => x.high));
  const lo = Math.min(...win.map(x => x.low));
  const dd = hi > 0 ? (hi - bar.close) / hi * 100 : 0;
  if (dd < opt.minDraw) return { ok: false };
  // 支撑带：最近波段低点 / 涨停日低点 / 斐波那契 0.382/0.5/0.618 回撤位，取距现价最近且在现价下方的
  const fibs = [0.382, 0.5, 0.618].map(f => hi - (hi - lo) * f);
  const cands = [lo, ...fibs].filter(v => v > 0 && v <= bar.close * 1.005);
  const support = cands.length ? Math.max(...cands) : lo;
  const nearSupport = support > 0 && Math.abs(bar.close - support) / bar.close <= opt.bandPct / 100;
  const deepEnough = dd >= opt.minDraw; // 回撤足够深即视为「在支撑区附近」的宽松口径
  if (!nearSupport && !deepEnough) return { ok: false };
  // ④ K线形态：十字星 / 小阳线
  const range = bar.high - bar.low;
  const body = Math.abs(bar.close - bar.open);
  const bodyRatio = range > 0 ? body / range : 0;
  let shape = null;
  if (bodyRatio <= 0.3 && range > 0) shape = 'doji';
  else if (pct > 0 && pct <= opt.smallYang && bodyRatio <= 0.6 && bar.close >= bar.open) shape = 'smallYang';
  if (!shape) return { ok: false };
  // ② 资金首次红：D-1 < 0 且 D > 0，此前 lookback 日净流出占比高
  const fi = fund ? fund.findIndex(x => fmtD(x.date) === fmtD(bar.date)) : -1;
  if (fi < 1) return { ok: false };
  const fd = fund[fi];
  const todayMain = fd.main, yMain = fund[fi - 1].main;
  if (!(Number.isFinite(yMain) && yMain < 0 && Number.isFinite(todayMain) && todayMain > 0)) return { ok: false };
  const prior = fund.slice(Math.max(0, fi - opt.lookback), fi).map(x => x.main).filter(Number.isFinite);
  const outN = prior.filter(v => v < 0).length;
  if (prior.length >= 2 && outN < 2) return { ok: false }; // 此前必须有连续净流出，避免震荡反复翻红
  const basis = [];
  basis.push('距20日高点回撤 ' + r1(dd) + '%');
  basis.push('主力净额 ' + (yMain / 1e8).toFixed(2) + '亿→' + (todayMain / 1e8).toFixed(2) + '亿（首次翻红）');
  basis.push(shape === 'doji' ? '十字星（实体/全幅 ' + r2(bodyRatio) + '）' : '小阳线（涨 ' + r1(pct) + '%）');
  basis.push('支撑参考 ' + r2(support));
  return {
    ok: true, shape, drawdown: r1(dd), dd, pct: r1(pct), bodyRatio: r2(bodyRatio),
    support: r2(support), nearSupport, prevMain: yMain, main: todayMain,
    outDaysBefore: outN, fundDate: fd.date, basis
  };
}

/** 次日结果：D+1 涨停 + 两种收益；无 D+1 返回 pending */
function supportNextOutcome(kl, i) {
  const d = kl[i], n = kl[i + 1];
  if (!d || !n) return { pending: true };
  const th = limitThreshold(d.code || '');
  const pct = d.close > 0 ? (n.close - d.close) / d.close * 100 : 0;
  const retOC = n.open > 0 ? (n.close - n.open) / n.open * 100 : null;
  const retCC = d.close > 0 ? (n.close - d.close) / d.close * 100 : null;
  return { pending: false, date: n.date, pct: r1(pct), limitUp: pct >= th, retOC: r1(retOC), retCC: r1(retCC), nextOpen: n.open, nextClose: n.close };
}

/**
 * 支撑位反转回测 + 当日信号列表。
 * candidates: [{code,name,board,industry,klines:[{date,open,high,low,close,code}], fund:[{date,main}]}]
 * opts: { window: 回测多少交易日(默认60), minDraw: 最小回撤%(默认4), bandPct: 支撑带%(默认3),
 *         smallYang: 小阳线最大涨幅%(默认3), lookback: 资金前视日数(默认6), fundSource, fundCaliber }
 */
function supportReversalBacktest(candidates, opts = {}) {
  const opt = {
    window: Math.max(20, Math.min(120, Number(opts.window) || 60)),
    minDraw: Math.max(1, Math.min(20, Number(opts.minDraw) || 4)),
    bandPct: Math.max(0.5, Math.min(8, Number(opts.bandPct) || 3)),
    smallYang: Math.max(0.5, Math.min(6, Number(opts.smallYang) || 3)),
    lookback: Math.max(3, Math.min(12, Number(opts.lookback) || 6))
  };
  const signals = []; // 全部历史信号（含下一日结果），用于回测统计
  let scanned = 0, noFund = 0;
  (candidates || []).forEach(c => {
    const kl = (c.klines || []).slice().sort((a, b) => fmtD(a.date).localeCompare(fmtD(b.date)));
    kl.forEach(x => { x.code = x.code || c.code; });
    const fund = (c.fund || []).slice().sort((a, b) => fmtD(a.date).localeCompare(fmtD(b.date)));
    if (kl.length < 30 || fund.length < 8) return;
    scanned++;
    // 取最后 window+1 根（需 D+1），逐日判定
    const start = Math.max(21, kl.length - 1 - opt.window);
    for (let i = start; i < kl.length; i++) {
      const sig = supportReversalSignal(kl, fund, i, opt);
      if (!sig.ok) continue;
      const out = supportNextOutcome(kl, i);
      signals.push({
        code: c.code, name: c.name, board: c.board || boardOf(c.code), industry: c.industry || '',
        floatCap: c.floatCap === undefined ? null : c.floatCap,
        date: fmtD(kl[i].date), close: kl[i].close,
        shape: sig.shape, drawdown: sig.drawdown, pct: sig.pct, bodyRatio: sig.bodyRatio,
        support: sig.support, prevMain: sig.prevMain, main: sig.main, outDaysBefore: sig.outDaysBefore,
        basis: sig.basis, pending: out.pending, next: out.pending ? null : out
      });
    }
  });
  // 汇总统计
  const counted = signals.filter(s => !s.pending && s.next);
  const rateOf = arr => arr.length ? +(arr.filter(s => s.next.limitUp).length / arr.length * 100).toFixed(1) : null;
  const meanOf = (arr, key) => {
    const v = arr.map(s => s.next[key]).filter(Number.isFinite);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
  };
  const winOf = (arr, key) => {
    const v = arr.map(s => s.next[key]).filter(Number.isFinite);
    return v.length ? +(v.filter(x => x > 0).length / v.length * 100).toFixed(1) : null;
  };
  const bucket = arr => ({
    n: arr.length, pending: 0,
    limitUp: arr.filter(s => s.next.limitUp).length,
    limitRate: rateOf(arr), retOC: meanOf(arr, 'retOC'), retCC: meanOf(arr, 'retCC'),
    winOC: winOf(arr, 'retOC'), winCC: winOf(arr, 'retCC')
  });
  const ddTier = d => d >= 15 ? 'deep' : d >= 8 ? 'mid' : 'shallow';
  const byShape = {
    doji: bucket(counted.filter(s => s.shape === 'doji')),
    smallYang: bucket(counted.filter(s => s.shape === 'smallYang'))
  };
  const byDraw = {
    shallow: bucket(counted.filter(s => ddTier(s.drawdown) === 'shallow')),
    mid: bucket(counted.filter(s => ddTier(s.drawdown) === 'mid')),
    deep: bucket(counted.filter(s => ddTier(s.drawdown) === 'deep'))
  };
  const overall = bucket(counted);
  const pending = signals.filter(s => s.pending);
  // 当日信号列表：最新交易日（D 无次日）优先，按资金强度排序，带历史分层概率
  const latestDate = signals.reduce((m, s) => s.date > m ? s.date : m, '');
  const latest = signals.filter(s => s.date === latestDate);
  const shapeRate = sh => byShape[sh] && byShape[sh].n >= 8 ? byShape[sh].limitRate : overall.limitRate;
  const list = latest.map(s => ({
    code: s.code, name: s.name, board: s.board, industry: s.industry,
    floatCap: s.floatCap === undefined ? null : s.floatCap, date: s.date,
    close: s.close, shape: s.shape, shapeLabel: s.shape === 'doji' ? '十字星' : '小阳线',
    drawdown: s.drawdown, pct: s.pct, support: s.support,
    main: s.main, prevMain: s.prevMain, mainYi: +(s.main / 1e8).toFixed(2),
    basis: s.basis,
    prob: shapeRate(s.shape),
    expOC: byShape[s.shape] && byShape[s.shape].n >= 8 ? byShape[s.shape].retOC : overall.retOC,
    expCC: byShape[s.shape] && byShape[s.shape].n >= 8 ? byShape[s.shape].retCC : overall.retCC
  })).sort((a, b) => (b.main - a.main) || (a.drawdown - b.drawdown));

  return {
    method: SUPPORT_REVERSAL_METHOD, opt,
    scanned, signalCount: signals.length,
    counted: counted.length, pending: pending.length,
    overall, byShape, byDraw,
    shapes: [
      { key: 'doji', label: '十字星', ...byShape.doji },
      { key: 'smallYang', label: '小阳线', ...byShape.smallYang }
    ],
    draws: [
      { key: 'shallow', label: '浅回调 4-8%', ...byDraw.shallow },
      { key: 'mid', label: '中回调 8-15%', ...byDraw.mid },
      { key: 'deep', label: '深回调 ≥15%', ...byDraw.deep }
    ],
    list, latestDate,
    // 全量样本（按信号日倒序）交给服务端缓存并分页下发，前端不再一次性渲染全部行
    samples: signals.slice().sort((a, b) => b.date.localeCompare(a.date)),
    sampleTotal: signals.length,
    realSource: opts.fundSource || null, fundCaliber: opts.fundCaliber || null,
    klineSource: opts.klineSource || null,
    asOf: new Date().toISOString()
  };
}

/* ═══════════════ DDX首红精选：复刻东财 ddx1120 动态分组 ═══════════════ */
/**
 * 复刻东方财富 App「ddx1120」动态分组的选股口径，并做次日涨停率/收益回测。
 * 东财原分组条件：当日 DDX ≥0.01%、前一日 DDX<0（首次翻红）、实体<5%、实际换手率≥5%、
 * 股吧人气前500、非ST、未炸板。
 *
 * DDX 是第三方专有算法指标，免费公开源取不到真实序列。本模块如实用
 * 「DDX 代理 = 主力净额 / 流通市值 × 100（%）」，东财资金口径=超大单+大单资金净额，
 * 降级新浪=超大单净额；数值与真 DDX 不可直接比较，绝不冒充真 DDX。
 * 换手率：日K无换手字段，用 成交量(手)×100 / 流通股本 推算，流通股本=流通市值/收盘价。
 *
 * 信号条件（D 日，严格盘后可见）：
 *  ① DDX代理 ≥ ddxMin（默认0.01%）且 前一日 DDX代理 < 0（首次翻红）
 *  ② 实体 = |开-收|/开 ≤ bodyMax（默认5%，东财「实体小于5%」）
 *  ③ 换手率 ≥ turnMin（默认5%，东财「实际换手率≥5%」）
 *  ④ 非ST（候选池已过滤）、未炸板（D日最高价未触及涨停价）
 *  ⑤ 股吧人气前500：公开源只有实时快照、无历史序列，仅对「当日信号」标注/过滤，不进历史回测
 * nextOutcome（D+1）：涨停 + 开→收 + 收→收，与支撑位口径一致。
 */
const DDX_FIRST_RED_METHOD = {
  title: 'DDX首红精选 · 复刻东财 ddx1120',
  points: [
    { name: '① 复刻对象', text: '对齐东方财富 App 动态分组「ddx1120」：当日 DDX≥0.01%、前一日 DDX<0（资金首次翻红）、实体<5%、实际换手率≥5%、股吧人气前500、非ST、未炸板。参数均可在页面调整。' },
    { name: '② DDX 口径（重要）', text: 'DDX / DDZ 是第三方专有算法指标，免费公开接口无法取得真实序列，本模块不提供也不冒充真 DDX。用「DDX代理 = 主力净额 ÷ 流通市值 ×100（%）」作为可回测替代：东财资金口径=超大单+大单净额，东财不可用时降级新浪=超大单净额。真值请以东方财富终端为准。' },
    { name: '③ 换手率口径', text: '免费日K接口不含换手率字段，用「成交量(手)×100 ÷ 流通股本」推算，流通股本 = 流通市值 ÷ 当日收盘价，与行情软件实际换手率接近但非完全一致。' },
    { name: '④ 信号条件（D 日，盘后可见）', text: 'DDX代理当日≥阈值(默认0.01%)且前一日<0（首次翻红）；实体=|开−收|/开 ≤ 上限(默认5%)；推算换手率 ≥ 下限(默认5%)；非ST；未炸板（当日最高价未触及涨停价）。人气前500只对最新信号按实时股吧榜过滤/标注，因无历史序列不进回测，页面会明确标注。' },
    { name: '⑤ 次日验证（D+1 真实数据）', text: '次日涨停：D+1 收盘涨幅≥该股涨停阈值。收益：①次日开盘买→收盘卖=(D+1收−D+1开)/D+1开；②信号日收盘买→次日收盘卖=(D+1收−D收)/D收。分档按 DDX代理强度与换手率统计，样本<8 只显示计数不显示概率。' },
    { name: '⑥ 边界与免责', text: '免费源资金流为日频快照非逐笔，DDX 为代理口径；概率为历史统计、非承诺。换手率为推算值。所有信号仅供复盘研究，不构成投资建议。' }
  ]
};

/** 换手率推算(%)：流通股本=流通市值(元)/收盘价。腾讯日K的 volume 单位按板块不同：
 *  科创板 688/689 返回「股」，其余板块返回「手」(100股/手)，实测与行情软件真实换手率一致。 */
function ddxTurnover(bar, floatCapYi) {
  if (!bar || !Number.isFinite(bar.volume) || !Number.isFinite(floatCapYi) || floatCapYi <= 0) return null;
  const close = Number(bar.close);
  if (!Number.isFinite(close) || close <= 0) return null;
  const shares = floatCapYi * 1e8 / close;
  if (!(shares > 0)) return null;
  const code = String(bar.code || '');
  const volShares = /^(688|689)/.test(code) ? bar.volume : bar.volume * 100;
  return +(volShares / shares * 100).toFixed(2);
}

/** 单票 D 日信号判定：返回 {ok,...} 或 {ok:false} */
function ddxFirstRedSignal(kl, fund, i, opt, floatCapYi) {
  const bar = kl[i];
  if (!bar || i < 2) return { ok: false };
  const code = bar.code || '';
  const prev = kl[i - 1];
  if (!prev || !Number.isFinite(floatCapYi) || floatCapYi <= 0) return { ok: false };
  const th = limitThreshold(code);
  // 资金按日期对齐（fund 与 kl 交易日可能不完全同步，用日期精确匹配）
  const fi = fund ? fund.findIndex(x => fmtD(x.date) === fmtD(bar.date)) : -1;
  if (fi < 1) return { ok: false };
  const todayMain = fund[fi].main, yMain = fund[fi - 1].main;
  if (!(Number.isFinite(todayMain) && Number.isFinite(yMain))) return { ok: false };
  // ① DDX代理 = 主力净额 / 流通市值 ×100(%)，当日≥阈值 且 前一日<0
  const ddx = todayMain / (floatCapYi * 1e8) * 100;
  const yDdx = yMain / (floatCapYi * 1e8) * 100;
  if (!(ddx >= opt.ddxMin && yDdx < 0)) return { ok: false };
  // ② 实体 ≤ 上限
  const open = Number(bar.open), close = Number(bar.close);
  if (!(Number.isFinite(open) && open > 0 && Number.isFinite(close))) return { ok: false };
  const body = Math.abs(close - open) / open * 100;
  if (body > opt.bodyMax) return { ok: false };
  // ③ 换手率 ≥ 下限
  const turn = ddxTurnover(bar, floatCapYi);
  if (turn === null || turn < opt.turnMin) return { ok: false };
  // ④ 未炸板：当日最高价未触及涨停价（触及但收盘未封即炸板）
  const limitPrice = prev.close * (1 + th / 100);
  const touchedLimit = Number.isFinite(bar.high) && bar.high >= limitPrice * 0.998;
  if (touchedLimit) return { ok: false };
  const pct = prev.close > 0 ? (close - prev.close) / prev.close * 100 : 0;
  const basis = [
    'DDX代理 ' + r2(yDdx) + '%→' + r2(ddx) + '%（首次翻红）',
    '实体 ' + r1(body) + '%（≤' + opt.bodyMax + '%）',
    '推算换手 ' + r1(turn) + '%（≥' + opt.turnMin + '%）'
  ];
  return {
    ok: true, ddx: r2(ddx), yDdx: r2(yDdx), body: r1(body), turnover: r1(turn),
    pct: r1(pct), close, prevMain: yMain, main: todayMain, fundDate: fund[fi].date, basis
  };
}

/** 次日结果：复用支撑位同口径 */
function ddxNextOutcome(kl, i) {
  const d = kl[i], n = kl[i + 1];
  if (!d || !n) return { pending: true };
  const th = limitThreshold(d.code || '');
  const pct = d.close > 0 ? (n.close - d.close) / d.close * 100 : 0;
  const retOC = n.open > 0 ? (n.close - n.open) / n.open * 100 : null;
  const retCC = d.close > 0 ? (n.close - d.close) / d.close * 100 : null;
  return { pending: false, date: n.date, pct: r1(pct), limitUp: pct >= th, retOC: r1(retOC), retCC: r1(retCC) };
}

/**
 * DDX首红 回测 + 当日信号。
 * candidates: [{code,name,board,industry,floatCap,klines,fund}]
 * opts: {window,ddxMin,bodyMax,turnMin,lookback,fundSource,fundCaliber}
 */
function ddxFirstRedBacktest(candidates, opts = {}) {
  const opt = {
    window: Math.max(20, Math.min(120, Number(opts.window) || 60)),
    ddxMin: Math.max(0, Math.min(5, Number(opts.ddxMin) === 0 ? 0 : (Number(opts.ddxMin) || 0.01))),
    bodyMax: Math.max(0.5, Math.min(20, Number(opts.bodyMax) || 5)),
    turnMin: Math.max(0.5, Math.min(30, Number(opts.turnMin) || 5)),
    lookback: Math.max(2, Math.min(12, Number(opts.lookback) || 3))
  };
  const signals = [];
  let scanned = 0;
  (candidates || []).forEach(c => {
    const kl = (c.klines || []).slice().sort((a, b) => fmtD(a.date).localeCompare(fmtD(b.date)));
    kl.forEach(x => { x.code = x.code || c.code; });
    const fund = (c.fund || []).slice().sort((a, b) => fmtD(a.date).localeCompare(fmtD(b.date)));
    const cap = Number(c.floatCap);
    if (kl.length < 30 || fund.length < 8 || !Number.isFinite(cap) || cap <= 0) return;
    scanned++;
    const start = Math.max(2, kl.length - 1 - opt.window);
    for (let i = start; i < kl.length; i++) {
      const sig = ddxFirstRedSignal(kl, fund, i, opt, cap);
      if (!sig.ok) continue;
      const out = ddxNextOutcome(kl, i);
      signals.push({
        code: c.code, name: c.name, board: c.board || boardOf(c.code), industry: c.industry || '',
        floatCap: cap, date: fmtD(kl[i].date), close: kl[i].close,
        ddx: sig.ddx, yDdx: sig.yDdx, body: sig.body, turnover: sig.turnover, pct: sig.pct,
        prevMain: sig.prevMain, main: sig.main, basis: sig.basis,
        pending: out.pending, next: out.pending ? null : out
      });
    }
  });
  const counted = signals.filter(s => !s.pending && s.next);
  const rateOf = arr => arr.length ? +(arr.filter(s => s.next.limitUp).length / arr.length * 100).toFixed(1) : null;
  const meanOf = (arr, key) => {
    const v = arr.map(s => s.next[key]).filter(Number.isFinite);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
  };
  const winOf = (arr, key) => {
    const v = arr.map(s => s.next[key]).filter(Number.isFinite);
    return v.length ? +(v.filter(x => x > 0).length / v.length * 100).toFixed(1) : null;
  };
  const bucket = arr => ({
    n: arr.length, limitUp: arr.filter(s => s.next.limitUp).length,
    limitRate: rateOf(arr), retOC: meanOf(arr, 'retOC'), retCC: meanOf(arr, 'retCC'),
    winOC: winOf(arr, 'retOC'), winCC: winOf(arr, 'retCC')
  });
  const ddxTier = d => d >= 0.5 ? 'strong' : d >= 0.1 ? 'mid' : 'weak';
  const turnTier = t => t >= 15 ? 'high' : t >= 8 ? 'mid' : 'low';
  const byDdx = {
    weak: bucket(counted.filter(s => ddxTier(s.ddx) === 'weak')),
    mid: bucket(counted.filter(s => ddxTier(s.ddx) === 'mid')),
    strong: bucket(counted.filter(s => ddxTier(s.ddx) === 'strong'))
  };
  const byTurn = {
    low: bucket(counted.filter(s => turnTier(s.turnover) === 'low')),
    mid: bucket(counted.filter(s => turnTier(s.turnover) === 'mid')),
    high: bucket(counted.filter(s => turnTier(s.turnover) === 'high'))
  };
  const overall = bucket(counted);
  const pending = signals.filter(s => s.pending);
  const latestDate = signals.reduce((m, s) => s.date > m ? s.date : m, '');
  const latest = signals.filter(s => s.date === latestDate);
  const list = latest.map(s => ({
    code: s.code, name: s.name, board: s.board, industry: s.industry, floatCap: s.floatCap,
    date: s.date, close: s.close, ddx: s.ddx, yDdx: s.yDdx, body: s.body, turnover: s.turnover,
    pct: s.pct, main: s.main, prevMain: s.prevMain, mainYi: +(s.main / 1e8).toFixed(2), basis: s.basis,
    prob: overall.limitRate, expOC: overall.retOC, expCC: overall.retCC
  })).sort((a, b) => (b.ddx - a.ddx) || (b.turnover - a.turnover));
  return {
    method: DDX_FIRST_RED_METHOD, opt,
    scanned, signalCount: signals.length, counted: counted.length, pending: pending.length,
    overall, byDdx, byTurn,
    ddxTiers: [
      { key: 'weak', label: 'DDX 0.01–0.1%', ...byDdx.weak },
      { key: 'mid', label: 'DDX 0.1–0.5%', ...byDdx.mid },
      { key: 'strong', label: 'DDX ≥0.5%', ...byDdx.strong }
    ],
    turnTiers: [
      { key: 'low', label: '换手 5–8%', ...byTurn.low },
      { key: 'mid', label: '换手 8–15%', ...byTurn.mid },
      { key: 'high', label: '换手 ≥15%', ...byTurn.high }
    ],
    list, latestDate,
    samples: signals.slice().sort((a, b) => b.date.localeCompare(a.date)),
    sampleTotal: signals.length,
    realSource: opts.fundSource || null, fundCaliber: opts.fundCaliber || null,
    klineSource: opts.klineSource || null,
    asOf: new Date().toISOString()
  };
}

/* ─────────── 首板龙头种子：历史回测 + 当日标记 ─────────── */
/**
 * 回答「连板天梯首板层里，哪些是藏着的未来龙头」。
 * 严格无未来函数：特征只取 D 日涨停池当日可见字段；晋级 / 成龙只用 D+1、D+2 真实池事后验证。
 *  - 晋级：D 日首板 → D+1 仍在涨停池且连板数 ≥2（1 进 2）
 *  - 成龙：D+1 或 D+2 连板数 ≥3（首板后两日内走成 3 板以上）
 * history 为 getPoolFullHistory 的 { dates 降序, byDate }；pools 为当日实时池，用于生成 marks。
 */
const SEED_METHOD = {
  title: '首板龙头种子 · 回测口径与边界',
  rules: [
    { name: '① 样本', text: '取最近可回溯交易日中，当日连板数为 1 的非 ST 涨停股。每个交易日独立取样，同一标的跨日重复出现，样本不独立。' },
    { name: '② 当日可见特征', text: '只使用 D 日涨停池已有字段：首封时间、炸板次数、封单额/流通市值、同行业当日涨停家数、近 N 日累计涨停次数、换手率、流通市值。不含 D 日之后任何数据，也不含实时快照或日K。' },
    { name: '③ 两项结果', text: '「晋级」= D+1 仍涨停且连板数 ≥2；「成龙」= D+1 或 D+2 连板数 ≥3。后者更严格、样本更少，两者都不是收益率。' },
    { name: '④ 概率平滑', text: '分档概率用 8 个伪样本的拉普拉斯平滑，先验取全样本基准率，避免小样本出现 0% / 100% 的极端值；页面同时显示样本量 n。' },
    { name: '⑤ 用途边界', text: '彩色边框与右上角概率是「历史相似特征组合的晋级比例」，不是个股买入建议，也不代表可成交收益。一字 / 秒板晋级率天然更高但往往买不进。' }
  ],
  note: '历史涨停池仅可回溯约 15 个交易日，首板晋级与成龙样本量有限；概率仅作相对排序参考，不构成投资建议。'
};

const SEED_FACTORS = [
  { key: 'early', label: '早盘首封', desc: '首封 ≤10:00', test: (x) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(x.firstSeal || '')); return m ? (+m[1] * 60 + +m[2]) <= 600 : false; } },
  { key: 'clean', label: '零炸板', desc: '炸板 0 次', test: (x) => (Number(x.brokenCount) || 0) === 0 },
  { key: 'seal', label: '封单强', desc: '封单/流通 ≥1%', test: (x) => (Number(x.sealFundRatio) || 0) >= 1 },
  { key: 'sector', label: '板块效应', desc: '同行业当日涨停 ≥3 家', test: (x, ctx) => (ctx.industryCount.get(x.industry || '未分类') || 0) >= 3 },
  { key: 'repeat', label: '反复活跃', desc: '近 N 日累计涨停 ≥3 次', test: (x) => (Number(x.statCount) || 0) >= 3 },
  { key: 'cap', label: '中小盘', desc: '流通市值 20~150 亿', test: (x) => { const c = Number(x.floatCap); return c >= 20 && c <= 150; } }
];

const SEED_TIERS = [
  { key: 'seed', label: '龙头种子(≥4项)', min: 4, color: '#d92b2b', bg: '#fdecec' },
  { key: 'watch', label: '潜力观察(2–3项)', min: 2, color: '#2f6fd0', bg: '#eaf2fd' },
  { key: 'plain', label: '普通首板(≤1项)', min: 0, color: '#8593a3', bg: '#f8fafc' }
];

function firstBoardSeedBacktest(history, pools, opts = {}) {
  const dates = ((history && history.dates) || []).slice();
  const byDate = (history && history.byDate) || {};
  const isFirst = x => !/ST/i.test(String(x && x.name || '')) && (Number(x && x.boards) || 1) === 1;
  const ctxOf = zt => {
    const industryCount = new Map();
    (zt || []).forEach(x => {
      if (!isFirst(x)) return;
      const k = x.industry || '未分类';
      industryCount.set(k, (industryCount.get(k) || 0) + 1);
    });
    return { industryCount };
  };
  const hitsOf = (x, ctx) => SEED_FACTORS.filter(f => f.test(x, ctx)).map(f => f.key);
  const tierOf = n => n >= 4 ? 'seed' : n >= 2 ? 'watch' : 'plain';
  const blank = () => ({ n: 0, adv: 0, dragon: 0 });
  const stats = { all: blank(), seed: blank(), watch: blank(), plain: blank() };
  const factorStats = {};
  SEED_FACTORS.forEach(f => { factorStats[f.key] = blank(); });

  let usedDays = 0;
  // dates 降序：dates[i] 为基准日，dates[i-1] 为次日，dates[i-2] 为后日
  for (let i = 1; i < dates.length; i++) {
    const d = String(dates[i].date), next = String(dates[i - 1].date);
    const next2 = i >= 2 ? String(dates[i - 2].date) : null;
    const day = byDate[d] || {};
    const firsts = (day.zt || []).filter(isFirst);
    if (!firsts.length) continue;
    const nm = new Map(((byDate[next] || {}).zt || []).map(x => [x.code, Number(x.boards) || 1]));
    const n2m = next2 ? new Map(((byDate[next2] || {}).zt || []).map(x => [x.code, Number(x.boards) || 1])) : null;
    const ctx = ctxOf(day.zt || []);
    usedDays++;
    firsts.forEach(x => {
      const hits = hitsOf(x, ctx), tier = tierOf(hits.length);
      const nb = nm.get(x.code) || 0, nb2 = n2m ? (n2m.get(x.code) || 0) : 0;
      const adv = nb >= 2 ? 1 : 0, dragon = Math.max(nb, nb2) >= 3 ? 1 : 0;
      [stats.all, stats[tier]].forEach(s => { s.n++; s.adv += adv; s.dragon += dragon; });
      hits.forEach(k => { factorStats[k].n++; factorStats[k].adv += adv; factorStats[k].dragon += dragon; });
    });
  }

  const PRIOR = 8;
  const base = stats.all.n ? stats.all.adv / stats.all.n * 100 : 0;
  const baseDragon = stats.all.n ? stats.all.dragon / stats.all.n * 100 : 0;
  const smooth = (p, n, b) => +((p + b / 100 * PRIOR) / (n + PRIOR) * 100).toFixed(1);
  const tiers = SEED_TIERS.map(t => {
    const s = stats[t.key];
    return {
      key: t.key, label: t.label, min: t.min, color: t.color, bg: t.bg,
      n: s.n, advanced: s.adv, rate: smooth(s.adv, s.n, base),
      dragon: s.dragon, dragonRate: smooth(s.dragon, s.n, baseDragon)
    };
  });
  const factors = SEED_FACTORS.map(f => {
    const s = factorStats[f.key], rate = smooth(s.adv, s.n, base);
    return {
      key: f.key, label: f.label, desc: f.desc, n: s.n, advanced: s.adv, rate,
      lift: base > 0 ? +(rate / base).toFixed(2) : null
    };
  }).sort((a, b) => b.rate - a.rate);

  const nowZt = (pools && pools.zt) || [];
  const nowCtx = ctxOf(nowZt);
  const marks = {};
  nowZt.filter(isFirst).forEach(x => {
    const hits = hitsOf(x, nowCtx), tier = tierOf(hits.length);
    const t = tiers.find(v => v.key === tier);
    marks[x.code] = {
      tier: t.key, label: t.label, color: t.color, bg: t.bg,
      score: hits.length, prob: t.rate, dragonProb: t.dragonRate,
      reasons: hits.map(k => (SEED_FACTORS.find(f => f.key === k) || {}).label).filter(Boolean)
    };
  });

  return {
    days: usedDays, historyDays: dates.length, samples: stats.all.n,
    advanced: stats.all.adv, baseRate: r1(base),
    dragons: stats.all.dragon, dragonBaseRate: r1(baseDragon),
    tiers, factors, marks, markCount: Object.keys(marks).length,
    asOf: opts.asOf || null, source: (history && history.source) || null,
    method: SEED_METHOD, note: SEED_METHOD.note
  };
}

/* ─────────────── 个股筹码峰估算（三角形筹码分布 + 换手衰减） ─────────────── */
/**
 * chipDistribution(bars, opts)
 * 由真实日/周K的价格区间与成交量，按经典「三角形筹码分布 + 换手衰减」模型估算筹码峰。
 * 这是模型估算，不是交易所真实持仓数据；本函数不产生行情数字，只基于传入的真实K线计算。
 * bars: [{date,open,high,low,close,volume(手)}]，按时间正序
 * opts: {price 当前价, floatCap 流通市值(亿元), decay 换手放大系数(默认1), bins 档位数(默认72), limit 使用最近N根, period}
 */
function chipDistribution(bars, opts = {}) {
  const rows = (bars || []).filter(b => b && Number.isFinite(b.high) && Number.isFinite(b.low) &&
    Number.isFinite(b.close) && b.high >= b.low).slice(-Math.max(30, Math.min(Number(opts.limit) || 120, 500)));
  if (rows.length < 8) return null;
  const price = Number.isFinite(opts.price) && opts.price > 0 ? opts.price : rows[rows.length - 1].close;
  const floatCap = Number.isFinite(opts.floatCap) && opts.floatCap > 0 ? opts.floatCap : null;
  const BINS = Math.max(30, Math.min(120, Number(opts.bins) || 72));
  const minP = Math.min(...rows.map(b => b.low)), maxP = Math.max(...rows.map(b => b.high));
  if (!(maxP > minP)) return null;
  const step = (maxP - minP) / BINS;
  const chips = new Array(BINS).fill(0);
  const avgVol = rows.reduce((s, b) => s + (Number(b.volume) || 0), 0) / rows.length || 1;
  const shares = floatCap ? floatCap * 1e8 / price : null; // 流通股本(股)
  const decay = Number.isFinite(opts.decay) && opts.decay > 0 ? opts.decay : 1;

  rows.forEach(b => {
    let turnover;
    if (shares && Number(b.volume) > 0) turnover = (Number(b.volume) * 100) / shares * decay; // 成交量(手)*100股 / 流通股本
    else turnover = clamp((Number(b.volume) || 0) / avgVol * 0.04, 0.004, 0.3); // 无流通股本时用相对量代理
    turnover = clamp(turnover, 0.002, 0.6);
    for (let i = 0; i < BINS; i++) chips[i] *= (1 - turnover); // 旧筹码按换手衰减
    const lo = b.low, hi = b.high, span = hi - lo || step;
    const peak = (b.high + b.low + b.close + b.open) / 4; // 当日成交密集价(三角顶点)
    const w = new Array(BINS).fill(0);
    let wsum = 0;
    for (let i = 0; i < BINS; i++) {
      const p = minP + (i + 0.5) * step;
      if (p < lo || p > hi) continue;
      const t = Math.abs(p - peak) / (span / 2);
      w[i] = t >= 1 ? 0.05 : 1 - t; // 三角形分布，两端保底 0.05
      wsum += w[i];
    }
    if (wsum <= 0) { const idx = clamp(Math.floor((peak - minP) / step), 0, BINS - 1); w[idx] = 1; wsum = 1; }
    for (let i = 0; i < BINS; i++) if (w[i]) chips[i] += turnover * w[i] / wsum; // 新筹码按当日换手注入
  });

  const total = chips.reduce((s, x) => s + x, 0) || 1;
  const bins = chips.map((v, i) => ({ price: r2(minP + (i + 0.5) * step), pct: +(v / total * 100).toFixed(2) }));
  const mean = 100 / BINS;
  const peaksRaw = [];
  for (let i = 1; i < BINS - 1; i++) {
    if (bins[i].pct >= bins[i - 1].pct && bins[i].pct >= bins[i + 1].pct && bins[i].pct >= mean * 1.25)
      peaksRaw.push({ price: bins[i].price, pct: bins[i].pct, idx: i });
  }
  peaksRaw.sort((a, b) => b.pct - a.pct);
  const peaks = [];
  for (const p of peaksRaw) {
    if (peaks.every(q => Math.abs(q.idx - p.idx) > BINS * 0.08)) peaks.push(p);
    if (peaks.length >= 3) break;
  }
  peaks.sort((a, b) => a.price - b.price);
  const costAvg = r2(bins.reduce((s, b) => s + b.price * b.pct, 0) / 100);
  const profitRatio = r2(bins.filter(b => b.price <= price).reduce((s, b) => s + b.pct, 0));
  const trappedRatio = r2(100 - profitRatio);
  // 成本分布分位区间：70%（15%~85%）与 90%（5%~95%）
  let cum = 0, low70 = bins[0].price, high70 = bins[BINS - 1].price, low90 = bins[0].price, high90 = bins[BINS - 1].price;
  let lo70 = false, lo90 = false, hi70 = false;
  for (const b of bins) {
    cum += b.pct;
    if (!lo90 && cum >= 5) { low90 = b.price; lo90 = true; }
    if (!lo70 && cum >= 15) { low70 = b.price; lo70 = true; }
    if (!hi70 && cum >= 85) { high70 = b.price; hi70 = true; }
    if (cum >= 95) { high90 = b.price; break; }
  }
  // 集中度：区间宽度 / 区间中值 ×100，值越小筹码越集中（越大越分散）
  const concentration = (lo, hi) => {
    const mid = (lo + hi) / 2;
    return mid > 0 ? r2((hi - lo) / mid * 100) : null;
  };
  const conc70 = concentration(low70, high70);
  const conc90 = concentration(low90, high90);
  const concLabel = c => c === null ? '—' : c < 10 ? '高度集中' : c < 20 ? '集中' : c < 30 ? '较集中' : c < 45 ? '较分散' : '分散';
  // 现价相对平均成本的偏离（正=现价高于平均成本，获利盘为主）
  const costDeviation = costAvg > 0 ? r2((price - costAvg) / costAvg * 100) : null;
  return {
    period: opts.period || 'day', price: r2(price), costAvg, profitRatio, trappedRatio,
    cost70: [r2(low70), r2(high70)], cost90: [r2(low90), r2(high90)],
    concentration: { c70: conc70, c90: conc90, label70: concLabel(conc70), label90: concLabel(conc90) },
    costDeviation,
    range: [r2(minP), r2(maxP)], binWidth: r2(step),
    bins, peaks: peaks.map(p => ({ price: p.price, pct: p.pct })),
    bars: rows.length, turnoverModel: shares ? '流通股本×成交量' : '相对成交量代理',
    method: '三角形筹码分布 + 换手衰减模型估算；非交易所真实持仓成本，仅供结构参考'
  };
}

/* ═══════════════ 集合竞价 · 首板封板概率（多因子回测） ═══════════════ */
/**
 * 核心思想：在「竞价/盘前即可知」的信息里，用多个因子合成首板封板概率。
 *  实测：单看竞价高开区分力有限（IC≈−0.20）；「位置/涨幅」类因子区分力更强
 *  （距5日线偏离 IC−0.28、多头排列/距20日高 IC−0.17~−0.20）。故用 4 类因子建模。
 *
 * 严格无未来函数——所有特征只用盘前/竞价瞬间可知信息：
 *  - gap    = 当日 open / 前一日 close − 1（开盘瞬间确定）
 *  - 位置/量能/热度 = 全部用 D 日之前（含 T-1）的日K与历史池统计
 *  - 标签 sealed 由当日 zt/zb 池事后判定，仅用于统计，绝不参与特征
 *
 * 方法：WoE 评分卡（等价于分档逻辑回归），训练期拟合，最近 1 日 holdout + 多日滚动验证。
 * history: { dates:[{date,zt,zb}], byDate:{ YYYYMMDD:{zt:[],zb:[]} } }
 * klinesMap: { code:[{date,open,close,high,low,volume}] } 按日期升序
 */

const AUCTION_FACTORS = [
  { key: 'gap', label: '竞价高开', desc: '开盘价÷前收−1；温和高开更易封，近涨停开盘易炸板' },
  { key: 'loc', label: '位置/涨幅', desc: '距5日线＋均线多头＋距20日高点＋近5日涨幅综合；越低越易封' },
  { key: 'vr', label: '昨日量能', desc: '昨日成交量÷前5日均量；温和放量更易封' },
  { key: 'hot', label: '近期上榜', desc: '该股近窗口上首板池次数；频繁上榜反而易炸' }
];

const AUCTION_METHOD = {
  title: '集合竞价 · 首板封板概率（多因子）口径',
  rules: [
    { name: '① 为什么要多因子', text: '单看竞价高开区分力有限（IC约−0.20，最高档约74% vs 最低档约43%，大量个股挤在同一档）。实测「位置/涨幅」类因子区分力更强（距5日线偏离 IC−0.28、多头排列/距20日高 IC−0.17~−0.20）。本模型把 4 类盘前可知因子用 WoE 评分卡合成一个概率，多日滚动样本外平均 AUC≈0.60，优于单因子约0.57。' },
    { name: '② 可观测信号', text: '全部严格盘前可知：竞价高开 gap（开盘价÷前收−1）、位置综合（距5日线/均线多头排列/距20日高点/近5日涨幅，均由 T-1 及之前日K计算）、昨日量能（昨量÷前5日均量）、近期上榜热度（近 N 日上首板池次数）。绝不使用当日收盘价、成交额、换手、封单、炸板次数、封板时间等事后字段。' },
    { name: '③ 样本与标签', text: '近 N 交易日涨停池「首板」(boards=1)为正样本(当日封住)，同日炸板池首板为负样本(炸板未封)，剔除 ST；同一只当日既在涨停池又在炸板池，以封住为准。缺少前 21 根日K的样本跳过并如实计数。' },
    { name: '④ 建模方法', text: 'WoE 评分卡（等价于分档逻辑回归）：每个因子按训练样本五等分，各档 WoE=ln(档内封板比/档内未封比)−ln(总体封板比/总体未封比)，加 0.5 平滑；综合 logit=基准 log-odds＋Σ各因子 WoE，概率=sigmoid(logit)。权重完全由训练数据估计，无人工拍脑袋。位置综合用训练期 z-score 标准化后合成。' },
    { name: '⑤ 样本外验证', text: '最近 1 交易日留作 holdout 不参与训练；另做多日滚动验证（每个交易日用其之前所有交易日训练、在当日预测），给出 AUC 与 Top30%/Bottom30% 实际封板率差。结果如实展示——模型并非每天有效，市场情绪异常日会失效。' },
    { name: '⑥ 选股分层', text: '对 holdout 候选按综合概率降序：前 30%=重点关注、中间 40%=次选观察、后 30%=回避；每只显示 4 因子分解（落入档位与该档 WoE 贡献），让「为什么高分/低分」可解释。概率是历史频率的排序工具，不是收益预测或买入信号。' },
    { name: '⑦ 边界', text: '免费源无逐笔竞价委托量，gap 用开盘价代理；单日样本小、跨日样本不独立；仅首板不含连板；一字/近涨停开盘实盘常买不进；不含消息面与龙虎榜；数据为免费公开快照，非交易所官方推送。' }
  ],
  caveat: '综合概率是历史条件频率的经验排序，滚动 AUC≈0.60、并非每天有效；不构成投资建议，竞价高开≠可买入。'
};

const AUCTION_GAP_LABELS = [
  { max: 0, label: '低开/平开' }, { max: 2, label: '0~2%' }, { max: 4, label: '2~4%' },
  { max: 6, label: '4~6%' }, { max: 8, label: '6~8%' }, { max: 9.5, label: '8~9.5%' },
  { max: Infinity, label: '≥9.5% 近涨停' }
];
function auctionGapLabel(gap) {
  if (!Number.isFinite(gap)) return '—';
  for (const b of AUCTION_GAP_LABELS) if (gap < b.max) return b.label;
  return AUCTION_GAP_LABELS[AUCTION_GAP_LABELS.length - 1].label;
}
const AUCTION_LOC_LABELS = ['低位', '偏低', '中位', '偏高', '高位'];
const AUCTION_VR_LABELS = ['缩量', '温和', '正常', '放量', '巨量'];
const AUCTION_HOT_LABELS = ['冷门', '偶发', '活跃', '频繁', '过热'];
const FACTOR_LABELS = { gap: AUCTION_GAP_LABELS.map(x => x.label), loc: AUCTION_LOC_LABELS, vr: AUCTION_VR_LABELS, hot: AUCTION_HOT_LABELS };

const normAucDate = d => String(d || '').replace(/-/g, '');
const rnd2 = x => Math.round(x * 100) / 100;
const sigmoidAuc = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** 构造严格盘前可知的样本；每一行 sealed 由当日池事后判定，特征只到 T-1 + 当日 open */
function auctionBuildSamples(history, klinesMap) {
  const dates = (history && history.dates || []).slice().map(d => d.date).sort((a, b) => String(a).localeCompare(String(b)));
  const byDate = (history && history.byDate) || {};
  const rows = [];
  let skipped = 0;
  for (let di = 0; di < dates.length; di++) {
    const D = dates[di], day = byDate[D] || {};
    const zt = (day.zt || []).filter(x => x && !x.isST && (Number(x.boards) || 1) === 1);
    const zb = (day.zb || []).filter(x => x && !x.isST && (Number(x.boards) || 1) === 1);
    const ztSet = new Set(zt.map(x => x.code));
    const add = (x, sealed) => {
      const bars = klinesMap[x.code] || [];
      let idx = -1;
      for (let i = 0; i < bars.length; i++) { if (normAucDate(bars[i].date) === normAucDate(D)) { idx = i; break; } }
      if (idx < 21) { skipped++; return; }
      const upto = bars.slice(0, idx);                       // T-1 及之前，盘前完全可知
      const prev = Number(upto[upto.length - 1].close);
      const open = Number(bars[idx].open);
      if (!(prev > 0) || !(open > 0)) { skipped++; return; }
      const gap = (open / prev - 1) * 100;
      const ma = n => upto.slice(-n).reduce((s, b) => s + Number(b.close), 0) / n;
      const ma5 = ma(5), ma10 = ma(10);
      const ret5 = (prev / Number(upto[upto.length - 6].close) - 1) * 100;
      const pos20 = (prev / Math.max(...upto.slice(-20).map(b => Number(b.high))) - 1) * 100;
      const vol5 = upto.slice(-6, -1).reduce((s, b) => s + Number(b.volume), 0) / 5;
      const vr = vol5 > 0 ? Number(upto[upto.length - 1].volume) / vol5 : 3;
      const maDev5 = (prev / ma5 - 1) * 100;
      const bull = (prev / ma5 - 1) * 100 + (ma5 / ma10 - 1) * 100 + (ma10 / Number(ma(20)) - 1) * 100;
      let hot = 0;
      for (let j = 0; j < di; j++) {
        const dd = dates[j], dday = byDate[dd] || {};
        ((dday.zt || []).concat(dday.zb || [])).forEach(y => { if (y && !y.isST && y.code === x.code) hot++; });
      }
      rows.push({
        date: D, code: x.code, name: x.name || '', industry: x.industry || '',
        board: x.board || boardOf(x.code), floatCap: x.floatCap ?? null,
        sealed: sealed ? 1 : 0,
        raw: { gap, maDev5, bull, pos20, ret5, vr, hot }
      });
    };
    zt.forEach(x => add(x, 1));
    zb.forEach(x => { if (!ztSet.has(x.code)) add(x, 0); });
  }
  return { dates, rows, skipped };
}

/** 拟合 WoE 评分卡（输入训练样本） */
function auctionFitCard(train) {
  const locKeys = ['maDev5', 'bull', 'pos20', 'ret5'];
  const st = {};
  locKeys.forEach(k => {
    const v = train.map(r => r.raw[k]).filter(Number.isFinite);
    const m = v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
    const sd = v.length ? Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) : 1;
    st[k] = { m, s: sd || 1 };
  });
  const feat = r => {
    const loc = locKeys.reduce((s, k) => s + (r.raw[k] - st[k].m) / st[k].s, 0) / locKeys.length;
    return { gap: r.raw.gap, loc, vr: r.raw.vr, hot: r.raw.hot };
  };
  const keys = AUCTION_FACTORS.map(f => f.key);
  const bs = train.filter(r => r.sealed).length, bf = train.length - bs;
  const baseWo = Math.log((bs + 0.5) / (bf + 0.5));
  const cards = {};
  const factors = [];
  keys.forEach(k => {
    const vals = train.map(r => ({ v: feat(r)[k], y: r.sealed })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.v - b.v);
    const cuts = [1, 2, 3, 4].map(g => vals[Math.floor(g * vals.length / 5)].v);
    const bins = [];
    for (let g = 0; g < 5; g++) {
      const part = vals.filter(p => (g === 0 ? p.v <= cuts[0] : g === 4 ? p.v > cuts[3] : p.v > cuts[g - 1] && p.v <= cuts[g]));
      const s = part.filter(p => p.y).length, f = part.length - s;
      bins.push({ n: part.length, rate: part.length ? rnd2(s / part.length * 100) : null, woe: part.length ? Math.log((s + 0.5) / (f + 0.5)) - baseWo : 0 });
    }
    // gap 是连续值，档位标签用实际分位边界；其余三类是序数，用语义标签
    const labels = k === 'gap'
      ? [0, 1, 2, 3, 4].map(g => g === 0 ? '≤' + rnd2(cuts[0]) + '%' : g === 4 ? '>' + rnd2(cuts[3]) + '%' : rnd2(cuts[g - 1]) + '~' + rnd2(cuts[g]) + '%')
      : FACTOR_LABELS[k];
    cards[k] = { cuts, bins, labels };
    // 单因子 IC（因子值与封板的皮尔逊相关）
    const n = vals.length, mx = vals.reduce((s, p) => s + p.v, 0) / n, my = vals.reduce((s, p) => s + p.y, 0) / n;
    let num = 0, dx = 0, dy = 0;
    vals.forEach(p => { num += (p.v - mx) * (p.y - my); dx += (p.v - mx) ** 2; dy += (p.y - my) ** 2; });
    const ic = dx && dy ? rnd2(num / Math.sqrt(dx * dy)) : null;
    const spread = bins[4].rate !== null && bins[0].rate !== null ? rnd2(bins[4].rate - bins[0].rate) : null;
    factors.push({
      key: k, label: (AUCTION_FACTORS.find(f => f.key === k) || {}).label || k,
      desc: (AUCTION_FACTORS.find(f => f.key === k) || {}).desc || '',
      ic, spread, bins: bins.map((b, i) => ({ label: labels[i], n: b.n, rate: b.rate, woe: rnd2(b.woe) }))
    });
  });
  const score = r => {
    const f = feat(r);
    let logit = baseWo; const detail = {};
    keys.forEach(k => {
      const v = f[k], c = cards[k];
      let g = 0; while (g < 4 && v > c.cuts[g]) g++;
      const b = c.bins[g];
      logit += b.woe;
      detail[k] = { g, label: c.labels[g], woe: rnd2(b.woe), rate: b.rate, n: b.n };
    });
    return { p: sigmoidAuc(logit), detail };
  };
  return { score, factors, baseWo, feat };
}

/** AUC（0.5=随机） */
function auctionAuc(arr) {
  const pos = arr.filter(r => r.sealed === 1), neg = arr.filter(r => r.sealed !== 1);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  pos.forEach(p => neg.forEach(n => { s += p.probability > n.probability ? 1 : p.probability === n.probability ? 0.5 : 0; }));
  return rnd2(s / (pos.length * neg.length));
}
const auctionRate = a => a.length ? rnd2(a.filter(r => r.sealed === 1).length / a.length * 100) : null;

function auctionFirstBoard(history, klinesMap, opts = {}) {
  const minN = Math.max(1, Number(opts.minN) || 3);
  const { dates, rows, skipped } = auctionBuildSamples(history, klinesMap);
  const empty = {
    available: false, reason: '历史涨停池样本不足，无法回测竞价首板概率',
    factors: [], buckets: [], list: [], validation: null, method: AUCTION_METHOD,
    samples: { train: 0, holdout: 0, skipped }
  };
  if (dates.length < 5) return empty;
  const holdoutDate = dates[dates.length - 1];
  const train = rows.filter(r => r.date < holdoutDate);
  const holdout = rows.filter(r => r.date === holdoutDate);
  if (train.length < minN) return { ...empty, reason: '有效训练样本不足，无法建模', samples: { train: train.length, holdout: holdout.length, skipped } };

  const card = auctionFitCard(train);
  const scoreRows = (arr) => arr.map(r => {
    const s = card.score(r);
    return {
      code: r.code, name: r.name, industry: r.industry, board: r.board, floatCap: r.floatCap,
      gap: rnd2(r.raw.gap), gapLabel: auctionGapLabel(r.raw.gap),
      probability: rnd2(s.p * 100), detail: s.detail,
      sealed: r.sealed, result: r.sealed === 1 ? '封住首板' : '炸板未封'
    };
  });

  // 样本外：最近一日打分 + 分层
  const list = scoreRows(holdout).sort((a, b) => b.probability - a.probability || a.gap - b.gap);
  const NA = list.length;
  list.forEach((x, i) => {
    x.rank = i + 1;
    x.tier = i < Math.ceil(NA * 0.3) ? 'focus' : i < Math.ceil(NA * 0.7) ? 'watch' : 'avoid';
    x.tierLabel = x.tier === 'focus' ? '重点关注' : x.tier === 'watch' ? '次选观察' : '回避';
    x.hit = x.probability >= 50 ? (x.sealed === 1) : (x.sealed === 0);
  });

  // 多日滚动样本外验证：每个交易日用其之前所有交易日训练，在当日预测
  const rollingDays = [];
  for (let di = 5; di < dates.length; di++) {
    const D = dates[di];
    const tr = rows.filter(r => r.date < D), ho = rows.filter(r => r.date === D);
    if (tr.length < 100 || ho.length < 10) continue;
    const rc = auctionFitCard(tr);
    const scored = ho.map(r => ({ sealed: r.sealed, probability: rc.score(r).p * 100 }));
    const auc = auctionAuc(scored);
    const m = Math.ceil(scored.length * 0.3);
    const srt = scored.slice().sort((a, b) => b.probability - a.probability);
    const topRate = auctionRate(srt.slice(0, m)), botRate = auctionRate(srt.slice(-m));
    rollingDays.push({ date: D, n: ho.length, auc, topRate, botRate, actualRate: auctionRate(ho) });
  }
  const avg = a => a.length ? rnd2(a.reduce((s, v) => s + v, 0) / a.length) : null;
  const aucs = rollingDays.map(d => d.auc).filter(v => v !== null);
  const diffs = rollingDays.map(d => d.topRate - d.botRate).filter(v => Number.isFinite(v));
  const rolling = {
    days: rollingDays, avgAuc: avg(aucs), avgTopBot: avg(diffs),
    topAvg: avg(rollingDays.map(d => d.topRate).filter(v => v !== null)),
    botAvg: avg(rollingDays.map(d => d.botRate).filter(v => v !== null)),
    note: aucs.length
      ? '滚动 ' + aucs.length + ' 个交易日：平均 AUC ' + avg(aucs) + '（0.5=随机，>0.55 有区分力），高分前30%平均封板率 ' +
        avg(rollingDays.map(d => d.topRate).filter(v => v !== null)) + '% vs 低分后30% ' + avg(rollingDays.map(d => d.botRate).filter(v => v !== null)) + '%；' +
        '模型并非每天有效，市场情绪异常日会失效。'
      : '滚动验证样本不足'
  };

  const listAuc = auctionAuc(list.map(x => ({ sealed: x.sealed, probability: x.probability })));
  const high = list.filter(x => x.probability >= 50), low = list.filter(x => x.probability < 50);
  const validation = {
    date: holdoutDate, n: NA, auc: listAuc,
    hitRate: NA ? rnd2(list.filter(x => x.hit).length / NA * 100) : null,
    highN: high.length, highActualSealRate: auctionRate(high),
    lowN: low.length, lowActualSealRate: auctionRate(low),
    note: NA < 8 ? '验证样本不足 8 只，单日命中率与方向检验仅供参考；请以多日滚动结果为准' :
      (listAuc !== null && listAuc >= 0.55 ? '样本外 AUC ' + listAuc + '，方向有效（单日样本小）；多日表现见下方滚动验证' :
        '本交易日样本外 AUC ' + listAuc + '（<0.55），单日区分力弱——这正说明模型并非每天有效，须结合滚动结果与市场环境判断'),
    rolling
  };

  const baseRate = train.length ? rnd2(train.filter(r => r.sealed === 1).length / train.length * 100) : null;
  return {
    available: true, method: AUCTION_METHOD, factors: card.factors,
    list, validation, baseRate, holdoutDate,
    samples: { train: train.length, holdout: holdout.length, skipped },
    window: dates,
    note: '多因子 WoE 评分卡：竞价高开＋位置/涨幅＋昨日量能＋近期上榜；训练用近 ' + (dates.length - 1) +
      ' 个交易日，最近 1 日样本外；所有特征盘前可知，无未来函数。概率是历史条件频率的排序工具，非买入信号。'
  };
}

/* ═══════════════ 集合竞价 · 9:25 首板预测（竞价强度信号 · 边运行边校准） ═══════════════ */
/**
 * 与「回测」彻底分开的一套口径。原因（实测）：把回测模型（学的是"已冲击涨停的票谁封得住"，
 * AUC 0.60）套到 9:25 全部高开票上是错的——实测 AUC 仅 0.28，高概率票无一封板。
 * 9:25 要回答的是"一堆高开票里谁最可能去冲板并封住"，信号体系不同。
 *
 * 信号（全部竞价时刻可知，无未来函数）：
 *  - gap   竞价高开幅度：回测+单日实测均指向 3~7% 温和偏高最优，过高(≥9.5%)常一字买不进/易炸
 *  - 量比   volRatio（竞价放量，资金抢筹）
 *  - 昨日量能 昨日成交量 ÷ 前5日均量（启动前的温和放量）
 *  - 流通市值 小盘更易封（实测封板组均值约52亿 vs 未封约156亿，单日小样本、低权重）
 *  - 题材热度 所属行业近3日涨停家数（盘前可知）
 *
 * 概率口径：默认「经验概率」——以高开票历史基准封板率 P0 为锚，按信号分档上浮，
 * 明确标注「经验估计·非精确概率」；每天落盘预测，T日收盘回填真实封板结果，
 * 累计≥20交易日后自动切换为各信号分档的实测封板频率（实测校准）。
 *
 * snapshot: [{code,name,open,prevClose,volRatio,floatCap,industry,board,pct}]
 * klinesMap: { code:[{date,open,close,high,low,volume}] } 按日期升序（只用 date<当日 的bars）
 * history: { dates, byDate } 历史涨停/炸板池（算题材热度 + 经验基准）
 * opts: { tradeDate, baseRate, calibratedBuckets }
 */

const AUCTION_PREDICT_METHOD = {
  title: '集合竞价 · 9:25 首板预测口径',
  rules: [
    { name: '① 为什么与回测分开', text: '回测模块学的是「已经冲击涨停的首板票里谁封得住」，用在 9:25 全部高开票上是错误口径——实测 AUC 仅 0.28，高概率票无一封板。预测模块改用「竞价强度信号」体系，回答「一堆高开票里谁最可能冲板并封住」。' },
    { name: '② 候选池', text: '9:25 抓全市场竞价快照，筛竞价高开 1.5%~9.8%（排除 ST）；高开≥9.5% 的一字/近涨停票单独标注「实盘常买不进」，不参与主排序。这是竞价时刻真实可见的池子，不是事后回看的涨停池。' },
    { name: '③ 竞价强度信号', text: '5 个竞价时刻可知的信号加权成 0~100 分：竞价高开幅度（3~7% 温和偏高最优）、竞价量比（放量抢筹）、昨日量能（启动前温和放量）、流通市值（小盘更易封）、题材热度（所属行业近3日涨停家数）。权重为经验设定，将随每日回填的实测结果持续校准。' },
    { name: '③b 竞价成交额惩罚', text: '在上述 5 信号之外，新增竞价成交额作为惩罚项（负分）：竞价额÷流通市值 <0.15% 不罚、0.15~0.5% 扣4分、0.5~1% 扣12分、≥1% 扣16分。依据近6日 217 只冲击涨停票回测：竞价换手 <0.1% 封板率约63~66%，≥0.5% 骤降至18.2%（反向AUC 0.60）——高开票里竞价放巨量多为分歧兑现，不利封板。竞价额只在 9:15~9:30 集合竞价时段取快照成交额；盘后该字段是全天成交额，自动禁用不扣分。' },
    { name: '④ 概率口径（重要）', text: '默认显示「经验概率」——以高开票历史基准封板率（约8%，来自实测，样本小）为锚，按信号分档谨慎上浮，最高档一般不超过 25%。这不是精确命中率，只是相对排序的经验估计；页面显著标注「经验估计·非精确概率」。' },
    { name: '⑤ 每日回填校准', text: '每个交易日 9:25 落盘预测快照，T 日收盘后回填每只候选的真实封板/未封结果。累计≥20 交易日后，用各信号分档的实测封板频率替换经验值，并在页面标注「已用 N 日实测校准」。 calibration 状态如实显示。' },
    { name: '⑥ 分时点说明', text: '9:25~9:30 抓到的是真实竞价量比；非交易时段打开页面展示的是最近交易日开盘快照的回演，量比字段退化为全天量比，页面会如实标注时点，不伪装成实时竞价。' },
    { name: '⑦ 边界', text: '免费源无逐笔竞价委托明细，量比/开盘价来自公开快照；单日封板样本极少，经验概率不确定性高；预测是概率排序，不是买入信号；一字/近涨停开盘实盘常买不进；不含消息面与龙虎榜。' }
  ],
  caveat: '经验概率是相对排序的保守估计（基准约8%），非精确命中率；每天回填真实结果，积累≥20日后自动切换为实测频率。竞价高开≠可买入，不构成投资建议。'
};

/** 竞价强度信号打分（分段经验函数，返回 0~满分） */
function auctionScoreGap(gap) {
  if (!Number.isFinite(gap)) return { pts: 0, label: '—' };
  if (gap < 1.5) return { pts: 4, label: '低开/不足' };
  if (gap < 3) return { pts: 10, label: '1.5~3% 偏弱' };
  if (gap < 5) return { pts: 24, label: '3~5% 优' };
  if (gap < 7) return { pts: 30, label: '5~7% 强' };
  if (gap < 8.5) return { pts: 20, label: '7~8.5% 偏高' };
  if (gap < 9.5) return { pts: 12, label: '8.5~9.5% 过热' };
  return { pts: 8, label: '≥9.5% 近涨停' };
}
function auctionScoreVolRatio(vr) {
  if (!Number.isFinite(vr)) return { pts: 0, label: '—' };
  if (vr < 1) return { pts: 2, label: '缩量(<1)' };
  if (vr < 1.5) return { pts: 10, label: '1~1.5' };
  if (vr < 2.5) return { pts: 18, label: '1.5~2.5' };
  if (vr < 4) return { pts: 25, label: '2.5~4 强' };
  return { pts: 20, label: '>4 过热' };
}
/**
 * 集合竞价成交额惩罚（负分）。
 * 回测口径：近 6 日 217 只冲击涨停票（126 首板封住 / 91 炸板），
 * 竞价换手 <0.1% 封板率约 63~66%，≥0.5% 骤降至 18.2%；竞价额反向 AUC 0.60。
 * 方向：高开票里竞价放巨量多为分歧兑现，不利封板。用竞价额/流通市值标准化，避免大盘股天然金额高被误伤。
 * 非竞价时段（盘后）快照金额是全天成交额，不可用，返回 usable=false、不扣分。
 */
function auctionScoreAuctionAmount(amount, turnover) {
  if (!Number.isFinite(amount) || !(amount > 0) || !Number.isFinite(turnover)) {
    return { pts: 0, label: '竞价额未启用', usable: false };
  }
  if (turnover < 0.15) return { pts: 0, label: '竞价额温和', usable: true };
  if (turnover < 0.5) return { pts: -4, label: '竞价额偏大', usable: true };
  if (turnover < 1) return { pts: -12, label: '竞价额大', usable: true };
  return { pts: -16, label: '竞价额巨量', usable: true };
}
function auctionScorePrevVol(r) {
  if (!Number.isFinite(r)) return { pts: 0, label: '—' };
  if (r < 0.8) return { pts: 2, label: '缩量' };
  if (r < 1.2) return { pts: 8, label: '0.8~1.2' };
  if (r < 1.8) return { pts: 15, label: '1.2~1.8 放量' };
  return { pts: 12, label: '>1.8 巨量' };
}
function auctionScoreCap(cap) {
  if (!Number.isFinite(cap)) return { pts: 8, label: '—' };
  if (cap < 40) return { pts: 20, label: '<40亿 小盘' };
  if (cap < 80) return { pts: 16, label: '40~80亿' };
  if (cap < 150) return { pts: 10, label: '80~150亿' };
  return { pts: 4, label: '>150亿 大盘' };
}
function auctionScoreHeat(n) {
  if (!Number.isFinite(n)) return { pts: 0, label: '—' };
  if (n <= 0) return { pts: 0, label: '冷门' };
  if (n === 1) return { pts: 4, label: '1家' };
  if (n === 2) return { pts: 7, label: '2家' };
  return { pts: 10, label: '≥3家 热门' };
}

/** 昨日量能：只用 date < tradeDate 的日K，最后一根/前5日均量 */
function auctionPrevVolRatio(bars, tradeDate) {
  if (!Array.isArray(bars)) return null;
  const td = normAucDate(tradeDate);
  const upto = bars.filter(b => normAucDate(b.date) < td);
  if (upto.length < 6) return null;
  const vol5 = upto.slice(-6, -1).reduce((s, b) => s + Number(b.volume || 0), 0) / 5;
  if (!(vol5 > 0)) return null;
  return rnd2(Number(upto[upto.length - 1].volume || 0) / vol5);
}

function auctionPredict(snapshot, klinesMap, history, opts = {}) {
  const snap = Array.isArray(snapshot) ? snapshot : [];
  const klines = klinesMap || {};
  const byDate = (history && history.byDate) || {};
  const dates = ((history && history.dates) || []).map(d => d.date).sort((a, b) => String(a).localeCompare(String(b)));
  const tradeDate = opts.tradeDate || (dates.length ? dates[dates.length - 1] : null);
  const baseRate = Number.isFinite(opts.baseRate) ? Math.max(1, Math.min(40, opts.baseRate)) : 8; // 高开票经验基准封板率
  const calibrated = Array.isArray(opts.calibratedBuckets) && opts.calibratedBuckets.length ? opts.calibratedBuckets : null;

  // 题材热度：近3个历史交易日各行业的首板/涨停家数
  const heat = {};
  dates.slice(-3).forEach(d => {
    const day = byDate[d] || {};
    ((day.zt || []).concat(day.zb || [])).forEach(x => {
      if (x && x.industry && !x.isST) heat[x.industry] = (heat[x.industry] || 0) + 1;
    });
  });

  // 候选：竞价高开 1.5%~9.8%，排除 ST；一字另标
  const cand = [];
  snap.forEach(r => {
    const code = String(r.code || '').padStart(6, '0');
    const name = String(r.name || '');
    const prev = Number(r.prevClose), open = Number(r.open);
    if (!code || /ST|退/i.test(name) || !(prev > 0) || !(open > 0)) return;
    const gap = (open / prev - 1) * 100;
    if (!Number.isFinite(gap) || gap < 1.5 || gap > 9.8) return;
    cand.push({ code, name, gap: rnd2(gap), volRatio: Number.isFinite(Number(r.volRatio)) ? Number(r.volRatio) : null,
      floatCap: Number.isFinite(Number(r.floatCap)) ? Number(r.floatCap) : null,
      auctionAmount: Number.isFinite(Number(r.auctionAmount)) && Number(r.auctionAmount) > 0 ? Number(r.auctionAmount) : null,
      industry: r.industry || '', board: r.board || boardOf(code), pct: r.pct ?? null });
  });

  const list = cand.map(r => {
    const sg = auctionScoreGap(r.gap);
    const sv = auctionScoreVolRatio(r.volRatio);
    const prevVol = auctionPrevVolRatio(klines[r.code], tradeDate);
    const spv = auctionScorePrevVol(prevVol);
    const sc = auctionScoreCap(r.floatCap);
    const heatN = r.industry ? (heat[r.industry] || 0) : 0;
    const sh = auctionScoreHeat(heatN);
    // 竞价换手 = 竞价成交额 / 流通市值 ×100；竞价额仅集合竞价时段有效，其余为 null
    const auctionTurnover = (r.auctionAmount !== null && Number.isFinite(r.floatCap) && r.floatCap > 0)
      ? rnd2(r.auctionAmount / (r.floatCap * 1e8) * 100) : null;
    const sa = auctionScoreAuctionAmount(r.auctionAmount, auctionTurnover);
    const baseScore = sg.pts + sv.pts + spv.pts + sc.pts + sh.pts; // 满分 100
    const score = rnd2(Math.max(0, baseScore + sa.pts)); // 竞价额巨量惩罚，最低 0
    // 经验概率：以 baseRate 为锚，信号分越高越上浮；保守封顶
    let expProb;
    if (calibrated) {
      const bucket = calibrated.find(b => score >= b.min && score < b.max);
      expProb = bucket && Number.isFinite(bucket.prob) ? bucket.prob : null;
    }
    if (expProb === null || expProb === undefined) {
      expProb = rnd2(Math.max(1.5, Math.min(28, baseRate * (0.3 + score / 100 * 2.1))));
    }
    const tier = score >= 70 ? 'focus' : score >= 50 ? 'watch' : 'avoid';
    return {
      code: r.code, name: r.name, industry: r.industry, board: r.board,
      gap: r.gap, volRatio: r.volRatio, floatCap: r.floatCap, prevVolRatio: prevVol, industryHeat: heatN,
      auctionAmount: r.auctionAmount, auctionTurnover, auctionUsable: sa.usable,
      score, baseScore, tier, tierLabel: tier === 'focus' ? '重点关注' : tier === 'watch' ? '次选观察' : '回避',
      expProb, probLabel: calibrated ? '实测校准' : '经验估计',
      oneWord: r.gap >= 9.5,
      signals: {
        gap: { pts: sg.pts, label: sg.label },
        volume: { pts: sv.pts, label: sv.label },
        prevVol: { pts: spv.pts, label: spv.label },
        cap: { pts: sc.pts, label: sc.label },
        heat: { pts: sh.pts, label: sh.label },
        auctionAmt: { pts: sa.pts, label: sa.label, usable: sa.usable, turnover: auctionTurnover }
      },
      result: null // T日收盘回填
    };
  }).sort((a, b) => b.score - a.score || b.gap - a.gap);

  list.forEach((x, i) => { x.rank = i + 1; });
  const focus = list.filter(x => x.tier === 'focus');
  const calibratedDays = opts.calibratedDays || 0;

  return {
    available: true,
    method: AUCTION_PREDICT_METHOD,
    tradeDate,
    baseRate,
    calibration: {
      mode: calibrated ? 'empirical' : 'heuristic',
      days: calibratedDays,
      label: calibrated ? '已用 ' + calibratedDays + ' 日实测校准' : '经验估计（待积累实测）',
      note: calibrated
        ? '概率已按累计 ' + calibratedDays + ' 交易日的真实回填结果分档校准'
        : '累计真实回填满 20 个交易日后自动切换为实测概率；当前为保守经验估计'
    },
    list,
    summary: {
      candidates: list.length,
      focus: focus.length,
      watch: list.filter(x => x.tier === 'watch').length,
      avoid: list.filter(x => x.tier === 'avoid').length,
      oneWord: list.filter(x => x.oneWord).length
    },
    note: '9:25 竞价强度信号排序；概率为' + (calibrated ? '实测校准' : '保守经验估计') +
      '（基准约' + baseRate + '%），非精确命中率、非买入信号；T 日收盘回填真实结果后持续校准。'
  };
}

module.exports = {
  ENLIGHTEN_METHOD, ENLIGHTEN_METHODS, ENLIGHTEN_PLAN, enlightenmentBacktest,
  prevLadderProgress,
  enlightenPlan, enlightenPlanOutcome,
  applyFilters, technicalAnalysis,
  marketOverview, buildThemes, buildConceptThemes, reviewPlan,
  shortTermPicks, shortTermScore,
  boardLowBuy, roleJudge, liveOpportunities,
  detectReverseBoard, relayPicks, aiResearch,
  pullbackAnalysis, pivotClusters, countTouches, PULLBACK_METHOD,
  supportReversalBacktest, SUPPORT_REVERSAL_METHOD,
  ddxFirstRedBacktest, DDX_FIRST_RED_METHOD, ddxTurnover,
  backtestOutcome, summarizeBacktest, BACKTEST_METHOD,
  dragonGame, dragonSentiment, dragonThemes, dragonValidation, dragonReview, attachReviewPerf, sealProfile, dragonEdgeMarks, dragonEdgeStats, DRAGON_METHOD, DRAGON_REVIEW_METHOD,
  firstBoardSeedBacktest, SEED_METHOD, SEED_FACTORS, SEED_TIERS,
  severeVolatilityForecast, tradeRiskFlags, dragonRiskEngine, DRAGON_RISK_METHOD,
  dragonNameThemes, boardLabelOf,
  newsMonitor, classifyNews, NEWS_METHOD,
  chipDistribution,
  auctionFirstBoard, AUCTION_METHOD, AUCTION_FACTORS,
  auctionPredict, AUCTION_PREDICT_METHOD,
  indicators: { sma, ema, macd, rsi, kdj, boll, atr }
};
