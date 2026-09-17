/**
 * 校验器：提交数据在与渲染**同一份** FormSchema 上校验。
 *
 * 这是「生成即校验」闭环的另一半——LLM/规则生成的约束（必填、正则、范围、条件可见性）
 * 不需要被翻译成后端代码，因此不存在「前端校验通过、后端拒绝」的经典错位。
 */

import { evaluateCondition, evaluateExpr, isTruthy, exprIdentifiers } from './expr.js';
import { DISPLAY_ONLY_TYPES, walkFields } from './schema.js';

// ---------------------------------------------------------------------------
// 归一化小工具
// ---------------------------------------------------------------------------

/** 去掉首尾空白、把全角空格换成半角。**不改动正文标点**——中文答案里的「，？：」必须原样保留。 */
export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/\u3000/g, ' ').trim();
}

/**
 * 全角 ASCII → 半角。只用于手机号/邮箱/身份证/数字/日期这类**结构化**字段，
 * 因为中文输入法下用户很容易打出全角数字和全角冒号。
 */
export function toHalfWidth(input) {
  return String(input ?? '').replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

const PATTERNS = {
  email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  telCN: /^1[3-9]\d{9}$/,
  telGeneric: /^\+?\d{6,15}$/,
  url: /^https?:\/\/[^\s]+$/i,
};

/** 中国大陆二代身份证校验：长度、出生日期、ISO 7064:1983 MOD 11-2 校验码。 */
export function validateChineseIdCard(raw) {
  const text = toHalfWidth(normalizeText(raw)).toUpperCase();
  if (!/^\d{17}[\dX]$/.test(text)) return { ok: false, reason: '身份证号应为 18 位（末位可为 X）' };

  const year = Number(text.slice(6, 10));
  const month = Number(text.slice(10, 12));
  const day = Number(text.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, reason: '身份证号中的出生日期不存在' };
  }

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(text[i]) * weights[i];
  if (checks[sum % 11] !== text[17]) return { ok: false, reason: '身份证号校验位不正确，请检查是否输错' };

  return { ok: true, value: text, birthDate: `${text.slice(6, 10)}-${text.slice(10, 12)}-${text.slice(12, 14)}`, gender: Number(text[16]) % 2 === 1 ? '男' : '女' };
}

function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0 || value.every(isEmptyValue);
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** 字段的空初始值——渲染器与导出器都依赖它保持列对齐。 */
export function emptyValueFor(field) {
  switch (field.type) {
    case 'checkbox': return [];
    case 'matrix': return {};
    case 'file': return field.multiple ? [] : null;
    case 'switch': return false;
    case 'number': case 'integer': case 'slider': case 'rating': return '';
    case 'question': return field.question?.type === 'multi' ? [] : (field.question?.type === 'blank' ? [''] : '');
    case 'section': case 'statement': return undefined;
    default: return '';
  }
}

/** 由 Schema 生成初始值表。 */
export function defaultValues(schema) {
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const { field } of walkFields(schema)) {
    if (DISPLAY_ONLY_TYPES.has(field.type)) continue;
    if (field.defaultValue !== undefined && field.defaultValue !== null) values[field.key] = field.defaultValue;
    else if (field.compute) values[field.key] = '';
    else values[field.key] = emptyValueFor(field);
  }
  return values;
}

// ---------------------------------------------------------------------------
// 可见性 & 计算字段
// ---------------------------------------------------------------------------

/**
 * 计算每个字段是否可见。
 *
 * 依赖顺序：按 visibleWhen 的变量依赖做拓扑松弛（最多 8 轮），
 * 使得「A 控制 B、B 控制 C」的多级联动能一次性收敛。
 */
export function resolveVisibility(schema, values) {
  /** @type {Map<string, {field: object, group: object}>} */
  const all = new Map();
  for (const entry of walkFields(schema)) all.set(entry.field.key, entry);

  /** @type {Map<string, boolean>} */
  const visible = new Map();
  for (const [key, { field }] of all) visible.set(key, !field.visibleWhen);

  // 分组级条件：任一字段所属分组被隐藏，字段即隐藏。
  const groupVisible = new Map();
  for (const group of schema.groups) {
    groupVisible.set(group.key, group.visibleWhen ? evaluateCondition(group.visibleWhen, values, { fallback: true }) : true);
  }

  let rounds = 0;
  let changed = true;
  while (changed && rounds < 8) {
    changed = false;
    rounds += 1;
    for (const [key, { field, group }] of all) {
      if (!groupVisible.get(group.key)) { visible.set(key, false); continue; }
      if (!field.visibleWhen) { visible.set(key, true); continue; }
      const next = evaluateCondition(field.visibleWhen, values, { fallback: false });
      if (visible.get(key) !== next) { visible.set(key, next); changed = true; }
    }
  }
  return visible;
}

