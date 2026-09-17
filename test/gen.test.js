import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRequirement, splitFieldList, parseFieldPhrase, extractOptions, detectDomain, extractTitle, splitClauses, isConditionClause, guessField } from '../src/gen/nlp.js';
import { parseSections, parseExamOutline, parseKnowledgePoints, fillMissingScorePer } from '../src/gen/exam-intent.js';
import { generate, generateByRule, compareChannels, planExam } from '../src/gen/index.js';
import { extractJson, isLlmConfigured, buildMessages, resolveLlmConfig } from '../src/gen/llm.js';
import { findField, walkFields, schemaStats, validateSchemaShape } from '../src/core/schema.js';
import { validateSubmission } from '../src/core/validate.js';
import { FormgenError } from '../src/core/errors.js';

/** 用中文标签找字段，让断言读起来就是需求本身。 */
const K = (schema, label) => {
  const field = findField(schema, label);
  assert.ok(field, `应当存在字段「${label}」，实际字段：${[...walkFields(schema)].map(e => e.field.label).join('、')}`);
  return field;
};

// ---------------------------------------------------------------------------
// 需求解析
// ---------------------------------------------------------------------------

test('切句：中英文标点都认', () => {
  assert.deepEqual(splitClauses('第一句。第二句；第三句！'), ['第一句', '第二句', '第三句']);
  assert.deepEqual(splitClauses('a;b\nc'), ['a', 'b', 'c']);
});

test('域识别', () => {
  assert.equal(detectDomain('生成一份高一数学期中试卷').domain, 'exam');
  assert.equal(detectDomain('做一个客户满意度调查问卷').domain, 'survey');
  assert.equal(detectDomain('员工入职信息收集表').domain, 'registration');
  assert.equal(detectDomain('投诉反馈表').domain, 'feedback');
  assert.equal(detectDomain('随便什么').domain, 'form');
});

test('标题抽取去掉动词前缀', () => {
  assert.equal(extractTitle('帮我做一个员工入职信息收集表，包含姓名'), '员工入职信息收集表');
  assert.equal(extractTitle('做一个客户满意度调查问卷：姓名'), '客户满意度调查问卷');
  assert.equal(extractTitle('创建一个活动报名表。基本信息：姓名'), '活动报名表');
});

test('字段清单切分：顿号、逗号、和', () => {
  assert.deepEqual(splitFieldList('姓名、手机号、邮箱'), ['姓名', '手机号', '邮箱']);
  assert.deepEqual(splitFieldList('姓名，手机号'), ['姓名', '手机号']);
  assert.deepEqual(splitFieldList('紧急联系人姓名和电话'), ['紧急联系人姓名', '电话']);
});

test('字段清单切分：括号里的选项不被顿号拆开', () => {
  // 「所在部门（技术部、市场部、财务部）」是一个字段，不是三个
  const parts = splitFieldList('所在部门（技术部、市场部、财务部）、报销金额');
  assert.equal(parts.length, 2, `实际切成了 ${JSON.stringify(parts)}`);
  assert.ok(parts[0].includes('技术部、市场部、财务部'));
});

test('字段清单切分：不像字段的「和」不拆', () => {
  const parts = splitFieldList('对公司的建议和意见');
  assert.equal(parts.length, 1, `实际切成了 ${JSON.stringify(parts)}`);
});

test('选项抽取', () => {
  assert.deepEqual(extractOptions('技术/产品/设计'), ['技术', '产品', '设计']);
  assert.deepEqual(extractOptions('差旅、餐饮、办公用品'), ['差旅', '餐饮', '办公用品']);
  assert.equal(extractOptions('必填'), null, '单个词不算选项列表');
});

// ---------------------------------------------------------------------------
// 端到端：真实需求 → Schema
// ---------------------------------------------------------------------------

test('员工入职表：类型推断与必填默认', () => {
  const { schema, issues } = parseRequirement(
    '帮我做一个员工入职信息收集表，包含姓名、手机号、身份证号、入职日期、部门（技术部/产品部/设计部），还要上传身份证照片。',
  );
  assert.deepEqual(issues, []);
  assert.equal(schema.title, '员工入职信息收集表');

  assert.equal(K(schema, '姓名').type, 'text');
  assert.equal(K(schema, '姓名').required, true, '姓名默认为必填');
  assert.equal(K(schema, '手机号').type, 'tel');
  assert.equal(K(schema, '手机号').required, true);
  assert.equal(K(schema, '身份证号').type, 'idcard');
  assert.equal(K(schema, '入职日期').type, 'date');
  assert.equal(K(schema, '部门').type, 'select');
  assert.deepEqual(K(schema, '部门').options.map(o => o.value), ['技术部', '产品部', '设计部']);
  // 「身份证照片」必须命中文件类型，且不被「身份证」抢走
  assert.equal(K(schema, '身份证照片').type, 'file');
  assert.equal(K(schema, '身份证照片').accept, 'image/*');
});

