/**
 * FormSchema：本引擎的中间表示（IR）。
 *
 * 设计立场——这是整个「低代码」主张的技术落点：
 *
 *   自然语言 ──► FormSchema（纯 JSON，可存储/可版本化/可 diff）──► 运行时渲染
 *                     ▲                                                │
 *                     └──────────── 提交数据按同一份 Schema 校验 ◄──────┘
 *
 * Schema 是**唯一事实来源**：渲染器、校验器、导出器、评分器都只读它，
 * 没有「生成代码」这一步，因此不存在生成产物与需求漂移的问题——改需求就是改数据。
 *
 * 本文件只负责：字段类型系统、中文别名归一、Schema 规范化与形状检查。
 */

import { FormgenError } from './errors.js';

/**
 * 规范字段类型。生成器（规则/LLM）产出的任何别名最终都要落到这个集合里。
 * @typedef {'text'|'textarea'|'number'|'integer'|'tel'|'email'|'url'|'idcard'|'date'|'datetime'|'time'
 *   |'select'|'radio'|'checkbox'|'switch'|'rating'|'slider'|'file'|'section'|'statement'|'matrix'|'question'} FieldType
 */

/** @type {readonly FieldType[]} */
export const FIELD_TYPES = Object.freeze([
  'text', 'textarea', 'number', 'integer', 'tel', 'email', 'url', 'idcard',
  'date', 'datetime', 'time',
  'select', 'radio', 'checkbox', 'switch', 'rating', 'slider', 'file',
  'section', 'statement', 'matrix', 'question',
]);

const FIELD_TYPE_SET = new Set(FIELD_TYPES);

/** 只用于展示、不产生提交值的字段类型。 */
export const DISPLAY_ONLY_TYPES = Object.freeze(new Set(['section', 'statement']));

/** 值形态为数组的字段类型。 */
export const MULTI_VALUE_TYPES = Object.freeze(new Set(['checkbox', 'matrix']));

/**
 * 中文/自然语言别名 → 规范类型。
 *
 * 这张表是规则生成器的第一道地基：中文表单需求里，「下拉框」和「select」是同一件事。
 * 关键词按长度倒序匹配，避免「多行文本」被「文本」抢先命中。
 */
const TYPE_ALIASES = new Map(Object.entries({
  // 文本族
  '多行文本': 'textarea', '长文本': 'textarea', '多行输入': 'textarea', '文本域': 'textarea',
  '大段文本': 'textarea', '富文本': 'textarea', '备注': 'textarea', '意见': 'textarea',
  '建议': 'textarea', '描述': 'textarea', '详情': 'textarea', '说明文字': 'textarea',
  '文本': 'text', '单行文本': 'text', '输入框': 'text', '文本框': 'text', '字符串': 'text',
  // 数值族
  '整数': 'integer', '数量': 'integer', '个数': 'integer',
  '数字': 'number', '数值': 'number', '金额': 'number', '价格': 'number', '小数': 'number',
  // 联系族
  '手机号码': 'tel', '手机号': 'tel', '手机': 'tel', '联系电话': 'tel', '电话': 'tel',
  '联系方式': 'tel', '座机': 'tel',
  '电子邮箱': 'email', '邮箱': 'email', '电子邮件': 'email', '邮件': 'email', 'email': 'email',
  '网址': 'url', '链接': 'url', '主页': 'url', 'url': 'url',
  '身份证号码': 'idcard', '身份证号': 'idcard', '身份证': 'idcard',
  // 时间族
  '日期时间': 'datetime', '时间戳': 'datetime', 'datetime': 'datetime',
  '日期': 'date', 'date': 'date', '时间': 'time', '时刻': 'time',
  // 选择族
  '下拉选择': 'select', '下拉框': 'select', '下拉菜单': 'select', '下拉': 'select',
  '单选框': 'radio', '单项选择': 'radio', '单选': 'radio', 'radio': 'radio',
  '复选框': 'checkbox', '多项选择': 'checkbox', '多选': 'checkbox', 'checkbox': 'checkbox',
  '开关': 'switch', '是否': 'switch', '布尔': 'switch',
  // 度量族
  '星级评分': 'rating', '评分': 'rating', '打分': 'rating', '星级': 'rating', 'rate': 'rating',
  '滑块': 'slider', '滑动条': 'slider', '进度条': 'slider',
  // 附件
  '文件上传': 'file', '上传附件': 'file', '上传文件': 'file', '附件': 'file', '上传': 'file',
  '照片': 'file', '图片': 'file', '文件': 'file', 'file': 'file',
  // 结构 / 展示
  '分组': 'section', '分组标题': 'section', '小节': 'section', '标题': 'section',
  '提示': 'statement', '说明': 'statement', '公告': 'statement', '题干': 'statement',
  '矩阵': 'matrix', '量表': 'matrix', '矩阵题': 'matrix', '表格题': 'matrix',
  '题目': 'question', '试题': 'question', '考题': 'question',
}));