/**
 * 依据 `compute` 表达式生成计算字段的值。
 * 依赖关系用 exprIdentifiers 推导，按拓扑层级推进，最多 4 轮（够覆盖链式计算）。
 */
export function applyComputations(schema, values) {
  const computed = [];
  for (const { field } of walkFields(schema)) {
    if (field.compute) computed.push(field);
  }
  if (!computed.length) return { ...values };

  const result = { ...values };
  const done = new Set();
  for (let round = 0; round < 4 && done.size < computed.length; round += 1) {
    let progressed = false;
    for (const field of computed) {
      if (done.has(field.key)) continue;
      const deps = exprIdentifiers(field.compute);
      if (deps.some(dep => computed.some(other => other.key === dep && !done.has(other.key)))) continue;
      const value = evaluateExpr(field.compute, result, { fallback: undefined });
      result[field.key] = value === undefined ? (result[field.key] ?? '') : value;
      done.add(field.key);
      progressed = true;
    }
    if (!progressed) break;
  }
  // 存在循环依赖时，用当前值兜底，避免留下未定义。
  for (const field of computed) if (!done.has(field.key)) result[field.key] = result[field.key] ?? '';
  return result;
}

// ---------------------------------------------------------------------------
// 单字段强制转换
// ---------------------------------------------------------------------------

/**
 * 把一个原始输入转成规范值。
 * @returns {{ok: boolean, value?: unknown, message?: string, code?: string}}
 */