test('报销表：金额约束、选填备注、选项不串味', () => {
  const { schema, issues } = parseRequirement(
    '做一个报销申请表，包含申请人姓名、所在部门（技术部、市场部、财务部）、报销金额（元）、费用发生日期、费用类型（差旅/餐饮/办公用品/其他）、发票附件上传、备注（选填）。',
  );
  assert.deepEqual(issues, []);

  const amount = K(schema, '报销金额');
  assert.equal(amount.type, 'number');
  assert.equal(amount.min, 0);
  assert.equal(amount.unit, '元');

  const expenseType = K(schema, '费用类型');
  assert.equal(expenseType.type, 'select');
  assert.deepEqual(expenseType.options.map(o => o.value), ['差旅', '餐饮', '办公用品', '其他']);

  assert.equal(K(schema, '备注').required ?? false, false, '备注标了选填');
  assert.equal(K(schema, '备注').type, 'textarea');

  // 「费用发生日期」曾被误判成 birthday（"发生日" 里含 "生日"）——这里钉死回归
  assert.equal(K(schema, '费用发生日期').type, 'date');
  assert.notEqual(K(schema, '费用发生日期').key, 'birthday');
});

test('满意度问卷：评分区间与开关', () => {
  const { schema } = parseRequirement(
    '做一个客户满意度调查问卷：姓名、手机号、对产品的满意度评分（1-5星）、意见建议、是否愿意推荐给朋友。',
  );
  const rating = K(schema, '对产品的满意度评分');
  assert.equal(rating.type, 'rating');
  assert.equal(rating.max, 5);
  assert.equal(K(schema, '意见建议').type, 'textarea');
  assert.equal(K(schema, '是否愿意推荐给朋友').type, 'switch');
});

test('分组与条件联动：被提到但未定义的字段一定会被创建出来', () => {
  const { schema } = parseRequirement(
    '创建一个活动报名表。基本信息：姓名、手机号、学校。参会信息：参会日期、饮食禁忌（素食/清真/无要求/其他）。如果是素食，请填写具体说明。',
  );
  assert.equal(schema.groups.length, 2);
  assert.equal(schema.groups[0].title, '基本信息');
  assert.equal(schema.groups[1].title, '参会信息');

  const diet = K(schema, '饮食禁忌');
  const detail = K(schema, '具体说明');
  assert.equal(detail.visibleWhen, `${diet.key} == "素食"`);
  assert.equal(detail.type, 'textarea', '「具体说明」是让用户填的，不能是只读展示块');

  // 系统必须解释清楚这个字段是怎么来的——用户没在字段清单里写它。
  const notes = schema.meta.notes ?? [];
  assert.ok(
    notes.some(n => n.includes('自动补建') || n.includes('不在内置词典里')),
    `应说明字段来源，实际 notes：${JSON.stringify(notes)}`,
  );
});

test('冒号前的标题句不会被误判为分组', () => {
  const { schema } = parseRequirement('做一个客户满意度调查问卷：姓名、手机号、意见建议。');
  assert.equal(schema.groups.length, 1);
  assert.equal(schema.groups[0].title, '', '标题句不应成为分组标题');
  assert.equal(K(schema, '姓名').type, 'text');
});

test('「需要的话填 X」：条件由紧邻其前的字段推断', () => {
  const { schema } = parseRequirement(
    '做一个店庆活动报名表：姓名、手机号、参加场次（上午/下午/全天）、参加人数、是否需要停车位，需要的话填车牌号，最后写一句想对店长说的话。',
  );
  const labels = schema.groups.flatMap(g => g.fields).map(f => f.label);
  assert.deepEqual(labels, ['姓名', '手机号', '参加场次', '参加人数', '是否需要停车位', '车牌号', '对店长说的话'],
    '字段顺序应遵循需求里被提到的先后');

  const parking = K(schema, '是否需要停车位');
  const plate = K(schema, '车牌号');
  assert.equal(parking.type, 'switch');
  assert.equal(plate.visibleWhen, `${parking.key} == true`);
  assert.equal(K(schema, '对店长说的话').type, 'textarea', '「写一句…的话」应是多行文本');
});