/** 别名匹配顺序：长的优先，短的不许截胡。 */
const TYPE_ALIAS_KEYS = [...TYPE_ALIASES.keys()].sort((a, b) => b.length - a.length);

/**
 * 把任意类型写法归一成规范类型。
 * @param {unknown} input
 * @returns {FieldType|null} 无法识别时返回 null（由调用方决定报错还是回退）
 */
export function normalizeFieldType(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (FIELD_TYPE_SET.has(raw)) return /** @type {FieldType} */ (raw);
  for (const alias of TYPE_ALIAS_KEYS) {
    if (raw === alias || raw.includes(alias)) return TYPE_ALIASES.get(alias) ?? null;
  }
  return null;
}

/**
 * 严格版类型归一：只认完整匹配，不做子串包含。
 *
 * 用于判断「这个短语本身就是一个类型词」（如「多行文本」）。
 * 不能用宽松版——「具体说明」包含别名「说明」，会被判成展示型 statement，
 * 于是一个本该让用户填写的字段变成了只读文字。
 */
export function normalizeFieldTypeExact(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (FIELD_TYPE_SET.has(raw)) return /** @type {FieldType} */ (raw);
  return TYPE_ALIASES.get(raw) ?? null;
}

/**
 * 常用中文字段名 → 英文 key。命中则产出可直接做 CSV 列名/表单 name 的稳定标识。
 * 未命中时回退到标签里的 ASCII 片段，再回退到中文标签本身，最后才是 `f{n}`。
 */
const KEY_DICTIONARY = new Map(Object.entries({
  姓名: 'name', 名字: 'name', 称呼: 'name', 联系人: 'contactName',
  手机号: 'phone', 手机: 'phone', 电话: 'phone', 联系电话: 'phone', 联系方式: 'phone',
  邮箱: 'email', 电子邮箱: 'email', 邮件: 'email',
  身份证号: 'idNumber', 身份证: 'idNumber',
  性别: 'gender', 年龄: 'age', 出生日期: 'birthday', 出生年月: 'birthday',
  地址: 'address', 家庭住址: 'address', 收货地址: 'shippingAddress', 所在城市: 'city',
  省份: 'province', 城市: 'city', 邮编: 'zipCode', 邮政编码: 'zipCode',
  学历: 'education', 专业: 'major', 毕业院校: 'graduateSchool', 学校: 'school',
  部门: 'department', 职位: 'position', 岗位: 'position', 职务: 'position',
  公司: 'company', 单位: 'company', 公司名称: 'companyName',
  班级: 'className', 学号: 'studentId', 工号: 'employeeId', 入职日期: 'hireDate',
  紧急联系人: 'emergencyContact', 紧急联系电话: 'emergencyPhone',
  备注: 'remark', 意见: 'opinion', 建议: 'suggestion', 满意度: 'satisfaction',
  评分: 'rating', 打分: 'rating', 分数: 'score', 金额: 'amount', 数量: 'quantity',
  标题: 'title', 内容: 'content', 描述: 'description', 附件: 'attachment', 照片: 'photo',
  科目: 'subject', 成绩: 'score', 答案: 'answer', 解析: 'analysis',
  是否同意: 'agreement', 同意条款: 'agreement', 反馈类型: 'feedbackType',
}));

