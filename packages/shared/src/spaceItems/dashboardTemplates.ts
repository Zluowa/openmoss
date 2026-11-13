// FILE: dashboardTemplates.ts
// Purpose: Built-in 数据看板 templates: a sales dashboard over a sample file, written to the
//          dashboard rules (one writer, marks, calcs, tooltips, a filter, narrow-width layout).
// Layer: Shared model (template data)
// Exports: SALES_DASHBOARD, salesDashboardData

import { createDashboard, type DashboardItem } from "./dashboard";

const SALES_CSV = `month,region,revenue,orders,target
2026-05,华东,128,410,120
2026-06,华东,136,432,125
2026-07,华东,149,468,130
2026-08,华东,145,455,140
2026-09,华东,162,501,150
2026-10,华东,178,540,160
2026-05,华南,96,322,100
2026-06,华南,101,330,100
2026-07,华南,108,351,105
2026-08,华南,117,368,110
2026-09,华南,121,380,115
2026-10,华南,134,402,120
2026-05,华北,88,290,90
2026-06,华北,92,301,92
2026-07,华北,90,296,95
2026-08,华北,97,312,98
2026-09,华北,104,330,100
2026-10,华北,109,341,105
`;

const PAGE = `<meta name="dash-one-writer">
<style>
.sd{display:flex;flex-direction:column;gap:var(--dash-gap-md);max-width:1120px;margin:0 auto}
.sd-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--dash-gap-sm)}
.sd-title{font-size:var(--dash-size-title);line-height:28px;font-weight:535;margin:0}
.sd-lede{color:var(--dash-fg-muted);margin:4px 0 0}
.sd-filter{display:flex;align-items:center;gap:8px;color:var(--dash-fg-muted);font-size:var(--dash-size-caption)}
.sd-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--dash-gap-sm)}
.sd-card{background:var(--dash-panel);border:1px solid var(--dash-line);border-radius:var(--dash-radius);padding:var(--dash-pad-lg);min-width:0}
.sd-label{color:var(--dash-fg-muted);font-size:var(--dash-size-caption)}
.sd-big{font-family:var(--dash-font-number);font-size:30px;line-height:36px;font-variant-numeric:tabular-nums;margin-top:6px}
.sd-change{font-size:var(--dash-size-caption);margin-top:2px;font-variant-numeric:tabular-nums}
.sd-change[data-good=yes]{color:var(--dash-ok)}.sd-change[data-good=no]{color:var(--dash-bad)}
.sd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--dash-gap-sm)}
.sd-chart{position:relative;min-height:240px;margin-top:8px}
.sd-chart svg text{fill:var(--dash-fg-muted);font-size:11px}
.sd-chart .domain{stroke:var(--dash-chart-axis)}.sd-chart .tick line{stroke:var(--dash-chart-grid)}
.sd-tip{position:absolute;pointer-events:none;background:var(--dash-tip-bg);border:1px solid var(--dash-tip-line);box-shadow:var(--dash-tip-shadow);border-radius:8px;padding:6px 8px;font-size:12px;white-space:nowrap;opacity:0;transform:translate(-50%,-100%)}
.sd-legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--dash-fg-muted);font-size:var(--dash-size-caption);margin-top:6px}
.sd-legend i{display:inline-block;width:10px;height:2px;margin-right:6px;vertical-align:middle}
.sd-wrap{overflow-x:auto}
.sd-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.sd-more{color:var(--dash-fg-muted);font-size:var(--dash-size-caption)}
.sd-table th{color:var(--dash-fg-muted);font-weight:475;font-size:var(--dash-size-caption);text-align:left}
.sd-table th,.sd-table td{padding:7px 8px;border-bottom:1px solid var(--dash-line);white-space:nowrap}
.sd-table td.num,.sd-table th.num{text-align:right}
.sd-empty{color:var(--dash-fg-muted);font-size:var(--dash-size-caption);padding:24px 0;text-align:center}
[data-dash-source-state=refreshing]{opacity:.5}
</style>
<div class="sd">
  <div class="sd-head" id="head">
    <div>
      <h1 class="sd-title" id="title">销售看板</h1>
      <p class="sd-lede" id="lede">10 月收入 <b data-draw="total" data-source="oct" data-field="revenue" data-where="region=">—</b> 万元，<span data-draw="verdict">—</span></p>
    </div>
    <label class="sd-filter">区域 <select class="dash-select" data-draw="region" aria-label="区域" data-source="sales"></select></label>
  </div>
  <div class="sd-tiles" id="tiles">
    <div class="sd-card" id="tile-revenue"><div class="sd-label">收入（万元）· 2026 年 10 月</div><div class="sd-big" data-draw="revenue" data-source="oct" data-field="revenue" data-where="region=">—</div><div class="sd-change" data-draw="revenue-change">—</div></div>
    <div class="sd-card" id="tile-orders"><div class="sd-label">订单数 · 2026 年 10 月</div><div class="sd-big" data-draw="orders" data-source="oct" data-field="orders" data-where="region=">—</div><div class="sd-change" data-draw="orders-change">—</div></div>
    <div class="sd-card" id="tile-target"><div class="sd-label">目标完成率 · 2026 年 10 月</div><div class="sd-big" data-draw="attain" data-source="oct" data-field="attainment" data-where="region=">—</div><div class="sd-change" data-draw="attain-note">—</div></div>
  </div>
  <div class="sd-grid">
    <div class="sd-card" id="trend"><div class="sd-label">月度收入（万元）</div><div class="sd-chart" data-draw="trend" data-source="monthly"></div><div class="sd-legend" data-draw="legend"></div></div>
    <div class="sd-card" id="by-region"><div class="sd-label">10 月各区域收入与目标（万元）</div><div class="sd-chart" data-draw="bars" data-source="sales"></div></div>
  </div>
  <div class="sd-card sd-wrap" id="detail">
    <div class="sd-label" style="margin-bottom:6px">明细</div>
    <table class="sd-table" id="rows" data-source="sales" data-row-key="month,region">
      <thead><tr><th data-field="month">月份</th><th data-field="region">区域</th><th class="num" data-field="revenue">收入</th><th class="num" data-field="orders">订单</th><th class="num" data-field="target">目标</th></tr></thead>
      <tbody data-draw="rows"></tbody>
    </table>
  </div>
</div>
<script>
// Monthly totals per region, and for all regions (region "").
dash.calc('monthly', {
  inputs: ['sales'],
  title: '每月合计',
  description: '每个区域、以及全部区域每月的收入、订单和目标之和',
  fn: (sales) => {
    const months = [...new Set(sales.map((r) => r.month))].sort();
    const regions = ['', ...new Set(sales.map((r) => r.region))];
    return regions.flatMap((region) => months.map((month) => {
      const of = sales.filter((r) => r.month === month && (!region || r.region === region));
      const sum = (key) => of.reduce((total, r) => total + Number(r[key]), 0);
      return { region, month, revenue: sum('revenue'), orders: sum('orders'), target: sum('target') };
    }));
  },
});
// The latest month against the one before, per region.
dash.calc('oct', {
  inputs: ['monthly'],
  title: '最近一个月',
  description: '最近一个月的合计、环比和目标完成率（每个区域一行）',
  fn: (monthly) => [...new Set(monthly.map((r) => r.region))].map((region) => {
    const rows = monthly.filter((r) => r.region === region);
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    return { region, month: last.month, revenue: last.revenue, orders: last.orders, target: last.target,
      attainment: Math.round((last.revenue / last.target) * 1000) / 10,
      revenue_change: prev ? Math.round(((last.revenue - prev.revenue) / prev.revenue) * 1000) / 10 : null,
      orders_change: prev ? Math.round(((last.orders - prev.orders) / prev.orders) * 1000) / 10 : null };
  }),
});
</script>
<script>
const fmt = d3.format(',');
const region = () => dash.params().region || '';
const one = () => { const d = dash.data('oct'); return d.status === 'ok' ? d.data.find((r) => r.region === region()) || null : null; };
// A mark names the row it shows; the row follows the region filter.
const mark = (el) => el.setAttribute('data-where', 'region=' + encodeURIComponent(region()));
const change = (el, value) => {
  if (value === null || value === undefined) { el.textContent = '—'; el.removeAttribute('data-good'); return; }
  el.textContent = (value >= 0 ? '+' : '') + value.toFixed(1) + '% 较 9 月';
  el.setAttribute('data-good', value >= 0 ? 'yes' : 'no');
};
dash.draw('total', (el) => { mark(el); const r = one(); el.textContent = r ? fmt(r.revenue) : '—'; });
dash.draw('verdict', (el) => { const r = one(); el.textContent = !r ? '—' : r.revenue >= r.target ? '高于目标。' : '低于目标。'; });
dash.draw('revenue', (el) => { mark(el); const r = one(); el.textContent = r ? fmt(r.revenue) : '—'; });
dash.draw('orders', (el) => { mark(el); const r = one(); el.textContent = r ? fmt(r.orders) : '—'; });
dash.draw('attain', (el) => { mark(el); const r = one(); el.textContent = r ? r.attainment.toFixed(1) + '%' : '—'; });
dash.draw('revenue-change', (el) => { const r = one(); change(el, r ? r.revenue_change : null); });
dash.draw('orders-change', (el) => { const r = one(); change(el, r ? r.orders_change : null); });
dash.draw('attain-note', (el) => { const r = one(); el.textContent = r ? '目标 ' + fmt(r.target) + ' 万元' : '—'; });
dash.draw('region', (select) => {
  const d = dash.data('sales');
  const regions = d.status === 'ok' ? [...new Set(d.data.map((r) => r.region))] : [];
  if (select.options.length !== regions.length + 1) select.replaceChildren(new Option('全部区域', ''), ...regions.map((r) => new Option(r, r)));
  if (document.activeElement !== select) select.value = dash.params().region || '';
  select.onchange = () => dash.setParams({ region: select.value || null });
});
dash.draw('rows', (body) => {
  const d = dash.data('sales');
  body.replaceChildren();
  if (d.status !== 'ok') return;
  const region = dash.params().region || '';
  // A long file would make a huge table: show the first 200 rows and say how many there are.
  const shown = d.data.filter((x) => !region || x.region === region);
  for (const r of shown.slice(0, 200)) {
    const tr = document.createElement('tr');
    for (const key of ['month', 'region', 'revenue', 'orders', 'target']) {
      const td = document.createElement('td');
      td.textContent = key === 'month' || key === 'region' ? r[key] : fmt(Number(r[key]));
      if (key !== 'month' && key !== 'region') td.className = 'num';
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  if (shown.length > 200) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'sd-more';
    td.textContent = '只显示前 200 行，共 ' + fmt(shown.length) + ' 行';
    tr.appendChild(td);
    body.appendChild(tr);
  }
});
dash.draw('legend', (el) => {
  el.replaceChildren();
  const add = (label, color, dashed) => { const s = document.createElement('span'); const i = document.createElement('i'); i.style.background = color; if (dashed) i.style.opacity = '.6'; s.append(i, label); el.append(s); };
  add('收入', dash.colors[0]); add('目标', 'var(--dash-chart-reference)', true);
});
dash.draw('trend', {
  mount: (el) => { const tip = document.createElement('div'); tip.className = 'sd-tip'; el.append(tip); return { tip }; },
  update: (el, made) => {
    const d = dash.data('monthly');
    el.querySelectorAll('svg,.sd-empty').forEach((n) => n.remove());
    if (d.status !== 'ok') { const p = document.createElement('div'); p.className = 'sd-empty'; p.textContent = d.status === 'error' ? '没有载入' : '—'; el.prepend(p); return; }
    const rows = d.data.filter((r) => r.region === region());
    const top = d3.max(rows, (r) => Math.max(r.revenue, r.target)) * 1.12;
    // The left margin fits the longest tick label.
    const W = Math.max(280, el.clientWidth), H = 240, m = { t: 12, r: 16, b: 26, l: Math.max(40, fmt(Math.ceil(top)).length * 7 + 12) };
    const x = d3.scalePoint(rows.map((r) => r.month), [m.l, W - m.r]);
    const y = d3.scaleLinear([0, top], [H - m.b, m.t]).nice();
    const svg = d3.select(el).insert('svg', ':first-child').attr('width', '100%').attr('viewBox', '0 0 ' + W + ' ' + H).attr('role', 'img').attr('aria-label', '月度收入折线图');
    svg.append('g').attr('transform', 'translate(0,' + (H - m.b) + ')').call(d3.axisBottom(x).tickFormat((v) => Number(v.slice(5)) + '月').tickSizeOuter(0));
    svg.append('g').attr('transform', 'translate(' + m.l + ',0)').call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r))).call((g) => g.select('.domain').remove());
    svg.append('path').datum(rows).attr('fill', 'none').style('stroke', 'var(--dash-chart-reference)').attr('stroke-dasharray', '4 4').attr('stroke-width', 1.5).attr('d', d3.line((r) => x(r.month), (r) => y(r.target)));
    svg.append('path').datum(rows).attr('fill', 'none').style('stroke', dash.colors[0]).attr('stroke-width', 2).attr('d', d3.line((r) => x(r.month), (r) => y(r.revenue)));
    svg.selectAll('circle').data(rows).join('circle').attr('cx', (r) => x(r.month)).attr('cy', (r) => y(r.revenue)).attr('r', 4).style('fill', dash.colors[0])
      .on('pointerenter', (event, r) => { made.tip.textContent = Number(r.month.slice(5)) + ' 月：收入 ' + fmt(r.revenue) + '，目标 ' + fmt(r.target); made.tip.style.left = (x(r.month) / W * el.clientWidth) + 'px'; made.tip.style.top = (y(r.revenue) / H * el.clientHeight - 8) + 'px'; made.tip.style.opacity = 1; })
      .on('pointerleave', () => { made.tip.style.opacity = 0; });
    const last = rows[rows.length - 1];
    if (last) svg.append('text').attr('x', x(last.month)).attr('y', y(last.revenue) - 10).attr('text-anchor', 'end').style('fill', 'var(--dash-fg)').text(fmt(last.revenue));
  },
});
dash.draw('bars', {
  mount: (el) => { const tip = document.createElement('div'); tip.className = 'sd-tip'; el.append(tip); return { tip }; },
  update: (el, made) => {
    const d = dash.data('sales');
    el.querySelectorAll('svg,.sd-empty').forEach((n) => n.remove());
    if (d.status !== 'ok') { const p = document.createElement('div'); p.className = 'sd-empty'; p.textContent = d.status === 'error' ? '没有载入' : '—'; el.prepend(p); return; }
    const month = d3.max(d.data, (r) => r.month);
    // One bar per region: a file may hold many rows per region and month.
    const rows = d3.rollups(d.data.filter((r) => r.month === month), (g) => ({ revenue: d3.sum(g, (r) => Number(r.revenue)), target: d3.sum(g, (r) => Number(r.target)) }), (r) => r.region).map(([region, v]) => ({ region, ...v }));
    const picked = dash.params().region || '';
    const top = d3.max(rows, (r) => Math.max(r.revenue, r.target)) * 1.15;
    const W = Math.max(280, el.clientWidth), H = 240, m = { t: 12, r: 16, b: 26, l: Math.max(40, fmt(Math.ceil(top)).length * 7 + 12) };
    const x = d3.scaleBand(rows.map((r) => r.region), [m.l, W - m.r]).padding(0.35);
    const y = d3.scaleLinear([0, top], [H - m.b, m.t]).nice();
    const svg = d3.select(el).insert('svg', ':first-child').attr('width', '100%').attr('viewBox', '0 0 ' + W + ' ' + H).attr('role', 'img').attr('aria-label', '各区域收入柱状图');
    svg.append('g').attr('transform', 'translate(0,' + (H - m.b) + ')').call(d3.axisBottom(x).tickSizeOuter(0));
    svg.append('g').attr('transform', 'translate(' + m.l + ',0)').call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r))).call((g) => g.select('.domain').remove());
    svg.selectAll('rect').data(rows).join('rect').attr('x', (r) => x(r.region)).attr('width', x.bandwidth()).attr('y', (r) => y(r.revenue)).attr('height', (r) => y(0) - y(r.revenue)).attr('rx', 3)
      .style('fill', (r) => (!picked || r.region === picked ? dash.colors[0] : 'var(--dash-chart-muted)')).style('cursor', 'pointer')
      .on('click', (event, r) => dash.setParams({ region: picked === r.region ? null : r.region }))
      .on('pointerenter', (event, r) => { made.tip.textContent = r.region + '：' + fmt(r.revenue) + ' / 目标 ' + fmt(r.target); made.tip.style.left = ((x(r.region) + x.bandwidth() / 2) / W * el.clientWidth) + 'px'; made.tip.style.top = (y(r.revenue) / H * el.clientHeight - 8) + 'px'; made.tip.style.opacity = 1; })
      .on('pointerleave', () => { made.tip.style.opacity = 0; });
    svg.selectAll('line.goal').data(rows).join('line').attr('class', 'goal').attr('x1', (r) => x(r.region) - 4).attr('x2', (r) => x(r.region) + x.bandwidth() + 4).attr('y1', (r) => y(r.target)).attr('y2', (r) => y(r.target)).style('stroke', 'var(--dash-chart-reference)').attr('stroke-width', 2);
    svg.selectAll('text.value').data(rows).join('text').attr('class', 'value').attr('x', (r) => x(r.region) + x.bandwidth() / 2).attr('y', (r) => y(r.revenue) - 6).attr('text-anchor', 'middle').style('fill', 'var(--dash-fg)').text((r) => fmt(r.revenue));
  },
});
</script>
`;

export function salesDashboardData(): DashboardItem {
  const base = createDashboard("销售看板");
  const at = "2026-11-13T00:00:00.000Z";
  return {
    ...base,
    params: { region: "" },
    datasets: {
      sales: {
        title: "示例：各区域月度销售",
        description: "Moss 写的示例数据，三个区域 5–10 月的收入、订单和目标，用来演示看板。",
        source: { kind: "file", name: "sales.csv", format: "csv", text: SALES_CSV },
        updated: { at, by: "Moss" },
        fixed: true,
        edit: { via: "moss", at },
      },
    },
    files: { "index.html": { text: PAGE, edit: { via: "moss", at } } },
  };
}

export const SALES_DASHBOARD = JSON.stringify(salesDashboardData());