export function coerceValue(field, raw, values) {
  const label = field.label;

  if (isEmptyValue(raw)) return { ok: true, value: emptyValueFor(field) };

  switch (field.type) {
    case 'text': case 'textarea': {
      const text = normalizeText(raw);
      if (field.minLength !== undefined && text.length < field.minLength) {
        return { ok: false, code: 'TOO_SHORT', message: `${label}至少需要 ${field.minLength} 个字` };
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return { ok: false, code: 'TOO_LONG', message: `${label}不能超过 ${field.maxLength} 个字` };
      }
      if (field.pattern && !new RegExp(field.pattern).test(text)) {
        return { ok: false, code: 'PATTERN_MISMATCH', message: field.patternMessage ?? `${label}格式不正确` };
      }
      return { ok: true, value: text };
    }

    case 'number': case 'integer': {
      const cleaned = toHalfWidth(normalizeText(raw)).replace(/[,\s]/g, '');
      const num = Number(cleaned);
      if (!Number.isFinite(num)) return { ok: false, code: 'NOT_A_NUMBER', message: `${label}必须是数字` };
      if (field.type === 'integer' && !Number.isInteger(num)) return { ok: false, code: 'NOT_AN_INTEGER', message: `${label}必须是整数` };
      if (field.min !== undefined && num < field.min) return { ok: false, code: 'BELOW_MIN', message: `${label}不能小于 ${field.min}` };
      if (field.max !== undefined && num > field.max) return { ok: false, code: 'ABOVE_MAX', message: `${label}不能大于 ${field.max}` };
      if (field.step !== undefined && field.step > 0) {
        const base = field.min ?? 0;
        const remainder = Math.abs((num - base) % field.step);
        if (remainder > 1e-9 && Math.abs(remainder - field.step) > 1e-9) {
          return { ok: false, code: 'STEP_MISMATCH', message: `${label}必须是 ${field.step} 的整数倍` };
        }
      }
      const precision = field.precision;
      return { ok: true, value: precision !== undefined ? Number(num.toFixed(precision)) : num };
    }

    case 'tel': {
      let text = toHalfWidth(normalizeText(raw)).replace(/[\s\-()]/g, '');
      if (text.startsWith('+86')) text = text.slice(3);
      if (text.startsWith('86') && text.length === 13) text = text.slice(2);
      if (field.pattern) {
        if (!new RegExp(field.pattern).test(text)) return { ok: false, code: 'PATTERN_MISMATCH', message: field.patternMessage ?? `${label}格式不正确` };
      } else if (!PATTERNS.telCN.test(text) && !PATTERNS.telGeneric.test(text)) {
        return { ok: false, code: 'INVALID_PHONE', message: `${label}应为有效的手机号或电话号码` };
      }
      return { ok: true, value: text };
    }

    case 'email': {
      const text = toHalfWidth(normalizeText(raw)).toLowerCase();
      if (!PATTERNS.email.test(text)) return { ok: false, code: 'INVALID_EMAIL', message: `${label}不是有效的邮箱地址` };
      return { ok: true, value: text };
    }

    case 'url': {
      const text = toHalfWidth(normalizeText(raw));
      if (!PATTERNS.url.test(text)) return { ok: false, code: 'INVALID_URL', message: `${label}应以 http:// 或 https:// 开头` };
      return { ok: true, value: text };
    }

    case 'idcard': {
      const result = validateChineseIdCard(raw);
      if (!result.ok) return { ok: false, code: 'INVALID_ID_CARD', message: `${label}：${result.reason}` };
      return { ok: true, value: result.value, extra: { birthDate: result.birthDate, gender: result.gender } };
    }

    case 'date': case 'datetime': case 'time': {
      const text = toHalfWidth(normalizeText(raw));
      const okDate = field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text);
      const okDateTime = field.type === 'datetime' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(text);
      const okTime = field.type === 'time' && /^\d{2}:\d{2}(:\d{2})?$/.test(text);
      if (!okDate && !okDateTime && !okTime) {
        return { ok: false, code: 'INVALID_DATE', message: `${label}格式应为 ${field.type === 'time' ? 'HH:MM' : 'YYYY-MM-DD'}` };
      }
      if (field.minDate && text < String(field.minDate)) return { ok: false, code: 'BEFORE_MIN_DATE', message: `${label}不能早于 ${field.minDate}` };
      if (field.maxDate && text > String(field.maxDate)) return { ok: false, code: 'AFTER_MAX_DATE', message: `${label}不能晚于 ${field.maxDate}` };
      return { ok: true, value: field.type === 'time' ? text : text.replace(' ', 'T') };
    }

    case 'select': {
      const options = field.options ?? [];
      if (field.multiple) {
        const list = (Array.isArray(raw) ? raw : [raw]).map(v => toHalfWidth(normalizeText(v))).filter(Boolean);
        const invalid = list.find(v => !options.some(o => o.value === v));
        if (invalid) return { ok: false, code: 'OPTION_UNKNOWN', message: `${label}包含无效选项：${invalid}` };
        if (field.min !== undefined && list.length < field.min) return { ok: false, code: 'TOO_FEW', message: `${label}至少选择 ${field.min} 项` };
        if (field.max !== undefined && list.length > field.max) return { ok: false, code: 'TOO_MANY', message: `${label}最多选择 ${field.max} 项` };
        return { ok: true, value: list };
      }
      const text = toHalfWidth(normalizeText(raw));
      if (options.length && !options.some(o => o.value === text)) {
        return { ok: false, code: 'OPTION_UNKNOWN', message: `${label}的取值不在可选范围内` };
      }
      return { ok: true, value: text };
    }

    case 'radio': {
      const text = toHalfWidth(normalizeText(raw));
      const options = field.options ?? [];
      if (options.length && !options.some(o => o.value === text)) {
        return { ok: false, code: 'OPTION_UNKNOWN', message: `${label}的取值不在可选范围内` };
      }
      return { ok: true, value: text };
    }

    case 'checkbox': {
      const list = (Array.isArray(raw) ? raw : [raw]).map(normalizeText).filter(Boolean);
      const options = field.options ?? [];
      const invalid = list.find(v => !options.some(o => o.value === v));
      if (invalid) return { ok: false, code: 'OPTION_UNKNOWN', message: `${label}包含无效选项：${invalid}` };
      if (field.min !== undefined && list.length < field.min) return { ok: false, code: 'TOO_FEW', message: `${label}至少选择 ${field.min} 项` };
      if (field.max !== undefined && list.length > field.max) return { ok: false, code: 'TOO_MANY', message: `${label}最多选择 ${field.max} 项` };
      return { ok: true, value: list };
    }

    case 'switch': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const text = toHalfWidth(normalizeText(raw)).toLowerCase();
      if (['true', '1', 'on', 'yes', '是', '同意'].includes(text)) return { ok: true, value: true };
      if (['false', '0', 'off', 'no', '否'].includes(text)) return { ok: true, value: false };
      return { ok: false, code: 'NOT_A_BOOLEAN', message: `${label}应为是/否` };
    }

    case 'rating': {
      const num = Number(toHalfWidth(normalizeText(raw)));
      const max = field.max ?? 5;
      if (!Number.isFinite(num)) return { ok: false, code: 'NOT_A_NUMBER', message: `${label}必须是数字评分` };
      if (num < 0 || num > max) return { ok: false, code: 'OUT_OF_RANGE', message: `${label}评分应在 0 到 ${max} 之间` };
      return { ok: true, value: num };
    }

    case 'slider': {
      const num = Number(toHalfWidth(normalizeText(raw)));
      const min = field.min ?? 0;
      const max = field.max ?? 100;
      if (!Number.isFinite(num)) return { ok: false, code: 'NOT_A_NUMBER', message: `${label}必须是数字` };
      if (num < min || num > max) return { ok: false, code: 'OUT_OF_RANGE', message: `${label}应在 ${min} 到 ${max} 之间` };
      return { ok: true, value: num };
    }

    case 'file': {
      const list = (Array.isArray(raw) ? raw : [raw]).filter(item => item && typeof item === 'object');
      const maxSizeMB = field.maxSizeMB ?? 5;
      const maxFiles = field.multiple ? (field.maxFiles ?? 5) : 1;
      if (list.length > maxFiles) return { ok: false, code: 'TOO_MANY_FILES', message: `${label}最多上传 ${maxFiles} 个文件` };
      const cleaned = [];
      for (const item of list) {
        const size = Number(item.size);
        if (Number.isFinite(size) && size > maxSizeMB * 1024 * 1024) {
          return { ok: false, code: 'FILE_TOO_LARGE', message: `${item.name ?? '文件'} 超过 ${maxSizeMB}MB 上限` };
        }
        const type = String(item.type ?? '');
        if (field.accept && type) {
          const accepted = field.accept.split(',').map(s => s.trim()).filter(Boolean);
          const hit = accepted.some(rule => (rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : rule === type));
          if (!hit) return { ok: false, code: 'FILE_TYPE_REJECTED', message: `${item.name ?? '文件'} 的类型不在允许范围内（${field.accept}）` };
        }
        cleaned.push({
          name: String(item.name ?? 'unnamed'),
          size: Number.isFinite(size) ? size : 0,
          type,
          ...(item.dataUrl ? { dataUrl: String(item.dataUrl) } : {}),
          uploadedAt: new Date().toISOString(),
        });
      }
      return { ok: true, value: field.multiple ? cleaned : cleaned[0] };
    }

    case 'matrix': {
      const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      /** @type {Record<string, string>} */
      const result = {};
      for (const row of field.rows ?? []) {
        const value = toHalfWidth(normalizeText(source[row.value]));
        if (!value) continue;
        if ((field.options ?? []).length && !field.options.some(o => o.value === value)) {
          return { ok: false, code: 'OPTION_UNKNOWN', message: `${label}「${row.label}」的取值无效` };
        }
        result[row.value] = value;
      }
      return { ok: true, value: result };
    }

    case 'question': {
      const question = field.question ?? {};
      const qType = question.type;
      if (qType === 'choice') {
        const text = toHalfWidth(normalizeText(Array.isArray(raw) ? raw[0] : raw));
        return { ok: true, value: text.toUpperCase() };
      }
      if (qType === 'multi') {
        const list = (Array.isArray(raw) ? raw : [raw]).map(v => toHalfWidth(normalizeText(v)).toUpperCase()).filter(Boolean);
        return { ok: true, value: [...new Set(list)].sort() };
      }
      if (qType === 'judge') {
        if (typeof raw === 'boolean') return { ok: true, value: raw };
        const text = toHalfWidth(normalizeText(raw));
        if (['对', '正确', 'true', 'T', '√', '是'].includes(text)) return { ok: true, value: true };
        if (['错', '错误', 'false', 'F', '×', '否'].includes(text)) return { ok: true, value: false };
        return { ok: false, code: 'NOT_A_BOOLEAN', message: `${label}请选择「对」或「错」` };
      }
      if (qType === 'blank') {
        const expected = Number(question.blanks) || Math.max(1, (String(question.stem ?? '').match(/_{2,}|＿{2,}/g) ?? []).length);
        const list = Array.isArray(raw) ? raw.map(v => normalizeText(v)) : [normalizeText(raw)];
        while (list.length < expected) list.push('');
        return { ok: true, value: list.slice(0, expected) };
      }
      return { ok: true, value: normalizeText(raw) };
    }

    default:
      return { ok: true, value: normalizeText(raw) };
  }
}

