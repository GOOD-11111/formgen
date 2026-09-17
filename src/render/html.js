/**
 * 服务端 HTML 外壳。
 *
 * 有意做得**很薄**：服务端只渲染外壳与元信息，表单本体由浏览器拿 Schema 动态构建。
 * 这不是偷懒，而是本项目要演示的范式——「生成」发生在数据层，
 * 渲染是同一个运行时对任意 Schema 的通用能力，而不是为每张表单生成一份页面代码。
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
}

/** 安全地把对象嵌进 <script> —— `</script>` 会提前结束脚本块。 */
export function jsonScript(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function layout({ title, description = '', body, scripts = [], styles = [], bodyClass = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
<link rel="stylesheet" href="/static/app.css">
${styles.map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n')}
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📝</text></svg>">
</head>
<body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ''}>
${body}
${scripts.map(src => `<script type="module" src="${escapeHtml(src)}"></script>`).join('\n')}
</body>
</html>
`;
}

function topbar(active = '') {
  const items = [
    { href: '/', label: '工作台', key: 'home' },
    { href: '/studio', label: '生成器', key: 'studio' },
    { href: '/docs', label: '设计说明', key: 'docs' },
  ];
  return `<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark">FG</span><span class="brand-name">FormGen</span><span class="brand-sub">低代码与智能表单生成引擎</span></a>
  <nav class="topnav">${items.map(i => `<a href="${i.href}"${i.key === active ? ' class="active"' : ''}>${i.label}</a>`).join('')}</nav>
</header>`;
}

/** 表单填写页：公开采集入口。 */
export function renderFillPage(schema, options = {}) {
  const body = `${topbar()}
<main class="page page-fill" id="formgen-body">
  <div class="fill-head">
    <h1 class="fill-title">${escapeHtml(schema.title)}</h1>
    ${schema.grading?.totalScore ? `<div class="fill-meta"><span class="pill">满分 ${schema.grading.totalScore} 分</span>${schema.grading.duration ? `<span class="pill">${schema.grading.duration} 分钟</span>` : ''}<span class="pill">共 ${countQuestions(schema)} 题</span></div>` : ''}
  </div>
  <div class="progress" id="formgen-progress">
    <div class="progress-bar" id="formgen-progress-bar"></div>
  </div>
  <p class="progress-text" id="formgen-progress-text"></p>
  <div class="alert" id="formgen-status" hidden></div>
  <form id="formgen-form" novalidate autocomplete="off">
    <div id="formgen-root"><noscript>本表单由 Schema 动态渲染，需要启用 JavaScript。</noscript></div>
  </form>
  <footer class="fill-foot">
    <span>由 FormGen 生成</span>
    <span class="dot">·</span>
    <span>Schema v${escapeHtml(String(schema.version ?? 1))}</span>
    ${schema.meta?.generator ? `<span class="dot">·</span><span>生成通道：${escapeHtml(String(schema.meta.generator))}</span>` : ''}
  </footer>
</main>
<script type="application/json" id="formgen-schema">${jsonScript(schema)}</script>`;
  return layout({ title: schema.title, description: schema.description || `${schema.title} - 在线填写`, body, scripts: ['/static/runtime.js'], bodyClass: 'fill' });
}

function countQuestions(schema) {
  let count = 0;
  for (const group of schema.groups ?? []) {
    for (const field of group.fields ?? []) if (field.type === 'question') count += 1;
  }
  return count;
}

/** 生成器工作台：左侧写需求，右侧实时预览。 */
export function renderStudioPage(options = {}) {
  const example = `做一个店庆活动报名表：姓名、手机号、参加场次（上午/下午/全天）、参加人数、是否需要停车位，需要的话填车牌号，最后写一句想对店长说的话。`;
  const body = `${topbar('studio')}
<main class="page page-studio">
  <section class="studio-input">
    <h1>用一句中文，换一张能用的表</h1>
    <p class="lede">写清楚你要收集什么、有哪些可选值、什么条件下才需要填。系统会把它编译成 FormSchema，并立刻渲染成可填写的页面。</p>
    <textarea id="nl-input" rows="7" placeholder="例如：${escapeHtml(example)}"></textarea>
    <div class="studio-controls">
      <label class="control">
        <span>生成通道</span>
        <select id="mode-select">
          <option value="auto">自动（优先大模型，失败降级规则）</option>
          <option value="rule">规则引擎（离线、确定性）</option>
          <option value="llm">大模型</option>
          <option value="compare">双通道对比</option>
          <option value="exam">考卷（组卷 + 自动评分）</option>
        </select>
      </label>
      <button id="generate-btn" class="primary">生成表单</button>
      <button id="example-btn" class="ghost" type="button">换个例子</button>
    </div>
    <div class="alert" id="studio-status" hidden></div>
    <div id="understanding" class="understanding" hidden></div>
  </section>
  <section class="studio-output">
    <div class="output-head">
      <h2>生成结果</h2>
      <div class="output-actions">
        <button id="publish-btn" class="primary" disabled>发布并获取链接</button>
        <button id="download-btn" class="ghost" disabled>下载 Schema</button>
      </div>
    </div>
    <div id="preview" class="preview"><p class="placeholder">左边写下需求，这里会出现一张真的能填的表。</p></div>
  </section>
</main>
<script type="application/json" id="studio-examples">${jsonScript(EXAMPLES)}</script>`;
  return layout({ title: '生成器 · FormGen', description: '自然语言生成表单', body, scripts: ['/static/studio.js'], bodyClass: 'studio' });
}

export const EXAMPLES = [
  '做一个店庆活动报名表：姓名、手机号、参加场次（上午/下午/全天）、参加人数、是否需要停车位，需要的话填车牌号，最后写一句想对店长说的话。',
  '帮我做一个员工入职信息收集表，包含姓名、手机号、身份证号、入职日期、部门（技术部/产品部/设计部），还要上传身份证照片，最后要填写紧急联系人姓名和电话。',
  '做一个客户满意度调查问卷：姓名、手机号、对产品的满意度评分（1-5星）、对客服的评分（1-5星）、意见建议、是否愿意推荐给朋友。',
  '创建一个活动报名表。基本信息：姓名、手机号、邮箱、学校、专业。参会信息：参会日期、是否需要住宿、饮食禁忌（素食/清真/无要求/其他）。如果是素食，请填写具体说明。',
  '做一个报销申请表，包含申请人姓名、所在部门（技术部、市场部、财务部）、报销金额（元）、费用发生日期、费用类型（差旅/餐饮/办公用品/其他）、发票附件上传、备注（选填）。',
  '生成一份高一数学期中试卷，满分150分，考试时间120分钟，包含选择题10道每题5分、填空题4道每题5分、解答题5道，覆盖函数、三角函数、数列，难度中等偏难，公式用 LaTeX。',
];

/** 工作台首页：已发布的表单列表。 */
export function renderHomePage(forms, stats) {
  const cards = forms.length
    ? forms.map(form => `
    <a class="card" href="/f/${escapeHtml(form.id)}">
      <div class="card-head">
        <h3>${escapeHtml(form.title)}</h3>
        <span class="pill pill-${escapeHtml(form.kind)}">${escapeHtml(kindLabel(form.kind))}</span>
      </div>
      <p class="card-desc">${escapeHtml(form.description || '暂无描述')}</p>
      <dl class="card-stats">
        <div><dt>字段</dt><dd>${form.fieldCount}</dd></div>
        <div><dt>提交</dt><dd>${form.submissionCount}</dd></div>
        <div><dt>通道</dt><dd>${escapeHtml(String(form.generator ?? '-').replace(/^llm:.*/, 'llm'))}</dd></div>
      </dl>
      <time>${escapeHtml(formatTime(form.createdAt))}</time>
    </a>`).join('')
    : `<div class="empty">
        <p>还没有任何表单。</p>
        <a class="primary" href="/studio">去生成第一张表 →</a>
      </div>`;

  const body = `${topbar('home')}
<main class="page page-home">
  <section class="hero">
    <h1>人类描述需求，系统渲染工具。</h1>
    <p class="lede">FormGen 把中文需求编译成一份可存储、可版本化、可校验的 <code>FormSchema</code>，
    再由同一个运行时把它渲染成真正能用的采集页面——没有代码生成，没有页面模板，改需求就是改数据。</p>
    <div class="hero-stats">
      <div><strong>${stats.forms}</strong><span>已发布表单</span></div>
      <div><strong>${stats.submissions}</strong><span>累计提交</span></div>
      <div><strong>${stats.questions}</strong><span>考卷题目</span></div>
      <div><strong>${stats.llmConfigured ? '已接入' : '未接入'}</strong><span>大模型通道</span></div>
    </div>
    <a class="primary" href="/studio">开始生成 →</a>
  </section>
  <section class="list">
    <h2>已发布的表单</h2>
    <div class="cards">${cards}</div>
  </section>
</main>`;
  return layout({ title: 'FormGen · 低代码与智能表单生成引擎', description: '自然语言生成表单与考卷', body, bodyClass: 'home' });
}

function kindLabel(kind) {
  return ({ form: '表单', survey: '问卷', exam: '考卷', registration: '报名', feedback: '反馈', collection: '收集' })[kind] ?? '表单';
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return String(iso); }
}

/** 结果页：提交数据表格 + 导出。 */
export function renderResultsPage(form, submissions, options = {}) {
  const columns = collectColumns(form.schema);
  const rows = submissions.map(submission => {
    const cells = columns.map(column => {
      const value = submission.values?.[column.key];
      return `<td>${escapeHtml(formatCell(column, value))}</td>`;
    }).join('');
    return `<tr><td class="mono">${escapeHtml(String(submission.id).slice(-8))}</td>${cells}<td class="mono">${escapeHtml(formatTime(submission.createdAt))}</td></tr>`;
  }).join('');

  const grading = options.grading;
  const gradingBlock = grading ? `
  <section class="grading">
    <h2>成绩分析</h2>
    <div class="hero-stats">
      <div><strong>${grading.count}</strong><span>份答卷</span></div>
      <div><strong>${grading.average}</strong><span>平均分</span></div>
      <div><strong>${grading.max}</strong><span>最高分</span></div>
      <div><strong>${grading.min}</strong><span>最低分</span></div>
    </div>
    <table class="data-table">
      <thead><tr><th>题目</th><th>满分</th><th>平均得分</th><th>正确率</th></tr></thead>
      <tbody>${grading.perQuestion.map(q => `<tr><td>${escapeHtml(q.label)}</td><td>${q.score}</td><td>${q.average}</td><td>${q.accuracy}</td></tr>`).join('')}</tbody>
    </table>
  </section>` : '';

  const body = `${topbar()}
<main class="page page-results">
  <div class="results-head">
    <div>
      <h1>${escapeHtml(form.title)}</h1>
      <p class="lede">${submissions.length} 条提交 · 数据在服务端按同一份 Schema 校验后入库</p>
    </div>
    <div class="output-actions">
      <a class="ghost" href="/f/${escapeHtml(form.id)}/fill">填写页</a>
      <a class="ghost" href="/f/${escapeHtml(form.id)}/export.csv">导出 CSV</a>
      <a class="ghost" href="/f/${escapeHtml(form.id)}/export.json">导出 JSON</a>
      <a class="ghost" href="/f/${escapeHtml(form.id)}/schema.json">查看 Schema</a>
    </div>
  </div>
  ${gradingBlock}
  <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>编号</th>${columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}<th>提交时间</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${columns.length + 2}" class="empty-cell">暂无提交</td></tr>`}</tbody>
    </table>
  </div>
</main>`;
  return layout({ title: `${form.title} · 结果`, body, bodyClass: 'results' });
}

/** 从 Schema 推导导出列（顺序与表单一致，不含纯展示字段）。 */
export function collectColumns(schema) {
  const columns = [];
  for (const group of schema.groups ?? []) {
    for (const field of group.fields ?? []) {
      if (field.type === 'section' || field.type === 'statement') continue;
      columns.push({ key: field.key, label: field.label, type: field.type, group: group.title });
    }
  }
  return columns;
}

export function formatCell(column, value) {
  if (value === undefined || value === null) return '';
  if (column.type === 'file') {
    const list = Array.isArray(value) ? value : [value];
    return list.filter(Boolean).map(f => f.name ?? String(f)).join('、');
  }
  if (column.type === 'matrix' && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}:${v}`).join('；');
  }
  if (column.type === 'question') {
    if (Array.isArray(value)) return value.join(' | ');
    if (typeof value === 'boolean') return value ? '对' : '错';
    return String(value);
  }
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

/** 设计说明页：把项目的技术主张写进产品本身。 */
export function renderDocsPage() {
  const body = `${topbar('docs')}
<main class="page page-docs">
  <h1>设计说明</h1>
  <p class="lede">这个项目想验证一件事：<strong>自然语言描述需求 → 系统动态渲染出可用工具</strong>，
  在工程上可以做得既可解释、又可离线、又可校验。下面是它的几个关键取舍。</p>

  <h2>1. 中间表示是唯一事实来源</h2>
  <p>自然语言被编译成 <code>FormSchema</code>（纯 JSON）。渲染器、校验器、导出器、评分器都只读这一份数据。
  没有「生成页面代码」这一步，所以不存在生成产物与需求漂移：改需求就是改数据，可 diff、可版本化、可回滚。</p>

  <h2>2. 后端与前端的校验是同一份代码</h2>
  <p>引擎是零依赖的纯 ESM。服务端把 <code>src/</code> 原样挂在 <code>/engine/</code> 下，
  浏览器 <code>import</code> 的就是服务端校验用的那个 <code>validateSubmission</code>。
  「前端过了后端不过」在结构上不可能发生——它们是同一个函数。</p>

  <h2>3. 双生成通道，而不是二选一</h2>
  <p><strong>规则引擎</strong>负责确定性、可解释、离线可用：每个字段为什么是下拉框、为什么必填，
  都能追溯到一条规则，并回放给用户看。<strong>大模型</strong>负责规则覆盖不了的意图性表达。
  两者产出同一种 Schema，因此可以互相比较、互相修补，也可以自动降级。</p>

  <h2>4. 选中「不生成代码」</h2>
  <p>低代码平台常见的做法是生成一份页面代码。这里刻意不这么做：生成本身是数据变换，
  运行时是通用的。代价是灵活性有上限，收益是安全性、可审计性和一致性。</p>

  <h2>5. 考卷场景：把「自适应」落在约束求解上</h2>
  <p>教师大纲被解析成命题蓝图（题型/题量/分值/知识点/难度分布），再从题库做带约束的随机组卷，
  并回报覆盖度、难度偏差与缺口建议。总分会被强制配平，同一 seed 可复现——可复现对考试是硬要求。</p>

  <h2>局限（如实列出）</h2>
  <ul>
    <li>规则通道依赖中文词典与句式，遇到没见过的表达会漏字段；漏掉的会在「问题」里如实报告，不会假装成功。</li>
    <li>文件上传走 base64 内联，单文件限制 2MB；没有做分片与对象存储。</li>
    <li>存储是 JSON 文件，适合演示与中小规模采集，不适合高并发写入。</li>
    <li>矩阵题、题目类型目前偏向基础题型，复杂排版（图片题、多栏排版）未实现。</li>
  </ul>
</main>`;
  return layout({ title: '设计说明 · FormGen', body, bodyClass: 'docs' });
}

export function renderErrorPage(status, message) {
  const body = `${topbar()}
<main class="page page-error">
  <h1>${status}</h1>
  <p class="lede">${escapeHtml(message)}</p>
  <a class="primary" href="/">返回工作台</a>
</main>`;
  return layout({ title: `${status} · FormGen`, body, bodyClass: 'error' });
}
