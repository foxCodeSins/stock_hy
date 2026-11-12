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
  const TICK = m => m.quoteTick || m.universeTick || (m.now ? m.now.slice(11, 16) : '—');

  const S = {
    data: null, prevPrices: {}, tab: 'review', boards: new Set(['全部']),
    freq: 15, tick: 0, timer: null, boardsList: null,
    collapsed: new Set(), expanded: new Set(), chartsReady: !!window.echarts,
    lastFilters: '', aiCfgOpen: false, aiText: '', aiTextTime: ''
  };

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
    };
    $('capQuick').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      $('capMin').value = b.dataset.min || ''; $('capMax').value = b.dataset.max || '';
      [...$('capQuick').children].forEach(c => c.classList.toggle('active', c === b));
    };
    $('tabs').onclick = e => {
      const t = e.target.closest('.tab'); if (!t) return;
      switchTab(t.dataset.tab);
    };
    ['sectorSelect', 'boardsMin', 'sortSel', 'excludeST'].forEach(id => {
      $(id).addEventListener('change', () => refresh(true));
    });
    ['capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'keyword'].forEach(id => {
      $(id).addEventListener('keydown', e => { if (e.key === 'Enter') refresh(true); });
    });
    loadBoards();
    const initTab = new URLSearchParams(location.search).get('tab');
    if (initTab && ['review', 'picks', 'live', 'lowbuy', 'relay', 'ai'].indexOf(initTab) >= 0) switchTab(initTab);
    refresh(true);
    startTimer();
  }

  function startTimer() {
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(() => {
      if (S.freq <= 0) { $('countdown').textContent = '已暂停'; return; }
      S.tick++;
      const left = Math.max(0, S.freq - S.tick);
      $('countdown').textContent = left + ' 秒';
      if (S.tick >= S.freq) { S.tick = 0; refresh(false); }
    }, 1000);
    $('countdown').textContent = S.freq > 0 ? S.freq + ' 秒' : '已暂停';
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
    const f = collectFilters();
    const q = new URLSearchParams();
    Object.keys(f).forEach(k => { if (f[k] !== '' && f[k] !== undefined) q.set(k, f[k]); });
    if (force) q.set('force', '1');
    $('btnRefresh').disabled = true;
    try {
      const r = await fetch('/api/dashboard?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      S.prevPrices = pricesOf(S.data);
      S.data = j;
      S.lastFilters = describeFilters(f);
      render();
      $('loading').classList.add('hide');
      $('alertBox').style.display = 'none';
    } catch (e) {
      $('loading').classList.add('hide');
      $('alertBox').style.display = '';
      $('alertBox').textContent = '数据加载失败：' + e.message + '。可点击「立即刷新」重试；若上游接口临时不可用，系统会在恢复后自动重新拉取。';
    } finally {
      $('btnRefresh').disabled = false;
      S.tick = 0;
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

  function switchTab(t) {
    S.tab = t;
    [...$('tabs').children].forEach(c => c.classList.toggle('active', c.dataset.tab === t));
    ['review', 'picks', 'live', 'lowbuy', 'relay', 'ai'].forEach(k => $('pane-' + k).classList.toggle('active', k === t));
    setTimeout(() => { Object.values(S.charts || {}).forEach(c => { try { c.resize(); } catch (e) { } }); }, 60);
  }

  /* ─────────────── 渲染入口 ─────────────── */
  function render() {
    const d = S.data, m = d.meta, ov = d.overview;
    renderMeta(m, ov);
    renderKPI(m, ov);
    renderConclusion(m, ov);
    renderReview(d);
    renderPicks(d);
    renderLive(d);
    renderLowBuy(d);
    renderRelay(d);
    renderAI(d);
    renderFooter(d);
    $('filterSummary').textContent = '当前：' + S.lastFilters;
    $('badgePicks').textContent = (d.picks || []).length;
    $('badgeLive').textContent = ov.limitUp + ' 涨停';
    $('badgeLow').textContent = (d.lowbuy || []).length;
    $('badgeRelay').textContent = ((d.relay && d.relay.list) || []).length;
    $('badgeAI').textContent = m.aiConfigured ? '已接模型' : '本地';
  }

  function renderMeta(m, ov) {
    $('tradeState').textContent = m.state;
    $('tradeState').title = m.note + '；' + m.caveat;
    $('dataTime').textContent = (m.quoteTick || m.universeTick || m.now.slice(11, 19)) + ' / ' + (m.poolDate || '—');
    $('dataTime').title = '腾讯实时快照：' + (m.quoteTick || '—') + '；新浪全市场快照：' + (m.universeTick || '—') + '；涨停池交易日：' + (m.poolDate || '—') + '；服务端生成：' + m.generatedAt;
    const hs = m.health || [], ok = hs.filter(h => h.ok).length;
    const pill = $('healthPill');
    pill.textContent = ok + '/' + hs.length + ' 在线';
    pill.style.color = ok === hs.length ? 'var(--down)' : (ok === 0 ? 'var(--up)' : 'var(--warn)');
  }

  function renderKPI(m, ov) {
    const idx = ov.indices || [];
    const cells = idx.slice(0, 4).map(i => {
      const c = i.pct > 0 ? 'up' : i.pct < 0 ? 'down' : 'flat';
      return '<div class="kpi"><span class="lbl">' + E(i.name) + '</span><div class="big ' + c + ' num">' + N(i.price) + '</div><div class="sub ' + c + '">' + (i.pct > 0 ? '+' : '') + N(i.pct) + '%</div></div>';
    });
    const extra = [
      { lbl: '涨停 / 跌停', big: ov.limitUp + ' / ' + ov.limitDown, sub: '炸板 ' + ov.broken + ' 家 · 率 ' + N(ov.breakRate, 1) + '%', cls: 'up' },
      { lbl: '最高连板', big: ov.maxBoard + ' 板', sub: ov.gap ? '梯队有断层' : '梯队无断层', cls: 'up' },
      { lbl: '涨跌家数', big: ov.up + ' / ' + ov.down, sub: '广度 ' + N(ov.breadth, 1) + '%', cls: ov.up >= ov.down ? 'up' : 'down' },
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
      tag('数据源 ' + (m.health || []).filter(h => h.ok).length + '/' + (m.health || []).length + ' 在线', (m.health || []).every(h => h.ok) ? 'green' : 'warn')
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

    const ladderItems = Object.keys(ov.ladder).sort((a, b) => b - a).map(b => ({
      name: b + '板', value: ov.ladder[b], label: ov.ladder[b] + ' 家', color: '#d92b2b'
    }));
    const space = ov.spaceBoard.length ? ov.spaceBoard.map(x => E(x.name) + '(' + E(x.code) + ') ' + x.boards + '板 · ' + E(x.industry)).join('；') : '无';

    const themes = (rv.topThemes || []).map(t =>
      '<div class="info-card theme-card"><h4>' + E(t.name) + ' <span class="mini-tag">' + t.count + ' 只涨停</span></h4>' +
      '<div class="theme-meta">' + tag('最高 ' + t.maxBoard + ' 板', 'red') + tag(t.stage, 'purple') + tag('预期：' + t.outlook, t.outlookScore >= 3 ? 'red' : 'warn') + (t.gap ? tag('梯队断层', 'warn') : '') + '</div>' +
      '<p><b>阶段依据：</b>' + E(t.stageBasis) + '</p>' +
      '<p style="margin-top:5px"><b>持续性：</b>' + E(t.outlookBasis) + '</p>' +
      (t.boardRef ? '<p style="margin-top:5px"><b>板块参照：</b>' + E(t.boardRef.name) + ' ' + (t.boardRef.pct > 0 ? '+' : '') + N(t.boardRef.pct) + '%，领涨 ' + E(t.boardRef.leaderName) + '（新浪财经板块行情）</p>' : '') +
      '</div>'
    ).join('');

    const focus = (rv.focus || []).map((f, i) => '<div class="info-card"><h4>' + tag('焦点 ' + (i + 1), 'blue') + ' ' + E(f.title) + '</h4><p>' + E(f.text) + '</p></div>').join('');

    const planRows = (rv.playbook || []).map(p =>
      '<div class="plan-row"><div class="col"><span class="cl">触发条件</span>' + E(p.condition) + '</div>' +
      '<div class="col"><span class="cl">对应动作</span>' + E(p.action) + '</div>' +
      '<div class="col"><span class="cl">风险 / 反例</span>' + E(p.risk) + '</div></div>'
    ).join('');

    const risks = (rv.risks || []).map(r => '<li>' + E(r) + '</li>').join('');

    $('pane-review').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>一、盘面结构与状态诊断</h3>' + src('新浪财经全市场快照 / 腾讯证券指数 / 东方财富涨停池，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid2"><div class="card pad"><div class="fact-list">' + facts + '</div></div>' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:6px">连板梯队分布（家）</h4><div id="chartLadder" class="chart-sm"></div>' +
      '<div class="note-box">空间板：' + space + '<br>梯队判读：' + E(ov.gap ? '存在断层，按 leader-game 框架属退潮前置信号，需次日 2/3 板补齐确认。' : '梯队连续无断层，情绪延续性优于断层结构。') + '</div></div></div></div>' +

      '<div class="sec"><div class="sec-head"><h3>二、主线题材与生命周期</h3>' + src('东方财富涨停池行业归属 + 新浪财经板块行情，交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="grid2">' + (themes || '<div class="empty">当前无涨停题材分组数据</div>') + '</div>' +
      '<div class="note-box">题材阶段完全由量价结构（涨停扩散数 / 连板高度 / 梯队完整度 / 炸板负反馈率 / 板块涨跌幅）机械推导，未接入新闻与公告数据；阶段判断为前瞻性推演，需次日盘面验证。</div></div>' +

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
        '<td class="left"><span class="code">' + E(x.code) + '</span> <span class="nm">' + E(x.name) + '</span>' + (x.isST ? ' <span class="mini-tag">ST</span>' : '') + '</td>' +
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
  const nameCell = x => '<span class="code">' + E(x.code) + '</span> <span class="nm">' + E(x.name) + '</span>';
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
      (list.length ? list.map(b => '<tr><td class="left"><b>' + E(b.name) + '</b></td><td>' + PC(b.pct) + '</td><td>' + E(b.members) + '</td><td>' + AMT(b.amount) + '</td><td class="left">' + E(b.leaderName || '—') + ' <span class="mini-tag">' + PC(b.leaderPct) + '</span></td></tr>').join('') : '<tr><td colspan="5" class="empty">板块数据暂不可用</td></tr>') + '</tbody></table></div>';

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
        ['斐波那契', t.fib ? '起涨基准 ' + N(t.fib.base) + ' → 0.382 ' + N(t.fib.f382) + ' / 0.5 ' + N(t.fib.f500) + ' / 0.618 ' + N(t.fib.f618) : '—'],
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

      return '<div class="lb-card' + (collapsed ? ' lb-collapsed' : '') + '" data-code="' + E(x.code) + '">' +
        '<div class="lb-head" data-toggle="' + E(x.code) + '">' +
        '<span class="lb-name">' + E(x.name) + '</span><span class="lb-code">' + E(x.code) + '</span>' +
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

    const scoreItems = rows.slice(0, 12).map(x => ({ name: x.name + '(' + x.code + ')', value: x.techScore || 0, label: x.techScore === null ? '—' : x.techScore }));

    $('pane-lowbuy').innerHTML = summary +
      '<div class="sec"><div class="sec-head"><h3>连板股技术评分对比</h3>' + src('本系统技术指标计算，输入为腾讯证券前复权日K') + '</div><div class="card pad"><div id="chartLowScore" class="chart"></div></div></div>' +
      '<div class="sec"><div class="sec-head"><h3>逐只研判（' + rows.length + ' 只）</h3>' + src('东方财富涨停池 + 腾讯证券行情/日K + 新浪财经板块，交易日 ' + (m.poolDate || '—')) + '</div>' +
      (cards || '<div class="card empty">当前筛选条件下无连板标的。可放宽「最低连板数 / 流通市值 / 板块」条件；若为非交易时段，涨停池展示最近一个交易日数据。</div>') + '</div>' +
      '<div class="disclaimer" style="margin-top:14px"><strong>风险提示</strong>：连板低吸属于高波动策略，高位股接力赔率最差；题材阶段为量价结构推导的前瞻判断，可能因消息面变化而失效。本模块不含新闻、公告与龙虎榜数据，所有结论仅供研究参考，不构成投资建议。</div>';

    $('pane-lowbuy').querySelectorAll('.lb-head[data-toggle]').forEach(el => {
      el.onclick = () => {
        const c = el.dataset.toggle, card = el.closest('.lb-card');
        if (S.collapsed.has(c)) { S.collapsed.delete(c); card.classList.remove('lb-collapsed'); }
        else { S.collapsed.add(c); card.classList.add('lb-collapsed'); }
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
        ? '<div class="lb-sub"><h5>同题材卡位竞争</h5>' + x.peers.map(p => '<div class="kv"><span class="k">' + E(p.name) + '(' + E(p.code) + ')</span><span class="v">' + E(p.boards) + ' 板</span></div>').join('') + '</div>'
        : '';
      const detail = '<div class="grid2" style="gap:14px"><div>' +
        '<div class="lb-sub"><h5>接力评分拆解（' + E(x.relayScore) + ' / 100）</h5><div class="score-parts">' + parts + '</div>' +
        (x.veto && x.veto.length ? '<div class="veto"><b>一票否决：</b>' + x.veto.map(E).join('；') + '</div>' : '') + '</div>' +
        revHtml + techHtml + '</div><div>' + anchorHtml + peers +
        '<div class="lb-sub purple"><h5>晋级条件与失效条件</h5>' +
        '<div class="note-box"><b>晋级：</b>' + E(x.ladderNote) + '</div>' +
        '<ul class="tight">' + (x.invalidate || []).map(z => '<li>' + E(z) + '</li>').join('') + '</ul></div></div></div>';

      return '<tr class="clickable" data-cat="' + E(x.category) + '" data-relay="' + E(x.code) + '">' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> <span class="nm">' + E(x.name) + '</span></td>' +
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

    const top = rows.slice(0, 10).map(x => ({ name: x.name + '(' + x.code + ')', value: x.relayScore, label: x.relayScore }));
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
    const sections = (ai.sections || []).map(s =>
      '<div class="info-card"><h4>' + E(s.title) + '</h4><p>' + E(s.body) + '</p>' +
      '<div class="small muted" style="margin-top:7px">依据：' + E((s.basis || []).join('、')) + '</div></div>'
    ).join('');
    const topRows = (ai.topPicks || []).map((x, i) =>
      '<tr><td class="left"><b>' + (i + 1) + '</b></td><td class="left"><span class="code">' + E(x.code) + '</span> <span class="nm">' + E(x.name) + '</span></td>' +
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
      '<div class="ai-form"><label>接口地址 <input type="text" id="aiBase" placeholder="https://api.openai.com/v1" value="' + E(m.aiBase || 'https://api.openai.com/v1') + '"></label>' +
      '<label>API Key <input type="password" id="aiKey" placeholder="sk-...（仅存服务端内存）"></label>' +
      '<label>模型名 <input type="text" id="aiModel" placeholder="gpt-4o-mini" value="' + E(m.aiModel || 'gpt-4o-mini') + '"></label></div>' +
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
      '<div class="health-item"><span class="hdot' + (h.ok ? '' : ' bad') + '"></span><b>' + E(h.label) + (h.sourceLabel ? ' · ' + E(h.sourceLabel) : '') + '</b>' +
      '<span class="muted">' + (h.ok ? '在线 · ' + E(h.rows) + ' 条 · ' + E(h.latency) + 'ms' : '异常 · ' + E(h.error || '未知')) + '</span></div>'
    ).join('');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
