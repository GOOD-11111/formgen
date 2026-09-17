import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSchema, schemaStats, validateSchemaShape, normalizeFieldType, deriveKey, findField } from '../src/core/schema.js';
import { validateSubmission, resolveVisibility, applyComputations, defaultValues, validateChineseIdCard } from '../src/core/validate.js';
import { evaluateExpr, evaluateCondition, checkExpr, exprIdentifiers, compileExpr } from '../src/core/expr.js';
import { FormgenError } from '../src/core/errors.js';

/** 一份覆盖多数字段类型的样例 Schema，多个测试共用。 */
function sampleSchema() {
  const { schema, issues } = normalizeSchema({
    title: '新员工入职信息收集',
    kind: 'form',
    groups: [{
      title: '基本信息',
      fields: [
        { label: '姓名', type: '文本', required: true },
        { label: '手机号', type: '手机号', required: true },
        { label: '身份证号', type: 'text', required: false },
        { label: '应聘部门', type: '单选', options: ['技术部', '产品部'] },
        { label: '技术栈', type: '多选', options: ['前端', '后端'], visibleWhen: "department == '技术部'" },
        { label: '数量', type: 'integer', min: 1, max: 99 },
        { label: '总价', type: 'number', compute: 'round(quantity * 12.5, 2)' },
        { label: '同意条款', type: 'switch', required: true },
      ],
    }],
  });
  return { schema, issues };
}

test('字段类型中英文别名归一', () => {
  assert.equal(normalizeFieldType('文本'), 'text');
  assert.equal(normalizeFieldType('多行文本'), 'textarea');
  assert.equal(normalizeFieldType('手机号'), 'tel');
  assert.equal(normalizeFieldType('手机号码'), 'tel');
  assert.equal(normalizeFieldType('下拉框'), 'select');
  assert.equal(normalizeFieldType('多选'), 'checkbox');
  assert.equal(normalizeFieldType('上传'), 'file');
  assert.equal(normalizeFieldType('Number'), 'number');
  assert.equal(normalizeFieldType('胡说八道'), null);
  assert.equal(normalizeFieldType(null), null);
});

test('key 由中文标签稳定推导且唯一', () => {
  const used = new Set();
  assert.equal(deriveKey('姓名', 0, used), 'name');
  assert.equal(deriveKey('手机号', 1, used), 'phone');
  assert.equal(deriveKey('手机号', 2, used), 'phone2');
  assert.equal(deriveKey('', 3, used), 'f4');
});

test('normalizeSchema 产出规范结构', () => {
  const { schema, issues } = sampleSchema();
  assert.deepEqual(issues, []);
  assert.equal(schema.title, '新员工入职信息收集');
  assert.equal(schema.kind, 'form');
  assert.equal(schema.groups.length, 1);

  const stats = schemaStats(schema);
  assert.equal(stats.fields, 8);
  assert.equal(stats.required, 3, '姓名/手机号/同意条款为必填');
  assert.equal(stats.types.tel, 1);
  assert.deepEqual(validateSchemaShape(schema), []);

  // 中文标签 → 稳定英文 key
  assert.equal(findField(schema, '姓名').key, 'name');
  assert.equal(findField(schema, '手机号').key, 'phone');
  assert.equal(findField(schema, '应聘部门').key, 'department');
  assert.equal(findField(schema, '同意条款').key, 'agreement');
});

test('未知字段类型抛 FormgenError 且 code 稳定', () => {
  assert.throws(
    () => normalizeSchema({ title: 'x', fields: [{ label: '怪字段', type: '量子纠缠' }] }),
    error => error instanceof FormgenError && error.code === 'SCHEMA_FIELD_TYPE_UNKNOWN',
  );
});

test('空 Schema 被拒绝', () => {
  assert.throws(() => normalizeSchema({ title: '空的' }), error => error.code === 'SCHEMA_EMPTY');
});

test('多余属性被剔除并记录 issue', () => {
  const { schema, issues } = normalizeSchema({
    title: 'x',
    fields: [{ label: '姓名', type: 'text', 乱七八糟: 1, min: 2 }],
  });
  const field = schema.groups[0].fields[0];
  assert.equal(field['乱七八糟'], undefined);
  assert.equal(field.min, undefined, 'min 不属于 text 类型，应被剔除');
  assert.ok(issues.some(i => i.includes('乱七八糟')));
});

