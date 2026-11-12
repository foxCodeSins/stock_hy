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
  const fib = base ? {
    base: r2(base),
    f382: r2(price - (price - base) * 0.382),
    f500: r2(price - (price - base) * 0.5),
    f618: r2(price - (price - base) * 0.618)
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
  const p = t.price;
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
    zoneBasis: `上沿取本轮起涨(基准 ${t.base})至现价的 0.382 回撤位；下沿取 0.5 回撤位${ma5 ? `，若 MA5 ${ma5} 落在区间内则上移至该更近支撑` : ''}；区间宽度机械限制在现价 1.5%–6%`,
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
  else if (yin && recentLimit) { type = '断板反包'; note = `前日断板收阴（近 ${evidence.recentLimitStat} 有涨停），今日涨停反包`; }
  else if (upperShadow >= 4 && pPct >= 3) { type = '炸板/长上影反包'; note = `前日上影 ${r1(upperShadow)}% 冲高回落，今日涨停收复`; }
  else if (yin && coverBody > 0) { type = '阴线反包'; note = `前日收阴，今日涨停收盘越过前日实体上沿 ${r1(coverBody)}%`; }
  else return { ...base, evidence, reason: '前一日未出现走弱结构（阴线/大阴/长上影），不构成反包' };

  const fullCover = coverHigh !== null && coverHigh > 0;
  return {
    isReverse: true, type,
    strength: fullCover ? '完全反包（收盘过前日最高）' : '部分反包（收盘过前日实体上沿）',
    strengthPct: r1(coverHigh !== null ? coverHigh : coverBody),
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
    levels: all.reduce((a, x) => (a[x.level] = (a[x.level] || 0) + 1, a), {})
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
  }).sort((a, b) => b.composite - a.composite || b.resonance - a.resonance).slice(0, 8);

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
    sourceNote: '日K/划线=' + klineSource + '（截至 ' + last.date + '）；现价=腾讯证券实时快照；候选代码=东方财富涨停池'
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

module.exports = {
  applyFilters, technicalAnalysis,
  marketOverview, buildThemes, reviewPlan,
  shortTermPicks, shortTermScore,
  boardLowBuy, roleJudge, liveOpportunities,
  detectReverseBoard, relayPicks, aiResearch,
  pullbackAnalysis, pivotClusters, countTouches, PULLBACK_METHOD,
  indicators: { sma, ema, macd, rsi, kdj, boll, atr }
};
