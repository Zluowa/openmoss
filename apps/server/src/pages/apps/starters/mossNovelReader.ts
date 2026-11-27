export const MOSS_NOVEL_READER_STARTER_ID = "moss-novel-reader-v1";
export const MOSS_NOVEL_READER_TITLE = "静读 · 小说阅读器";
export const MOSS_NOVEL_READER_DESCRIPTION =
  "支持本地 TXT / Markdown 导入、双栏翻页、护眼纸张主题、目录、全文搜索、书签与笔记导出的原生阅读器。";

export const MOSS_NOVEL_READER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>静读 · 小说阅读器</title>
  <script type="application/json" id="moss-app-manifest">
  {
    "title": "静读 · 小说阅读器",
    "description": "支持本地 TXT / Markdown 导入、双栏翻页、护眼纸张主题、目录、全文搜索、书签与笔记导出的原生阅读器。",
    "capabilities": {}
  }
  </script>
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f7f8fa;
      --surface-2: #eff1f5;
      --border: #e5e7eb;
      --text: #18181b;
      --muted: #64748b;
      --accent: #2563eb;
      --accent-soft: rgba(37, 99, 235, 0.1);
      --reader-font: "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, serif;
      --reader-size: 17px;
      --reader-line: 1.85;
      --reader-width: 740px;
    }
    [data-theme="sepia"] {
      --bg: #f6efe2;
      --surface: #efe5d3;
      --surface-2: #e5d8c2;
      --border: #ddd0ba;
      --text: #3d3126;
      --muted: #7a6a58;
      --accent: #b45309;
      --accent-soft: rgba(180, 83, 9, 0.12);
    }
    [data-theme="sage"] {
      --bg: #eaf3ea;
      --surface: #dfece0;
      --surface-2: #d3e4d5;
      --border: #c5d9c7;
      --text: #1e3324;
      --muted: #52705a;
      --accent: #15803d;
      --accent-soft: rgba(21, 128, 61, 0.12);
    }
    [data-theme="slate"] {
      --bg: #23262d;
      --surface: #2b2f38;
      --surface-2: #343944;
      --border: #3d4350;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #60a5fa;
      --accent-soft: rgba(96, 165, 250, 0.16);
    }
    [data-theme="oled"] {
      --bg: #0c0d10;
      --surface: #15171c;
      --surface-2: #1f222a;
      --border: #282c36;
      --text: #e4e4e7;
      --muted: #8b8f9c;
      --accent: #93c5fd;
      --accent-soft: rgba(147, 197, 253, 0.16);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: 0;
      cursor: pointer;
    }
    .app-shell {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      background: var(--bg);
      transition: background-color 180ms ease, color 180ms ease;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      height: 48px;
      padding: 0 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 92%, transparent);
      backdrop-filter: blur(8px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand h1 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }
    .brand-meta {
      font-size: 12px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 10px;
      border-radius: 7px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid transparent;
      color: var(--muted);
      transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
    }
    .btn:hover { background: var(--surface); color: var(--text); }
    .btn.active {
      background: var(--accent-soft);
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 26%, transparent);
    }
    .btn-primary {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    .btn-primary:hover {
      background: color-mix(in srgb, var(--accent) 88%, #000);
      color: #ffffff;
    }
    .main-grid {
      flex: 1;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      min-height: 0;
    }
    .drawer {
      width: 276px;
      border-right: 1px solid var(--border);
      background: var(--surface);
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 82px);
    }
    .drawer.hidden { display: none; }
    .drawer-tabs {
      display: flex;
      padding: 8px;
      gap: 4px;
      border-bottom: 1px solid var(--border);
    }
    .drawer-tab {
      flex: 1;
      height: 28px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
    }
    .drawer-tab.active {
      background: var(--bg);
      color: var(--text);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    .drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .drawer-item {
      width: 100%;
      text-align: left;
      padding: 8px 10px;
      border-radius: 7px;
      margin-bottom: 2px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .drawer-item:hover { background: var(--surface-2); }
    .drawer-item.active {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .drawer-item-title { font-size: 12.5px; font-weight: 500; line-height: 1.4; }
    .drawer-item-sub { font-size: 11px; color: var(--muted); }
    .search-box {
      width: 100%;
      height: 32px;
      padding: 0 10px;
      margin-bottom: 8px;
      border-radius: 7px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 12.5px;
      outline: none;
    }
    .search-box:focus { border-color: var(--accent); }
    .bookshelf-view {
      padding: 28px 24px;
      max-width: 1020px;
      width: 100%;
      margin: 0 auto;
    }
    .shelf-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }
    .shelf-title { margin: 0; font-size: 18px; font-weight: 600; }
    .shelf-sub { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
    .shelf-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 16px;
    }
    .book-card {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 14px;
      transition: transform 140ms ease, border-color 140ms ease;
    }
    .book-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .book-cover {
      height: 92px;
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      color: #ffffff;
      font-family: "Noto Serif SC", Georgia, serif;
      font-weight: 600;
      font-size: 15px;
      line-height: 1.3;
    }
    .book-meta { font-size: 12px; color: var(--muted); line-height: 1.5; }
    .reader-wrap {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      padding: 24px 20px 64px;
      align-items: center;
    }
    .reader-paper {
      width: 100%;
      max-width: var(--reader-width);
      font-family: var(--reader-font);
      font-size: var(--reader-size);
      line-height: var(--reader-line);
    }
    .chapter-header {
      margin-bottom: 24px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .chapter-kicker {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      font-size: 11.5px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .chapter-title {
      margin: 0;
      font-size: 1.55em;
      line-height: 1.35;
      font-weight: 700;
    }
    .chapter-content p {
      margin: 0 0 1.05em;
      text-align: justify;
      text-indent: 2em;
    }
    .chapter-content p.quote {
      text-indent: 0;
      padding: 10px 14px;
      border-left: 3px solid var(--accent);
      background: var(--surface);
      border-radius: 0 8px 8px 0;
      font-size: 0.94em;
      color: var(--muted);
    }
    .reader-paper.paged {
      max-width: 1040px;
    }
    .paged-viewport {
      overflow: hidden;
      height: calc(100vh - 208px);
      min-height: 360px;
    }
    .paged-track {
      height: 100%;
      column-gap: 56px;
      column-fill: auto;
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .paged-track.two-col { column-count: 2; }
    .paged-track.one-col { column-count: 1; }
    .paged-track p { break-inside: avoid; }
    .chapter-footer-nav {
      margin-top: 28px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .settings-popover {
      position: fixed;
      top: 56px;
      right: 18px;
      z-index: 40;
      width: 300px;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg);
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.16);
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 12.5px;
    }
    .settings-popover.hidden { display: none; }
    .setting-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--text);
    }
    .theme-swatches {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
    }
    .swatch {
      height: 30px;
      border-radius: 7px;
      border: 2px solid transparent;
      font-size: 11px;
      font-weight: 600;
    }
    .swatch.active { border-color: var(--accent); }
    .pill-group {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .pill {
      height: 28px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-size: 11.5px;
    }
    .pill.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    .bottom-status {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      height: 34px;
      padding: 0 18px;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 94%, transparent);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      color: var(--muted);
      z-index: 15;
    }
    .progress-bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 34px;
      height: 2px;
      background: var(--surface-2);
      z-index: 16;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 180ms ease;
    }
    .hidden { display: none !important; }
    mark.hit {
      background: color-mix(in srgb, var(--accent) 24%, transparent);
      color: inherit;
      padding: 0 2px;
      border-radius: 3px;
    }
    @media (max-width: 780px) {
      .drawer { position: fixed; top: 48px; bottom: 34px; left: 0; z-index: 30; }
      .paged-track.two-col { column-count: 1; }
    }
  </style>
</head>
<body>
  <div class="app-shell" id="app-root" data-theme="paper">
    <header class="topbar">
      <div class="brand">
        <button class="btn" id="btn-shelf" title="书架">书架</button>
        <button class="btn" id="btn-drawer" title="目录与书签">目录</button>
        <h1 data-moss-top-heading="true">静读</h1>
        <span class="brand-meta" id="topbar-meta"></span>
      </div>
      <div class="top-actions">
        <label class="btn" style="cursor:pointer;">
          导入 TXT/MD
          <input type="file" id="file-import" accept=".txt,.md,.markdown" style="display:none;" />
        </label>
        <button class="btn" id="btn-mode-toggle">双栏翻页</button>
        <button class="btn" id="btn-bookmark">加书签</button>
        <button class="btn" id="btn-export-notes">导出笔记</button>
        <button class="btn" id="btn-settings">排版</button>
      </div>
    </header>

    <div class="main-grid">
      <aside class="drawer" id="drawer">
        <div class="drawer-tabs">
          <button class="drawer-tab active" data-dtab="toc">目录</button>
          <button class="drawer-tab" data-dtab="search">搜索</button>
          <button class="drawer-tab" data-dtab="bookmarks">书签</button>
        </div>
        <div class="drawer-body" id="drawer-body"></div>
      </aside>

      <main id="view-shelf" class="bookshelf-view hidden">
        <div class="shelf-head">
          <div>
            <h2 class="shelf-title">我的书架</h2>
            <p class="shelf-sub">点击任一书籍开始阅读；选中文中任意段落即可直接批注或向 Moss 提问。</p>
          </div>
          <label class="btn btn-primary" style="cursor:pointer;">
            导入本地小说 (.txt / .md)
            <input type="file" id="shelf-import" accept=".txt,.md,.markdown" style="display:none;" />
          </label>
        </div>
        <div class="shelf-grid" id="shelf-grid"></div>
      </main>

      <main id="view-reader" class="reader-wrap">
        <article class="reader-paper" id="reader-paper"></article>
      </main>
    </div>

    <div class="settings-popover hidden" id="settings-popover">
      <div>
        <div class="setting-label"><span>纸张主题</span></div>
        <div class="theme-swatches">
          <button class="swatch" data-theme-pick="paper" style="background:#ffffff;color:#18181b;border-color:#d4d4d8;">纯白</button>
          <button class="swatch" data-theme-pick="sepia" style="background:#f6efe2;color:#3d3126;">暖黄</button>
          <button class="swatch" data-theme-pick="sage" style="background:#eaf3ea;color:#1e3324;">护眼</button>
          <button class="swatch" data-theme-pick="slate" style="background:#23262d;color:#e2e8f0;">灰夜</button>
          <button class="swatch" data-theme-pick="oled" style="background:#0c0d10;color:#e4e4e7;">墨黑</button>
        </div>
      </div>
      <div>
        <div class="setting-label"><span>字体风格</span></div>
        <div class="pill-group">
          <button class="pill" data-font="serif">宋体</button>
          <button class="pill" data-font="sans">黑体</button>
          <button class="pill" data-font="kai">楷体</button>
        </div>
      </div>
      <div>
        <div class="setting-label"><span>字号</span><span id="label-font-size">17px</span></div>
        <div class="pill-group">
          <button class="pill" id="btn-font-dec">A-</button>
          <button class="pill" id="btn-font-reset">默认</button>
          <button class="pill" id="btn-font-inc">A+</button>
        </div>
      </div>
      <div>
        <div class="setting-label"><span>版心宽度</span></div>
        <div class="pill-group">
          <button class="pill" data-width="narrow">紧凑</button>
          <button class="pill" data-width="medium">适中</button>
          <button class="pill" data-width="wide">舒展</button>
        </div>
      </div>
      <div>
        <div class="setting-label"><span>行距</span><span id="label-line-height">1.85</span></div>
        <input type="range" id="range-line" min="1.5" max="2.2" step="0.05" value="1.85" style="width:100%;" />
      </div>
    </div>

    <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
    <footer class="bottom-status">
      <span id="status-left">第 1 章</span>
      <span id="status-right">阅读进度 0%</span>
    </footer>
  </div>

  <script>
  (function () {
    var STORAGE_KEY = "moss.nativeNovelReader.v1";
    var DEFAULT_BOOKS = [
      {
        id: "changan-demo",
        title: "长安十二时辰 · 卷上（选读本）",
        author: "原生阅读器内置典藏示例",
        gradient: "linear-gradient(135deg, #7c2d12, #b45309)",
        chapters: [
          {
            title: "第一章 · 巳正，望楼传讯",
            paragraphs: [
              "天宝三载，上元节将至。长安一百零八坊撤去宵禁前的最后一轮鼓声尚未敲响，靖安司大厅中央的微缩沙盘模型已然点亮。檀木刻就的朱雀大街如一道深沉的脊梁，将全城坊市一分为二。",
              "望楼上的旗手单膝跪在木垛边，双臂举起一面青底白纹方旗，又迅速换作两面红黄斜旗。三百步外另一座望楼的木窗立刻开启，相同的旗语在凛冽春风里一路接力向内城传递。",
              "> 原注：望楼旗语依托固定格子矩阵编码，既可传达坊名与兵马数量，亦能在不惊动市井的前提下完成跨坊调度。",
              "张小敬站在舆图左侧的案几前，指尖停在怀远坊西市交界处。他很清楚，看似平静的灯市与胡姬酒肆底下，暗桩早已顺着漕渠的暗流潜入了西市南门。只要亥时花萼楼的灯火亮起，整座城的命运就会压在最后那半柱香里。"
            ]
          },
          {
            title: "第二章 · 午初，西市暗流",
            paragraphs: [
              "西市的喧嚣比东市更早攀上顶峰。粟特商人的驼队刚刚解下鞍辔，胡麻饼炉前的炭火正旺，青石板路缝里渗着冰水化开的湿气。张小敬穿过卖波斯琉璃与绢帛的巷弄，在一家不起眼的墨铺门前停住了脚步。",
              "柜台后的掌柜正低头研墨，手腕稳得像秤杆，唯独左手食指指节有一圈陈旧的弓弦老茧。两人目光相接不过半息，便各自收回了视线——这并不是普通的文房四宝铺子，而是不良人留给西市的最后一处死信箱。",
              "掌柜递来一卷包好的松烟墨，夹纸里只写着七个墨字：『石脂已入修德坊。』石脂遇火即燃，水泼不灭，一旦在大灯楼周围倾泻，整片皇城南门都将化作火海。"
            ]
          },
          {
            title: "第三章 · 未正，大案牍术",
            paragraphs: [
              "靖安司侧厅里堆满了近十年间京兆府、金吾卫与户部的过所文书。年轻的徐宾坐在一排排竹简与麻纸卷宗中间，鼻尖沾着一丝淡墨，口中低声念着一串年份与税银数额。",
              "『世人只道卷宗繁杂，可只要把人名、货色、驿站车马的脚程放在同一张表里推演，所有谎言都会在数字相撞的地方露出破绽。』徐宾推了推手边的算筹，抽出一张泛黄的草纸。",
              "纸上赫然列着过去三个月内所有采购过大批劣质狼毒与硫磺的商号名称，其中四家看似毫无关联的皮货行，恰巧在同一个阴雨夜使用了同一批车夫。线索至此连成了一张无形的网。"
            ]
          }
        ]
      },
      {
        id: "deep-time-demo",
        title: "群星与深时 · 短篇科幻选集",
        author: "Moss 原生书架示例",
        gradient: "linear-gradient(135deg, #1e3a8a, #2563eb)",
        chapters: [
          {
            title: "第一章 · 轨道修船厂的黎明",
            paragraphs: [
              "在距离木卫二冰壳表面四百公里的同步轨道上，七号船坞每隔九十六分钟就会迎来一次蓝色地平线日出。工程师林岚摘下微重力吸附手套，让咖啡杯缓缓漂浮在观测舷窗前面。",
              "> 摘录：当你长期与光秒级的通讯延迟共处，就会习惯先在本地完成全部推演，再把最终结论发往三千万公里外的地球。",
              "今天的任务是校准一艘老旧货运船的磁约束喷嘴。虽然自动化机械臂已经接管了九成以上的高危焊接，但热胀冷缩在钛合金焊缝里留下的微米级应力，仍然需要人的手指抚过传感图谱去感知。"
            ]
          },
          {
            title: "第二章 · 冰下回声",
            paragraphs: [
              "正午时分，冰下探测器『潜渊三号』传回了本周第三组声呐回波。与前两次单调的岩层折射不同，这一次的频谱图边缘出现了一组极具规律的十二赫兹谐波。",
              "林岚把声波曲线投射到工作台上，逐段放大。每间隔四秒钟，深海热泉附近的盐度传感器就会录得一次短暂扰动——像是某种未知的地质气囊正在冰穹底部缓缓呼吸。"
            ]
          }
        ]
      }
    ];

    function loadState() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.books) && parsed.books.length > 0) return parsed;
        }
      } catch (e) {}
      return {
        view: "reader",
        bookId: DEFAULT_BOOKS[0].id,
        chapterIndex: 0,
        pageMode: "scroll",
        pageOffset: 0,
        drawerOpen: true,
        drawerTab: "toc",
        theme: "paper",
        font: "serif",
        fontSize: 17,
        lineHeight: 1.85,
        width: "medium",
        bookmarks: [],
        books: DEFAULT_BOOKS
      };
    }

    var state = loadState();
    var searchQuery = "";
    var totalPagedCount = 1;

    function saveState() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    }

    function currentBook() {
      for (var i = 0; i < state.books.length; i += 1) {
        if (state.books[i].id === state.bookId) return state.books[i];
      }
      return state.books[0];
    }

    function parseImportedNovel(filename, text) {
      var title = filename.replace(/\\.(txt|md|markdown)$/i, "") || "未命名小说";
      var lines = text.replace(/\\r\\n?/g, "\\n").split("\\n");
      var chapters = [];
      var curTitle = "正文开始";
      var curParas = [];
      var headingRe = /^(\\s*#{1,3}\\s+.+|\\s*第[零一二三四五六七八九十百千万0-9]+[章节回卷集部][^\\n]{0,40}|\\s*Chapter\\s+[0-9IVXivx]+.*)$/i;
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i].trim();
        if (!line) continue;
        if (headingRe.test(line)) {
          if (curParas.length > 0) chapters.push({ title: curTitle, paragraphs: curParas });
          curTitle = line.replace(/^#+\\s*/, "").trim();
          curParas = [];
        } else {
          curParas.push(line);
          if (curParas.length >= 60 && chapters.length === 0) {
            chapters.push({ title: curTitle + " · 第 " + (chapters.length + 1) + " 节", paragraphs: curParas });
            curParas = [];
          }
        }
      }
      if (curParas.length > 0) chapters.push({ title: curTitle, paragraphs: curParas });
      if (chapters.length === 0) chapters.push({ title: "全文", paragraphs: ["（文件为空）"] });
      var gradients = [
        "linear-gradient(135deg, #0f766e, #14b8a6)",
        "linear-gradient(135deg, #4338ca, #6366f1)",
        "linear-gradient(135deg, #9f1239, #e11d48)"
      ];
      return {
        id: "import-" + Date.now(),
        title: title,
        author: "本地导入 · " + chapters.length + " 章",
        gradient: gradients[state.books.length % gradients.length],
        chapters: chapters
      };
    }

    function applyAppearance() {
      var root = document.getElementById("app-root");
      root.setAttribute("data-theme", state.theme || "paper");
      var fontMap = {
        serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, serif',
        sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
        kai: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif'
      };
      var widthMap = { narrow: "620px", medium: "740px", wide: "940px" };
      root.style.setProperty("--reader-font", fontMap[state.font] || fontMap.serif);
      root.style.setProperty("--reader-size", (state.fontSize || 17) + "px");
      root.style.setProperty("--reader-line", String(state.lineHeight || 1.85));
      root.style.setProperty("--reader-width", widthMap[state.width] || "740px");
      document.getElementById("label-font-size").textContent = (state.fontSize || 17) + "px";
      document.getElementById("label-line-height").textContent = Number(state.lineHeight || 1.85).toFixed(2);
      document.getElementById("range-line").value = String(state.lineHeight || 1.85);
      document.querySelectorAll("[data-theme-pick]").forEach(function (el) {
        el.classList.toggle("active", el.getAttribute("data-theme-pick") === state.theme);
      });
      document.querySelectorAll("[data-font]").forEach(function (el) {
        el.classList.toggle("active", el.getAttribute("data-font") === state.font);
      });
      document.querySelectorAll("[data-width]").forEach(function (el) {
        el.classList.toggle("active", el.getAttribute("data-width") === state.width);
      });
    }

    function renderDrawer() {
      var drawer = document.getElementById("drawer");
      drawer.classList.toggle("hidden", !state.drawerOpen || state.view === "shelf");
      document.getElementById("btn-drawer").classList.toggle("active", state.drawerOpen && state.view !== "shelf");
      document.querySelectorAll("[data-dtab]").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-dtab") === state.drawerTab);
      });
      var body = document.getElementById("drawer-body");
      body.innerHTML = "";
      var book = currentBook();
      if (state.drawerTab === "toc") {
        book.chapters.forEach(function (ch, idx) {
          var item = document.createElement("button");
          item.className = "drawer-item" + (idx === state.chapterIndex ? " active" : "");
          var words = ch.paragraphs.join("").length;
          item.innerHTML = '<span class="drawer-item-title">' + escapeHtml(ch.title) + '</span><span class="drawer-item-sub">约 ' + words + ' 字</span>';
          item.onclick = function () {
            state.chapterIndex = idx;
            state.pageOffset = 0;
            state.view = "reader";
            saveState();
            renderAll();
          };
          body.appendChild(item);
        });
      } else if (state.drawerTab === "search") {
        var input = document.createElement("input");
        input.className = "search-box";
        input.placeholder = "搜索本书段落关键词…";
        input.value = searchQuery;
        input.oninput = function (e) {
          searchQuery = e.target.value;
          renderDrawer();
          var nextInput = document.querySelector(".search-box");
          if (nextInput) { nextInput.focus(); nextInput.setSelectionRange(searchQuery.length, searchQuery.length); }
        };
        body.appendChild(input);
        var q = searchQuery.trim().toLowerCase();
        var count = 0;
        book.chapters.forEach(function (ch, cIdx) {
          ch.paragraphs.forEach(function (p) {
            if (!q || p.toLowerCase().indexOf(q) === -1 || count >= 30) return;
            count += 1;
            var item = document.createElement("button");
            item.className = "drawer-item";
            item.innerHTML = '<span class="drawer-item-title">' + escapeHtml(ch.title) + '</span><span class="drawer-item-sub">' + escapeHtml(p.slice(0, 68)) + '…</span>';
            item.onclick = function () {
              state.chapterIndex = cIdx;
              state.pageOffset = 0;
              state.view = "reader";
              saveState();
              renderAll();
            };
            body.appendChild(item);
          });
        });
        if (q && count === 0) {
          var empty = document.createElement("div");
          empty.className = "drawer-item-sub";
          empty.style.padding = "12px";
          empty.textContent = "未找到匹配段落";
          body.appendChild(empty);
        }
      } else {
        var marks = state.bookmarks.filter(function (b) { return b.bookId === book.id; });
        if (marks.length === 0) {
          var none = document.createElement("div");
          none.className = "drawer-item-sub";
          none.style.padding = "12px";
          none.textContent = "暂无书签，点击顶部「加书签」即可记录当前章节。";
          body.appendChild(none);
        } else {
          marks.forEach(function (m) {
            var item = document.createElement("button");
            item.className = "drawer-item";
            item.innerHTML = '<span class="drawer-item-title">' + escapeHtml(m.chapterTitle) + '</span><span class="drawer-item-sub">' + escapeHtml(m.excerpt) + ' · ' + escapeHtml(m.time) + '</span>';
            item.onclick = function () {
              state.chapterIndex = m.chapterIndex;
              state.pageOffset = 0;
              state.view = "reader";
              saveState();
              renderAll();
            };
            body.appendChild(item);
          });
        }
      }
    }

    function renderShelf() {
      var grid = document.getElementById("shelf-grid");
      grid.innerHTML = "";
      state.books.forEach(function (book) {
        var words = book.chapters.reduce(function (sum, ch) { return sum + ch.paragraphs.join("").length; }, 0);
        var card = document.createElement("div");
        card.className = "book-card";
        card.innerHTML =
          '<div>' +
            '<div class="book-cover" style="background:' + book.gradient + '">' + escapeHtml(book.title) + '</div>' +
            '<div class="book-meta" style="margin-top:10px;">' + escapeHtml(book.author) + '<br/>共 ' + book.chapters.length + ' 章 · 约 ' + words + ' 字</div>' +
          '</div>' +
          '<button class="btn btn-primary" style="justify-content:center;">继续阅读</button>';
        card.querySelector("button").onclick = function () {
          state.bookId = book.id;
          state.chapterIndex = 0;
          state.pageOffset = 0;
          state.view = "reader";
          saveState();
          renderAll();
        };
        grid.appendChild(card);
      });
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function renderReader() {
      var book = currentBook();
      if (state.chapterIndex >= book.chapters.length) state.chapterIndex = 0;
      var ch = book.chapters[state.chapterIndex];
      var paper = document.getElementById("reader-paper");
      document.getElementById("topbar-meta").textContent = book.title + " · " + ch.title;
      var modeBtn = document.getElementById("btn-mode-toggle");
      modeBtn.textContent = state.pageMode === "paged" ? "双栏翻页中" : "连续滚动中";
      modeBtn.classList.toggle("active", state.pageMode === "paged");

      var parasHtml = ch.paragraphs.map(function (p) {
        if (p.indexOf(">") === 0) return '<p class="quote">' + escapeHtml(p.slice(1).trim()) + '</p>';
        return "<p>" + escapeHtml(p) + "</p>";
      }).join("");

      if (state.pageMode === "paged") {
        paper.className = "reader-paper paged";
        paper.innerHTML =
          '<div class="chapter-header"><div class="chapter-kicker">' + escapeHtml(book.title) + '</div><h2 class="chapter-title">' + escapeHtml(ch.title) + '</h2></div>' +
          '<div class="paged-viewport" id="paged-viewport"><div class="paged-track two-col" id="paged-track">' + parasHtml + '</div></div>' +
          '<div class="chapter-footer-nav">' +
            '<div style="display:flex;gap:8px;"><button class="btn" id="btn-prev-chap">上一章</button><button class="btn" id="btn-prev-page">← 上一页</button></div>' +
            '<span class="brand-meta" id="page-counter">第 1 / 1 页</span>' +
            '<div style="display:flex;gap:8px;"><button class="btn" id="btn-next-page">下一页 →</button><button class="btn btn-primary" id="btn-next-chap">下一章</button></div>' +
          '</div>';
        requestAnimationFrame(updatePagedLayout);
      } else {
        paper.className = "reader-paper";
        paper.innerHTML =
          '<div class="chapter-header"><div class="chapter-kicker">' + escapeHtml(book.title) + '</div><h2 class="chapter-title">' + escapeHtml(ch.title) + '</h2></div>' +
          '<div class="chapter-content">' + parasHtml + '</div>' +
          '<div class="chapter-footer-nav">' +
            '<button class="btn" id="btn-prev-chap">← 上一章</button>' +
            '<span class="brand-meta">第 ' + (state.chapterIndex + 1) + ' / ' + book.chapters.length + ' 章</span>' +
            '<button class="btn btn-primary" id="btn-next-chap">下一章 →</button>' +
          '</div>';
      }

      var prevChap = document.getElementById("btn-prev-chap");
      var nextChap = document.getElementById("btn-next-chap");
      if (prevChap) prevChap.onclick = function () {
        if (state.chapterIndex > 0) { state.chapterIndex -= 1; state.pageOffset = 0; saveState(); renderAll(); window.scrollTo(0, 0); }
      };
      if (nextChap) nextChap.onclick = function () {
        if (state.chapterIndex < book.chapters.length - 1) { state.chapterIndex += 1; state.pageOffset = 0; saveState(); renderAll(); window.scrollTo(0, 0); }
      };
      var prevPage = document.getElementById("btn-prev-page");
      var nextPage = document.getElementById("btn-next-page");
      if (prevPage) prevPage.onclick = function () { movePaged(-1); };
      if (nextPage) nextPage.onclick = function () { movePaged(1); };

      var pct = Math.round(((state.chapterIndex + 1) / book.chapters.length) * 100);
      document.getElementById("status-left").textContent = book.title + " · " + ch.title;
      document.getElementById("status-right").textContent = "全书进度 " + pct + "% · 支持直接划词评论或用右侧标注框选段落";
      document.getElementById("progress-fill").style.width = pct + "%";
    }

    function updatePagedLayout() {
      var vp = document.getElementById("paged-viewport");
      var track = document.getElementById("paged-track");
      if (!vp || !track) return;
      var step = vp.clientWidth + 56;
      var total = Math.max(1, Math.ceil((track.scrollWidth + 56) / Math.max(1, step)));
      totalPagedCount = total;
      if (state.pageOffset >= total) state.pageOffset = total - 1;
      if (state.pageOffset < 0) state.pageOffset = 0;
      track.style.transform = "translateX(-" + (state.pageOffset * step) + "px)";
      var counter = document.getElementById("page-counter");
      if (counter) counter.textContent = "本节第 " + (state.pageOffset + 1) + " / " + total + " 页（双栏翻页）";
    }

    function movePaged(delta) {
      var book = currentBook();
      var next = state.pageOffset + delta;
      if (next < 0) {
        if (state.chapterIndex > 0) { state.chapterIndex -= 1; state.pageOffset = 0; saveState(); renderAll(); }
        return;
      }
      if (next >= totalPagedCount) {
        if (state.chapterIndex < book.chapters.length - 1) { state.chapterIndex += 1; state.pageOffset = 0; saveState(); renderAll(); }
        return;
      }
      state.pageOffset = next;
      saveState();
      updatePagedLayout();
    }

    function renderAll() {
      applyAppearance();
      var isShelf = state.view === "shelf";
      document.getElementById("view-shelf").classList.toggle("hidden", !isShelf);
      document.getElementById("view-reader").classList.toggle("hidden", isShelf);
      document.getElementById("btn-shelf").classList.toggle("active", isShelf);
      renderDrawer();
      if (isShelf) renderShelf();
      else renderReader();
    }

    function bindEvents() {
      document.getElementById("btn-shelf").onclick = function () {
        state.view = state.view === "shelf" ? "reader" : "shelf";
        saveState();
        renderAll();
      };
      document.getElementById("btn-drawer").onclick = function () {
        if (state.view === "shelf") state.view = "reader";
        state.drawerOpen = !state.drawerOpen;
        saveState();
        renderAll();
      };
      document.querySelectorAll("[data-dtab]").forEach(function (btn) {
        btn.onclick = function () {
          state.drawerTab = btn.getAttribute("data-dtab");
          state.drawerOpen = true;
          saveState();
          renderDrawer();
        };
      });
      document.getElementById("btn-mode-toggle").onclick = function () {
        state.pageMode = state.pageMode === "paged" ? "scroll" : "paged";
        state.pageOffset = 0;
        if (state.view === "shelf") state.view = "reader";
        saveState();
        renderAll();
      };
      document.getElementById("btn-settings").onclick = function (e) {
        e.stopPropagation();
        document.getElementById("settings-popover").classList.toggle("hidden");
      };
      document.getElementById("settings-popover").onclick = function (e) { e.stopPropagation(); };
      document.addEventListener("click", function () {
        document.getElementById("settings-popover").classList.add("hidden");
      });
      document.querySelectorAll("[data-theme-pick]").forEach(function (btn) {
        btn.onclick = function () { state.theme = btn.getAttribute("data-theme-pick"); saveState(); applyAppearance(); };
      });
      document.querySelectorAll("[data-font]").forEach(function (btn) {
        btn.onclick = function () { state.font = btn.getAttribute("data-font"); saveState(); applyAppearance(); updatePagedLayout(); };
      });
      document.querySelectorAll("[data-width]").forEach(function (btn) {
        btn.onclick = function () { state.width = btn.getAttribute("data-width"); saveState(); applyAppearance(); updatePagedLayout(); };
      });
      document.getElementById("btn-font-dec").onclick = function () { state.fontSize = Math.max(14, (state.fontSize || 17) - 1); saveState(); applyAppearance(); updatePagedLayout(); };
      document.getElementById("btn-font-reset").onclick = function () { state.fontSize = 17; saveState(); applyAppearance(); updatePagedLayout(); };
      document.getElementById("btn-font-inc").onclick = function () { state.fontSize = Math.min(24, (state.fontSize || 17) + 1); saveState(); applyAppearance(); updatePagedLayout(); };
      document.getElementById("range-line").oninput = function (e) { state.lineHeight = Number(e.target.value); saveState(); applyAppearance(); updatePagedLayout(); };
      document.getElementById("btn-bookmark").onclick = function () {
        var book = currentBook();
        var ch = book.chapters[state.chapterIndex];
        var sel = window.getSelection ? String(window.getSelection() || "").trim() : "";
        var excerpt = (sel || ch.paragraphs[0] || "").slice(0, 48);
        state.bookmarks.unshift({
          bookId: book.id,
          chapterIndex: state.chapterIndex,
          chapterTitle: ch.title,
          excerpt: excerpt,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        });
        state.drawerTab = "bookmarks";
        state.drawerOpen = true;
        saveState();
        renderDrawer();
      };
      document.getElementById("btn-export-notes").onclick = function () {
        var book = currentBook();
        var marks = state.bookmarks.filter(function (b) { return b.bookId === book.id; });
        var md = "# 《" + book.title + "》阅读书签与笔记\\n\\n" + (marks.length === 0
          ? "暂未添加书签。当前阅读至：" + book.chapters[state.chapterIndex].title + "\\n"
          : marks.map(function (m, i) { return (i + 1) + ". **" + m.chapterTitle + "** (" + m.time + ")\\n   > " + m.excerpt; }).join("\\n\\n"));
        var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = book.title + "-笔记.md";
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      };
      function handleImport(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var book = parseImportedNovel(file.name, String(reader.result || ""));
          state.books.unshift(book);
          state.bookId = book.id;
          state.chapterIndex = 0;
          state.pageOffset = 0;
          state.view = "reader";
          saveState();
          renderAll();
        };
        reader.readAsText(file, "utf-8");
        e.target.value = "";
      }
      document.getElementById("file-import").onchange = handleImport;
      document.getElementById("shelf-import").onchange = handleImport;
      window.addEventListener("keydown", function (e) {
        if (state.pageMode !== "paged" || state.view !== "reader") return;
        if (e.key === "ArrowLeft") movePaged(-1);
        else if (e.key === "ArrowRight") movePaged(1);
      });
      window.addEventListener("resize", updatePagedLayout);
    }

    bindEvents();
    renderAll();
  })();
  </script>
</body>
</html>
`;
