import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRichText, latexToMathML } from '../src/latex/mathml.js';
import { renderFillPage, renderHomePage, renderResultsPage, renderErrorPage, escapeHtml, jsonScript, collectColumns, formatCell } from '../src/render/html.js';
import { paperToSchema, paperToText } from '../src/exam/paper-schema.js';
import { buildBlueprint } from '../src/exam/blueprint.js';
import { selectQuestions } from '../src/exam/select.js';
import { loadBank } from '../src/exam/bank.js';
import { validateSubmission } from '../src/core/validate.js';
import { isCorrect } from '../src/server/app.js';

// ---------------------------------------------------------------------------
// 公式渲染
// ---------------------------------------------------------------------------

test('考卷题干里的 LaTeX 渲染为 MathML', () => {
  const stems = [
    '已知函数 $f(x)=\\sqrt{2-x}+\\dfrac{1}{x-1}$ 的定义域是',
    '在 $\\triangle ABC$ 中，$a=3$，$b=4$，$C=\\dfrac{\\pi}{3}$，求边 $c$ 的长。',
    '求数列 $\\{n\\cdot 2^{n}\\}$ 的前 $n$ 项和 $S_{n}$。',
  ];
  for (const stem of stems) {
    const html = renderRichText(stem);
    assert.ok(html.includes('<math'), `应输出 MathML：${stem}`);
    assert.ok(!html.includes('\\dfrac'), 'LaTeX 命令不应原样残留');
    assert.ok(html.includes('xmlns="http://www.w3.org/1998/Math/MathML"'));
  }
});

test('公式渲染对畸形输入不抛错', () => {
  for (const bad of ['$', '\\frac{', '{{{{', '$$$$', null, undefined, 123]) {
    assert.doesNotThrow(() => renderRichText(bad));
    assert.equal(typeof renderRichText(bad), 'string');
  }
  assert.equal(typeof latexToMathML('\\unknowncmd{x}'), 'string');
});

test('非公式文本被 HTML 转义', () => {
  const html = renderRichText('a<b & c>d "e"');
  assert.ok(html.includes('&lt;b'));
  assert.ok(html.includes('&amp;'));
  assert.ok(!html.includes('<b>'));
});

// ---------------------------------------------------------------------------
// 外壳 HTML 的安全性
// ---------------------------------------------------------------------------