// ---------------------------------------------------------------------------
// 整表校验
// ---------------------------------------------------------------------------

/**
 * 校验一次提交。
 *
 * @param {object} schema
 * @param {Record<string, unknown>} input 原始提交数据
 * @param {{partial?: boolean}} [options] partial=true 时跳过必填检查（用于草稿/分步保存）
 * @returns {{ok: boolean, errors: Array<{key:string,label:string,code:string,message:string}>,
 *            values: Record<string, unknown>, warnings: string[], answered: number, total: number}}
 */
export function validateSubmission(schema, input, options = {}) {
  const raw = (input && typeof input === 'object') ? input : {};
  /** @type {Record<string, unknown>} */
  const values = { ...raw };

  // 先算计算字段，再算可见性——条件里可能引用计算值。
  const withComputes = applyComputations(schema, values);
  Object.assign(values, withComputes);
  const visible = resolveVisibility(schema, values);

  /** @type {Array<{key:string,label:string,code:string,message:string}>} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, unknown>} */
  const cleaned = {};
  let answered = 0;
  let total = 0;

  for (const { field } of walkFields(schema)) {
    if (DISPLAY_ONLY_TYPES.has(field.type)) continue;
    if (visible.get(field.key) === false) { cleaned[field.key] = emptyValueFor(field); continue; }

    total += 1;
    const isComputed = Boolean(field.compute);
    const rawValue = values[field.key];

    if (isComputed) {
      cleaned[field.key] = rawValue;
      if (!isEmptyValue(rawValue)) answered += 1;
      continue;
    }

    if (!isEmptyValue(rawValue)) answered += 1;

    if (field.required && !options.partial && isEmptyValue(rawValue)) {
      errors.push({ key: field.key, label: field.label, code: 'REQUIRED', message: `${field.label}为必填项` });
      cleaned[field.key] = emptyValueFor(field);
      continue;
    }
    // switch 的「必填」语义是必须为真（典型场景：同意条款）
    if (field.required && !options.partial && field.type === 'switch' && rawValue !== true) {
      errors.push({ key: field.key, label: field.label, code: 'MUST_ACCEPT', message: `请确认「${field.label}」` });
      cleaned[field.key] = false;
      continue;
    }

    const result = coerceValue(field, rawValue, values);
    if (!result.ok) {
      errors.push({ key: field.key, label: field.label, code: result.code ?? 'INVALID', message: result.message ?? `${field.label}格式不正确` });
      cleaned[field.key] = emptyValueFor(field);
      continue;
    }
    cleaned[field.key] = result.value;

    // 自定义规则：表达式在「已清洗的当前值 + 全表值」作用域里求值。
    if (Array.isArray(field.rules)) {
      const scope = { ...values, ...cleaned, [field.key]: result.value };
      for (const rule of field.rules) {
        if (!evaluateCondition(rule.expr, scope, { fallback: true, defaultWhenEmpty: true })) {
          errors.push({ key: field.key, label: field.label, code: 'RULE_FAILED', message: rule.message });
          break;
        }
      }
    }
  }

  // 交叉字段校验（Schema 级规则），例如「结束日期不得早于开始日期」。
  const crossRules = Array.isArray(schema.rules) ? schema.rules : [];
  for (const rule of crossRules) {
    if (!rule || typeof rule.expr !== 'string') continue;
    if (!evaluateCondition(rule.expr, cleaned, { fallback: true, defaultWhenEmpty: true })) {
      errors.push({ key: rule.key ?? '_form', label: '表单', code: 'CROSS_RULE_FAILED', message: String(rule.message ?? '表单校验未通过') });
    }
  }

  if (options.partial) warnings.push('这是部分保存：必填项未做检查');

  return { ok: errors.length === 0, errors, values: cleaned, warnings, answered, total };
}

/**
 * 计算「答卷完成度」（0..1），用于进度条与未完成提示。
 */
export function completionRatio(schema, values) {
  const visible = resolveVisibility(schema, values);
  let total = 0;
  let filled = 0;
  for (const { field } of walkFields(schema)) {
    if (DISPLAY_ONLY_TYPES.has(field.type) || field.compute) continue;
    if (visible.get(field.key) === false) continue;
    total += 1;
    if (!isEmptyValue(values[field.key])) filled += 1;
  }
  return { filled, total, ratio: total === 0 ? 1 : filled / total };
}

export { isEmptyValue, isTruthy };