const KEY_DICTIONARY_KEYS = [...KEY_DICTIONARY.keys()].sort((a, b) => b.length - a.length);

/**
 * 合法字段 key。
 *
 * 允许中文：`参会日期` 这样的 key 比 `f6` 有意义得多——表达式引擎本来就把 CJK 识别为标识符，
 * 于是 `visibleWhen: "饮食禁忌 == '素食'"` 可以直接写，中文用户不必在脑内做中英映射。
 */
export const KEY_PATTERN = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/;

/**
 * 由标签推导一个稳定、唯一、ASCII 的字段 key。
 * @param {string} label
 * @param {number} index 用于去重与兜底
 * @param {Set<string>} used 已占用的 key 集合（会被就地更新）
 */
export function deriveKey(label, index, used) {
  const text = String(label ?? '').trim();
  let base = '';

  for (const word of KEY_DICTIONARY_KEYS) {
    if (text.includes(word)) { base = KEY_DICTIONARY.get(word); break; }
  }
  if (!base) {
    // 退一步：标签里若含 ASCII（如 "Email"、"Q1"），直接拿来用。
    const ascii = text.replace(/[^A-Za-z0-9]+/g, ' ').trim();
    if (ascii) {
      const parts = ascii.split(/\s+/);
      base = parts[0].toLowerCase() + parts.slice(1).map(p => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
    }
  }
  if (!base) {
    // 再退一步：中文标签本身做 key（去掉标点与空白）。
    const cjk = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9_]/g, '');
    if (cjk && /[\u4e00-\u9fa5]/.test(cjk)) base = cjk.slice(0, 24);
  }
  if (!base) base = `f${index + 1}`;

  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}${n++}`;
  used.add(key);
  return key;
}

/** 归一化选项：支持 `['A','B']`、`[{value,label}]`、`{A:'甲'}`、字符串 `甲/乙/丙`。 */
function normalizeOptions(raw) {
  if (raw == null) return undefined;
  const list = [];
  const push = (value, label) => {
    const v = String(value ?? '').trim();
    const l = String(label ?? value ?? '').trim();
    if (!v && !l) return;
    list.push({ value: v || l, label: l || v });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item != null && typeof item === 'object') {
        push(item.value ?? item.label ?? item.name, item.label ?? item.name ?? item.value);
      } else push(item, item);
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) push(k, v);
  } else if (typeof raw === 'string') {
    for (const part of raw.split(/[\/、,，|;；]+/)) push(part.trim(), part.trim());
  }
  return list.length ? list : undefined;
}

/** 从文本里抽取以「形如 0-100 / 1~5 / 0至10」表达的数值范围。 */
function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function normalizeBoolean(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '是', '必填', 'required'].includes(text)) return true;
  if (['false', '0', 'no', 'n', '否', '选填', 'optional'].includes(text)) return false;
  return fallback;
}

/** 各类型允许出现在字段上的属性白名单——用于把 LLM 幻觉出来的垃圾属性剔掉。 */
const COMMON_KEYS = [
  'key', 'label', 'type', 'required', 'placeholder', 'help', 'defaultValue', 'default',
  'visibleWhen', 'compute', 'rules', 'columns', 'group', 'order', 'width', 'prefix', 'suffix',
];

const TYPE_SPECIFIC_KEYS = {
  text: ['minLength', 'maxLength', 'pattern', 'patternMessage', 'normalize'],
  textarea: ['minLength', 'maxLength', 'rows', 'maxWords'],
  number: ['min', 'max', 'step', 'unit', 'precision'],
  integer: ['min', 'max', 'step', 'unit'],
  tel: ['pattern'],
  email: [],
  url: [],
  idcard: [],
  date: ['min', 'max', 'minDate', 'maxDate'],
  datetime: ['minDate', 'maxDate'],
  time: ['min', 'max'],
  select: ['options', 'multiple', 'searchable'],
  radio: ['options', 'inline'],
  checkbox: ['options', 'min', 'max', 'inline'],
  switch: ['onLabel', 'offLabel'],
  rating: ['min', 'max', 'icon', 'allowHalf'],
  slider: ['min', 'max', 'step', 'unit'],
  file: ['accept', 'multiple', 'maxSizeMB', 'maxFiles'],
  section: ['collapsible'],
  statement: ['content', 'rich', 'variant'],
  matrix: ['rows', 'scale', 'options', 'min', 'max'],
  question: ['question', 'answer', 'score', 'knowledge', 'difficulty'],
};

/**
 * 规范化单个字段。未知属性被丢弃（并记录 issue），保证 Schema 是封闭的、可审计的。
 * @returns {{field: object, issues: string[]}}
 */
export function normalizeField(raw, index, usedKeys, path) {
  const issues = [];
  if (raw == null || typeof raw !== 'object') {
    throw new FormgenError('SCHEMA_FIELD_INVALID', `${path}[${index}] 不是对象，无法作为字段`);
  }

  const label = String(raw.label ?? raw.title ?? raw.name ?? raw.key ?? `字段${index + 1}`).trim();
  const type = normalizeFieldType(raw.type ?? raw.fieldType ?? raw.kind);
  if (!type) {
    throw new FormgenError('SCHEMA_FIELD_TYPE_UNKNOWN', `${path}[${index}] 字段「${label}」的类型无法识别：${JSON.stringify(raw.type ?? null)}`, { detail: { label, rawType: raw.type ?? null } });
  }

  const key = typeof raw.key === 'string' && KEY_PATTERN.test(raw.key)
    ? (usedKeys.has(raw.key) ? deriveKey(raw.key, index, usedKeys) : (usedKeys.add(raw.key), raw.key))
    : deriveKey(label, index, usedKeys);

  /** @type {Record<string, unknown>} */
  const field = { key, label, type };
  const allowed = new Set([...COMMON_KEYS, ...(TYPE_SPECIFIC_KEYS[type] ?? [])]);

  for (const [k, v] of Object.entries(raw)) {
    // `type` 必须跳过：它在上面已经被归一成规范类型，
    // 若让原始值（可能是「多选」「手机号」这类中文别名）覆盖回来，整个类型系统就失效了。
    if (k === 'type') continue;
    if (!allowed.has(k) || v === undefined) {
      if (!['title', 'name', 'fieldType', 'kind'].includes(k) && v !== undefined) {
        issues.push(`字段「${label}」的属性 ${k} 不属于 ${type} 类型，已忽略`);
      }
      continue;
    }
    field[k] = v;
  }

  // ---- 逐类型归一 ----
  if (field.options !== undefined || ['select', 'radio', 'checkbox'].includes(type)) {
    const options = normalizeOptions(field.options);
    if (options) field.options = options;
    else if (type !== 'select') delete field.options;
  }
  if (type === 'select' && !field.options) field.options = [];
  if (type === 'checkbox' && !field.options) {
    // 无选项的 checkbox 语义是「单个勾选同意」，归一成 switch 更诚实。
    issues.push(`字段「${label}」为多选但未给出选项，已改为开关类型`);
    field.type = 'switch';
  }
  for (const k of ['min', 'max', 'step', 'minLength', 'maxLength', 'rows', 'maxFiles', 'maxSizeMB', 'precision', 'maxWords']) {
    if (field[k] !== undefined) {
      const n = normalizeNumber(field[k]);
      if (n === undefined) delete field[k];
      else field[k] = n;
    }
  }
  if (field.defaultValue === undefined && field.default !== undefined) field.defaultValue = field.default;
  delete field.default;

  const required = normalizeBoolean(field.required, false);
  field.required = required;

  if (field.placeholder !== undefined) field.placeholder = String(field.placeholder);
  if (field.help !== undefined) field.help = String(field.help);
  if (field.pattern !== undefined) {
    field.pattern = String(field.pattern);
    try { new RegExp(field.pattern); }
    catch {
      issues.push(`字段「${label}」的正则 ${field.pattern} 非法，已移除`);
      delete field.pattern;
    }
  }
  if (field.visibleWhen !== undefined) field.visibleWhen = String(field.visibleWhen).trim() || undefined;
  if (field.compute !== undefined) field.compute = String(field.compute).trim() || undefined;
  if (field.rules !== undefined) {
    field.rules = (Array.isArray(field.rules) ? field.rules : [])
      .filter(r => r && typeof r === 'object' && typeof r.expr === 'string')
      .map(r => ({ expr: String(r.expr), message: String(r.message ?? '不满足校验条件') }));
    if (!field.rules.length) delete field.rules;
  }
  if (field.columns !== undefined) {
    const c = normalizeNumber(field.columns);
    field.columns = c === 2 ? 2 : 1;
  }
  if (field.type === 'matrix') {
    field.rows = Array.isArray(field.rows)
      ? field.rows.map(r => (typeof r === 'string' ? { value: r, label: r } : { value: String(r?.value ?? r?.label ?? ''), label: String(r?.label ?? r?.value ?? '') })).filter(r => r.value)
      : [];
    field.options = field.options ?? [];
    if (!field.rows.length) issues.push(`矩阵题「${label}」缺少行定义`);
  }
  if (field.type === 'question') {
    const q = raw.question;
    if (!q || typeof q !== 'object') {
      throw new FormgenError('SCHEMA_QUESTION_MISSING', `题目字段「${label}」缺少 question 定义`);
    }
    field.question = {
      id: String(q.id ?? key),
      type: String(q.type ?? 'solve'),
      stem: String(q.stem ?? ''),
      options: normalizeOptions(q.options) ?? undefined,
      answer: q.answer,
      analysis: q.analysis === undefined ? undefined : String(q.analysis),
      score: normalizeNumber(q.score ?? raw.score) ?? 0,
      difficulty: normalizeNumber(q.difficulty),
      knowledge: Array.isArray(q.knowledge) ? q.knowledge.map(String) : (q.knowledge ? [String(q.knowledge)] : []),
      source: q.source === undefined ? undefined : String(q.source),
      blanks: normalizeNumber(q.blanks),
    };
  }
  if (field.type === 'statement') {
    field.content = String(field.content ?? raw.content ?? field.label ?? '');
  }

  return { field, issues };
}

/** 遍历 Schema 中所有字段（含分组级）。 */
export function* walkFields(schema) {
  for (const group of schema.groups ?? []) {
    for (const field of group.fields ?? []) yield { group, field };
  }
}

/** 取出所有字段，返回 key → field 的映射。 */
export function fieldIndex(schema) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const { field } of walkFields(schema)) map.set(field.key, field);
  return map;
}

/**
 * 按 key 或中文标签查找字段。
 * 让 CLI、导出器、测试都能用「姓名」这样的自然指代定位字段，而不必记住推导出的英文 key。
 */
export function findField(schema, keyOrLabel) {
  for (const { field } of walkFields(schema)) {
    if (field.key === keyOrLabel || field.label === keyOrLabel) return field;
  }
  return undefined;
}

/**
 * 把「宽松输入」规范化成规范 FormSchema。
 *
 * @param {unknown} raw 生成器（规则/LLM/模板）产出的任意形状
 * @param {{source?: string, issues?: string[]}} [options]
 * @returns {{schema: object, issues: string[]}}
 */
export function normalizeSchema(raw, options = {}) {
  const issues = [...(options.issues ?? [])];
  if (raw == null || typeof raw !== 'object') {
    throw new FormgenError('SCHEMA_INVALID', 'Schema 必须是对象');
  }
  const input = /** @type {Record<string, any>} */ (raw);

  const title = String(input.title ?? input.name ?? '未命名表单').trim() || '未命名表单';
  const kindRaw = String(input.kind ?? input.formType ?? 'form').toLowerCase();
  const kind = ['form', 'survey', 'exam', 'registration', 'feedback'].includes(kindRaw) ? kindRaw : 'form';

  // 分组：允许 groups / sections / fields 三种写法
  const rawGroups = Array.isArray(input.groups) && input.groups.length
    ? input.groups
    : (Array.isArray(input.fields) && input.fields.length
      ? [{ key: 'main', title: input.groupTitle ?? '', fields: input.fields }]
      : (Array.isArray(input.sections) ? input.sections.map(s => ({ ...s, fields: s.fields ?? s.items ?? [] })) : []));

  if (!rawGroups.length) {
    throw new FormgenError('SCHEMA_EMPTY', `表单「${title}」没有解析出任何字段`);
  }

  const usedKeys = new Set();
  const usedGroupKeys = new Set();
  /** @type {object[]} */
  const groups = [];
  let fieldIndexCounter = 0;

  rawGroups.forEach((rawGroup, gi) => {
    if (rawGroup == null || typeof rawGroup !== 'object') return;
    const gTitle = String(rawGroup.title ?? rawGroup.label ?? rawGroup.name ?? '').trim();
    const rawFields = Array.isArray(rawGroup.fields) ? rawGroup.fields
      : (Array.isArray(rawGroup.items) ? rawGroup.items : []);
    /** @type {object[]} */
    const fields = [];
    for (const rf of rawFields) {
      const { field, issues: fieldIssues } = normalizeField(rf, fieldIndexCounter, usedKeys, `groups[${gi}]`);
      fieldIndexCounter += 1;
      issues.push(...fieldIssues);
      fields.push(field);
    }
    if (!fields.length) return;

    let gKey = typeof rawGroup.key === 'string' && KEY_PATTERN.test(rawGroup.key)
      ? rawGroup.key
      : deriveKey(gTitle || `group${gi + 1}`, gi, usedGroupKeys);
    // 同名分组在真实需求里很常见（"基本信息"出现两次），加序号消歧而不是丢弃。
    let suffix = 2;
    const baseKey = gKey;
    while (groups.some(g => g.key === gKey)) gKey = `${baseKey}_${suffix++}`;
    usedGroupKeys.add(gKey);

    groups.push({
      key: gKey,
      title: gTitle || (groups.length === 0 ? '' : `第${groups.length + 1}部分`),
      ...(rawGroup.description ? { description: String(rawGroup.description) } : {}),
      ...(rawGroup.visibleWhen ? { visibleWhen: String(rawGroup.visibleWhen) } : {}),
      fields,
    });
  });

  if (!groups.length) throw new FormgenError('SCHEMA_EMPTY', `表单「${title}」没有解析出任何字段`);

  const rawSettings = (input.settings && typeof input.settings === 'object') ? input.settings : {};
  const settings = {
    submitText: String(rawSettings.submitText ?? (kind === 'exam' ? '交卷' : '提交')),
    successMessage: String(rawSettings.successMessage ?? (kind === 'exam' ? '已交卷，感谢作答。' : '提交成功，感谢你的填写！')),
    allowMultipleSubmissions: normalizeBoolean(rawSettings.allowMultipleSubmissions, true),
    showProgress: normalizeBoolean(rawSettings.showProgress, true),
    collectMeta: normalizeBoolean(rawSettings.collectMeta, false),
    theme: ['default', 'exam', 'compact'].includes(String(rawSettings.theme)) ? String(rawSettings.theme) : 'default',
    ...(rawSettings.closeAt ? { closeAt: String(rawSettings.closeAt) } : {}),
    ...(rawSettings.maxSubmissions !== undefined ? { maxSubmissions: normalizeNumber(rawSettings.maxSubmissions) } : {}),
    ...(rawSettings.notice ? { notice: String(rawSettings.notice) } : {}),
  };

  const grading = input.grading && typeof input.grading === 'object'
    ? {
      autoGrade: normalizeBoolean(input.grading.autoGrade, kind === 'exam'),
      totalScore: normalizeNumber(input.grading.totalScore),
      duration: normalizeNumber(input.grading.duration),
      sections: Array.isArray(input.grading.sections) ? input.grading.sections : undefined,
      blueprint: input.grading.blueprint && typeof input.grading.blueprint === 'object' ? input.grading.blueprint : undefined,
    }
    : (kind === 'exam' ? { autoGrade: true } : undefined);

  const schema = {
    id: String(input.id ?? '').trim() || undefined,
    version: 1,
    kind,
    title,
    description: String(input.description ?? input.desc ?? '').trim(),
    locale: String(input.locale ?? 'zh-CN'),
    groups,
    settings,
    ...(grading ? { grading } : {}),
    meta: {
      createdAt: new Date().toISOString(),
      source: String(input.meta?.source ?? options.source ?? 'manual'),
      ...(input.meta?.sourceText ? { sourceText: String(input.meta.sourceText) } : {}),
      ...(input.meta?.model ? { model: String(input.meta.model) } : {}),
      ...(input.meta?.generator ? { generator: String(input.meta.generator) } : {}),
      ...(input.meta?.notes?.length ? { notes: input.meta.notes.map(String) } : {}),
    },
  };

  return { schema, issues };
}

/** Schema 自检：返回人类可读的问题列表（空数组 = 健康）。 */
export function validateSchemaShape(schema) {
  const issues = [];
  if (!schema || typeof schema !== 'object') return ['Schema 不是对象'];
  if (!schema.title) issues.push('缺少 title');
  if (!Array.isArray(schema.groups) || !schema.groups.length) issues.push('缺少 groups');

  const seen = new Set();
  for (const { group, field } of walkFields(schema)) {
    if (seen.has(field.key)) issues.push(`字段 key 重复：${field.key}`);
    seen.add(field.key);
    if (!FIELD_TYPE_SET.has(field.type)) issues.push(`字段 ${field.key} 类型非法：${field.type}`);
    if (['select', 'radio', 'checkbox'].includes(field.type) && !(field.options ?? []).length) {
      issues.push(`字段「${field.label}」是 ${field.type} 但没有选项`);
    }
    if (field.type === 'question' && !field.question?.stem) issues.push(`题目「${field.label}」没有题干`);
    if (field.visibleWhen && String(field.visibleWhen).trim() === '') issues.push(`字段 ${field.key} 的 visibleWhen 为空`);
    void group;
  }
  return issues;
}

/** Schema 概览统计，用于 CLI / Studio 展示。 */
export function schemaStats(schema) {
  const types = {};
  let required = 0;
  let fields = 0;
  const questions = [];
  for (const { field } of walkFields(schema)) {
    fields += 1;
    types[field.type] = (types[field.type] ?? 0) + 1;
    if (field.required) required += 1;
    if (field.type === 'question') questions.push(field);
  }
  return {
    groups: schema.groups.length,
    fields,
    required,
    types,
    questions: questions.length,
    totalScore: questions.reduce((sum, f) => sum + (Number(f.question?.score) || 0), 0),
    kind: schema.kind,
    title: schema.title,
  };
}