test('完整提交通过校验并转换类型', () => {
  const { schema } = sampleSchema();
  const K = label => findField(schema, label).key;
  const result = validateSubmission(schema, {
    [K('姓名')]: '张三',
    [K('手机号')]: '138-0013-8000',
    [K('应聘部门')]: '技术部',
    [K('技术栈')]: ['前端'],
    [K('数量')]: '3',
    [K('同意条款')]: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.values[K('姓名')], '张三');
  assert.equal(result.values[K('手机号')], '13800138000', '电话中的分隔符应被清理');
  assert.equal(result.values[K('数量')], 3);
  assert.equal(result.values[K('总价')], 37.5, '计算字段应自动求值');
  assert.deepEqual(result.values[K('技术栈')], ['前端']);
});

test('必填与格式错误被逐字段报告', () => {
  const { schema } = sampleSchema();
  const K = label => findField(schema, label).key;
  const result = validateSubmission(schema, {
    [K('姓名')]: '', [K('手机号')]: '123', [K('数量')]: '0', [K('同意条款')]: false,
  });
  assert.equal(result.ok, false);
  const codes = result.errors.map(e => e.code);
  assert.ok(codes.includes('REQUIRED'));
  assert.ok(codes.includes('INVALID_PHONE'));
  assert.ok(codes.includes('BELOW_MIN'));
  assert.ok(codes.includes('MUST_ACCEPT'));
  assert.ok(result.errors.every(e => typeof e.message === 'string' && e.message.length > 0));
});

test('不可见字段的值被清空，且不参与必填', () => {
  const { schema } = sampleSchema();
  const K = label => findField(schema, label).key;
  const result = validateSubmission(schema, {
    [K('姓名')]: '李四',
    [K('手机号')]: '13900139000',
    [K('应聘部门')]: '产品部',
    [K('技术栈')]: ['前端'],
    [K('同意条款')]: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.values[K('技术栈')], [], '部门不是技术部时，技术栈应被清空');
});

test('多级联动可见性收敛', () => {
  const { schema } = normalizeSchema({
    title: '联动',
    fields: [
      { key: 'a', label: 'A', type: 'switch' },
      { key: 'b', label: 'B', type: 'switch', visibleWhen: 'a == true' },
      { key: 'c', label: 'C', type: 'text', visibleWhen: 'b == true' },
    ],
  });
  const off = resolveVisibility(schema, { a: false, b: false, c: '' });
  assert.equal(off.get('b'), false);
  assert.equal(off.get('c'), false);

  const on = resolveVisibility(schema, { a: true, b: true, c: 'x' });
  assert.equal(on.get('b'), true);
  assert.equal(on.get('c'), true);
});

test('循环依赖的计算字段不会死循环也不会留 undefined', () => {
  const { schema } = normalizeSchema({
    title: '循环',
    fields: [
      { key: 'x', label: 'X', type: 'number', compute: 'y + 1' },
      { key: 'y', label: 'Y', type: 'number', compute: 'x + 1' },
    ],
  });
  const values = applyComputations(schema, defaultValues(schema));
  assert.notEqual(values.x, undefined, '循环依赖也必须给出确定值，不能留 undefined');
  assert.notEqual(values.y, undefined);
});

test('身份证校验：校验位/日期/长度', () => {
  assert.equal(validateChineseIdCard('110101199003072316').ok, true, '这是校验位正确的样例号码');
  const valid = validateChineseIdCard('11010519491231002X');
  assert.equal(valid.ok, true);
  assert.equal(valid.gender, '女');
  assert.equal(valid.birthDate, '1949-12-31');
  assert.equal(validateChineseIdCard('110105194912310021').ok, false, '校验位错误');
  assert.equal(validateChineseIdCard('11010519491331002X').ok, false, '13 月不存在');
  assert.equal(validateChineseIdCard('123').ok, false);
});

test('全角数字在结构化字段被归一，中文正文标点不被破坏', () => {
  const { schema } = normalizeSchema({
    title: 'x',
    fields: [
      { key: 'phone', label: '手机号', type: 'tel' },
      { key: 'remark', label: '备注', type: 'textarea' },
    ],
  });
  const result = validateSubmission(schema, { phone: '１３８００１３８０００', remark: '公司很好，但是：工资低了？' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.values.phone, '13800138000');
  assert.equal(result.values.remark, '公司很好，但是：工资低了？', '中文标点必须原样保留');
});

test('表达式：算术、比较、逻辑、中文逻辑词', () => {
  assert.equal(evaluateExpr('round(price * quantity * 0.87, 2)', { price: 19.9, quantity: 3 }), 51.94);
  assert.equal(evaluateExpr('age >= 18 && name != ""', { age: 20, name: 'x' }), true);
  assert.equal(evaluateExpr('年龄 >= 18 且 姓名 != ""', { 年龄: 20, 姓名: 'x' }), true);
  assert.equal(evaluateExpr('dept in ["技术部","产品部"]', { dept: '技术部' }), true);
  assert.equal(evaluateExpr('x not in [1,2]', { x: 3 }), true);
  assert.equal(evaluateExpr('if(score > 90, "优秀", "继续努力")', { score: 95 }), '优秀');
  assert.equal(evaluateExpr('len(hobbies) > 0 && includes(hobbies, "读书")', { hobbies: ['读书', '跑步'] }), true);
  assert.equal(evaluateExpr('1 + 2 * 3'), 7);
  assert.equal(evaluateExpr('(1 + 2) * 3'), 9);
});

test('表达式短路求值避免空值崩溃', () => {
  assert.equal(evaluateExpr('a && a.b.c', {}), false);
  assert.equal(evaluateExpr('a.b.c', {}), undefined);
});

test('表达式拒答原型链访问', () => {
  assert.equal(evaluateExpr('constructor', {}), undefined);
  assert.equal(evaluateExpr('a.__proto__', { a: {} }), undefined);
  assert.equal(evaluateExpr('a.constructor', { a: {} }), undefined);
});

test('表达式错误可检测且默认不抛', () => {
  assert.ok(checkExpr('1 +') !== null, '不完整的表达式应被判定为错误');
  assert.ok(checkExpr('a &&') !== null);
  assert.equal(checkExpr('a + b'), null);
  assert.equal(evaluateExpr('@@@', {}, { fallback: 'X' }), 'X');
  assert.throws(() => evaluateExpr('@@@', {}, { strict: true }));
});

test('exprIdentifiers 提取依赖并排除函数名', () => {
  const names = exprIdentifiers('round(price * quantity, 2) > threshold && flag');
  assert.deepEqual(names.sort(), ['flag', 'price', 'quantity', 'threshold']);
});

test('compileExpr 与 evaluateExpr 结果一致且可复用', () => {
  const fn = compileExpr('a * b + 1');
  assert.equal(fn({ a: 2, b: 3 }), 7);
  assert.equal(fn({ a: 2, b: 3 }), 7);
  assert.equal(fn({}), 1, '缺值按 0 处理');
});

test('条件表达式：空表达式默认放行', () => {
  assert.equal(evaluateCondition('', {}, { defaultWhenEmpty: true }), true);
  assert.equal(evaluateCondition('', {}, { defaultWhenEmpty: false }), false);
});

test('partial 模式跳过必填检查', () => {
  const { schema } = sampleSchema();
  const result = validateSubmission(schema, { name: '' }, { partial: true });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.length > 0);
});

test('Schema 级交叉规则生效', () => {
  const { schema } = normalizeSchema({
    title: 'date range',
    fields: [
      { key: 'startDate', label: '开始日期', type: 'date' },
      { key: 'endDate', label: '结束日期', type: 'date' },
    ],
  });
  schema.rules = [{ expr: 'endDate >= startDate', message: '结束日期不能早于开始日期', key: 'endDate' }];
  const bad = validateSubmission(schema, { startDate: '2024-05-01', endDate: '2024-04-01' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'CROSS_RULE_FAILED');
  const good = validateSubmission(schema, { startDate: '2024-04-01', endDate: '2024-05-01' });
  assert.equal(good.ok, true);
});
