/**
 * 表达式引擎：让「低代码」真的低代码。
 *
 * 表单/考卷里的三类逻辑都用同一种 DSL 表达：
 *   - 条件显示   field.visibleWhen = "department == '技术部' && years >= 3"
 *   - 计算字段   field.compute     = "round(price * quantity * 0.87, 2)"
 *   - 校验规则   field.rules       = [{ expr: "len(phone) == 11", message: "手机号应为 11 位" }]
 *
 * 安全约束（这是本模块存在的全部理由）：
 *   1. 手写词法 + Pratt 语法分析 + AST 求值，**不使用 eval / new Function**；
 *   2. 作用域只能读到显式传入的普通对象，`__proto__` / `constructor` / `prototype` 被拒绝；
 *   3. 任何解析或求值失败都不抛给用户，而是返回 `undefined` 并可由调用方降级
 *      （表单逻辑出错不该让整个页面白屏）。
 */

import { FormgenError } from './errors.js';

export class ExprError extends FormgenError {}

const BLOCKED_PROPS = new Set(['__proto__', 'constructor', 'prototype']);

/** 全角 → 半角：中文输入法下写出的表达式必须可用。 */
const FULLWIDTH_MAP = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '（': '(', '）': ')', '［': '[', '］': ']', '｛': '{', '｝': '}',
  '＝': '=', '＞': '>', '＜': '<', '！': '!', '＋': '+', '－': '-', '＊': '*', '／': '/', '％': '%',
  '，': ',', '．': '.', '：': ':', '？': '?', '＆': '&', '｜': '|', '；': ';',
  '“': '"', '”': '"', '‘': "'", '’': "'", '　': ' ',
};

function normalizeSource(src) {
  let out = '';
  for (const ch of String(src ?? '')) out += FULLWIDTH_MAP[ch] ?? ch;
  // 中文逻辑词 → 符号。英文 and/or/not/in 交给词法分析器处理：
  // `not` 必须与 `in` 组合成 `not in`，在这里文本替换会把它拆坏。
  return out
    .replace(/并且|而且|且/g, '&&')
    .replace(/或者|或/g, '||')
    .replace(/非/g, '!');
}

const TOKEN = {
  NUMBER: 'number', STRING: 'string', IDENT: 'ident', OP: 'op',
  LPAREN: '(', RPAREN: ')', LBRACKET: '[', RBRACKET: ']', COMMA: ',', DOT: '.',
  EOF: 'eof',
};

const KEYWORDS = new Set(['true', 'false', 'null', 'undefined']);

/** 以单词形式出现的中缀/前缀运算符。词法阶段就归成 OP，解析器才看得见它们。 */
const OPERATOR_WORDS = new Set(['and', 'or', 'not', 'in']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const text = normalizeSource(src);

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) { i += 1; continue; }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j += 1;
      if (text[j] === '.') { j += 1; while (j < text.length && /[0-9]/.test(text[j])) j += 1; }
      if (/[eE]/.test(text[j] ?? '')) {
        let k = j + 1;
        if (/[+-]/.test(text[k] ?? '')) k += 1;
        if (/[0-9]/.test(text[k] ?? '')) { while (k < text.length && /[0-9]/.test(text[k])) k += 1; j = k; }
      }
      tokens.push({ type: TOKEN.NUMBER, value: Number(text.slice(i, j)), pos: i });
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') {
          const next = text[j + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
          j += 2;
        } else { value += text[j]; j += 1; }
      }
      if (j >= text.length) throw new ExprError('EXPR_UNTERMINATED_STRING', `字符串缺少结束引号：${src}`);
      tokens.push({ type: TOKEN.STRING, value, pos: i });
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_$\u4e00-\u9fa5]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(text[j])) j += 1;
      const raw = text.slice(i, j);
      const isOperator = KEYWORDS.has(raw) || OPERATOR_WORDS.has(raw);
      tokens.push({ type: isOperator ? TOKEN.OP : TOKEN.IDENT, value: raw, pos: i });
      i = j;
      continue;
    }

    if (ch === '(') { tokens.push({ type: TOKEN.LPAREN, value: ch, pos: i }); i += 1; continue; }
    if (ch === ')') { tokens.push({ type: TOKEN.RPAREN, value: ch, pos: i }); i += 1; continue; }
    if (ch === '[') { tokens.push({ type: TOKEN.LBRACKET, value: ch, pos: i }); i += 1; continue; }
    if (ch === ']') { tokens.push({ type: TOKEN.RBRACKET, value: ch, pos: i }); i += 1; continue; }
    if (ch === ',') { tokens.push({ type: TOKEN.COMMA, value: ch, pos: i }); i += 1; continue; }
    if (ch === '.') { tokens.push({ type: TOKEN.DOT, value: ch, pos: i }); i += 1; continue; }

    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (three === '===' || three === '!==') { tokens.push({ type: TOKEN.OP, value: three, pos: i }); i += 3; continue; }
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { tokens.push({ type: TOKEN.OP, value: two, pos: i }); i += 2; continue; }
    if ('+-*/%<>!'.includes(ch)) { tokens.push({ type: TOKEN.OP, value: ch, pos: i }); i += 1; continue; }

    throw new ExprError('EXPR_UNEXPECTED_CHAR', `表达式中出现无法识别的字符「${ch}」：${src}`, { detail: { pos: i } });
  }

  tokens.push({ type: TOKEN.EOF, value: null, pos: text.length });
  return tokens;
}

