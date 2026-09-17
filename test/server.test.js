import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFormgenServer, toCsv } from '../src/server/app.js';
import { FileStore } from '../src/server/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(HERE, '..', '.tmp-test');

let instance;
let base;

test.before(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  instance = await createFormgenServer({ dataDir: TMP_ROOT, quiet: true });
  const address = await instance.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await instance?.close();
  await rm(TMP_ROOT, { recursive: true, force: true });
});

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

test('首页/生成器/设计说明都能打开', async () => {
  for (const [pathname, marker] of [['/', 'FormGen'], ['/studio', 'nl-input'], ['/docs', '设计说明']]) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, pathname);
    const html = await response.text();
    assert.ok(html.includes(marker), `${pathname} 应包含 ${marker}`);
  }
});

test('未知路径返回 404 页面而不是崩溃', async () => {
  const response = await fetch(`${base}/no/such/page`);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes('页面不存在'));
});

// ---------------------------------------------------------------------------
// 引擎源码直供浏览器
// ---------------------------------------------------------------------------

test('/engine/ 提供引擎源码，前后端共用同一份实现', async () => {
  const response = await fetch(`${base}/engine/core/validate.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /javascript/);
  const source = await response.text();
  assert.ok(source.includes('export function validateSubmission'));
  assert.ok(source.includes("from './expr.js'"), '相对 import 必须原样保留，否则浏览器解析不到依赖');
});

test('/static/ 提供前端资源', async () => {
  const response = await fetch(`${base}/static/runtime.js`);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('/engine/core/validate.js'), '运行时必须从 /engine/ 导入引擎');
});

test('静态资源禁止目录穿越', async () => {
  for (const attack of ['/engine/%2e%2e%2fpackage.json', '/static/%2e%2e%2fsrc%2fcli.js']) {
    const response = await fetch(`${base}${attack}`);
    assert.ok([403, 404].includes(response.status), `${attack} 应被拒绝，实际 ${response.status}`);
    const body = await response.text();
    assert.ok(!body.includes('"name": "formgen"'), '不得泄露项目文件');
  }
});

// ---------------------------------------------------------------------------
// 生成 → 发布 → 填写 → 提交 → 结果
// ---------------------------------------------------------------------------

test('完整闭环：生成 → 发布 → 填写 → 提交 → 导出', async () => {
  // 1. 生成
  const generated = await post('/api/generate', {
    text: '做一个活动报名表，包含姓名、手机号、参加场次（上午/下午）、参加人数。',
    mode: 'rule',
  });
  assert.equal(generated.status, 200);
  const gen = await generated.json();
  assert.equal(gen.ok, true);
  assert.equal(gen.channel, 'rule');
  assert.ok(gen.draftId);
  assert.equal(gen.schema.kind, 'form');

  const labels = gen.schema.groups.flatMap(g => g.fields.map(f => f.label));
  assert.deepEqual(labels, ['姓名', '手机号', '参加场次', '参加人数']);

  // 2. 发布
  const published = await (await post('/api/publish', { draftId: gen.draftId })).json();
  assert.equal(published.ok, true);
  const formId = published.formId;
  assert.match(published.fillUrl, new RegExp(`^/f/${formId}/fill$`));

  // 3. 填写页真的把 Schema 嵌进去了
  const fill = await fetch(`${base}${published.fillUrl}`);
  assert.equal(fill.status, 200);
  const fillHtml = await fill.text();
  assert.ok(fillHtml.includes('id="formgen-schema"'));
  assert.ok(fillHtml.includes('活动报名表'));

  // 4. 非法提交被服务端拒绝，且逐字段给出原因
  const rejected = await post('/api/submit', { formId, values: { name: '', phone: '123' } });
  assert.equal(rejected.status, 422);
  const rejectBody = await rejected.json();
  assert.equal(rejectBody.error.code, 'VALIDATION_FAILED');
  assert.ok(rejectBody.errors.some(e => e.code === 'REQUIRED'));
  assert.ok(rejectBody.errors.some(e => e.code === 'INVALID_PHONE'));

  // 5. 合法提交
  const keyOf = label => gen.schema.groups.flatMap(g => g.fields).find(f => f.label === label).key;
  const accepted = await post('/api/submit', {
    formId,
    values: {
      [keyOf('姓名')]: '赵六',
      [keyOf('手机号')]: '138-0013-8000',
      [keyOf('参加场次')]: '上午',
      [keyOf('参加人数')]: '3',
    },
  });
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.ok, true);
  assert.ok(acceptedBody.submissionId);

  // 服务端把数据归一后入库（电话号码里的横线被清理、人数变成数字）
  const stored = await instance.store.listSubmissions(formId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].values[keyOf('手机号')], '13800138000');
  assert.equal(stored[0].values[keyOf('参加人数')], 3);

  // 6. 结果页与导出
  const results = await fetch(`${base}/f/${formId}`);
  assert.equal(results.status, 200);
  assert.ok((await results.text()).includes('赵六'));

  const csv = await fetch(`${base}/f/${formId}/export.csv`);
  assert.equal(csv.status, 200);
  // 注意：fetch().text() 会按规范**剥掉**开头的 BOM，所以要验证 BOM 必须看原始字节。
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'CSV 必须带 UTF-8 BOM，否则 Excel 打开中文乱码');
  const csvText = new TextDecoder('utf-8').decode(csvBytes);
  assert.ok(csvText.includes('姓名'));
  assert.ok(csvText.includes('赵六'));
  assert.ok(csvText.includes('13800138000'));

  const schemaJson = await (await fetch(`${base}/f/${formId}/schema.json`)).json();
  assert.equal(schemaJson.title, '活动报名表');
  assert.equal(schemaJson.id, formId);

  const exported = await (await fetch(`${base}/f/${formId}/export.json`)).json();
  assert.equal(exported.submissions.length, 1);
});

test('发布不存在的草稿给出明确错误', async () => {
  const response = await post('/api/publish', { draftId: 'nope' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'DRAFT_NOT_FOUND');
});

test('空需求被拒绝', async () => {
  const response = await post('/api/generate', { text: '   ', mode: 'rule' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'NLP_EMPTY_INPUT');
});

// ---------------------------------------------------------------------------
// 考卷
// ---------------------------------------------------------------------------

test('考卷闭环：组卷 → 渲染 → 自动判分', async () => {
  const response = await post('/api/generate', {
    mode: 'exam',
    text: '生成一份高一数学期中试卷，满分150分，考试时间120分钟，包含选择题10道每题5分、填空题4道每题5分、解答题5道，覆盖函数、三角函数、数列，公式用 LaTeX',
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.kind, 'exam');

  const schema = payload.schema;
  assert.equal(schema.kind, 'exam');
  assert.equal(schema.grading.totalScore, 150, '满分必须精确等于用户要求');
  assert.equal(schema.grading.duration, 120);

  // 每题分值之和必须等于满分，且与蓝图一致
  let sum = 0;
  let questionCount = 0;
  for (const group of schema.groups) {
    for (const field of group.fields) {
      if (field.type !== 'question') continue;
      questionCount += 1;
      sum += field.question.score;
    }
  }
  assert.equal(questionCount, 19);
  assert.equal(sum, 150, '试卷实际总分必须等于计划总分');
  assert.equal(payload.paper.totalScore, 150, '组卷报告也不应再报总分偏差');
  assert.deepEqual(payload.paper.report.warnings, []);

  // 题干保留 LaTeX，交给前端渲染成 MathML
  const stems = schema.groups.flatMap(g => g.fields).map(f => f.question.stem);
  assert.ok(stems.some(s => s.includes('$')), '数学卷题干应含 LaTeX 公式');

  // 选择题选项要有 A/B/C/D 标号
  const choice = schema.groups[0].fields[0].question;
  assert.equal(choice.options[0].value, 'A');

  // 发布后作答，客观题自动判分
  const published = await (await post('/api/publish', { draftId: payload.draftId })).json();
  const examsFields = schema.groups.flatMap(g => g.fields).filter(f => f.type === 'question');

  const values = {};
  let expected = 0;
  let answered = 0;
  for (const field of examsFields) {
    const question = field.question;
    if (['choice', 'multi', 'judge', 'blank'].includes(question.type) && question.answer !== undefined && answered < 5) {
      values[field.key] = question.type === 'blank' && Array.isArray(question.answer) ? question.answer[0] : question.answer;
      expected += question.score;
      answered += 1;
    }
  }
  assert.ok(answered > 0, '题库中应有带答案的客观题');

  const submit = await post('/api/submit', { formId: published.formId, values });
  const submitBody = await submit.json();
  assert.equal(submit.status, 200, JSON.stringify(submitBody));
  assert.equal(submitBody.ok, true);
  assert.equal(submitBody.totalScore, 150);
  assert.equal(submitBody.score, expected, `答对 ${answered} 题应得 ${expected} 分`);

  // 成绩分析出现在结果页
  const results = await fetch(`${base}/f/${published.formId}`);
  assert.equal(results.status, 200);
  const html = await results.text();
  assert.ok(html.includes('成绩分析'));
  assert.ok(html.includes('平均分'));
});

test('考卷题库覆盖不足时如实告警，不假装成功', async () => {
  const response = await post('/api/generate', {
    mode: 'exam',
    text: '生成一份高二化学期末试卷，满分150分，包含选择题20道每题5分、解答题5道，覆盖有机物、化学平衡',
  });
  const payload = await response.json();
  assert.equal(payload.ok, true, '题库不足也要给出一份可解释的结果');
  const warnings = payload.paper.report.warnings;
  assert.ok(Array.isArray(warnings));
  // 要么补齐了，要么如实说明缺口；不允许「静默少于计划分值」
  if (payload.paper.totalScore !== 150) {
    assert.ok(warnings.length > 0, '总分不足时必须给出告警');
    assert.ok(payload.paper.report.suggestions.length > 0, '应给出补充题库的建议');
  }
});

// ---------------------------------------------------------------------------
// 单元：CSV 生成
// ---------------------------------------------------------------------------

test('toCsv 正确转义引号、逗号与换行', () => {
  const schema = {
    groups: [{ title: 'G', fields: [
      { key: 'a', label: '备注', type: 'textarea' },
      { key: 'b', label: '标签', type: 'checkbox' },
    ] }],
  };
  const csv = toCsv(schema, [{
    id: 'x1',
    createdAt: '2024-01-01T00:00:00.000Z',
    values: { a: '含"引号", 逗号\n和换行', b: ['甲', '乙'] },
  }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"含""引号"", 逗号\n和换行"'), 'CSV 字段内的引号要双写、整体加引号');
  assert.ok(csv.includes('甲、乙'));
});

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

test('FileStore：索引、提交、删除', async () => {
  const dir = path.join(TMP_ROOT, 'store-unit');
  const store = await new FileStore(dir).init();

  const record = await store.createForm({ title: '单元测试表', kind: 'form', groups: [{ fields: [] }], meta: {} });
  assert.ok(record.id);
  assert.equal(store.listForms().length, 1);

  const loaded = await store.getForm(record.id);
  assert.equal(loaded.schema.title, '单元测试表');
  assert.equal(loaded.schema.id, record.id, '读回时 id 应被写入 schema');

  await store.addSubmission(record.id, { values: { a: 1 } });
  await store.addSubmission(record.id, { values: { a: 2 } });
  assert.equal((await store.listSubmissions(record.id)).length, 2);
  assert.equal((await store.stats()).submissions, 2);

  assert.equal(await store.deleteForm(record.id), true);
  assert.equal(store.listForms().length, 0);
  assert.equal(await store.getForm(record.id), null);
  assert.deepEqual(await store.listSubmissions(record.id), []);
});

test('FileStore：跨实例持久化（重启不丢数据）', async () => {
  const dir = path.join(TMP_ROOT, 'store-persist');
  const first = await new FileStore(dir).init();
  const record = await first.createForm({ title: '持久化表', kind: 'form', groups: [{ fields: [] }], meta: {} });
  await first.addSubmission(record.id, { values: { keep: true } });

  const second = await new FileStore(dir).init();
  assert.equal(second.listForms().length, 1);
  assert.equal((await second.getForm(record.id)).schema.title, '持久化表');
  assert.equal((await second.listSubmissions(record.id))[0].values.keep, true);
});

test('草稿：可取回，过期后失效', async () => {
  const dir = path.join(TMP_ROOT, 'store-draft');
  const store = await new FileStore(dir).init();
  const id = store.putDraft({ title: '草稿' });
  assert.equal(store.getDraft(id).title, '草稿');
  assert.equal(store.getDraft('unknown'), null);

  store.drafts.get(id).at = Date.now() - store.draftTtlMs - 1;
  assert.equal(store.getDraft(id), null, '过期草稿应失效');
});