test('词典不认识的字段被抢救下来，而不是静默丢弃', () => {
  // 漏字段比判错类型严重：用户会以为收到了数据，其实什么都没收到。
  const { schema, understanding } = parseRequirement('做一个登记表，包含姓名、请填写你的座右铭。');
  const labels = schema.groups.flatMap(g => g.fields).map(f => f.label);
  assert.ok(labels.includes('座右铭'), `实际字段：${labels.join('、')}`);
  assert.equal(K(schema, '座右铭').type, 'text');
  assert.ok(schema.meta.notes.some(n => n.includes('不在内置词典里')), '应如实说明这是兜底推断出来的类型');
  void understanding;
});

test('条件从句不被当成字段短语', () => {
  // 曾经的 bug：从句「希望的话填方便回电时间」被当成字段，产出名为
  // 「的话填方便回电时间」的垃圾字段，同时真正的字段又被重复创建一次。
  const { schema } = parseRequirement(
    '做一个客户投诉表：姓名、手机号、投诉类型（产品质量/物流配送/售后服务/其他）、如果选其他就填具体问题、问题描述、上传凭证照片、是否希望回电，希望的话填方便回电时间。',
  );
  const labels = schema.groups.flatMap(g => g.fields).map(f => f.label);
  assert.deepEqual(labels, ['姓名', '手机号', '投诉类型', '具体问题', '问题描述', '凭证照片', '是否希望回电', '方便回电时间']);
  assert.ok(!labels.some(l => l.startsWith('的话')), '不应出现以连接词开头的垃圾字段');

  // 触发条件写的是选项值「其他」而不是字段名，也应能绑定
  const type = K(schema, '投诉类型');
  const detail = K(schema, '具体问题');
  assert.equal(detail.visibleWhen, `${type.key} == "其他"`);
  assert.equal(detail.type, 'textarea');

  // 触发条件是布尔字段时判真值；目标字段类型按「时间」这个类型词推断
  const callback = K(schema, '是否希望回电');
  const slot = K(schema, '方便回电时间');
  assert.equal(slot.visibleWhen, `${callback.key} == true`);
  assert.equal(slot.type, 'time');
});

test('isConditionClause 区分条件从句与普通字段', () => {
  assert.equal(isConditionClause('如果选其他就填具体问题'), true);
  assert.equal(isConditionClause('需要的话填车牌号'), true);
  assert.equal(isConditionClause('希望的话填写方便回电时间'), true);
  assert.equal(isConditionClause('假如有发票请上传附件'), true);
  // 「的话」也可能只是名词后缀——这类是字段，不是条件
  assert.equal(isConditionClause('最后写一句想对店长说的话'), false);
  assert.equal(isConditionClause('备注（选填）'), false);
  assert.equal(isConditionClause('是否希望回电'), false);
  assert.equal(isConditionClause('问题描述'), false);
  assert.equal(isConditionClause(''), false);
});

