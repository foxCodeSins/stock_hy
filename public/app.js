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

  /* 「连不上本地服务」与「上游数据源不可用」是两类完全不同的故障，提示不能混为一谈 */
  const SERVICE_HINT = '本地服务未响应：请确认 A股实时复盘系统已启动（双击项目目录 start.bat，或在项目目录运行 node server.js）；默认端口 8899，被占用时会自动顺延，请以控制台输出的「本机访问」地址为准。';
  function isConnError(e) {
    return e instanceof TypeError ||
      /Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET/i.test(String((e && e.message) || e));
  }

  const S = {
    data: null, prevPrices: {}, tab: 'review', boards: new Set(['全部']),
    freq: 15, tick: 0, timer: null, boardsList: null,
    collapsed: new Set(), expanded: new Set(), chartsReady: !!window.echarts,
    lastFilters: '', aiCfgOpen: false, aiText: '', aiTextTime: '',
    pull: null, pullLoading: false, pullAt: 0, pullSelected: null,
    pullFilters: '', pullError: null, pullMethodOpen: false, pullOfflineTimer: null, pullDays: 8,
    bt: null, btLoading: false, btError: null, btOpen: false,
    btDate: 'all', btWindow: 5, btMethodOpen: false,
    dg: null, dgLoading: false, dgError: null, dgAt: 0, dgSelected: null, dgFilters: '',
    dgMethodOpen: false, dgValidationOpen: false,
    dgOpts: { days: 12, showAll: 0, sort: 'score', sortDir: 'desc', role: '全部', limit: 60 },
    dgOfflineTimer: null
  };
  const activeHealth = m => (m.health || []).filter(h => !h.standby);

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
    if (initTab && ['review', 'picks', 'live', 'lowbuy', 'relay', 'ai', 'pullback', 'dragon'].indexOf(initTab) >= 0) switchTab(initTab);
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
      // 新模块走独立 API：仅在该 tab 可见、筛选变化或超过 60 秒时才重新扫描，避免拖累 15 秒主看板刷新
      if (S.tab === 'pullback' && Date.now() - S.pullAt > 12000 &&
        (S.pullFilters !== S.lastFilters || Date.now() - S.pullAt > 60000)) loadPullback(false);
      if (S.tab === 'dragon' && Date.now() - S.dgAt > 12000 &&
        (S.dgFilters !== S.lastFilters || Date.now() - S.dgAt > 60000)) loadDragon(false);
      $('loading').classList.add('hide');
      $('alertBox').style.display = 'none';
    } catch (e) {
      $('loading').classList.add('hide');
      $('alertBox').style.display = '';
      $('alertBox').textContent = '数据加载失败：' + e.message + '。' +
        (isConnError(e)
          ? SERVICE_HINT + ' 可点击「立即刷新」重试。'
          : '可点击「立即刷新」重试；若上游接口临时不可用，系统会在恢复后自动重新拉取。');
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
    ['review', 'picks', 'live', 'lowbuy', 'relay', 'ai', 'pullback', 'dragon'].forEach(k => $('pane-' + k).classList.toggle('active', k === t));
    if (t === 'pullback' && !S.pull && !S.pullLoading) loadPullback(false);
    if (t === 'dragon' && !S.dg && !S.dgLoading) loadDragon(false);
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
    if (S.pull) $('badgePull').textContent = (S.pull.list || []).length;
  }

  function renderMeta(m, ov) {
    $('tradeState').textContent = m.state;
    $('tradeState').title = m.note + '；' + m.caveat;
    $('dataTime').textContent = (m.quoteTick || m.universeTick || m.now.slice(11, 19)) + ' / ' + (m.poolDate || '—');
    $('dataTime').title = '腾讯实时快照：' + (m.quoteTick || '—') + '；新浪全市场快照：' + (m.universeTick || '—') + '；涨停池交易日：' + (m.poolDate || '—') + '；服务端生成：' + m.generatedAt;
    const hs = activeHealth(m), ok = hs.filter(h => h.ok).length;
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
      tag('数据源 ' + activeHealth(m).filter(h => h.ok).length + '/' + activeHealth(m).length + ' 在线', activeHealth(m).every(h => h.ok) ? 'green' : 'warn')
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

  /* ─────────────── 涨停回踩支撑（K线图 + 划线解释） ─────────────── */
  function pbLevelClass(l) {
    return l === '重点观察' ? 'recommend' : l === '条件观察' ? 'watch' : l === '已失效' ? 'no' : 'plain';
  }
  function pbStatusTag(s) {
    return tag(s, s === '已回踩到位' ? 'red' : s === '接近支撑' ? 'warn' : s === '跌破支撑' ? 'green' : '');
  }
  const pbKv = (k, v) => '<div class="pb-kv"><span>' + E(k) + '</span><b>' + v + '</b></div>';

  /* ─────────── 历史回溯 · 成功率验证 ─────────── */
  const btDateLabel = d => String(d || '').length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : String(d || '—');
  const btPct = v => (v === null || v === undefined) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  const btKpi = (label, value, sub, cls) =>
    '<div class="bt-kpi"><span class="lbl">' + E(label) + '</span><b class="' + (cls || '') + '">' + value + '</b>' +
    '<span class="small muted">' + E(sub || '') + '</span></div>';
  const btLevelCls = l => l === '重点观察' ? 'red' : l === '条件观察' ? 'warn' : l === '已失效' ? 'green' : '';
  const btResultTag = r => '<span class="bt-result ' +
    (r === '达标' ? 'up' : r === '止损' ? 'down' : r === '观察中' ? 'blue' : '') + '">' + E(r || '—') + '</span>';

  function btTrendSvg(days) {
    if (!days || !days.length) return '';
    const W = 700, H = 152, L = 26, R = 8, T = 18, B = 36;
    const n = days.length, gap = (W - L - R) / n, bw = Math.min(50, gap - 10);
    const hOf = v => (H - T - B) * (Number(v) || 0) / 100;
    const y50 = H - B - hOf(50);
    const bars = days.map((d, i) => {
      const x = L + i * gap + (gap - bw) / 2;
      const rate = d.winRate;
      const h = rate === null ? 5 : Math.max(2, hOf(rate));
      const y = H - B - h;
      const fill = rate === null ? '#cbd5e1' : rate >= 60 ? '#d92b2b' : rate >= 40 ? '#d97706' : '#0f9960';
      const tip = btDateLabel(d.date) + '：成功率 ' + (rate === null ? '观察中' : rate + '%') +
        '，已完结 ' + d.completed + ' / 样本 ' + d.total;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="3" fill="' + fill + '" opacity="' + (rate === null ? '.5' : '.88') + '"><title>' + E(tip) + '</title></rect>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" font-size="10" fill="#4b5b6b">' +
        (rate === null ? '—' : rate + '%') + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - B + 14) + '" text-anchor="middle" font-size="9.5" fill="#8593a3">' + E(btDateLabel(d.date)) + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - B + 26) + '" text-anchor="middle" font-size="9" fill="#8593a3">n=' + E(d.completed) + '</text>';
    }).join('');
    return '<div class="bt-trend"><div class="bt-h5">近 ' + n + ' 个基准日成功率趋势（柱高为成功率，n 为已完结样本数）</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="152" role="img" aria-label="每日成功率柱状图">' +
      '<line x1="' + L + '" y1="' + y50.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y50.toFixed(1) +
      '" stroke="#e4e9f0" stroke-dasharray="4 4"/>' +
      '<text x="2" y="' + (y50 + 3).toFixed(1) + '" font-size="9" fill="#8593a3">50%</text>' + bars + '</svg></div>';
  }

  function btCardInner() {
    const head = '<div class="bt-head"><div><h4>历史回溯 · 成功率验证</h4>' +
      '<div class="small muted">选一个过去的交易日，用当时可见的日K重跑划线规则，再用之后 N 根真实K线检验「目标 / 止损」是否兑现。</div></div>' +
      '<button class="btn" id="btToggle">' + (S.btOpen ? '收起' : '展开回溯近 10 日') + '</button></div>';
    if (!S.btOpen) return head;

    const j = S.bt;
    const dates = (j && j.meta && j.meta.baseDates) || [];
    const dateOpts = ['<option value="all"' + (S.btDate === 'all' ? ' selected' : '') + '>近 ' + (dates.length || 10) + ' 日汇总</option>']
      .concat(dates.map(d => '<option value="' + E(d) + '"' + (S.btDate === d ? ' selected' : '') + '>' + E(btDateLabel(d)) + ' 基准日</option>')).join('');
    const winOpts = [3, 5, 10].map(w => '<option value="' + w + '"' + (S.btWindow === w ? ' selected' : '') + '>' + w + ' 个交易日</option>').join('');
    const controls = '<div class="bt-controls"><label>基准日 <select class="sel" id="btDate">' + dateOpts + '</select></label>' +
      '<label>观察窗口 <select class="sel" id="btWindow">' + winOpts + '</select></label>' +
      '<button class="btn" id="btReload">重新计算</button>' +
      '<button class="link-btn" id="btMethod">' + (S.btMethodOpen ? '收起' : '查看') + '口径说明</button></div>';

    if (S.btLoading) return head + controls + '<div class="bt-state">正在回溯近 10 个交易日、逐只核对真实日K并判定结果…（首次约需数秒）</div>';
    if (S.btError) return head + controls + '<div class="bt-state err">' +
      (isConnError(new Error(S.btError)) && /Failed to fetch|fetch failed|NetworkError/i.test(S.btError)
        ? '无法连接本地服务：' + E(SERVICE_HINT)
        : '历史回溯失败：' + E(S.btError)) +
      '<br><span class="small muted">系统不会用推测数据填充统计。</span></div>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" id="btRetry">重新回溯</button></div>';
    if (!j) return head + controls + '<div class="bt-state">点击「重新计算」开始回溯。</div>';

    const m = j.meta || {};
    const sum = S.btDate === 'all' ? (j.summary || {}) : (j.days || []).find(d => d.date === S.btDate) || {};
    const rows = S.btDate === 'all' ? (j.rows || []) : (j.rows || []).filter(r => r.date === S.btDate);
    const done = sum.completed || 0;
    const warn = '<div class="bt-warn"><b>口径提醒</b>：这是「触及型」判定（目标通常仅 +2%~+8%，止损约 −3%），成功率天然偏高，' +
      '<b>不等于真实交易胜率</b>；请同时看平均收益与止损率。同一标的会在多个基准日重复出现，样本不独立。</div>';
    const fb = m.fallback ? '<div class="pb-warn">口径提示：腾讯前复权日K当前不可用，本轮回测已降级为「新浪财经日K（不复权）」；除权个股历史价位可能与前复权不一致。</div>' : '';
    const kpis = '<div class="bt-kpi-grid">' +
      btKpi('已完结样本', E(done), '总样本 ' + E(sum.total || 0) + ' 个') +
      btKpi('成功率', (sum.winRate === null || sum.winRate === undefined) ? '—' : sum.winRate + '%', '达标 ' + E(sum.success || 0) + ' 个', 'up') +
      btKpi('止损率', (sum.stopRate === null || sum.stopRate === undefined) ? '—' : sum.stopRate + '%', '止损 ' + E(sum.stopped || 0) + ' 个', 'down') +
      btKpi('平均收益', btPct(sum.avgReturn), '单笔最好 ' + btPct(sum.best) + ' / 最差 ' + btPct(sum.worst), (sum.avgReturn > 0 ? 'up' : sum.avgReturn < 0 ? 'down' : '')) +
      btKpi('观察中', E(sum.watching || 0), '窗口未走完，不计入分母') +
      btKpi('未触发', E(sum.timeout || 0), '窗口内未触及目标/止损') +
      '</div>';

    const levels = Object.keys(sum.byLevel || {}).map(k => {
      const v = sum.byLevel[k];
      return '<tr><td>' + tag(k, btLevelCls(k)) + '</td><td>' + E(v.total) + '</td><td>' + E(v.completed) + '</td>' +
        '<td><b>' + (v.winRate === null ? '—' : v.winRate + '%') + '</b></td><td>' + btPct(v.avgReturn) + '</td>' +
        '<td>' + E(v.stopped) + '</td></tr>';
    }).join('');
    const levelTbl = '<div class="bt-block"><div class="bt-h5">按结论档位分组（可检验评分档位是否真有区分度）</div>' +
      '<div class="tbl-wrap"><table class="tbl bt-tbl"><thead><tr><th>档位</th><th>样本</th><th>已完结</th><th>成功率</th><th>平均收益</th><th>止损数</th></tr></thead>' +
      '<tbody>' + (levels || '<tr><td colspan="6" class="muted">无样本</td></tr>') + '</tbody></table></div></div>';

    const detail = rows.slice(0, 100).map(r => {
      const o = r.outcome || {};
      return '<tr><td>' + E(btDateLabel(r.date)) + '</td>' +
        '<td><b>' + E(r.name) + '</b><br><span class="code">' + E(r.code) + '</span></td>' +
        '<td>' + tag(r.level, btLevelCls(r.level)) + '</td><td>' + E(r.score) + '</td>' +
        '<td>' + N(o.entry) + '</td><td>' + N(o.target) + '</td><td>' + N(o.stop) + '</td>' +
        '<td class="small">' + (o.windowHigh === null || o.windowHigh === undefined ? '—' : N(o.windowHigh) + ' / ' + N(o.windowLow)) + '</td>' +
        '<td>' + btResultTag(o.result) + (o.hitDay ? '<span class="small muted"> 第' + E(o.hitDay) + '日</span>' : '') + '</td>' +
        '<td>' + PC(o.returnPct) + '</td><td class="small">' + E(r.klineSource || '—') + '</td></tr>';
    }).join('');
    const detailTbl = '<div class="bt-block"><div class="bt-h5">逐只明细（' + E(rows.length) + ' 条' +
      (rows.length > 100 ? '，仅显示前 100 条' : '') + '）</div>' +
      '<div class="tbl-wrap bt-detail"><table class="tbl bt-tbl"><thead><tr>' +
      '<th>基准日</th><th>标的</th><th>档位</th><th>评分</th><th>基准价</th><th>目标</th><th>止损</th>' +
      '<th>后续高/低</th><th>结果</th><th>收益</th><th>日K口径</th></tr></thead><tbody>' +
      (detail || '<tr><td colspan="11" class="muted">该基准日没有可判定的样本（上游数据不足或全部被规则过滤）</td></tr>') +
      '</tbody></table></div></div>';

    const meth = (j.methodology || {});
    const method = '<div class="bt-method" style="display:' + (S.btMethodOpen ? '' : 'none') + '">' +
      (meth.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(meth.caveat || '') + '</div></div>';
    const skips = Object.keys(m.skipped || {}).map(k => E(k) + ' ' + E(m.skipped[k])).join('；') || '无';
    const trace = '<div class="bt-trace small muted">' +
      '历史涨停池：' + E((m.historyRange || []).join(' ~ ')) + '（' + E(m.historyDays) + ' 个交易日，仅可回溯约 15 日）· ' +
      '计划组合 ' + E(m.plannedCount) + ' 个 → 去重 ' + E(m.codesRequested) + ' 只 → 日K成功 ' + E(m.klineOk) + ' 只 · ' +
      '日K口径：' + E((m.klineSources || []).join(' / ') || '未取得') + ' · 服务端耗时 ' + E(m.elapsedMs) + ' ms<br>' +
      '被规则跳过：' + skips + '<br>' + E(m.dataSourceNote || '') +
      '<br>以上为历史回放，不构成投资建议；市场有风险，投资需谨慎。</div>';

    return head + controls + warn + fb + kpis + btTrendSvg(j.days) + levelTbl + detailTbl +
      '<button class="link-btn" id="btMethod2" style="margin-top:8px">' + (S.btMethodOpen ? '收起' : '查看') + '口径说明</button>' +
      method + trace;
  }

  function refreshBtCard() {
    if ($('btCard')) $('btCard').innerHTML = btCardInner();
    if ($('btToggle')) $('btToggle').onclick = () => { S.btOpen = !S.btOpen; refreshBtCard(); };
    if ($('btDate')) $('btDate').onchange = e => { S.btDate = e.target.value; refreshBtCard(); };
    if ($('btWindow')) $('btWindow').onchange = e => { S.btWindow = Number(e.target.value); loadBacktest(false); };
    if ($('btReload')) $('btReload').onclick = () => loadBacktest(true);
    if ($('btRetry')) $('btRetry').onclick = () => loadBacktest(true);
    if ($('btMethod')) $('btMethod').onclick = () => { S.btMethodOpen = !S.btMethodOpen; refreshBtCard(); };
    if ($('btMethod2')) $('btMethod2').onclick = () => { S.btMethodOpen = !S.btMethodOpen; refreshBtCard(); };
    if (S.btOpen && !S.bt && !S.btLoading && !S.btError) loadBacktest(false);
  }

  async function loadBacktest(force) {
    if (S.btLoading) return;
    S.btLoading = true; S.btError = null;
    refreshBtCard();
    const q = new URLSearchParams({ window: String(S.btWindow), days: '10' });
    if (force) q.set('force', '1');
    let j = null, lastErr = null;
    try {
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch('/api/backtest?' + q.toString(), { cache: 'no-store' });
          let data;
          try { data = await r.json(); }
          catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
          if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
          j = data; break;
        } catch (e) {
          lastErr = e;
          if (!isConnError(e) || i === 2) break;
          await new Promise(res => setTimeout(res, 1000 + i * 1200));
        }
      }
      if (!j) throw lastErr || new Error('未知错误');
      S.bt = j;
      if (S.btDate !== 'all' && !(j.meta.baseDates || []).includes(S.btDate)) S.btDate = 'all';
    } catch (e) { S.btError = e.message; }
    finally { S.btLoading = false; refreshBtCard(); }
  }

  /* 连接级失败（例如服务正在重启）自动重试；服务端 / 上游错误立即返回，不重复打上游 */
  async function fetchPullbackJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/pullback?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '），请确认访问的是本系统地址'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        if (!S.pull) $('pane-pullback').innerHTML = '<div class="card empty">本地服务未响应，正在重连…（第 ' + (i + 1) + ' 次）</div>';
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  /* 服务离线期间每 3 秒探测健康接口，恢复后自动重新扫描，无需手动刷新页面 */
  function watchService(kind) {
    clearTimeout(S.pullOfflineTimer);
    const probe = async () => {
      try {
        const h = await fetch('/api/health?_=' + Date.now(), { cache: 'no-store' });
        if (h.ok) {
          S.pullOfflineTimer = null;
          if (kind === 'dragon') loadDragon(false); else loadPullback(false);
          return;
        }
      } catch (_) { /* 服务尚未就绪，继续探测 */ }
      S.pullOfflineTimer = setTimeout(probe, 3000);
    };
    S.pullOfflineTimer = setTimeout(probe, 3000);
  }

  async function loadPullback(force) {
    if (S.pullLoading) return;
    S.pullLoading = true;
    if (!S.pull) $('pane-pullback').innerHTML = '<div class="card empty">正在回溯近期涨停股、逐只核对真实日K并计算支撑压力位…</div>';
    const f = collectFilters();
    const q = new URLSearchParams();
    ['board', 'capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'excludeST', 'keyword', 'sector', 'sort', 'limit']
      .forEach(k => { if (f[k] !== '' && f[k] !== undefined) q.set(k, f[k]); });
    q.set('days', String(S.pullDays));
    if (force) q.set('force', '1');
    try {
      const j = await fetchPullbackJson(q);
      clearTimeout(S.pullOfflineTimer); S.pullOfflineTimer = null;
      S.pull = j; S.pullAt = Date.now(); S.pullFilters = describeFilters(f); S.pullError = null;
      const list = j.list || [];
      if (!list.some(x => x.code === S.pullSelected)) S.pullSelected = list.length ? list[0].code : null;
      renderPullback();
      $('badgePull').textContent = list.length;
    } catch (e) {
      const conn = isConnError(e);
      S.pullError = e.message;
      S.pullAt = Date.now();   // 失败后防抖，避免自动刷新每 15 秒重复打上游
      $('pane-pullback').innerHTML =
        '<div class="card empty">' + (conn ? '无法连接本地服务' : '划线数据加载失败') + '：' + E(e.message) +
        '<br><span class="small muted">' + E(conn
          ? SERVICE_HINT + ' 服务恢复后页面会自动重新扫描，也可点击「重新扫描」立即重试；系统不会用推测数据填充列表。'
          : '可点击「重新扫描」重试；上游接口临时不可用时，系统不会填充任何推测数据。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="pbRetry">重新扫描</button></div>';
      if ($('pbRetry')) $('pbRetry').onclick = () => loadPullback(true);
      if (conn) watchService();
    } finally { S.pullLoading = false; }
  }

  function renderPullback() {
    const j = S.pull; if (!j) return;
    const m = j.meta || {}, s = j.summary || {}, list = j.list || [], meth = j.methodology || {};
    const lvl = s.levels || {};
    const dates = (s.historyDates || []).map(d => d.date).join('、');
    const warn = /降级|不复权/.test(m.klineNote || '')
      ? '<div class="pb-warn">口径提示：' + E(m.klineNote) + '</div>' : '';
    const head =
      '<div class="conclusion card pb-head"><div class="lead">扫描近 ' + (s.historyDates || []).length + ' 个交易日的 ' + E(s.historyCount) +
      ' 只涨停股，核对真实日K后得到 <b>' + E(s.analyzedCount) + '</b> 只回调结构标的，其中 <b>' + E(s.nearCount) + '</b> 只已回踩或接近支撑位。</div>' +
      '<div class="tags">' +
      tag('重点观察 ' + (lvl['重点观察'] || 0), 'red') + tag('条件观察 ' + (lvl['条件观察'] || 0), 'warn') +
      tag('仅跟踪 ' + (lvl['仅跟踪'] || 0), '') + tag('已失效 ' + (lvl['已失效'] || 0), 'green') +
      tag('市场档位：' + (m.marketTier || '—'), 'blue') + tag('情绪：' + (m.marketEmotion || '—'), 'blue') + '</div></div>';

    const source =
      '<div class="card pad pb-source">' +
      '<div>候选来源：东方财富涨停池（' + E(dates || '—') + '，共 ' + E(s.historyCount) + ' 只）· 实时快照：腾讯证券 ' + E(m.quoteTick || '—') +
      ' · 日K口径：<b>' + E((s.klineSources || []).join(' / ') || '未取得') + '</b></div>' +
      '<div>预筛 ' + E(s.preselectCount) + ' 只 → 取 ' + E(s.scannedCount) + ' 只拉日K（成功 ' + E(s.klineOk) + ' 只）→ 完成划线 ' + E(s.analyzedCount) +
      ' 只 · 服务端耗时 ' + E(m.elapsedMs) + ' ms · 生成时点 ' + E(m.generatedAt) + '</div>' +
      warn +
      '<div class="pb-actions"><button class="btn btn-primary" id="pbRescan">重新扫描</button> ' +
      '<label class="small muted">候选回溯 <select class="sel" id="pbDays">' +
      [8, 10, 15].map(n => '<option value="' + n + '"' + (S.pullDays === n ? ' selected' : '') + '>近 ' + n + ' 个交易日</option>').join('') +
      '</select></label> ' +
      '<button class="btn" id="pbMethod">' + (S.pullMethodOpen ? '收起' : '查看') + '划线口径说明</button> ' +
      '<span class="small muted">本模块应用：市场板块 / 流通市值 / 涨跌幅 / 换手 / 排除ST / 关键字 / 板块筛选；「最低连板数」不适用于回调结构。</span></div></div>';

    const method = '<div class="card pad pb-method" id="pbMethodBox" style="display:' + (S.pullMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">划线口径（先看规则，再看线）</h4>' +
      (meth.steps || []).map(st => '<div class="pb-step"><b>' + E(st.name) + '</b><span>' + E(st.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(meth.caveat || '') + '</div></div>';

    const items = list.map(x =>
      '<div class="pb-item' + (x.code === S.pullSelected ? ' active' : '') + '" data-code="' + E(x.code) + '">' +
      '<div class="pb-item-top"><b>' + E(x.name) + '</b><span class="code">' + E(x.code) + '</span>' +
      '<span class="verdict ' + pbLevelClass(x.level) + '">' + E(x.level) + '</span></div>' +
      '<div class="pb-item-mid"><span>现价 <b>' + N(x.price) + '</b></span>' + PC(x.pct) + '<span>评分 <b>' + E(x.score) + '</b></span></div>' +
      '<div class="pb-item-bot"><span>涨停 ' + E(String(x.ztDate).slice(5)) + ' · 回调 ' + E(x.sinceZt) + ' 日</span>' + pbStatusTag(x.status) + '</div>' +
      '<div class="pb-item-sup">主支撑 ' + E(x.primarySupport.short) + ' ' + N(x.primarySupport.price) +
      ' · 距 ' + (x.nearPct > 0 ? '+' : '') + N(x.nearPct, 1) + '%</div></div>'
    ).join('');

    const why = s.analyzedCount
      ? '已完成划线的 ' + E(s.analyzedCount) + ' 只标的均被当前全局筛选条件过滤，请放宽市值 / 涨跌幅 / 换手 / 板块条件。'
      : '可能原因：近期涨停股大多仍在涨停当日或次日窗口内（本模块要求至少 2 根回调K线）、当日仍强势，或上游日K接口临时不可用。';
    const empty = '<div class="card empty pb-empty"><b>当前没有符合条件的回踩标的</b><br><span class="small muted">' + why +
      '系统不会用推测数据填充列表。</span><br><span class="small muted">扫描链路：候选 ' + E(s.historyCount) + ' 只 → 预筛 ' + E(s.preselectCount) +
      ' 只 → 日K成功 ' + E(s.klineOk) + '/' + E(s.scannedCount) + ' 只 → 完成划线 ' + E(s.analyzedCount) + ' 只。</span></div>';

    const body = list.length
      ? '<div class="pb-layout"><div class="pb-list" id="pbList">' + items + '</div><div class="pb-detail" id="pbDetail"></div></div>'
      : empty;
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';

    $('pane-pullback').innerHTML = head + source + '<div class="card pad bt-card" id="btCard"></div>' + method + body + disc;
    refreshBtCard();
    if ($('pbRescan')) $('pbRescan').onclick = () => loadPullback(true);
    if ($('pbDays')) $('pbDays').onchange = e => { S.pullDays = Number(e.target.value); loadPullback(true); };
    if ($('pbMethod')) $('pbMethod').onclick = () => {
      S.pullMethodOpen = !S.pullMethodOpen;
      $('pbMethodBox').style.display = S.pullMethodOpen ? '' : 'none';
      $('pbMethod').textContent = (S.pullMethodOpen ? '收起' : '查看') + '划线口径说明';
    };
    $('pane-pullback').querySelectorAll('.pb-item').forEach(el => {
      el.onclick = () => {
        S.pullSelected = el.dataset.code;
        $('pane-pullback').querySelectorAll('.pb-item').forEach(n => n.classList.toggle('active', n === el));
        renderPullDetail();
      };
    });
    renderPullDetail();
  }

  function renderPullDetail() {
    const j = S.pull; if (!j) return;
    const box = $('pbDetail'); if (!box) return;
    const x = (j.list || []).find(a => a.code === S.pullSelected);
    if (!x) { box.innerHTML = '<div class="card empty">请选择左侧标的查看 K 线图与划线解释</div>'; return; }
    box.innerHTML = detailHead(x) + klineCard(x) + lineExplanations(x) + tradePlanCard(x, j.meta || {});
  }

  function detailHead(x) {
    const ps = x.primarySupport || {}, pr = x.primaryResistance || {};
    return '<div class="card pb-detail-head">' +
      '<div class="pb-dh-top"><span class="lb-name">' + E(x.name) + '</span><span class="lb-code">' + E(x.code) + '</span>' +
      tag(x.board || '—', '') + tag(x.industry || '无行业', 'purple') + pbStatusTag(x.status) +
      '<span class="lb-spacer"></span><span class="verdict ' + pbLevelClass(x.level) + '">' + E(x.level) + '</span></div>' +
      '<div class="pb-dh-reason">结论：' + E(x.reason) + '</div>' +
      '<div class="pb-kv-grid">' +
      pbKv('现价 / 涨跌幅', N(x.price) + ' 元　' + PC(x.pct)) +
      pbKv('涨停日 / 回调', E(x.ztDate) + ' · ' + E(x.sinceZt) + ' 个交易日') +
      pbKv('阶段高点 / 回撤', N(x.swingHigh) + '（' + E(String(x.swingHighDate).slice(5)) + '）· −' + N(x.drawdown, 1) + '%') +
      pbKv('起涨低点 / 回撤比例', N(x.swingLow) + ' · 回吐 ' + N(x.retrace, 1) + '%') +
      pbKv('主支撑 / 距现价', E(ps.short) + ' ' + N(ps.price) + ' · ' + (x.nearPct > 0 ? '+' : '') + N(x.nearPct, 1) + '%') +
      pbKv('主压力 / 上方空间', (pr.short ? E(pr.short) + ' ' + N(pr.price) : '—') + ' · +' + N(x.roomPct, 1) + '%') +
      pbKv('缩量比 / RSI14', (x.volRatio === null ? '—' : N(x.volRatio) + ' 倍') + ' · ' + E(x.rsi14 === null ? '—' : x.rsi14)) +
      pbKv('MA20 / 评分', N(x.ma && x.ma.ma20) + ' · ' + (x.aboveMA20 ? '站上' : '跌破') + ' · ' + E(x.score) + ' 分') +
      '</div>' +
      '<div class="pb-trace-line">' + E(x.sourceNote) + '　|　涨停日交叉校验：' + E(x.ztSourceNote) + '</div></div>';
  }

  /** 零依赖 SVG K 线图：蜡烛 + 成交量 + 均线 + 水平支撑/压力线 + 右侧标签 + 观察区 */
  function klineCard(x) {
    const c = x.chart || {}, bars = c.bars || [];
    if (bars.length < 10) return '<div class="card empty">该标的日K数据不足，无法绘制K线图（不生成示意图）</div>';
    const W = 940, H = 438, L = 58, R = 136, PW = W - L - R;
    const PT = 28, PB = 292, VT = 312, VB = 372, DY = 392;
    let minP = Math.min(...bars.map(b => b.low)), maxP = Math.max(...bars.map(b => b.high));
    const visible = (c.lines || []).filter(l => l.price >= minP * 0.97 && l.price <= maxP * 1.03);
    visible.forEach(l => { minP = Math.min(minP, l.price); maxP = Math.max(maxP, l.price); });
    if (c.zone) { minP = Math.min(minP, c.zone[0]); maxP = Math.max(maxP, c.zone[1]); }
    minP = Math.min(minP, c.price); maxP = Math.max(maxP, c.price);
    const pad = (maxP - minP) * 0.06 || maxP * 0.02;
    minP -= pad; maxP += pad;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    const maxV = Math.max(1, ...bars.map(b => b.volume || 0));
    const cw = PW / bars.length, bw = Math.max(2, Math.min(9, cw * 0.62));
    const CX = i => L + cw * (i + 0.5);
    const a = [];
    a.push('<svg class="pb-kline" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + E(x.name) + ' 日K线与支撑压力划线">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7" stroke-width="1"/>');
      a.push('<text x="' + (L - 7) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    if (c.zone) {
      const y1 = Y(c.zone[1]), y2 = Y(c.zone[0]);
      a.push('<rect x="' + L + '" y="' + y1.toFixed(1) + '" width="' + PW + '" height="' + Math.max(2, y2 - y1).toFixed(1) + '" fill="#eaf2fd" opacity="0.8"/>');
      a.push('<text x="' + (L + 5) + '" y="' + (y1 - 4).toFixed(1) + '" font-size="10" fill="#2f6fd0">回踩观察区 ' + N(c.zone[0]) + '–' + N(c.zone[1]) + '</text>');
    }
    bars.forEach((b, i) => {
      const cx = CX(i), col = b.close >= b.open ? '#d92b2b' : '#0f9960';
      const yo = Y(b.open), yc = Y(b.close), yh = Y(b.high), yl = Y(b.low);
      const tip = E(b.date) + ' 开 ' + N(b.open) + ' 高 ' + N(b.high) + ' 低 ' + N(b.low) + ' 收 ' + N(b.close) + ' 量 ' + E(b.volume);
      a.push('<g><title>' + tip + '</title>');
      a.push('<line x1="' + cx.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yl.toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>');
      a.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Math.min(yo, yc).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.4, Math.abs(yo - yc)).toFixed(1) + '" fill="' + col + '"/></g>');
    });
    [['ma5', '#e8912a'], ['ma10', '#2f6fd0'], ['ma20', '#6d4bd6']].forEach(pair => {
      const arr = c[pair[0]] || [], pts = [];
      arr.forEach((v, i) => { if (v !== null && v !== undefined && Number.isFinite(v)) pts.push(CX(i).toFixed(1) + ',' + Y(v).toFixed(1)); });
      if (pts.length > 1) a.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + pair[1] + '" stroke-width="1.2" opacity="0.85"/>');
    });
    const labels = [];
    visible.forEach(l => {
      const y = Y(l.price), isMain = !!(x.primarySupport && l.id === x.primarySupport.id);
      const col = l.kind === 'support' ? (isMain ? '#0f7b6c' : '#2f6fd0') : '#d92b2b';
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) +
        '" stroke="' + col + '" stroke-width="' + (isMain ? 1.9 : 1.1) + '" stroke-dasharray="' + (isMain ? '7 3' : '4 4') +
        '" opacity="' + (isMain ? 0.95 : 0.7) + '"/>');
      labels.push({ y, col, text: l.id + ' ' + l.short + ' ' + N(l.price), isMain });
    });
    const py = Y(c.price);
    a.push('<line x1="' + L + '" y1="' + py.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + py.toFixed(1) + '" stroke="#1c2733" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>');
    labels.push({ y: py, col: '#1c2733', text: '现价 ' + N(c.price), dark: true });
    labels.sort((p, q) => p.y - q.y);
    let lastY = -100;
    labels.forEach(lb => {
      let ly = Math.max(PT + 10, Math.min(PB + 20, lb.y));
      if (ly - lastY < 15) ly = lastY + 15;
      lastY = ly;
      const lx = L + PW + 6, txt = lb.text.length > 17 ? lb.text.slice(0, 16) + '…' : lb.text;
      if (Math.abs(ly - lb.y) > 2)
        a.push('<line x1="' + (L + PW) + '" y1="' + lb.y.toFixed(1) + '" x2="' + (lx - 2) + '" y2="' + ly.toFixed(1) + '" stroke="' + lb.col + '" stroke-width="0.8" opacity="0.5"/>');
      a.push('<rect x="' + lx + '" y="' + (ly - 8).toFixed(1) + '" width="' + (R - 12) + '" height="15" rx="3" fill="' + lb.col + '" opacity="' + (lb.dark ? 1 : 0.92) + '"/>');
      a.push('<text x="' + (lx + 5) + '" y="' + (ly + 3).toFixed(1) + '" font-size="10" fill="#ffffff" font-weight="600">' + E(txt) + '</text>');
    });
    const zi = bars.findIndex(b => b.date === c.ztDate);
    if (zi >= 0) {
      const cx = CX(zi), top = Y(bars[zi].high);
      a.push('<path d="M' + (cx - 5).toFixed(1) + ' ' + (top - 9).toFixed(1) + ' L' + (cx + 5).toFixed(1) + ' ' + (top - 9).toFixed(1) +
        ' L' + cx.toFixed(1) + ' ' + (top - 3).toFixed(1) + ' Z" fill="#d92b2b"/>');
      a.push('<text x="' + cx.toFixed(1) + '" y="' + (top - 12).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="#d92b2b" font-weight="700">涨停</text>');
    }
    const hi = bars.findIndex(b => b.date === c.highDate);
    if (hi >= 0) {
      const cx = CX(hi), top = Y(bars[hi].high);
      a.push('<circle cx="' + cx.toFixed(1) + '" cy="' + (top - 3).toFixed(1) + '" r="2.6" fill="#d97706"/>');
      a.push('<text x="' + cx.toFixed(1) + '" y="' + (top - 7).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#d97706">阶段高</text>');
    }
    a.push('<line x1="' + L + '" y1="' + VT + '" x2="' + (L + PW) + '" y2="' + VT + '" stroke="#eef2f7"/>');
    a.push('<text x="' + (L - 7) + '" y="' + (VT + 10) + '" text-anchor="end" font-size="9" fill="#8593a3">量</text>');
    bars.forEach((b, i) => {
      const h = (b.volume || 0) / maxV * (VB - VT - 4), col = b.close >= b.open ? '#d92b2b' : '#0f9960';
      a.push('<rect x="' + (CX(i) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1, h).toFixed(1) + '" fill="' + col + '" opacity="0.55"><title>' + E(b.date) + ' 成交量 ' + E(b.volume) + '</title></rect>');
    });
    const step = Math.max(1, Math.ceil(bars.length / 6));
    bars.forEach((b, i) => {
      if (i % step === 0 || i === bars.length - 1)
        a.push('<text x="' + CX(i).toFixed(1) + '" y="' + DY + '" text-anchor="middle" font-size="9.5" fill="#8593a3">' + E(String(b.date).slice(5)) + '</text>');
    });
    const legend = [['#d92b2b', '阳线'], ['#0f9960', '阴线'], ['#e8912a', 'MA5'], ['#2f6fd0', 'MA10/支撑'], ['#6d4bd6', 'MA20'], ['#0f7b6c', '主支撑'], ['#d92b2b', '压力位']];
    let lx = L;
    legend.forEach(pair => {
      a.push('<rect x="' + lx + '" y="8" width="8" height="8" rx="2" fill="' + pair[0] + '"/>');
      a.push('<text x="' + (lx + 12) + '" y="16" font-size="10" fill="#6b7a8c">' + pair[1] + '</text>');
      lx += 92;
    });
    a.push('<text x="' + L + '" y="420" font-size="10" fill="#8593a3">日K：' + E(c.source || '—') + '（截至 ' + E(c.asOf || '—') + '，' + bars.length +
      ' 根）；划线由本系统按规则从真实日K计算，非交易所数据；鼠标悬停K线可查看当日 OHLC。</text>');
    a.push('</svg>');
    return '<div class="card pb-chart-card"><div class="pb-chart-head"><h4>日K线图与支撑 / 压力划线</h4>' + src(x.sourceNote) + '</div>' +
      '<div class="pb-svg-wrap">' + a.join('') + '</div>' +
      '<div class="note-box">图上只标注最重要的 4 条支撑 + 3 条压力（距现价过远的线不画，避免压缩K线），完整清单与每条线的生成依据见下方「划线解释」。蓝色 / 绿色虚线为支撑，红色虚线为压力，粗绿虚线为主支撑，浅蓝阴影为回踩观察区。</div></div>';
  }

  function lineExplanations(x) {
    const shown = x.chart.lines || [], ids = new Set(shown.map(l => l.id));
    const all = [...(x.supports || []), ...(x.resistances || [])];
    const cards = shown.map(l => {
      const main = !!(x.primarySupport && l.id === x.primarySupport.id);
      const col = l.kind === 'support' ? (main ? '#0f7b6c' : '#2f6fd0') : '#d92b2b';
      return '<div class="lv-card" style="border-left-color:' + col + '">' +
        '<div class="lv-top"><span class="lv-id" style="background:' + col + '">' + E(l.id) + '</span><b>' + E(l.name) + '</b>' +
        '<span class="lv-price">' + N(l.price) + ' 元</span>' + tag(l.kind === 'support' ? '支撑' : '压力', l.kind === 'support' ? 'blue' : 'red') +
        (main ? tag('主支撑', 'green') : '') +
        '<span class="lv-dist">距现价 ' + (l.distPct > 0 ? '+' : '') + N(l.distPct, 1) + '%</span></div>' +
        '<div class="lv-basis"><b>为什么画在这里：</b>' + E(l.basis) + '</div>' +
        '<div class="lv-foot">历史有效触碰 ' + E(l.touches) + ' 次' + (l.lastTouch ? '（末次 ' + E(String(l.lastTouch).slice(5)) + '）' : '') +
        ' · 强度 ' + E(l.strength) + '/3 · ' + E(l.source) + '</div></div>';
    }).join('');
    const rows = all.map(l =>
      '<tr' + (ids.has(l.id) ? ' class="lv-onchart"' : '') + '><td class="left">' + (ids.has(l.id) ? '<span class="dot-on">●</span> ' : '') + E(l.id) + '</td>' +
      '<td class="left">' + E(l.short) + '</td><td>' + N(l.price) + '</td><td>' + (l.distPct > 0 ? '+' : '') + N(l.distPct, 1) + '%</td>' +
      '<td>' + E(l.touches) + '</td><td class="left">' + tag(l.kind === 'support' ? '支撑' : '压力', l.kind === 'support' ? 'blue' : 'red') + '</td>' +
      '<td class="left small">' + E(l.basis) + '</td></tr>'
    ).join('');
    const ma = (x.maRefs || []).map(r =>
      '<div class="kv"><span class="k">' + E(r.name) + '</span><span class="v">' + N(r.price) + ' 元 · ' + E(r.note) + '</span></div>').join('');
    return '<div class="card pad pb-lines"><div class="sec-head"><h3>划线解释（逐条可追溯）</h3>' +
      src(x.chart.source + '，截至 ' + x.chart.asOf) + '</div>' +
      '<div class="pb-note">读图顺序：先看现价与主支撑的距离（是否回踩到位），再看上方压力决定空间，最后看缩量与收盘是否破位。支撑被收盘有效跌破即转为压力，这就是「支撑压力互换」。</div>' +
      '<div class="lv-grid">' + cards + '</div>' +
      '<div class="sec-head" style="margin-top:15px"><h3 style="font-size:12.5px">完整水平位清单</h3><span class="src">● 表示已画在图上</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">编号</th><th class="left">线名</th><th>价位</th><th>距现价</th><th>触碰</th><th class="left">类型</th><th class="left">生成依据</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="sec-head" style="margin-top:13px"><h3 style="font-size:12.5px">动态参考线（非水平划线）</h3></div><div class="pb-ma">' + ma + '</div>' +
      (x.klineNote ? '<div class="pb-warn">口径提示：' + E(x.klineNote) + '</div>' : '') + '</div>';
  }

  function tradePlanCard(x, m) {
    const p = x.plan || {};
    const parts = (x.scoreParts || []).map(z =>
      '<div class="sp"><span class="spn">' + E(z.factor) + '</span><div class="spb"><div class="spf" style="width:' +
      (z.max ? Math.max(0, Math.min(100, z.got / z.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(z.got) + '/' + E(z.max) + '</span></div>'
    ).join('');
    const li = arr => (arr || []).map(t => '<li>' + E(t) + '</li>').join('');
    return '<div class="pb-plan-grid">' +
      '<div class="card pad"><div class="sec-head"><h3 style="font-size:12.5px">条件化观察框架（非买卖指令）</h3></div>' +
      '<div class="zone-box"><div class="zl">回踩观察区间（元）</div><div class="zv">' + N(p.zone && p.zone[0]) + ' — ' + N(p.zone && p.zone[1]) + '</div>' +
      '<div class="zone-row"><span class="small">止损参考 <b class="down">' + N(p.stop) + '</b></span>' +
      '<span class="small">上方目标 <b class="up">' + N(p.target) + '</b></span>' +
      '<span class="small">盈亏比 <b>' + N(p.rr) + '</b></span></div></div>' +
      '<div class="note-box"><b>区间算法：</b>' + E(p.basis) + '</div>' +
      '<div class="sec-head" style="margin-top:12px"><h3 style="font-size:12.5px">评分拆解（' + E(x.score) + ' / 100）</h3></div>' +
      '<div class="score-parts">' + parts + '</div>' +
      (x.veto && x.veto.length ? '<div class="veto"><b>一票否决项（' + x.veto.length + '）：</b><br>' + x.veto.map(z => '· ' + E(z)).join('<br>') + '</div>' : '') +
      '</div>' +
      '<div class="card pad"><div class="sec-head"><h3 style="font-size:12.5px">确认条件 / 分仓路径 / 失效条件</h3></div>' +
      '<h5 class="pb-h5">需同时确认（否则不进入观察）</h5><ul class="tight">' + li(p.conditions) + '</ul>' +
      '<h5 class="pb-h5">分仓路径（研究框架示例）</h5><ul class="tight">' + li(p.steps) + '</ul>' +
      '<h5 class="pb-h5" style="color:var(--up)">计划失效条件（触发即退出）</h5><ul class="tight">' + li(p.invalid) + '</ul>' +
      '<div class="pb-trace"><h5 class="pb-h5">数据溯源</h5>' +
      '<div class="kv"><span class="k">候选涨停标记</span><span class="v">东方财富涨停池 ' + E(x.poolDate || '—') + '</span></div>' +
      '<div class="kv"><span class="k">实时价 / 涨跌幅</span><span class="v">腾讯证券 ' + E(x.quoteTick || '—') + '</span></div>' +
      '<div class="kv"><span class="k">日K与划线</span><span class="v">' + E(x.klineSource || '—') + ' · 截至 ' + E(x.lastDate || '—') + '</span></div>' +
      '<div class="kv"><span class="k">涨停日校验</span><span class="v">' + E(x.ztSourceNote) + '</span></div>' +
      '<div class="kv"><span class="k">市场档位</span><span class="v">' + E(m.marketTier || '—') + ' / ' + E(m.marketEmotion || '—') + '</span></div>' +
      '</div></div></div>';
  }

  /* ═══════════ 明日龙头 · 只做龙头 / 买在分歧卖在一致 ═══════════ */
  const dgDtypeCls = d => ({ '良性分歧': 'red', '一致加速': 'warn', '恶性分歧': 'purple', '分歧偏弱': 'blue', '中性': '' }[d] || '');
  const dgToneCls = t => ({ primary: 'red', warn: 'warn', blue: 'blue', muted: '' }[t] || '');
  const dgBar = (v, cls) => '<div class="dg-bar"><i class="' + (cls || 'blue') + '" style="width:'
    + Math.max(0, Math.min(100, Number(v) || 0)).toFixed(1) + '%"></i></div>';
  const dgNum = (v, suffix) => (v === null || v === undefined) ? '—' : E(v) + (suffix || '');

  function dgHead(j) {
    const s = j.sentiment, su = j.summary;
    return '<div class="conclusion card dg-head"><div class="lead">「只做龙头」把 ' + E(su.poolCount) +
      ' 只涨停股收敛为 <b>' + E(su.leaderCount) + '</b> 只有明确定位的龙头 / 卡位标的；当前情绪 <b>' + E(s.phase) +
      '</b>（温度 ' + E(s.temperature) + ' / 100，姿态：' + E(s.stance) + '），空间板高度 ' + E(s.maxBoards) + ' 板。' +
      '<div class="dg-head-sub">核心命题：<b>买在分歧</b>（放量换手后等次日弱转强确认）、<b>卖在一致</b>（缩量加速不追高）。下面是<b>明日盘前观察清单</b>，不是买入名单。</div></div>' +
      '<div class="tags">' + tag('涨停 ' + s.ztCount, 'red') +
      tag('炸板率 ' + dgNum(s.brokenRate, '%'), 'warn') + tag('跌停 ' + s.dtCount, 'green') +
      tag('最高 ' + s.maxBoards + ' 板', 'blue') +
      tag('昨日连板溢价 ' + (s.prevPremium === null ? '—' : (s.prevPremium > 0 ? '+' : '') + s.prevPremium + '%'), s.prevPremium < 0 ? 'green' : 'red') +
      tag('候选 ' + su.shown, 'purple') + '</div></div>';
  }

  function dgSource(j) {
    const m = j.meta, o = S.dgOpts;
    return '<div class="card pad dg-source">' +
      '<div>数据溯源：东方财富涨停 / 炸板 / 跌停池（交易日 <b>' + E(m.poolDate) + '</b>）· 历史池近 <b>' +
      E((m.historyDates || []).length) + '</b> 个交易日 · 昨日连板股今日溢价 = 腾讯证券实时快照（' +
      E(m.quotesOk) + '/' + E(m.prevCodesCount) + ' 只，时点 ' + E(m.quoteTick || '—') + '）· 指数：腾讯证券</div>' +
      '<div class="small muted">' + E(m.dataSourceNote) + ' · 生成 ' + E(m.generatedAt) + ' · 服务端耗时 ' + E(m.elapsedMs) + ' ms</div>' +
      (m.empty ? '<div class="pb-warn">' + E(m.emptyReason) + '</div>' : '') +
      (m.historyNote ? '<div class="small muted">口径：' + E(m.historyNote) + '</div>' : '') +
      '<div class="dg-actions">' +
      '<button class="btn btn-primary" id="dgReload">重新扫描</button> ' +
      '<label class="small muted">范围 <select class="sel" id="dgShowAll">' +
      '<option value="0"' + (Number(o.showAll) === 0 ? ' selected' : '') + '>仅龙头（只做龙头）</option>' +
      '<option value="1"' + (Number(o.showAll) === 1 ? ' selected' : '') + '>全池对照（含后排）</option></select></label> ' +
      '<label class="small muted">地位 <select class="sel" id="dgRole">' +
      ['全部', '空间板', '题材龙', '卡位股', '容量中军', '后排/补涨', '孤立涨停'].map(r =>
        '<option value="' + E(r) + '"' + (o.role === r ? ' selected' : '') + '>' + E(r) + '</option>').join('') +
      '</select></label> ' +
      '<label class="small muted">回溯 <select class="sel" id="dgDays">' +
      [7, 10, 12, 15].map(n => '<option value="' + n + '"' + (Number(o.days) === n ? ' selected' : '') + '>近 ' + n + ' 日</option>').join('') +
      '</select></label> ' +
      '<label class="small muted">排序 <select class="sel" id="dgSort">' +
      [['score', '观察优先级'], ['boards', '连板高度'], ['divergence', '分歧度'], ['consensus', '一致度'], ['amount', '成交额']]
        .map(p => '<option value="' + p[0] + '"' + (o.sort === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('') +
      '</select></label> ' +
      '<button class="btn" id="dgMethod">' + (S.dgMethodOpen ? '收起' : '查看') + '打法口径</button>' +
      '<span class="small muted">全局筛选（市值 / 板块 / ST / 关键字）同样作用于本模块</span></div></div>';
  }

  function dgSentimentCard(j) {
    const s = j.sentiment;
    const kpis = [
      ['涨停家数', s.ztCount, '东财涨停池'], ['炸板家数', s.zbCount, '东财炸板池'],
      ['炸板率', dgNum(s.brokenRate, '%'), '炸板/(涨停+炸板)'], ['跌停家数', s.dtCount, '东财跌停池'],
      ['最高连板', s.maxBoards + ' 板', '空间板高度'],
      ['昨日连板溢价', s.prevPremium === null ? '—' : (s.prevPremium > 0 ? '+' : '') + s.prevPremium + '%', '腾讯实时快照'],
      ['昨日涨停晋级率', dgNum(s.promoteRate, '%'), '今日仍涨停占比']
    ];
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>情绪温度计与高位反馈</h4>' +
      src('东方财富涨停/炸板/跌停池 ' + s.date + ' · 腾讯实时快照 ' + (j.meta.quoteTick || '—')) + '</div>' +
      '<div class="dg-kpi-grid">' + kpis.map(k =>
        '<div class="dg-kpi"><span>' + E(k[0]) + '</span><b>' + E(k[1]) + '</b><em>' + E(k[2]) + '</em></div>').join('') + '</div>' +
      '<div class="dg-temp"><div class="dg-temp-top"><span>情绪温度 <b>' + E(s.temperature) + '</b> / 100</span>' +
      '<span>' + tag(s.phase, 'warn') + ' ' + tag('姿态：' + s.stance, 'blue') + '</span></div>' + dgBar(s.temperature, 'blue') +
      '<div class="small muted">分档：≥70 主升 · 55~70 修复/进攻 · 42~55 高位震荡 · 28~42 分歧退潮 · &lt;28 冰点；高位负反馈强制降档</div></div>' +
      (s.deteriorateNote ? '<div class="pb-warn">' + E(s.deteriorateNote) + '</div>' : '') +
      '<div class="tbl-wrap dg-factor-tbl"><table><thead><tr><th>因子</th><th>实测值</th><th>得分</th><th>权重</th><th>口径</th></tr></thead><tbody>' +
      (s.parts || []).map(p => '<tr><td>' + E(p.name) + '</td><td>' + E(p.value === null ? '—' : p.value) +
        '</td><td>' + E(p.score) + '</td><td>' + E(p.weight) + '%</td><td class="small muted">' + E(p.detail) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      (s.idxNote ? '<div class="small muted" style="margin-top:8px">指数：' + E(s.idxNote) + '</div>' : '') +
      '<div class="note-box">' + E(s.note) + '</div></div>';
  }

  function dgLadderCard(j) {
    const s = j.sentiment;
    const max = Math.max(1, ...j.ladder.map(l => l.count));
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>连板梯队与断层</h4>' +
      src('东方财富涨停池 ' + s.date + ' · 连板数 lbc') + '</div>' +
      (j.ladder || []).map(l =>
        '<div class="dg-ladder-row"><span class="dg-lb">' + E(l.boards) + ' 板</span>' +
        '<div class="dg-ladder-track"><i style="width:' + (l.count / max * 100).toFixed(1) + '%"></i></div>' +
        '<b>' + E(l.count) + ' 家</b><span class="small muted">' + E(l.names.join('、') || '—') +
        (l.codes.length < l.count ? ' 等' : '') + '</span></div>').join('') +
      '<div class="note-box">梯队' + (s.ladderComplete ? '目前无断层（1~' + E(s.maxBoards) + ' 板均有标的）'
        : '在 ' + E(s.gaps.join('/')) + ' 板出现断层，按龙头战法属于退潮信号') +
      '；断层是退潮信号，梯队完整度决定卡位股逻辑是否成立。代表股最多显示 6 只。</div></div>';
  }

  function dgThemesCard(j) {
    const rows = (j.themes || []).slice(0, 10);
    const spark = t => {
      const max = Math.max(1, ...t.series.map(s => s.count));
      return '<div class="dg-spark" title="' + E(t.series.map(s => String(s.date).slice(4) + ':' + s.count + '家').join(' / ')) + '">' +
        t.series.map(s => '<i style="height:' + Math.max(3, s.count / max * 22) + 'px"></i>').join('') + '</div>';
    };
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>题材强度与生命周期</h4>' +
      src('东财行业分类 hybk · 近 5 个交易日涨停家数（历史池）') + '</div>' +
      (rows.length ? '<div class="tbl-wrap"><table><thead><tr><th>行业</th><th>涨停</th><th>最高板</th><th>阶段</th><th>强度</th><th>近 5 日家数</th></tr></thead><tbody>' +
        rows.map(t => '<tr><td><b>' + E(t.industry) + '</b><div class="small muted">' + E(t.names.slice(0, 3).join('、')) + '</div></td>' +
          '<td>' + E(t.count) + '</td><td>' + E(t.maxBoards) + ' 板</td><td>' + tag(t.stage, t.stage === '退潮' ? 'green' : t.stage === '高潮' ? 'warn' : 'blue') + '</td>' +
          '<td><div class="dg-mini-bar">' + dgBar(t.strength, 'purple') + '<span>' + E(t.strength) + '</span></div></td>' +
          '<td>' + spark(t) + '<div class="small muted">' + t.series.map(s => s.count).join('/') + '</div></td></tr>').join('') +
        '</tbody></table></div>' : '<div class="card empty">当日无涨停行业数据</div>') +
      '<div class="note-box">阶段由近 5 日该行业涨停家数序列、最高板变化与今日一字占比判定；东财行业分类较细，「孤立涨停」偏多是分类口径的结果，可能与市场俗称题材不同。</div></div>';
  }

  function dgValidationCard(j) {
    const v = j.validation || {};
    const emptyRate = () => ({ n: 0, promoted: 0, rate: null });
    const line = (label, o, cls) => '<div class="dg-val-row"><span>' + E(label) + '</span><b>' + E(o.n) + '</b>' +
      '<span class="small muted">晋级 ' + E(o.promoted) + '</span><b class="' + (cls || '') + '">' +
      (o.rate === null ? '—' : o.rate + '%') + '</b>' + dgBar(o.rate || 0, cls === 'down' ? 'green' : 'blue') + '</div>';
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>历史验证 · 次日晋级率</h4>' +
      src('东方财富历史涨停池近 ' + (j.meta.historyDates || []).length + ' 个交易日 · ' + (v.days || 0) + ' 组「基准日→次日」样本') + '</div>' +
      '<div class="dg-val-grid"><div><div class="dg-h5">按一致 / 分歧分类</div>' +
      line('全部龙头', v.overall || emptyRate()) + line('良性分歧', v.divergence || emptyRate()) + line('一致加速', v.consensus || emptyRate()) +
      '</div><div><div class="dg-h5">按分歧度分组</div>' +
      (v.byDivergenceBand || []).map(b => line(b.band, b)).join('') + '</div></div>' +
      (v.insufficient ? '<div class="pb-warn">样本不足：良性分歧组与一致加速组至少一组样本 &lt;20，本模块只展示计数，不据此下结论，更不能反推「分歧无效」或「追一致更好」。</div>' : '') +
      '<div class="note-box"><b>怎么读：</b>晋级率 = 次日再次涨停且连板数增加的比例，<b>不等于收益率或可交易胜率</b>。一字/秒板的一致加速股次日继续涨停概率天然更高，但往往买不进或只能涨停价成交；「卖在一致」讲的是赔率与兑现风险，不是「次日一定不涨」。</div>' +
      '<div class="note-box">' + E(v.note || '') + '</div></div>';
  }

  function dgMethodCard(j) {
    const m = j.methodology || {};
    return '<div class="card pad dg-method" id="dgMethodBox" style="display:' + (S.dgMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">' + E(m.title || '打法口径') + '（先看规则，再看结论）</h4>' +
      (m.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(m.caveat || '') + '</div></div>';
  }

  function dgListItems(j) {
    return (j.list || []).map(x =>
      '<div class="dg-item' + (x.code === S.dgSelected ? ' active' : '') + '" data-code="' + E(x.code) + '">' +
      '<div class="dg-item-top"><b>' + E(x.name) + '</b><span class="code muted">' + E(x.code) + '</span>' +
      '<span class="tag ' + dgDtypeCls(x.dtype) + '">' + E(x.dtype) + '</span>' +
      '<span class="dg-score">' + E(x.score) + '</span></div>' +
      '<div class="dg-item-mid"><span>' + E(x.boards) + ' 板</span><span class="tag ' + (x.roleRank === 1 ? 'red' : 'blue') + '">' + E(x.role) + '</span>' +
      '<span class="muted">' + E(x.industry) + '</span></div>' +
      '<div class="dg-mini-meters"><span>一致 ' + E(x.consensus) + '</span>' + dgBar(x.consensus, 'blue') +
      '<span>分歧 ' + E(x.divergence) + '</span>' + dgBar(x.divergence, 'red') + '</div>' +
      '<div class="dg-item-bot">' + E(x.script.title) + '</div></div>').join('');
  }

  function dgDetailHead(x) {
    return '<div class="card pad dg-detail-head"><div class="dg-dh-top"><h3>' + E(x.name) + ' <span class="muted" style="font-size:12px;font-weight:400">' + E(x.code) + '</span></h3>' +
      tag(x.boards + ' 板', 'red') + tag(x.role, 'blue') + tag(x.dtype, dgDtypeCls(x.dtype)) +
      tag('观察优先级 ' + x.score, 'purple') + '<span class="muted small">' + E(x.industry) + ' · ' + E(x.board) + '</span></div>' +
      '<div class="dg-dh-reason"><b>地位依据：</b>' + E(x.roleReason) + '</div>' +
      '<div class="dg-kv-grid">' +
      dgKv('收盘价', N(x.price) + ' 元') + dgKv('当日涨幅', PC(x.pct)) +
      dgKv('首次封板', E(x.firstSeal)) + dgKv('最后封板', E(x.lastSeal)) +
      dgKv('炸板次数', E(x.brokenCount) + ' 次') + dgKv('封单/流通市值', N(x.sealFundRatio) + '%') +
      dgKv('换手率', N(x.turnover) + '%') + dgKv('成交额', AMT(x.amount)) +
      dgKv('流通市值', CAP(x.floatCap)) + dgKv('近期涨停', (x.statDays === null || x.statDays === undefined ? '—' : E(x.statDays) + ' 天 ' + E(x.statCount) + ' 板')) +
      dgKv('封单额', AMT(x.sealFund)) + dgKv('所属题材阶段', x.theme ? E(x.theme.stage) + ' / 强度 ' + E(x.theme.strength) : '—') +
      '</div><div class="dg-trace">' + src(x.sourceNote) + '</div></div>';
  }
  function dgKv(k, v) { return '<div class="dg-kv"><span>' + E(k) + '</span><b>' + v + '</b></div>'; }

  function dgMeters(x) {
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>一致度 / 分歧度（0~100，全部由真实封板字段计算）</h4></div>' +
      '<div class="dg-meter-block"><div class="dg-meter-top"><b>一致度 ' + E(x.consensus) + '</b>' +
      '<span class="small muted">早封 + 零炸板 + 高封单比 + 低换手 = 筹码锁定</span></div>' + dgBar(x.consensus, 'blue') + '</div>' +
      '<div class="dg-meter-block"><div class="dg-meter-top"><b>分歧度 ' + E(x.divergence) + '</b>' +
      '<span class="small muted">炸板 + 换手 + 封板晚 + 封单弱 + 放量 = 筹码交换</span></div>' + dgBar(x.divergence, 'red') + '</div>' +
      '<div class="note-box">' + E(x.benignRule) + '；当前判定：<b>' + E(x.dtype) + '</b>。</div>' +
      '<div class="dg-factor-grid"><div><div class="dg-h5">一致度因子</div>' +
      (x.consensusParts || []).map(p => '<div class="dg-factor"><span>' + E(p.name) + ' <em>权重' + E(p.weight) + '%</em></span>' +
        '<b>' + E(p.got) + '</b>' + dgBar(p.got, 'blue') + '<small>' + E(p.detail) + '</small></div>').join('') +
      '</div><div><div class="dg-h5">分歧度因子</div>' +
      (x.divergenceParts || []).map(p => '<div class="dg-factor"><span>' + E(p.name) + ' <em>权重' + E(p.weight) + '%</em></span>' +
        '<b>' + E(p.got) + '</b>' + dgBar(p.got, 'red') + '<small>' + E(p.detail) + '</small></div>').join('') +
      '</div></div></div>';
  }

  function dgScriptCard(x) {
    const sc = x.script || {};
    return '<div class="card pad dg-card dg-script ' + (sc.tone || '') + '"><div class="dg-card-head">' +
      '<h4>' + E(sc.title) + '</h4>' + tag('明日条件化剧本', dgToneCls(sc.tone)) + '</div>' +
      '<div class="dg-thesis">' + E(sc.thesis) + '</div>' +
      '<div class="dg-h5">触发条件 → 观察结论</div>' +
      (sc.triggers || []).map((t, i) => '<div class="dg-trigger"><b>' + (i + 1) + '</b>' +
        '<div><span class="dg-cond">若 ' + E(t.condition) + '</span><span class="dg-action">→ ' + E(t.action) + '</span></div></div>').join('') +
      '<div class="dg-h5">失效条件 / 证伪信号</div><ul class="dg-list-plain">' +
      (sc.invalidation || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul>' +
      '<div class="dg-risk"><b>风险：</b>' + E(sc.risk) + '</div>' +
      '<div class="dg-h5">明日需同步观察</div><ul class="dg-list-plain">' +
      (x.watch || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>';
  }

  function dgScoreCard(x) {
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>观察优先级评分明细</h4>' +
      '<span class="small muted">满分 100 = 地位 30 + 分歧质量 25 + 题材 20 + 情绪 15 − 风险 10</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>因子</th><th>得分</th><th>上限</th><th>依据</th></tr></thead><tbody>' +
      (x.scoreParts || []).map(p => '<tr><td>' + E(p.name) + '</td><td><b>' + E(p.got) + '</b></td><td>' +
        (p.max === 0 ? '扣减项' : E(p.max)) + '</td><td class="small muted">' + E(p.detail) + '</td></tr>').join('') +
      '</tbody></table></div><div class="note-box">排序是「明日观察优先级」，不是收益预测，更不是买入建议；一致加速的一字板在此项会被扣分。</div></div>';
  }

  function renderDragonDetail() {
    const j = S.dg; if (!j) return;
    const box = $('dgDetail'); if (!box) return;
    const x = (j.list || []).find(a => a.code === S.dgSelected);
    if (!x) { box.innerHTML = '<div class="card empty">请选择左侧标的查看地位依据、一致/分歧拆解与明日剧本</div>'; return; }
    box.innerHTML = dgDetailHead(x) + dgMeters(x) + dgScriptCard(x) + dgScoreCard(x);
  }

  function renderDragon() {
    const j = S.dg; if (!j) return;
    const s = j.sentiment, list = j.list || [];
    const focus = '<div class="card pad dg-card"><div class="dg-card-head"><h4>明日 3 个核心变量</h4>' +
      '<span class="small muted">由今日真实梯队 / 情绪 / 题材数据生成，不是预测</span></div>' +
      (j.focus || []).map((f, i) => '<div class="dg-focus"><b>' + (i + 1) + '</b><span>' + E(f) + '</span></div>').join('') + '</div>';
    const empty = '<div class="card empty dg-empty"><b>当前没有符合条件的龙头候选</b><br>' +
      '<span class="small muted">' + (j.meta.empty ? E(j.meta.emptyReason)
        : '「只做龙头」纪律下已剔除 ' + E((j.excluded || []).length) + ' 只后排 / 孤立涨停。可切换「全池对照」查看被剔除标的，或放宽地位筛选。系统不会用推测数据填充。') +
      '</span></div>';
    const body = list.length
      ? '<div class="dg-layout"><div class="dg-list" id="dgList">' + dgListItems(j) + '</div>' +
      '<div class="dg-detail" id="dgDetail"></div></div>'
      : empty;
    const excl = (j.excluded || []).length && Number(S.dgOpts.showAll) === 0
      ? '<div class="card pad dg-card dg-excluded"><div class="dg-h5">「只做龙头」纪律剔除（' + E(j.excluded.length) + ' 只，仅作对照）</div>' +
      '<div class="dg-excl-tags">' + j.excluded.slice(0, 18).map(x =>
        '<span class="tag" title="' + E(x.roleReason) + '">' + E(x.name) + ' ' + E(x.boards) + '板 · ' + E(x.role) + '</span>').join('') +
      (j.excluded.length > 18 ? '<span class="small muted">等共 ' + E(j.excluded.length) + ' 只</span>' : '') + '</div></div>' : '';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';
    $('pane-dragon').innerHTML = dgHead(j) + dgSource(j) + dgSentimentCard(j) +
      '<div class="dg-grid2">' + dgLadderCard(j) + dgThemesCard(j) + '</div>' +
      focus + dgValidationCard(j) + dgMethodCard(j) + body + excl + disc;

    $('dgReload').onclick = () => loadDragon(true);
    $('dgShowAll').onchange = e => { S.dgOpts.showAll = Number(e.target.value); loadDragon(true); };
    $('dgRole').onchange = e => { S.dgOpts.role = e.target.value; loadDragon(true); };
    $('dgDays').onchange = e => { S.dgOpts.days = Number(e.target.value); loadDragon(true); };
    $('dgSort').onchange = e => { S.dgOpts.sort = e.target.value; loadDragon(true); };
    $('dgMethod').onclick = () => {
      S.dgMethodOpen = !S.dgMethodOpen;
      $('dgMethodBox').style.display = S.dgMethodOpen ? '' : 'none';
      $('dgMethod').textContent = (S.dgMethodOpen ? '收起' : '查看') + '打法口径';
    };
    $('pane-dragon').querySelectorAll('.dg-item').forEach(el => {
      el.onclick = () => {
        S.dgSelected = el.dataset.code;
        $('pane-dragon').querySelectorAll('.dg-item').forEach(n => n.classList.toggle('active', n === el));
        renderDragonDetail();
      };
    });
    renderDragonDetail();
  }

  async function fetchDragonJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/dragon?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '），请确认访问的是本系统地址'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        if (!S.dg) $('pane-dragon').innerHTML = '<div class="card empty">本地服务未响应，正在重连…（第 ' + (i + 1) + ' 次）</div>';
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  async function loadDragon(force) {
    if (S.dgLoading) return;
    S.dgLoading = true;
    if (!S.dg) $('pane-dragon').innerHTML = '<div class="card empty">正在回溯涨停/炸板池、核对连板梯队与封板质量，生成明日观察清单…</div>';
    const q = new URLSearchParams();
    const o = S.dgOpts;
    ['days', 'showAll', 'sort', 'sortDir', 'role', 'limit'].forEach(k => {
      if (o[k] !== '' && o[k] !== undefined && o[k] !== null) q.set(k, o[k]);
    });
    // 复用全局筛选（与本模块相关的字段）
    const f = collectFilters();
    ['board', 'capMin', 'capMax', 'excludeST', 'keyword'].forEach(k => {
      if (f[k] !== '' && f[k] !== undefined && f[k] !== null) q.set(k, f[k]);
    });
    if (force) q.set('force', '1');
    try {
      const j = await fetchDragonJson(q);
      S.dg = j; S.dgAt = Date.now(); S.dgError = null; S.dgFilters = S.lastFilters;
      const list = j.list || [];
      if (!list.some(x => x.code === S.dgSelected)) S.dgSelected = list.length ? list[0].code : null;
      renderDragon();
      $('badgeDragon').textContent = list.length;
    } catch (e) {
      S.dgError = e.message;
      const offline = isConnError(e);
      $('badgeDragon').textContent = '—';
      $('pane-dragon').innerHTML = '<div class="card empty"><b>明日龙头数据加载失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (offline ? E(SERVICE_HINT)
          : '服务端或上游数据源返回异常；系统不会用推测数据填充，稍后可点下方按钮重试。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="dgRetry">重新扫描</button></div>';
      $('dgRetry').onclick = () => loadDragon(true);
      if (offline) watchService('dragon');
    } finally { S.dgLoading = false; }
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
      (h.standby ? '<span class="mini-tag">备用源</span>' : '') +
      '<span class="muted">' + (h.ok ? '在线 · ' + E(h.rows) + ' 条 · ' + E(h.latency) + 'ms'
        : (h.standby ? '未启用（主源可用时不调用）' : '异常 · ' + E(h.error || '未知'))) + '</span></div>'
    ).join('') +
      ((m.health || []).some(h => h.key === 'qqKline' && !h.ok) && (m.health || []).some(h => h.standby && h.ok)
        ? '<div class="note-box" style="margin-top:8px">腾讯前复权日K当前不可用，系统已自动切换「新浪财经日K（不复权）」；涉及历史价位的划线可能与前复权口径不一致，相关模块已如实标注口径。</div>' : '');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