test('escapeHtml 覆盖五个危险字符', () => {
  assert.equal(escapeHtml(`<script>"x"&'y'`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
});

test('嵌入 Schema 的 JSON 不会提前闭合 script 标签', () => {
  const payload = { title: '</script><img src=x onerror=alert(1)>' };
  const embedded = jsonScript(payload);
  assert.ok(!embedded.includes('</script>'), '必须转义 < 以阻止 script 提前闭合');
  assert.ok(embedded.includes('\\u003c'));
  // 仍应能还原成原对象
  assert.equal(JSON.parse(embedded).title, payload.title);
});

test('表单标题里的 HTML 被转义，不会形成注入', () => {
  const schema = {
    version: 1, kind: 'form', title: '<img src=x onerror=alert(1)>',
    description: '', locale: 'zh-CN',
    groups: [{ key: 'g', title: '组', fields: [{ key: 'a', label: '姓名', type: 'text' }] }],
    settings: {}, meta: {},
  };
  const html = renderFillPage(schema);
  assert.ok(!html.includes('<img src=x'), '标题必须被转义');
  assert.ok(html.includes('&lt;img src=x'));
});

test('结果页转义单元格内容', () => {
  const form = { id: 'f1', title: 'T', schema: { groups: [{ title: '', fields: [{ key: 'a', label: '备注', type: 'textarea' }] }] } };
  const html = renderResultsPage(form, [{ id: 'sub-12345678', createdAt: '2024-01-01T00:00:00Z', values: { a: '<script>alert(1)</script>' } }]);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('错误页与首页在空数据下也能渲染', () => {
  assert.ok(renderErrorPage(404, '没有这个页面').includes('没有这个页面'));
  const home = renderHomePage([], { forms: 0, submissions: 0, questions: 0, llmConfigured: false });
  assert.ok(home.includes('还没有任何表单'));
  assert.ok(home.includes('未接入'));
});

// ---------------------------------------------------------------------------
// 导出列与单元格格式化
// ---------------------------------------------------------------------------

test('导出列跳过纯展示字段', () => {
  const schema = { groups: [{ title: 'G', fields: [
    { key: 'a', label: '姓名', type: 'text' },
    { key: 's', label: '说明', type: 'statement' },
    { key: 'h', label: '小节', type: 'section' },
  ] }] };
  const columns = collectColumns(schema);
  assert.deepEqual(columns.map(c => c.key), ['a']);
  assert.equal(columns[0].group, 'G');
});

test('单元格格式化：文件、矩阵、布尔、数组', () => {
  assert.equal(formatCell({ type: 'file' }, { name: '简历.pdf' }), '简历.pdf');
  assert.equal(formatCell({ type: 'file' }, [{ name: 'a.png' }, { name: 'b.png' }]), 'a.png、b.png');
  assert.equal(formatCell({ type: 'matrix' }, { 教学: '满意', 环境: '一般' }), '教学:满意；环境:一般');
  assert.equal(formatCell({ type: 'switch' }, true), '是');
  assert.equal(formatCell({ type: 'checkbox' }, ['甲', '乙']), '甲、乙');
  assert.equal(formatCell({ type: 'question' }, true), '对');
  assert.equal(formatCell({ type: 'text' }, null), '');
});

// ---------------------------------------------------------------------------
// 考卷 → Schema → 判分 全链路
// ---------------------------------------------------------------------------

test('组卷产出的 Schema 可直接渲染、校验与判分', async () => {
  const blueprint = buildBlueprint({
    title: '单元测试卷', subject: '数学', grade: '高一', totalScore: 100, duration: 60,
    sections: [
      { type: '选择题', count: 5, scorePer: 6 },
      { type: '填空题', count: 2, scorePer: 5 },
      { type: '解答题', count: 3 },
    ],
    knowledgePoints: ['函数', '数列', '三角函数'],
  });
  const bank = await loadBank({ subject: '数学' });
  assert.ok(bank.length > 0, '种子题库应能加载');

  // 分值以蓝图为准：先对齐再组卷，实际总分才等于计划总分
  const { alignBankToBlueprint } = await import('../src/exam/paper-schema.js');
  const { paper, report } = selectQuestions(alignBankToBlueprint(bank, blueprint), blueprint);
  assert.equal(paper.totalScore, blueprint.totalScore, '实际总分必须等于计划总分');
  assert.deepEqual(report.warnings, []);

  const schema = paperToSchema(paper, { sourceText: '单元测试' });
  assert.equal(schema.kind, 'exam');
  assert.equal(schema.grading.totalScore, 100);
  assert.equal(schema.grading.duration, 60);
  assert.equal(schema.settings.submitText, '交卷');

  // 每题分值之和 = 满分
  const scoreSum = schema.groups.flatMap(g => g.fields).reduce((sum, f) => sum + (f.question?.score ?? 0), 0);
  assert.equal(scoreSum, 100);

  // 选择题选项带 A/B/C/D 标号
  const choiceField = schema.groups.flatMap(g => g.fields).find(f => f.question?.type === 'choice');
  assert.equal(choiceField.question.options[0].value, 'A');
  assert.ok(choiceField.question.stem.includes('$'), '数学题题干应带 LaTeX');

  // 空卷也能通过校验（考试允许不作答）
  const empty = validateSubmission(schema, {});
  assert.equal(empty.ok, true);

  // 判分：答对给满分，答错给 0
  const question = choiceField.question;
  assert.equal(isCorrect(question, question.answer), true);
  const wrong = question.answer === 'A' ? 'B' : 'A';
  assert.equal(isCorrect(question, wrong), false);

  // 多选题必须全对才得分
  assert.equal(isCorrect({ type: 'multi', answer: ['A', 'B'] }, ['B', 'A']), true);
  assert.equal(isCorrect({ type: 'multi', answer: ['A', 'B'] }, ['A']), false);
  assert.equal(isCorrect({ type: 'multi', answer: ['A', 'B'] }, ['A', 'B', 'C']), false);

  // 判断题兼容 true / '对' 两种写法
  assert.equal(isCorrect({ type: 'judge', answer: true }, '对'), true);
  assert.equal(isCorrect({ type: 'judge', answer: false }, '对'), false);

  // 填空题按归一后字符串比较（忽略空格与大小写）
  assert.equal(isCorrect({ type: 'blank', answer: ['3'] }, [' 3 ']), true);
  assert.equal(isCorrect({ type: 'blank', answer: ['3'] }, ['4']), false);

  // 主观题不给自动判定
  assert.equal(isCorrect({ type: 'solve', answer: 'x' }, 'y'), null);

  // 纯文本版可打印
  const text = paperToText(paper);
  assert.ok(text.includes('单元测试卷'));
  assert.ok(text.includes('满分 100 分'));
});

test('考场蓝图配平后与用户明示的分值一致', () => {
  const blueprint = buildBlueprint({
    totalScore: 150,
    sections: [
      { type: 'choice', count: 10, scorePer: 5 },
      { type: 'blank', count: 4, scorePer: 5 },
      { type: 'solve', count: 5, scorePer: 16 },
    ],
  });
  assert.equal(blueprint.sections.find(s => s.type === 'choice').scorePer, 5, '明示的分值不得被改写');
  assert.equal(blueprint.sections.reduce((sum, s) => sum + s.count * s.scorePer, 0), 150);
  assert.deepEqual(blueprint.adjustments, [], '大纲本身已闭合，不应产生配平调整');
});