test('解析出的 Schema 结构与提交校验闭环', () => {
  const { schema } = parseRequirement('做一个报名表，包含姓名、手机号、参加场次（上午/下午）、参加人数。');
  assert.deepEqual(validateSchemaShape(schema), []);
  assert.ok(schemaStats(schema).fields >= 4);

  const bad = validateSubmission(schema, { [K(schema, '姓名').key]: '', [K(schema, '手机号').key]: '123' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.code === 'REQUIRED'));
  assert.ok(bad.errors.some(e => e.code === 'INVALID_PHONE'));

  const good = validateSubmission(schema, {
    [K(schema, '姓名').key]: '王五',
    [K(schema, '手机号').key]: '13800138000',
    [K(schema, '参加场次').key]: '上午',
    [K(schema, '参加人数').key]: '2',
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.values[K(schema, '参加人数').key], 2);
});

test('无法识别字段时抛出可读错误而不是产出空表', () => {
  assert.throws(
    () => parseRequirement('???'),
    error => error instanceof FormgenError && error.code === 'NLP_NO_FIELD',
  );
  assert.throws(() => parseRequirement(''), error => error.code === 'NLP_EMPTY_INPUT');
});

// ---------------------------------------------------------------------------
// 考卷需求解析
// ---------------------------------------------------------------------------

test('考卷题型解析：数量与分值各归其位', () => {
  const sections = parseSections('满分150分，包含选择题10道每题5分、填空题4道每题5分、解答题5道');
  assert.deepEqual(sections, [
    { type: 'choice', title: '选择题', count: 10, scorePer: 5 },
    { type: 'blank', title: '填空题', count: 4, scorePer: 5 },
    { type: 'solve', title: '解答题', count: 5 },
  ], '解答题前面紧邻的「每题5分」属于填空题，不能泄漏到解答题上');
});

test('考卷题型解析：「共 N 分」按题型总分处理', () => {
  const sections = parseSections('解答题5题共60分');
  assert.equal(sections[0].type, 'solve');
  assert.equal(sections[0].count, 5);
  assert.equal(sections[0].scorePer, 12);
});

test('未写分值的题型吸收剩余总分', () => {
  const outline = parseExamOutline('满分150分，选择题10道每题5分、填空题4道每题5分、解答题5道');
  const solve = outline.sections.find(s => s.type === 'solve');
  assert.equal(solve.scorePer, 16, '150 − 10×5 − 4×5 = 80，80 ÷ 5 = 16');
  const choice = outline.sections.find(s => s.type === 'choice');
  assert.equal(choice.scorePer, 5, '用户明示的分值不得被改写');
});

test('fillMissingScorePer 不动已闭合的大纲', () => {
  const outline = { totalScore: 100, sections: [{ type: 'choice', count: 10, scorePer: 10 }] };
  fillMissingScorePer(outline);
  assert.equal(outline.sections[0].scorePer, 10);
});

test('知识点抽取不会被题型结构污染', () => {
  assert.deepEqual(
    parseKnowledgePoints('满分150分，包含选择题10道每题5分、填空题4道每题5分、解答题5道，覆盖函数、三角函数、数列，难度中等偏难'),
    ['函数', '三角函数', '数列'],
  );
  assert.deepEqual(parseKnowledgePoints('考查集合与常用逻辑用语、函数'), ['集合与常用逻辑用语', '函数']);
  assert.deepEqual(parseKnowledgePoints('做一份问卷'), []);
});

test('考卷需求整体解析', () => {
  const outline = parseExamOutline('生成一份高一数学期中试卷，满分150分，考试时间120分钟，包含选择题10道每题5分、填空题4道每题5分、解答题5道，覆盖函数、三角函数、数列，难度中等偏难，公式用 LaTeX');
  assert.equal(outline.title, '高一数学期中试卷', '要去掉「生成一份」这类动词前缀');
  assert.equal(outline.subject, '数学');
  assert.equal(outline.grade, '高一');
  assert.equal(outline.totalScore, 150);
  assert.equal(outline.duration, 120);
  assert.equal(outline.difficulty, 'hard');
  assert.equal(outline.requiresLatex, true);
  assert.deepEqual(outline.knowledgePoints, ['函数', '三角函数', '数列']);
});

test('「单元测验」不会被截成「单元测」', () => {
  const outline = parseExamOutline('初二物理单元测验，满分100，选择题10道每题4分');
  assert.equal(outline.title, '初二物理单元测验');
});

// ---------------------------------------------------------------------------
// 通道编排
// ---------------------------------------------------------------------------

test('generateByRule 是同步且确定性的', () => {
  const a = generateByRule('做一个报名表，包含姓名、手机号');
  const b = generateByRule('做一个报名表，包含姓名、手机号');
  assert.equal(a.channel, 'rule');
  assert.deepEqual(
    [...walkFields(a.schema)].map(e => [e.field.key, e.field.type]),
    [...walkFields(b.schema)].map(e => [e.field.key, e.field.type]),
  );
});

test('generate auto：未配置 key 时降级到规则通道并说明原因', async () => {
  const result = await generate('做一个报名表，包含姓名、手机号', { apiKey: '' });
  assert.equal(result.kind, 'form');
  assert.equal(result.channel, 'rule');
  assert.equal(result.fallback.code, 'LLM_NOT_CONFIGURED');
  assert.ok(result.fallback.reason.includes('DEEPSEEK_API_KEY'));
});

test('generate auto：LLM 失败时降级而不是抛出', async () => {
  const result = await generate('做一个报名表，包含姓名、手机号', {
    apiKey: 'sk-not-a-real-key',
    baseUrl: 'http://127.0.0.1:1',   // 必然连不上
    timeoutMs: 800,
  });
  assert.equal(result.channel, 'rule');
  assert.equal(result.fallback.from, 'llm');
  assert.ok(result.schema.groups.length > 0, '降级后仍必须产出可用表单');
});

test('generate auto：allowFallback=false 时如实抛出', async () => {
  await assert.rejects(
    () => generate('做一个报名表', { apiKey: 'sk-bad', baseUrl: 'http://127.0.0.1:1', timeoutMs: 800, allowFallback: false }),
  );
});

test('考卷需求被路由到考卷通道', async () => {
  const result = await generate('生成一份高一数学期中试卷，满分150分，选择题10道每题5分、填空题4道每题5分、解答题5道');
  assert.equal(result.kind, 'exam');
  assert.equal(result.outline.totalScore, 150);
});

test('planExam 不组卷，只给大纲', () => {
  const planned = planExam('满分100分，选择题10道每题4分、填空题5道每题4分、解答题3道');
  assert.equal(planned.kind, 'exam');
  assert.equal(planned.outline.totalScore, 100);
  // 100 − 10×4 − 5×4 = 40，40 ÷ 3 按 0.5 分粒度取 13.5
  assert.equal(planned.outline.sections.find(s => s.type === 'solve').scorePer, 13.5);
});

test('compareChannels 报出两条通道的差异', () => {
  const rule = generateByRule('做一个报名表，包含姓名、手机号');
  const fake = JSON.parse(JSON.stringify(rule));
  // 模拟大模型多补了一个字段、且把手机号判成了文本
  fake.schema.groups[0].fields.push({ key: 'extra', label: '补充说明', type: 'textarea' });
  const phone = fake.schema.groups[0].fields.find(f => f.key === 'phone');
  phone.type = 'text';

  const comparison = compareChannels(rule, { schema: fake.schema });
  assert.deepEqual(comparison.onlyInLlm, ['补充说明']);
  assert.deepEqual(comparison.onlyInRule, []);
  assert.deepEqual(comparison.typeDiffs, [{ label: '手机号', rule: 'tel', llm: 'text' }]);
  assert.ok(comparison.verdict.length > 0);
});

// ---------------------------------------------------------------------------
// LLM 通道的纯函数部分（不打网络）
// ---------------------------------------------------------------------------

test('extractJson 容忍代码围栏与前后寒暄', () => {
  assert.deepEqual(extractJson('{"title":"x"}'), { title: 'x' });
  assert.deepEqual(extractJson('```json\n{"title":"x"}\n```'), { title: 'x' });
  assert.deepEqual(extractJson('好的，这是结果：\n{"title":"x"}\n希望有帮助'), { title: 'x' });
  assert.throws(() => extractJson('完全不是 JSON'), error => error.code === 'LLM_MALFORMED_JSON');
  assert.throws(() => extractJson(''), error => error.code === 'LLM_EMPTY_RESPONSE');
});

test('提示词包含字段类型契约与 few-shot', () => {
  const messages = buildMessages('做一个报名表');
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('visibleWhen'), '契约里必须写明条件表达式');
  assert.ok(messages[0].content.includes('idcard'));
  assert.equal(messages.at(-1).content, '做一个报名表');

  const repair = buildMessages('做一个报名表', '字段「x」类型无法识别');
  assert.ok(repair.length > messages.length);
  assert.ok(repair.at(-1).content.includes('字段「x」类型无法识别'));
});

test('配置解析：显式参数优先于环境变量', () => {
  const config = resolveLlmConfig({ apiKey: 'k', baseUrl: 'http://x/', model: 'm' });
  assert.equal(config.apiKey, 'k');
  assert.equal(config.baseUrl, 'http://x', '结尾斜杠应被去掉');
  assert.equal(config.model, 'm');
  assert.equal(isLlmConfigured({ apiKey: 'k' }), true);
  assert.equal(isLlmConfigured({ apiKey: '' }) && Boolean(process.env.DEEPSEEK_API_KEY), Boolean(process.env.DEEPSEEK_API_KEY));
});

test('parseFieldPhrase 对非字段短语返回 null 而不是造垃圾字段', () => {
  const used = new Set();
  assert.equal(parseFieldPhrase('好的', 0, used).field, null);
  assert.equal(parseFieldPhrase('', 0, used).field, null);
});