const BINARY_PRECEDENCE = new Map([
  ['||', 1],
  ['&&', 2],
  ['==', 3], ['!=', 3], ['===', 3], ['!==', 3],
  ['<', 4], ['<=', 4], ['>', 4], ['>=', 4], ['in', 4], ['not in', 4],
  ['+', 5], ['-', 5],
  ['*', 6], ['/', 6], ['%', 6],
]);

function parse(tokens, src) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parsePrimary() {
    const token = peek();
    switch (token.type) {
      case TOKEN.NUMBER: next(); return { kind: 'literal', value: token.value };
      case TOKEN.STRING: next(); return { kind: 'literal', value: token.value };
      case TOKEN.OP:
        if (token.value === 'true') { next(); return { kind: 'literal', value: true }; }
        if (token.value === 'false') { next(); return { kind: 'literal', value: false }; }
        if (token.value === 'null') { next(); return { kind: 'literal', value: null }; }
        if (token.value === 'undefined') { next(); return { kind: 'literal', value: undefined }; }
        if (token.value === '!' || token.value === '-' || token.value === 'not') {
          next();
          return { kind: 'unary', op: token.value === 'not' ? '!' : token.value, arg: parseUnary() };
        }
        break;
      case TOKEN.LPAREN: {
        next();
        const expr = parseExpression(0);
        if (peek().type !== TOKEN.RPAREN) throw new ExprError('EXPR_EXPECTED_RPAREN', `表达式括号不匹配：${src}`);
        next();
        return expr;
      }
      case TOKEN.LBRACKET: {
        next();
        const items = [];
        while (peek().type !== TOKEN.RBRACKET) {
          items.push(parseExpression(0));
          if (peek().type === TOKEN.COMMA) next();
          else break;
        }
        if (peek().type !== TOKEN.RBRACKET) throw new ExprError('EXPR_EXPECTED_RBRACKET', `表达式方括号不匹配：${src}`);
        next();
        return { kind: 'array', items };
      }
      case TOKEN.IDENT: {
        next();
        let node = { kind: 'identifier', name: token.value };
        while (true) {
          if (peek().type === TOKEN.LPAREN) {
            next();
            const args = [];
            while (peek().type !== TOKEN.RPAREN) {
              args.push(parseExpression(0));
              if (peek().type === TOKEN.COMMA) next(); else break;
            }
            if (peek().type !== TOKEN.RPAREN) throw new ExprError('EXPR_EXPECTED_RPAREN', `函数调用缺少右括号：${src}`);
            next();
            node = { kind: 'call', callee: node, args };
            continue;
          }
          if (peek().type === TOKEN.DOT) {
            next();
            const prop = next();
            if (prop.type !== TOKEN.IDENT && prop.type !== TOKEN.NUMBER) {
              throw new ExprError('EXPR_EXPECTED_PROPERTY', `成员访问缺少属性名：${src}`);
            }
            node = { kind: 'member', object: node, property: String(prop.value) };
            continue;
          }
          if (peek().type === TOKEN.LBRACKET) {
            next();
            const index = parseExpression(0);
            if (peek().type !== TOKEN.RBRACKET) throw new ExprError('EXPR_EXPECTED_RBRACKET', `下标访问缺少右方括号：${src}`);
            next();
            node = { kind: 'member', object: node, property: index, computed: true };
            continue;
          }
          break;
        }
        return node;
      }
      default:
        break;
    }
    throw new ExprError('EXPR_UNEXPECTED_TOKEN', `表达式在「${token.value ?? '末尾'}」处不完整：${src}`);
  }

  function parseUnary() {
    const token = peek();
    if (token.type === TOKEN.OP && (token.value === '!' || token.value === '-' || token.value === 'not')) {
      next();
      return { kind: 'unary', op: token.value === 'not' ? '!' : token.value, arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parseExpression(minPrecedence) {
    let left = parseUnary();

    while (true) {
      const token = peek();
      if (token.type !== TOKEN.OP) break;

      let op = token.value;
      let consumed = 1;
      if (op === 'not' && tokens[pos + 1]?.value === 'in') {
        op = 'not in';
        consumed = 2;
      }
      const precedence = BINARY_PRECEDENCE.get(op);
      if (precedence === undefined || precedence < minPrecedence) break;

      for (let k = 0; k < consumed; k += 1) next();
      const right = parseExpression(precedence + 1);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  const ast = parseExpression(0);
  if (peek().type !== TOKEN.EOF) {
    throw new ExprError('EXPR_TRAILING_TOKEN', `表达式存在多余内容「${peek().value}」：${src}`);
  }
  return ast;
}

const parseCache = new Map();
const PARSE_CACHE_LIMIT = 2000;

/** 解析表达式为 AST（带缓存）。非法表达式抛 ExprError。 */
export function parseExpr(src) {
  const key = String(src ?? '').trim();
  if (!key) throw new ExprError('EXPR_EMPTY', '表达式为空');
  const cached = parseCache.get(key);
  if (cached) return cached;
  const ast = parse(tokenize(key), key);
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(key, ast);
  return ast;
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

export function isTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value === undefined || value === null || value === '' || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.trim() !== '' && value !== 'false' && value !== '0';
  return true;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined || value === '') return NaN;
  return Number(String(value).replace(/[,\s]/g, ''));
}

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  return [value];
}

/** 语义相等：空值互相等价，数字按数值比，数组按内容比，其余按字符串比。 */
function semanticEquals(a, b) {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty && bEmpty) return true;
  if (aEmpty !== bEmpty) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return isTruthy(a) === isTruthy(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = flatten(a).map(v => String(v)).sort();
    const arrB = flatten(b).map(v => String(v)).sort();
    return arrA.length === arrB.length && arrA.every((v, idx) => v === arrB[idx]);
  }
  const numA = toNumber(a);
  const numB = toNumber(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA === numB;
  return String(a) === String(b);
}

function compare(a, b) {
  const numA = toNumber(a);
  const numB = toNumber(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA === numB ? 0 : (numA < numB ? -1 : 1);
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  return strA === strB ? 0 : (strA < strB ? -1 : 1);
}

const FUNCTIONS = {
  len: v => (Array.isArray(v) ? v.length : String(v ?? '').length),
  count: v => flatten(v).length,
  sum: v => flatten(v).reduce((acc, item) => acc + (Number(toNumber(item)) || 0), 0),
  avg: v => { const list = flatten(v).map(toNumber).filter(n => !Number.isNaN(n)); return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0; },
  min: (...args) => Math.min(...flatten(args).map(toNumber).filter(n => !Number.isNaN(n))),
  max: (...args) => Math.max(...flatten(args).map(toNumber).filter(n => !Number.isNaN(n))),
  abs: v => Math.abs(toNumber(v)),
  round: (v, digits = 0) => { const factor = 10 ** (Number(digits) || 0); return Math.round(toNumber(v) * factor) / factor; },
  floor: v => Math.floor(toNumber(v)),
  ceil: v => Math.ceil(toNumber(v)),
  num: v => { const n = toNumber(v); return Number.isNaN(n) ? 0 : n; },
  str: v => (v === undefined || v === null ? '' : String(v)),
  bool: v => isTruthy(v),
  empty: v => !isTruthy(v),
  includes: (haystack, needle) => {
    if (Array.isArray(haystack)) return haystack.some(item => semanticEquals(item, needle));
    return String(haystack ?? '').includes(String(needle ?? ''));
  },
  startsWith: (text, prefix) => String(text ?? '').startsWith(String(prefix ?? '')),
  endsWith: (text, suffix) => String(text ?? '').endsWith(String(suffix ?? '')),
  matches: (text, pattern) => { try { return new RegExp(String(pattern)).test(String(text ?? '')); } catch { return false; } },
  if: (condition, thenValue, elseValue) => (isTruthy(condition) ? thenValue : elseValue),
  int: v => Math.trunc(toNumber(v)) || 0,
  join: (list, sep = '、') => flatten(list).map(v => String(v ?? '')).filter(Boolean).join(String(sep)),
  upper: v => String(v ?? '').toUpperCase(),
  lower: v => String(v ?? '').toLowerCase(),
  trim: v => String(v ?? '').trim(),
  replace: (text, from, to) => String(text ?? '').split(String(from)).join(String(to ?? '')),
  pick: (list, key) => flatten(list).map(item => (item && typeof item === 'object' ? item[key] : undefined)).filter(v => v !== undefined),
  keys: v => (v && typeof v === 'object' ? Object.keys(v) : []),
  values: v => (v && typeof v === 'object' ? Object.values(v) : []),
};

function resolveScope(name, scope) {
  if (BLOCKED_PROPS.has(name)) return undefined;
  if (!scope || typeof scope !== 'object') return undefined;
  // `$name` 与 `name` 等价：`$` 只是给作者一个「这是变量」的视觉提示。
  const key = name.startsWith('$') ? name.slice(1) : name;
  if (key in scope) return scope[key];
  return undefined;
}

function readProperty(object, property) {
  if (object === undefined || object === null) return undefined;
  if (BLOCKED_PROPS.has(String(property))) return undefined;
  if (typeof object === 'string' || Array.isArray(object)) {
    if (String(property) === 'length') return object.length;
  }
  if (Array.isArray(object) && /^\d+$/.test(String(property))) return object[Number(property)];
  if (typeof object === 'object') return object[property];
  return undefined;
}

function evaluateNode(node, scope) {
  switch (node.kind) {
    case 'literal': return node.value;
    case 'identifier': return resolveScope(node.name, scope);
    case 'array': return node.items.map(item => evaluateNode(item, scope));
    case 'unary': {
      const value = evaluateNode(node.arg, scope);
      if (node.op === '!') return !isTruthy(value);
      return -toNumber(value);
    }
    case 'member': {
      const object = evaluateNode(node.object, scope);
      const property = node.computed ? evaluateNode(node.property, scope) : node.property;
      return readProperty(object, property);
    }
    case 'call': {
      if (node.callee.kind !== 'identifier') return undefined;
      const fn = FUNCTIONS[node.callee.name];
      if (typeof fn !== 'function') return undefined;
      return fn(...node.args.map(arg => evaluateNode(arg, scope)));
    }
    case 'binary': {
      // 短路：&& / || 必须先判左值，否则 `a && a.b` 会炸。
      if (node.op === '&&') return isTruthy(evaluateNode(node.left, scope)) ? evaluateNode(node.right, scope) : false;
      if (node.op === '||') {
        const left = evaluateNode(node.left, scope);
        return isTruthy(left) ? left : evaluateNode(node.right, scope);
      }
      const a = evaluateNode(node.left, scope);
      const b = evaluateNode(node.right, scope);
      switch (node.op) {
        case '==': case '===': return semanticEquals(a, b);
        case '!=': case '!==': return !semanticEquals(a, b);
        case '<': return compare(a, b) < 0;
        case '<=': return compare(a, b) <= 0;
        case '>': return compare(a, b) > 0;
        case '>=': return compare(a, b) >= 0;
        case '+': {
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          const numA = toNumber(a); const numB = toNumber(b);
          if (!Number.isNaN(numA) && !Number.isNaN(numB) && a !== '' && b !== '' && a !== null && a !== undefined && b !== null && b !== undefined && typeof a !== 'string' && typeof b !== 'string') return numA + numB;
          if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`;
          return (Number.isNaN(numA) ? 0 : numA) + (Number.isNaN(numB) ? 0 : numB);
        }
        case '-': return (Number.isNaN(toNumber(a)) ? 0 : toNumber(a)) - (Number.isNaN(toNumber(b)) ? 0 : toNumber(b));
        case '*': return (Number.isNaN(toNumber(a)) ? 0 : toNumber(a)) * (Number.isNaN(toNumber(b)) ? 0 : toNumber(b));
        case '/': {
          const divisor = toNumber(b);
          if (divisor === 0) return 0;
          return (Number.isNaN(toNumber(a)) ? 0 : toNumber(a)) / divisor;
        }
        case '%': {
          const divisor = toNumber(b);
          if (divisor === 0) return 0;
          return (Number.isNaN(toNumber(a)) ? 0 : toNumber(a)) % divisor;
        }
        case 'in': {
          if (Array.isArray(b)) return b.some(item => semanticEquals(item, a));
          if (b && typeof b === 'object') return Object.prototype.hasOwnProperty.call(b, String(a));
          return String(b ?? '').includes(String(a ?? ''));
        }
        case 'not in': {
          if (Array.isArray(b)) return !b.some(item => semanticEquals(item, a));
          if (b && typeof b === 'object') return !Object.prototype.hasOwnProperty.call(b, String(a));
          return !String(b ?? '').includes(String(a ?? ''));
        }
        default: return undefined;
      }
    }
    default: return undefined;
  }
}

/**
 * 求值。表达式非法或求值出错时返回 `fallback`（默认 undefined），绝不抛给调用方。
 * @param {string} src
 * @param {Record<string, unknown>} [scope]
 * @param {{fallback?: unknown, strict?: boolean}} [options]
 */
export function evaluateExpr(src, scope = {}, options = {}) {
  try {
    return evaluateNode(parseExpr(src), scope);
  } catch (error) {
    if (options.strict) throw error;
    return options.fallback;
  }
}

/** 求值并做真值判断——条件显示/规则判断的常用入口。 */
export function evaluateCondition(src, scope = {}, options = {}) {
  if (src === undefined || src === null || String(src).trim() === '') return options.defaultWhenEmpty ?? true;
  const value = evaluateExpr(src, scope, { fallback: options.fallback ?? false });
  return isTruthy(value);
}

const compileCache = new Map();

/** 编译为可复用函数：批量校验时避免重复解析。 */
export function compileExpr(src) {
  const key = String(src ?? '').trim();
  if (!key) return () => undefined;
  let ast = compileCache.get(key);
  if (!ast) {
    ast = parseExpr(key);
    if (compileCache.size >= PARSE_CACHE_LIMIT) compileCache.clear();
    compileCache.set(key, ast);
  }
  return scope => { try { return evaluateNode(ast, scope ?? {}); } catch { return undefined; } };
}

/** 提取表达式引用的变量名——用于计算字段的依赖排序与「谁影响谁」分析。 */
export function exprIdentifiers(src) {
  const names = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'identifier') {
      const name = node.name.startsWith('$') ? node.name.slice(1) : node.name;
      if (!(name in FUNCTIONS)) names.add(name);
    }
    if (node.kind === 'call') { node.args.forEach(visit); if (node.callee?.kind === 'member') visit(node.callee.object); return; }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  try { visit(parseExpr(src)); } catch { /* 非法表达式没有依赖可言 */ }
  return [...names];
}

/** 校验表达式能否解析，返回 null 或中文错误说明。 */
export function checkExpr(src) {
  try { parseExpr(src); return null; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
