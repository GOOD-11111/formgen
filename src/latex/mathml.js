/**
 * formgen / 公式渲染层
 * ---------------------------------------------------------------------------
 * 零依赖 LaTeX → MathML Core 编译器（离线可用，输出可直接 innerHTML）。
 *
 * 设计要点
 *  - 手写词法分析（lex）+ 递归下降语法分析（Parser 类）+ 显式栈，绝不使用
 *    eval / new Function / Function 构造器。
 *  - 默认路径「绝不抛异常」：任何输入（null / undefined / 非字符串 / 畸形花括号 /
 *    未知命令 / 超长嵌套）都返回一个字符串；解析器内部异常会被兜底为可见的
 *    <mtext> 字面量。仅当显式传入 { strict: true } 时才抛 LatexError。
 *  - 输出为合法 XML/HTML 片段：标签成对闭合、属性全部加引号、文本内容做
 *    & < > " ' 五字符转义，中文与任意 Unicode 原样保留在 <mtext> 中。
 *  - 未知命令降级为可见的 <mtext>\cmd</mtext>，绝不吞掉后续内容。
 *
 * 导出的 API
 *  - latexToMathML(src, options) -> string
 *  - renderRichText(text, options) -> string
 *  - splitRichText(text) -> Array<{kind, value, display}>
 *  - LatexError
 */

/** 严格模式下由显式错误路径抛出的错误类型。 */
export class LatexError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'LatexError';
    if (detail !== undefined) this.detail = detail;
  }
}

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/* ========================================================================== *
 * 1. 转义
 * ========================================================================== */

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** XML/HTML 文本与属性值转义（五字符）。 */
function esc(value) {
  return String(value).replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

/** 生成属性串；值为 undefined / null 时跳过，布尔值输出 true/false，全部双引号。 */
function attr(name, value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'boolean' ? String(value) : value;
  return ` ${name}="${esc(text)}"`;
}

/* ========================================================================== *
 * 2. 词法分析
 * ========================================================================== */

const LETTER_RE = /[A-Za-z]/;
const DIGIT_RE = /[0-9]/;
const SPACE_RE = /\s/;

/**
 * 把 LaTeX 源码切成 token 数组。永不抛错。
 * token 形态：
 *   { t:'cmd', name }        控制序列（name 不含反斜杠；控制符号时 name 就是那个符号）
 *   { t:'char', value }      单个普通字符
 *   { t:'num', value }       数字串（含小数）
 *   { t:'space', value }     空白串（保留原始空白，供 \text 使用；数学模式下被忽略）
 *   { t:'{', t:'}', t:'^', t:'_', t:'&', t:'prime', t:'rowbreak' }
 */
function lex(src) {
  const s = String(src);
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 >= s.length) {
        // 结尾孤立反斜杠：可见降级
        toks.push({ t: 'cmd', name: '', pos: i });
        i += 1;
        continue;
      }
      const n = s[i + 1];
      if (LETTER_RE.test(n)) {
        let j = i + 1;
        while (j < s.length && LETTER_RE.test(s[j])) j += 1;
        toks.push({ t: 'cmd', name: s.slice(i + 1, j), pos: i });
        i = j;
      } else if (n === '\\') {
        toks.push({ t: 'rowbreak', pos: i });
        i += 2;
      } else {
        toks.push({ t: 'cmd', name: n, pos: i });
        i += 2;
      }
      continue;
    }
    if (c === '{' || c === '}' || c === '^' || c === '_' || c === '&') {
      toks.push({ t: c, pos: i });
      i += 1;
      continue;
    }
    if (c === "'") {
      toks.push({ t: 'prime', pos: i });
      i += 1;
      continue;
    }
    if (DIGIT_RE.test(c)) {
      let j = i;
      while (j < s.length && DIGIT_RE.test(s[j])) j += 1;
      if (s[j] === '.' && DIGIT_RE.test(s[j + 1] || '')) {
        j += 1;
        while (j < s.length && DIGIT_RE.test(s[j])) j += 1;
      }
      toks.push({ t: 'num', value: s.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (SPACE_RE.test(c)) {
      let j = i;
      while (j < s.length && SPACE_RE.test(s[j])) j += 1;
      toks.push({ t: 'space', value: s.slice(i, j), pos: i });
      i = j;
      continue;
    }
    toks.push({ t: 'char', value: c, pos: i });
    i += 1;
  }
  return toks;
}

/** 文本模式（\text 等）里把控制符号还原成真实字符，避免出现 `\%` 这种噪音。 */
const TEXT_ESCAPES = {
  '%': '%',
  $: '$',
  '&': '&',
  '#': '#',
  _: '_',
  '{': '{',
  '}': '}',
  ' ': '\u00A0',
  ',': '\u2009',
  ';': '\u2005',
  ':': '\u2005',
  '!': '',
  '-': '',
  '/': '',
  '|': '‖',
  backslash: '\\',
  textbackslash: '\\',
  textbraceleft: '{',
  textbraceright: '}',
  textdollar: '$',
  textunderscore: '_',
  textasciitilde: '~',
  textasciicircum: '^',
  textless: '<',
  textgreater: '>',
  textbar: '|',
  textellipsis: '…',
  ldots: '…',
  dots: '…',
};

/** token → 原始文本（用于文本模式与深度保护降级）。 */
function tokenSource(tk) {
  if (!tk) return '';
  switch (tk.t) {
    case 'cmd':
      if (Object.prototype.hasOwnProperty.call(TEXT_ESCAPES, tk.name)) return TEXT_ESCAPES[tk.name];
      return '\\' + tk.name;
    case 'space':
      return tk.value;
    case 'num':
      return tk.value;
    case 'char':
      return tk.value;
    case 'prime':
      return "'";
    case 'rowbreak':
      return '\\\\';
    case '{':
    case '}':
    case '^':
    case '_':
    case '&':
      return tk.t;
    default:
      return '';
  }
}

/* ========================================================================== *
 * 3. 符号表
 * ========================================================================== */

/**
 * 每条记录：[kind, text, extra]
 *   mi     斜体标识符，extra 可给 mathvariant
 *   mo     运算符
 *   fn     直排函数名（<mi mathvariant="normal">，上下标在侧面）
 *   lim    直排算符（上下标走 munder/mover）
 *   bigop  大运算符（上下标走 munder/mover/munderover）
 *   space  间距
 *   mtext  文本
 *   eat    吃掉不输出
 */
const SYMBOLS = {
  /* ---- 希腊字母：小写（斜体） ---- */
  alpha: ['mi', 'α'],
  beta: ['mi', 'β'],
  gamma: ['mi', 'γ'],
  delta: ['mi', 'δ'],
  epsilon: ['mi', 'ϵ'],
  varepsilon: ['mi', 'ε'],
  zeta: ['mi', 'ζ'],
  eta: ['mi', 'η'],
  theta: ['mi', 'θ'],
  vartheta: ['mi', 'ϑ'],
  iota: ['mi', 'ι'],
  kappa: ['mi', 'κ'],
  varkappa: ['mi', 'ϰ'],
  lambda: ['mi', 'λ'],
  mu: ['mi', 'μ'],
  nu: ['mi', 'ν'],
  xi: ['mi', 'ξ'],
  omicron: ['mi', 'ο'],
  pi: ['mi', 'π'],
  varpi: ['mi', 'ϖ'],
  rho: ['mi', 'ρ'],
  varrho: ['mi', 'ϱ'],
  sigma: ['mi', 'σ'],
  varsigma: ['mi', 'ς'],
  tau: ['mi', 'τ'],
  upsilon: ['mi', 'υ'],
  phi: ['mi', 'ϕ'],
  varphi: ['mi', 'φ'],
  chi: ['mi', 'χ'],
  psi: ['mi', 'ψ'],
  omega: ['mi', 'ω'],

  /* ---- 希腊字母：大写（LaTeX 中直排） ---- */
  Gamma: ['mi', 'Γ', 'normal'],
  Delta: ['mi', 'Δ', 'normal'],
  Theta: ['mi', 'Θ', 'normal'],
  Lambda: ['mi', 'Λ', 'normal'],
  Xi: ['mi', 'Ξ', 'normal'],
  Pi: ['mi', 'Π', 'normal'],
  Sigma: ['mi', 'Σ', 'normal'],
  Upsilon: ['mi', 'Υ', 'normal'],
  Phi: ['mi', 'Φ', 'normal'],
  Psi: ['mi', 'Ψ', 'normal'],
  Omega: ['mi', 'Ω', 'normal'],
  Alpha: ['mi', 'A', 'normal'],
  Beta: ['mi', 'B', 'normal'],
  Epsilon: ['mi', 'E', 'normal'],
  Zeta: ['mi', 'Z', 'normal'],
  Eta: ['mi', 'H', 'normal'],
  Iota: ['mi', 'I', 'normal'],
  Kappa: ['mi', 'K', 'normal'],
  Mu: ['mi', 'M', 'normal'],
  Nu: ['mi', 'N', 'normal'],
  Omicron: ['mi', 'O', 'normal'],
  Rho: ['mi', 'P', 'normal'],
  Tau: ['mi', 'T', 'normal'],
  Chi: ['mi', 'X', 'normal'],

  /* ---- 关系 ---- */
  '=': ['mo', '='],
  ne: ['mo', '≠'],
  neq: ['mo', '≠'],
  lt: ['mo', '<'],
  gt: ['mo', '>'],
  le: ['mo', '≤'],
  leq: ['mo', '≤'],
  ge: ['mo', '≥'],
  geq: ['mo', '≥'],
  leqslant: ['mo', '⩽'],
  geqslant: ['mo', '⩾'],
  approx: ['mo', '≈'],
  equiv: ['mo', '≡'],
  sim: ['mo', '∼'],
  simeq: ['mo', '≃'],
  cong: ['mo', '≅'],
  propto: ['mo', '∝'],
  asymp: ['mo', '≍'],
  doteq: ['mo', '≐'],
  triangleq: ['mo', '≜'],
  ll: ['mo', '≪'],
  gg: ['mo', '≫'],
  prec: ['mo', '≺'],
  succ: ['mo', '≻'],
  preceq: ['mo', '⪯'],
  succeq: ['mo', '⪰'],
  mid: ['mo', '∣'],
  nmid: ['mo', '∤'],
  perp: ['mo', '⊥'],
  parallel: ['mo', '∥'],
  nparallel: ['mo', '∦'],
  bowtie: ['mo', '⋈'],

  /* ---- 运算 ---- */
  pm: ['mo', '±'],
  mp: ['mo', '∓'],
  times: ['mo', '×'],
  div: ['mo', '÷'],
  cdot: ['mo', '⋅'],
  ast: ['mo', '∗'],
  star: ['mo', '⋆'],
  circ: ['mo', '∘'],
  bullet: ['mo', '∙'],
  oplus: ['mo', '⊕'],
  ominus: ['mo', '⊖'],
  otimes: ['mo', '⊗'],
  oslash: ['mo', '⊘'],
  odot: ['mo', '⊙'],
  bigcirc: ['mo', '○'],
  diamond: ['mo', '⋄'],
  triangle: ['mo', '△'],
  bigtriangleup: ['mo', '△'],
  bigtriangledown: ['mo', '▽'],
  wedge: ['mo', '∧'],
  vee: ['mo', '∨'],
  sqcup: ['mo', '⊔'],
  sqcap: ['mo', '⊓'],
  uplus: ['mo', '⊎'],

  /* ---- 集合 / 逻辑 ---- */
  in: ['mo', '∈'],
  notin: ['mo', '∉'],
  ni: ['mo', '∋'],
  owns: ['mo', '∋'],
  subset: ['mo', '⊂'],
  subseteq: ['mo', '⊆'],
  supset: ['mo', '⊃'],
  supseteq: ['mo', '⊇'],
  nsubseteq: ['mo', '⊈'],
  nsupseteq: ['mo', '⊉'],
  sqsubset: ['mo', '⊏'],
  sqsupset: ['mo', '⊐'],
  sqsubseteq: ['mo', '⊑'],
  sqsupseteq: ['mo', '⊒'],
  cup: ['mo', '∪'],
  cap: ['mo', '∩'],
  setminus: ['mo', '∖'],
  smallsetminus: ['mo', '∖'],
  backslash: ['mo', '\\'],
  emptyset: ['mo', '∅'],
  varnothing: ['mo', '∅'],
  forall: ['mo', '∀'],
  exists: ['mo', '∃'],
  nexists: ['mo', '∄'],
  neg: ['mo', '¬'],
  lnot: ['mo', '¬'],
  land: ['mo', '∧'],
  lor: ['mo', '∨'],
  implies: ['mo', '⟹'],
  Longrightarrow: ['mo', '⟹'],
  iff: ['mo', '⟺'],
  Longleftrightarrow: ['mo', '⟺'],
  therefore: ['mo', '∴'],
  because: ['mo', '∵'],

  /* ---- 箭头 ---- */
  to: ['mo', '→'],
  rightarrow: ['mo', '→'],
  leftarrow: ['mo', '←'],
  leftrightarrow: ['mo', '↔'],
  Rightarrow: ['mo', '⇒'],
  Leftarrow: ['mo', '⇐'],
  Leftrightarrow: ['mo', '⇔'],
  mapsto: ['mo', '↦'],
  longmapsto: ['mo', '⟼'],
  hookrightarrow: ['mo', '↪'],
  hookleftarrow: ['mo', '↩'],
  uparrow: ['mo', '↑'],
  downarrow: ['mo', '↓'],
  updownarrow: ['mo', '↕'],
  Uparrow: ['mo', '⇑'],
  Downarrow: ['mo', '⇓'],
  Updownarrow: ['mo', '⇕'],
  nearrow: ['mo', '↗'],
  searrow: ['mo', '↘'],
  swarrow: ['mo', '↙'],
  nwarrow: ['mo', '↖'],
  longrightarrow: ['mo', '⟶'],
  longleftarrow: ['mo', '⟵'],

  /* ---- 杂项符号 ---- */
  infty: ['mo', '∞'],
  infinity: ['mo', '∞'],
  partial: ['mo', '∂'],
  nabla: ['mo', '∇'],
  angle: ['mo', '∠'],
  measuredangle: ['mo', '∡'],
  dots: ['mo', '…'],
  ldots: ['mo', '…'],
  cdots: ['mo', '⋯'],
  vdots: ['mo', '⋮'],
  ddots: ['mo', '⋱'],
  prime: ['mo', '′'],
  degree: ['mo', '°'],
  square: ['mo', '□'],
  blacksquare: ['mo', '■'],
  checkmark: ['mo', '✓'],
  hbar: ['mi', 'ℏ'],
  ell: ['mi', 'ℓ'],
  Re: ['mi', 'ℜ', 'normal'],
  Im: ['mi', 'ℑ', 'normal'],
  aleph: ['mi', 'ℵ'],
  wp: ['mi', '℘'],

  /* ---- 大运算符（上下限走 munder/mover/munderover） ---- */
  sum: ['bigop', '∑'],
  prod: ['bigop', '∏'],
  coprod: ['bigop', '∐'],
  int: ['bigop', '∫'],
  oint: ['bigop', '∮'],
  iint: ['bigop', '∬'],
  iiint: ['bigop', '∭'],
  idotsint: ['bigop', '∫⋯∫'],
  bigcup: ['bigop', '⋃'],
  bigcap: ['bigop', '⋂'],
  bigvee: ['bigop', '⋁'],
  bigwedge: ['bigop', '⋀'],
  bigoplus: ['bigop', '⨁'],
  bigotimes: ['bigop', '⨂'],
  bigodot: ['bigop', '⨀'],
  bigsqcup: ['bigop', '⨆'],
  biguplus: ['bigop', '⨄'],

  /* ---- 极限型算符（上下限走 munder/mover） ---- */
  lim: ['lim', 'lim'],
  limsup: ['lim', 'lim sup'],
  liminf: ['lim', 'lim inf'],
  max: ['lim', 'max'],
  min: ['lim', 'min'],
  sup: ['lim', 'sup'],
  inf: ['lim', 'inf'],
  det: ['lim', 'det'],
  gcd: ['lim', 'gcd'],
  arg: ['lim', 'arg'],
  dim: ['lim', 'dim'],
  deg: ['lim', 'deg'],
  ker: ['lim', 'ker'],
  hom: ['lim', 'hom'],
  Pr: ['lim', 'Pr'],

  /* ---- 直排函数名（上下标在侧面） ---- */
  sin: ['fn', 'sin'],
  cos: ['fn', 'cos'],
  tan: ['fn', 'tan'],
  cot: ['fn', 'cot'],
  sec: ['fn', 'sec'],
  csc: ['fn', 'csc'],
  arcsin: ['fn', 'arcsin'],
  arccos: ['fn', 'arccos'],
  arctan: ['fn', 'arctan'],
  arccot: ['fn', 'arccot'],
  sinh: ['fn', 'sinh'],
  cosh: ['fn', 'cosh'],
  tanh: ['fn', 'tanh'],
  coth: ['fn', 'coth'],
  log: ['fn', 'log'],
  ln: ['fn', 'ln'],
  lg: ['fn', 'lg'],
  exp: ['fn', 'exp'],
  sgn: ['fn', 'sgn'],
  mod: ['fn', 'mod'],

  /* ---- 间距 ---- */
  quad: ['space', '1em'],
  qquad: ['space', '2em'],
  enspace: ['space', '0.5em'],
  thinspace: ['space', '0.167em'],
  medspace: ['space', '0.222em'],
  thickspace: ['space', '0.278em'],
  negthinspace: ['eat', ''],
  negmedspace: ['eat', ''],
  negthickspace: ['eat', ''],
  ',': ['space', '0.167em'],
  ';': ['space', '0.278em'],
  ':': ['space', '0.222em'],
  ' ': ['space', '0.333em'],
  '!': ['eat', ''],
  '/': ['eat', ''],
  '-': ['eat', ''],

  /* ---- 转义字符 ---- */
  '%': ['mo', '%'],
  $: ['mo', '$'],
  '&': ['mtext', '&'],
  '#': ['mtext', '#'],
  _: ['mo', '_'],
  '{': ['mo', '{'],
  '}': ['mo', '}'],
  '|': ['mo', '‖'],

  /* ---- 定界符类命令 ---- */
  lbrace: ['mo', '{'],
  rbrace: ['mo', '}'],
  lbrack: ['mo', '['],
  rbrack: ['mo', ']'],
  langle: ['mo', '⟨'],
  rangle: ['mo', '⟩'],
  lvert: ['mo', '|'],
  rvert: ['mo', '|'],
  vert: ['mo', '|'],
  lVert: ['mo', '‖'],
  rVert: ['mo', '‖'],
  Vert: ['mo', '‖'],
  lfloor: ['mo', '⌊'],
  rfloor: ['mo', '⌋'],
  lceil: ['mo', '⌈'],
  rceil: ['mo', '⌉'],
  lgroup: ['mo', '⟮'],
  rgroup: ['mo', '⟯'],
  lmoustache: ['mo', '⎰'],
  rmoustache: ['mo', '⎱'],
  ulcorner: ['mo', '⌜'],
  urcorner: ['mo', '⌝'],
  llcorner: ['mo', '⌞'],
  lrcorner: ['mo', '⌟'],

  /* ---- 空格类 ---- */
  '~': ['space', '0.333em'],
};

/** 定界符（\left \right \big 之后出现的符号）。 */
const DELIMS = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '|': '|',
  '/': '/',
  '<': '⟨',
  '>': '⟩',
  '.': null,
  '{': '{',
  '}': '}',
  lbrace: '{',
  rbrace: '}',
  lbrack: '[',
  rbrack: ']',
  langle: '⟨',
  rangle: '⟩',
  lvert: '|',
  rvert: '|',
  vert: '|',
  lVert: '‖',
  rVert: '‖',
  Vert: '‖',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  backslash: '\\',
  uparrow: '↑',
  downarrow: '↓',
  updownarrow: '↕',
  Uparrow: '⇑',
  Downarrow: '⇓',
  Updownarrow: '⇕',
  lgroup: '⟮',
  rgroup: '⟯',
  lmoustache: '⎰',
  rmoustache: '⎱',
};

/** 环境：定界符与列对齐。 */
const ENVIRONMENTS = {
  matrix: {},
  smallmatrix: {},
  array: {},
  tabular: {},
  aligned: { align: 'right left' },
  align: { align: 'right left' },
  alignat: { align: 'right left' },
  alignedat: { align: 'right left' },
  split: { align: 'right left' },
  gathered: { align: 'center' },
  gather: { align: 'center' },
  subarray: { align: 'center' },
  pmatrix: { open: '(', close: ')' },
  bmatrix: { open: '[', close: ']' },
  Bmatrix: { open: '{', close: '}' },
  vmatrix: { open: '|', close: '|' },
  Vmatrix: { open: '‖', close: '‖' },
  cases: { open: '{', align: 'left left' },
  dcases: { open: '{', align: 'left left' },
  rcases: { open: '|', align: 'left left' },
};

/** 字体变体命令 → mathvariant 取值（MathML Core 合法值）。 */
const VARIANTS = {
  mathrm: 'normal',
  mathbf: 'bold',
  mathit: 'italic',
  mathsf: 'sans-serif',
  mathtt: 'monospace',
  mathcal: 'script',
  mathscr: 'script',
  mathbb: 'double-struck',
  mathfrak: 'fraktur',
  boldsymbol: 'bold-italic',
  bm: 'bold-italic',
};

/** 尺寸修饰命令，只吃符号不改字号。 */
const SIZE_MODIFIERS = new Set([
  'big',
  'Big',
  'bigg',
  'Bigg',
  'bigl',
  'bigr',
  'bigm',
  'Bigl',
  'Bigr',
  'Bigm',
  'biggl',
  'biggr',
  'biggm',
  'Biggl',
  'Biggr',
  'Biggm',
]);

/** 仅消费、不输出任何内容的命令。 */
const EAT_COMMANDS = new Set([
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'scriptscriptstyle',
  'limits',
  'nolimits',
  'nonumber',
  'notag',
  'relax',
  'allowbreak',
  'mathstrut',
  'strut',
  'hline',
  'toprule',
  'midrule',
  'bottomrule',
  'noalign',
  'smallskip',
  'medskip',
  'bigskip',
  'vspace',
  'vskip',
  'protect',
  'ignorespaces',
]);

/** 可以夹在「基」与上下标之间的修饰命令，遇到时要跳过继续找 ^ _ '。 */
const SCRIPT_MODIFIERS = new Set([
  'limits',
  'nolimits',
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'scriptscriptstyle',
]);

/** 只透传参数的包装命令。 */
const PASSTHROUGH_COMMANDS = new Set([
  'ensuremath',
  'smash',
  'mathop',
  'mathrel',
  'mathbin',
  'mathord',
  'mathopen',
  'mathclose',
  'mathpunct',
  'mathinner',
  'hbox',
  'mbox',
  'textnormal',
  'textrm',
  'textup',
  'operatornamewithlimits',
  'substack',
]);

/** 取反映射：\not 后接这些单字符时直接换成预组合字符。 */
const NEGATIONS = {
  '=': '≠',
  '<': '≮',
  '>': '≯',
  '∈': '∉',
  '∋': '∌',
  '⊂': '⊄',
  '⊃': '⊅',
  '≤': '≰',
  '≥': '≱',
  '≡': '≢',
  '∼': '≁',
  '≈': '≉',
  '∣': '∤',
  '∥': '∦',
  '≃': '≄',
  '≅': '≇',
};

/** ASCII 普通字符 → 运算符。 */
const ASCII_OPS = {
  '+': '+',
  '-': '−',
  '=': '=',
  '<': '<',
  '>': '>',
  ',': ',',
  ';': ';',
  ':': ':',
  '!': '!',
  '?': '?',
  '*': '∗',
  '/': '/',
  '|': '|',
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '{': '{',
  '}': '}',
  '@': '@',
  $: '$',
  '%': '%',
  '#': '#',
  '"': '"',
  '`': '`',
  '.': '.',
  '~': null,
};

/** CJK / 全角字符走 <mtext>，保证中文原样保留。 */
const CJK_RE =
  /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u31C0-\u31EF\u3200-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

/** 递归深度上限：200 层嵌套正常工作，更深的输入优雅降级而不是爆栈。 */
const MAX_DEPTH = 512;

/* ========================================================================== *
 * 4. 节点构造与字体变体
 * ========================================================================== */

const emptyRow = () => ({ t: 'mrow', children: [] });
const row = (children) => {
  const kids = (children || []).filter(Boolean);
  if (kids.length === 0) return emptyRow();
  if (kids.length === 1) return kids[0];
  return { t: 'mrow', children: kids };
};
const mo = (text, extra) => Object.assign({ t: 'mo', text }, extra || {});
const mi = (text, variant) => (variant ? { t: 'mi', text, variant } : { t: 'mi', text });
const mn = (text) => ({ t: 'mn', text });
const mtext = (text, variant) => (variant ? { t: 'mtext', text, variant } : { t: 'mtext', text });
const mspace = (width) => ({ t: 'mspace', width });
const fence = (text, form) =>
  mo(text, { stretchy: true, fence: true, form });

/** 递归套用字体变体（落在 mi / mn / mo / mtext 叶子上）。 */
function applyVariant(node, variant) {
  if (!node || typeof node !== 'object') return node;
  const out = Object.assign({}, node);
  switch (out.t) {
    case 'mi':
    case 'mn':
    case 'mo':
    case 'mtext':
      out.variant = variant;
      return out;
    case 'mrow':
    case 'msqrt':
    case 'mphantom':
    case 'menclose':
      out.children = (out.children || []).map((c) => applyVariant(c, variant));
      return out;
    case 'msup':
    case 'msub':
      out.base = applyVariant(out.base, variant);
      if (out.sup) out.sup = applyVariant(out.sup, variant);
      if (out.sub) out.sub = applyVariant(out.sub, variant);
      return out;
    case 'msubsup':
    case 'munderover':
      out.base = applyVariant(out.base, variant);
      out.sub = applyVariant(out.sub, variant);
      out.sup = applyVariant(out.sup, variant);
      if (out.under) out.under = applyVariant(out.under, variant);
      if (out.over) out.over = applyVariant(out.over, variant);
      return out;
    case 'munder':
      out.base = applyVariant(out.base, variant);
      out.under = applyVariant(out.under, variant);
      return out;
    case 'mover':
      out.base = applyVariant(out.base, variant);
      out.over = applyVariant(out.over, variant);
      return out;
    case 'mfrac':
      out.num = applyVariant(out.num, variant);
      out.den = applyVariant(out.den, variant);
      return out;
    case 'mroot':
      out.base = applyVariant(out.base, variant);
      out.index = applyVariant(out.index, variant);
      return out;
    case 'mtable':
      out.rows = (out.rows || []).map((r) => r.map((c) => applyVariant(c, variant)));
      return out;
    default:
      return out;
  }
}

/** 单个普通字符 → 节点。 */
function charNode(ch) {
  if (Object.prototype.hasOwnProperty.call(ASCII_OPS, ch)) {
    const mapped = ASCII_OPS[ch];
    if (mapped === null) return mspace('0.333em');
    return { t: 'mo', text: mapped };
  }
  if (ch.charCodeAt(0) < 128) {
    if (LETTER_RE.test(ch)) return mi(ch);
    if (DIGIT_RE.test(ch)) return mn(ch);
    return mtext(ch);
  }
  if (CJK_RE.test(ch)) return mtext(ch);
  if (/\p{L}/u.test(ch)) return mi(ch);
  if (/\p{N}/u.test(ch)) return mn(ch);
  return mtext(ch);
}

/* ========================================================================== *
 * 5. 解析器
 * ========================================================================== */

class Parser {
  constructor(tokens, options) {
    this.toks = tokens;
    this.i = 0;
    this.depth = 0;

    this.opts = options || {};
    this.budget = Math.max(4096, tokens.length * 4 + 512);
  }

  peek(k) {
    return this.toks[this.i + (k || 0)] || null;
  }

  next() {
    return this.toks[this.i++] || null;
  }

  get eof() {
    return this.i >= this.toks.length;
  }

  fail(message, tok) {
    if (this.opts.strict === true) {
      throw new LatexError(message, tok && tok.pos !== undefined ? { pos: tok.pos } : undefined);
    }
  }

  spend() {
    this.budget -= 1;
    if (this.budget <= 0) throw new LatexError('parser budget exhausted');
  }

  /* ---------------- 序列 ---------------- */

  /**
   * 解析一串原子，直到 stop(token) 为真、遇到 } （stopAtBrace）或输入结束。
   */
  parseSequence(stop, stopAtBrace) {
    const out = [];
    if (this.depth >= MAX_DEPTH) {
      // 深度保护：把剩余 token 原样收集成可见文本，绝不递归、绝不爆栈。
      let raw = '';
      while (!this.eof) {
        const tk = this.peek();
        if (stop && stop(tk)) break;
        if (tk.t === '}') break;
        this.next();
        raw += tokenSource(tk);
      }
      return raw === '' ? [] : [mtext(raw)];
    }
    this.depth += 1;
    try {
      while (!this.eof) {
        const tk = this.peek();
        if (stop && stop(tk)) break;
        if (tk.t === 'space') {
          this.next();
          continue;
        }
        if (tk.t === '}' && stopAtBrace !== false) break;
        const node = this.parseAtomWithScripts();
        if (node) out.push(node);
      }
    } finally {
      this.depth -= 1;
    }
    return out;
  }

  /* ---------------- 原子与上下标 ---------------- */

  parseAtomWithScripts() {
    this.spend();
    const base = this.parseAtom();
    if (!base) return null;

    let sup = null;
    let sub = null;
    for (;;) {
      const tk = this.peek();
      if (!tk) break;
      // \sum\limits_{...}：尺寸/样式修饰夹在基与上下标之间，先吃掉再继续找 ^ _ '
      if (tk.t === 'cmd' && SCRIPT_MODIFIERS.has(tk.name)) {
        this.next();
        continue;
      }
      if (tk.t === 'prime') {
        this.next();
        sup = mergeScript(sup, mo('′'));
        continue;
      }
      if (tk.t === '^') {
        this.next();
        sup = mergeScript(sup, this.parseScriptArg());
        continue;
      }
      if (tk.t === '_') {
        this.next();
        sub = mergeScript(sub, this.parseScriptArg());
        continue;
      }
      break;
    }

    const limits = base.bigop === true || base.limits === 'movable';
    if (limits) {
      if (sub && sup) return { t: 'munderover', base, sub, sup };
      if (sub) return { t: 'munder', base, under: sub };
      if (sup) return { t: 'mover', base, over: sup };
      return stripMarkers(base);
    }
    if (sub && sup) return { t: 'msubsup', base: stripMarkers(base), sub, sup };
    if (sub) return { t: 'msub', base: stripMarkers(base), sub };
    if (sup) return { t: 'msup', base: stripMarkers(base), sup };
    return stripMarkers(base);
  }

  parseAtom() {
    const tk = this.next();
    if (!tk) return null;
    switch (tk.t) {
      case 'num':
        return mn(tk.value);
      case 'char':
        return charNode(tk.value);
      case '{':
        return this.parseGroup();
      case '}':
        this.fail('存在多余的右花括号 }', tk);
        return mo('}');
      case '^':
        return mo('^');
      case '_':
        return mo('_');
      case '&':
        return mtext('&');
      case 'prime':
        return mo('′');
      case 'rowbreak':
        return { t: 'mspace', linebreak: true };
      case 'space':
        return mspace('0.333em');
      case 'cmd':
        return this.parseCommand(tk);
      default:
        return null;
    }
  }

  /** 上下标的参数：{...} 分组，或单个原子（\frac12 里 12 要拆成 1 和 2）。 */
  parseScriptArg() {
    const tk = this.peek();
    if (!tk) {
      this.fail('缺少上下标参数');
      return emptyRow();
    }
    if (tk.t === 'space') {
      this.next();
      return this.parseScriptArg();
    }
    if (tk.t === '{') {
      this.next();
      return normalizeDegree(this.parseGroup());
    }
    const single = this.takeSingleNumber();
    if (single) return normalizeDegree(single);
    if (tk.t === 'char' && (tk.value === '-' || tk.value === '+')) {
      this.next();
      const sign = charNode(tk.value);
      const rest = this.parseAtom();
      return normalizeDegree(row([sign, rest]));
    }
    return normalizeDegree(this.parseAtom() || emptyRow());
  }

  /** 命令参数：{...} 分组或单个原子。 */
  parseArg() {
    const tk = this.peek();
    if (!tk) {
      this.fail('缺少命令参数');
      return emptyRow();
    }
    if (tk.t === 'space') {
      this.next();
      return this.parseArg();
    }
    if (tk.t === '{') {
      this.next();
      return this.parseGroup();
    }
    const single = this.takeSingleNumber();
    if (single) return single;
    const node = this.parseAtomWithScripts();
    return node || emptyRow();
  }

  /** 把多位数 token 拆成「首位」，其余留在流里（\frac12 → \frac{1}{2}）。 */
  takeSingleNumber() {
    const tk = this.peek();
    if (tk && tk.t === 'num' && tk.value.length > 1) {
      this.toks[this.i] = { t: 'num', value: tk.value.slice(1), pos: tk.pos };
      return mn(tk.value[0]);
    }
    return null;
  }

  /* ---------------- 分组 ---------------- */

  /** 调用前已消费 `{`。 */
  parseGroup() {
    const nodes = this.parseSequence((tk) => tk.t === '}', true);
    const close = this.peek();
    if (close && close.t === '}') {
      this.next();
    } else {
      this.fail('花括号未闭合');
    }
    return row(nodes);
  }

  /** 原样读取一个 { ... } 文本块（用于 \text / \begin），不做数学解析。 */
  parseTextGroup() {
    const open = this.peek();
    if (!open) return '';
    if (open.t === 'space') {
      this.next();
      return this.parseTextGroup();
    }
    if (open.t !== '{') return '';
    this.next();
    let depth = 1;
    let out = '';
    while (!this.eof) {
      const tk = this.next();
      if (tk.t === '{') {
        depth += 1;
        out += '{';
        continue;
      }
      if (tk.t === '}') {
        depth -= 1;
        if (depth === 0) break;
        out += '}';
        continue;
      }
      out += tokenSource(tk);
    }
    return out;
  }

  /** 尝试跳过 [ ... ] 可选参数；内容不像参数时保持原样。 */
  trySkipOptional() {
    const open = this.peek();
    if (!open || open.t !== 'char' || open.value !== '[') return null;
    let j = this.i + 1;
    let depth = 1;
    let raw = '';
    while (j < this.toks.length) {
      const tk = this.toks[j];
      if (tk.t === 'char' && tk.value === '[') depth += 1;
      else if (tk.t === 'char' && tk.value === ']') {
        depth -= 1;
        if (depth === 0) break;
      } else if (tk.t === '{') depth += 1;
      else if (tk.t === '}') depth -= 1;
      raw += tokenSource(tk);
      j += 1;
    }
    if (j >= this.toks.length || depth !== 0) return null;
    if (!/^[\sA-Za-z0-9.,+\-]*$/.test(raw)) return null;
    this.i = j + 1;
    return raw;
  }

  /* ---------------- 命令 ---------------- */

  parseCommand(tk) {
    const name = tk.name;
    if (name === '') return mtext('\\');

    const sym = Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? SYMBOLS[name] : null;
    if (sym) return this.buildSymbol(sym);

    if (EAT_COMMANDS.has(name)) return null;

    if (SIZE_MODIFIERS.has(name)) {
      // \big( 之类：吃掉尺寸修饰，保留后面的定界符
      const arg = this.parseArg();
      return arg;
    }

    switch (name) {
      /* ---- 分式 ---- */
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac': {
        if (name === 'cfrac') this.trySkipOptional();
        const num = this.parseArg();
        const den = this.parseArg();
        return { t: 'mfrac', num, den };
      }
      case 'binom':
      case 'dbinom':
      case 'tbinom': {
        const top = this.parseArg();
        const bottom = this.parseArg();
        return {
          t: 'mrow',
          children: [
            fence('(', 'prefix'),
            { t: 'mfrac', num: top, den: bottom, linethickness: '0' },
            fence(')', 'postfix'),
          ],
        };
      }

      /* ---- 根式 ---- */
      case 'sqrt': {
        const index = this.trySkipOptional();
        const body = this.parseArg();
        if (index !== null && index.trim() !== '') {
          const idxNodes = this.parseInlineText(index);
          return { t: 'mroot', base: body, index: row(idxNodes) };
        }
        return { t: 'msqrt', children: [body] };
      }

      /* ---- 文本 ---- */
      case 'text':
      case 'textnormal':
      case 'textrm':
      case 'textup':
      case 'mbox':
      case 'hbox':
        return mtext(this.parseTextGroup());
      case 'textbf':
        return mtext(this.parseTextGroup(), 'bold');
      case 'textit':
      case 'emph':
        return mtext(this.parseTextGroup(), 'italic');
      case 'texttt':
        return mtext(this.parseTextGroup(), 'monospace');
      case 'textsf':
        return mtext(this.parseTextGroup(), 'sans-serif');
      case 'operatorname': {
        const star = this.peek();
        if (star && star.t === 'char' && star.value === '*') this.next();
        const txt = this.parseTextGroup();
        const node = mi(txt, 'normal');
        node.func = true;
        return node;
      }

      /* ---- 字体变体 ---- */
      case 'mathrm':
      case 'mathbf':
      case 'mathit':
      case 'mathsf':
      case 'mathtt':
      case 'mathcal':
      case 'mathscr':
      case 'mathbb':
      case 'mathfrak':
      case 'boldsymbol':
      case 'bm':
        return applyVariant(this.parseArg(), VARIANTS[name]);

      /* ---- 定界符 ---- */
      case 'left':
        return this.parseLeftRight(tk);
      case 'right': {
        this.fail('\\right 没有配对的 \\left', tk);
        const d = this.parseDelimiter();
        return d === null ? null : mo(d, { stretchy: true, fence: true, form: 'postfix' });
      }
      case 'middle': {
        const d = this.parseDelimiter();
        return d === null ? null : mo(d, { stretchy: true });
      }

      /* ---- 装饰 ---- */
      case 'vec':
        return { t: 'mover', base: this.parseArg(), over: mo('→', { stretchy: false }), accent: true };
      case 'overrightarrow':
        return { t: 'mover', base: this.parseArg(), over: mo('→', { stretchy: true }), accent: true };
      case 'overleftarrow':
        return { t: 'mover', base: this.parseArg(), over: mo('←', { stretchy: true }), accent: true };
      case 'bar':
        return { t: 'mover', base: this.parseArg(), over: mo('¯', { stretchy: false }), accent: true };
      case 'overline':
        return { t: 'mover', base: this.parseArg(), over: mo('‾', { stretchy: true }), accent: true };
      case 'underline':
        return { t: 'munder', base: this.parseArg(), under: mo('_', { stretchy: true }), accentunder: true };
      case 'hat':
        return { t: 'mover', base: this.parseArg(), over: mo('^', { stretchy: false }), accent: true };
      case 'widehat':
        return { t: 'mover', base: this.parseArg(), over: mo('^', { stretchy: true }), accent: true };
      case 'check':
        return { t: 'mover', base: this.parseArg(), over: mo('ˇ', { stretchy: false }), accent: true };
      case 'breve':
        return { t: 'mover', base: this.parseArg(), over: mo('˘', { stretchy: false }), accent: true };
      case 'tilde':
        return { t: 'mover', base: this.parseArg(), over: mo('~', { stretchy: false }), accent: true };
      case 'widetilde':
        return { t: 'mover', base: this.parseArg(), over: mo('~', { stretchy: true }), accent: true };
      case 'acute':
        return { t: 'mover', base: this.parseArg(), over: mo('´', { stretchy: false }), accent: true };
      case 'grave':
        return { t: 'mover', base: this.parseArg(), over: mo('`', { stretchy: false }), accent: true };
      case 'dot':
        return { t: 'mover', base: this.parseArg(), over: mo('˙', { stretchy: false }), accent: true };
      case 'ddot':
        return { t: 'mover', base: this.parseArg(), over: mo('¨', { stretchy: false }), accent: true };
      case 'dddot':
        return { t: 'mover', base: this.parseArg(), over: mo('‴', { stretchy: false }), accent: true };
      case 'overbrace':
        return { t: 'mover', base: this.parseArg(), over: mo('⏞', { stretchy: true }), accent: true };
      case 'underbrace':
        return { t: 'munder', base: this.parseArg(), under: mo('⏟', { stretchy: true }), accentunder: true };

      /* ---- 堆叠 ---- */
      case 'overset':
      case 'stackrel': {
        const over = this.parseArg();
        const base = this.parseArg();
        return { t: 'mover', base, over, accent: false };
      }
      case 'underset': {
        const under = this.parseArg();
        const base = this.parseArg();
        return { t: 'munder', base, under, accentunder: false };
      }
      case 'xrightarrow':
      case 'xleftarrow': {
        const under = this.trySkipOptional();
        const over = this.parseArg();
        const arrow = name === 'xrightarrow' ? '→' : '←';
        let base = mo(arrow, { stretchy: true });
        if (under !== null && under.trim() !== '') {
          base = { t: 'munder', base, under: row(this.parseInlineText(under)) };
        }
        return { t: 'mover', base, over, accent: false };
      }

      /* ---- 取反 ---- */
      case 'not':
        return this.parseNot();

      /* ---- 模运算 ---- */
      case 'bmod':
        return mo('mod', { lspace: '0.333em', rspace: '0.333em' });
      case 'pmod':
      case 'pod': {
        const body = this.parseArg();
        const isPod = name === 'pod';
        const out = [
          fence('(', 'prefix'),
          mo(isPod ? '' : 'mod', isPod ? {} : { lspace: '0em', rspace: '0.167em' }),
          body,
          fence(')', 'postfix'),
        ];
        return { t: 'mrow', children: out.filter(Boolean) };
      }

      /* ---- 外框 / 占位 ---- */
      case 'boxed':
        return { t: 'menclose', notation: 'box', children: [this.parseArg()] };
      case 'fbox':
        return { t: 'menclose', notation: 'box', children: [mtext(this.parseTextGroup())] };
      case 'phantom':
      case 'hphantom':
      case 'vphantom':
        return { t: 'mphantom', children: [this.parseArg()] };
      case 'hspace':
      case 'hskip':
      case 'kern':
      case 'mkern':
      case 'mskip':
        return this.parseSpaceArg();
      case 'textcolor':
      case 'color':
        this.parseArg();
        return this.parseArg();
      case 'mathchoice': {
        const first = this.parseArg();
        this.parseArg();
        this.parseArg();
        this.parseArg();
        return first;
      }
      case 'raisebox': {
        this.parseArg();
        return this.parseArg();
      }

      /* ---- 环境 ---- */
      case 'begin':
        return this.parseEnvironment();
      case 'end': {
        this.fail('\\end 没有配对的 \\begin', tk);
        const nm = this.parseTextGroup();
        return mtext('\\end{' + nm + '}');
      }
      case 'cr':
        return { t: 'mspace', linebreak: true };

      default:
        break;
    }

    if (PASSTHROUGH_COMMANDS.has(name)) {
      return this.parseArg();
    }

    /* ---- 未知命令：可见降级，绝不吞内容 ---- */
    this.fail('未知命令 \\' + name, tk);
    return mtext('\\' + name);
  }

  buildSymbol(sym) {
    const kind = sym[0];
    const text = sym[1];
    const extra = sym[2];
    switch (kind) {
      case 'mi':
        return mi(text, extra);
      case 'mo':
        return mo(text, typeof extra === 'object' && extra ? extra : undefined);
      case 'fn': {
        const node = mi(text, 'normal');
        node.func = true;
        return node;
      }
      case 'lim': {
        const node = mi(text, 'normal');
        node.limits = 'movable';
        return node;
      }
      case 'bigop':
        // 上下限由 munder / mover / munderover 显式表达，mo 本身不再加 largeop
        return mo(text, { bigop: true });
      case 'space':
        return mspace(text);
      case 'mtext':
        return mtext(text);
      case 'eat':
      default:
        return null;
    }
  }

  /** \not：优先用预组合字符，否则叠加组合斜线。 */
  parseNot() {
    const target = this.parseAtom();
    if (!target) return mo('¬');
    const t = stripMarkers(target);
    if (t.t === 'mo' && typeof t.text === 'string') {
      if (Object.prototype.hasOwnProperty.call(NEGATIONS, t.text)) return mo(NEGATIONS[t.text]);
      if (t.text.length <= 2) return mo(t.text + '\u0338');
    }
    if (t.t === 'mi' || t.t === 'mn') {
      return mo(t.text + '\u0338');
    }
    return { t: 'menclose', notation: 'updiagonalstrike', children: [t] };
  }

  /** \hspace{2em} / \kern2pt 之类：能识别就转成 mspace，否则安静吃掉或原样保留。 */
  parseSpaceArg() {
    if (this.trySkipOptional() !== null) return null;
    const open = this.peek();
    if (!open) return null;
    let text = '';
    if (open.t === '{') {
      // 花括号参数永远属于间距命令，无法识别时安静吃掉
      text = this.parseTextGroup();
    } else if (open.t === 'num') {
      // \kern2pt：裸数字 + 字母单位。只有整体合法时才消费 token，避免吞内容
      let j = this.i + 1;
      let unit = '';
      while (
        j < this.toks.length &&
        this.toks[j].t === 'char' &&
        LETTER_RE.test(this.toks[j].value)
      ) {
        unit += this.toks[j].value;
        j += 1;
      }
      if (!/^(em|ex|px|pt|pc|cm|mm|in|mu|rem)$/.test(unit)) return null;
      text = open.value + unit;
      this.i = j;
    } else {
      return null;
    }
    const m = /^\s*([0-9]*\.?[0-9]+)\s*(em|ex|px|pt|pc|cm|mm|in|mu|rem|%|)\s*$/.exec(text);
    if (!m) return null;
    const value = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(value)) return null;
    if (unit === 'mu') return mspace(value / 18 + 'em');
    if (unit === '') return null;
    if (unit === '%') return mspace(value / 100 + 'em');
    return mspace(value + unit);
  }

  /** 把一段纯文本（如 \sqrt 的可选参数）当数学解析。 */
  parseInlineText(text) {
    try {
      const sub = new Parser(lex(text), this.opts);
      sub.depth = this.depth + 1;
      return sub.parseSequence(null, false);
    } catch (err) {
      if (err instanceof LatexError && this.opts.strict === true) throw err;
      return [mtext(text)];
    }
  }

  /* ---------------- 定界符 ---------------- */

  parseDelimiter() {
    const tk = this.peek();
    if (!tk) return null;
    if (tk.t === 'space') {
      this.next();
      return this.parseDelimiter();
    }
    if (tk.t === 'char') {
      this.next();
      if (tk.value === '.') return null;
      return Object.prototype.hasOwnProperty.call(DELIMS, tk.value) ? DELIMS[tk.value] : tk.value;
    }
    if (tk.t === 'cmd') {
      this.next();
      if (tk.name === '.' || tk.name === '') return null;
      if (Object.prototype.hasOwnProperty.call(DELIMS, tk.name)) return DELIMS[tk.name];
      const sym = Object.prototype.hasOwnProperty.call(SYMBOLS, tk.name) ? SYMBOLS[tk.name] : null;
      if (sym && (sym[0] === 'mo' || sym[0] === 'mi')) return sym[1];
      return '\\' + tk.name;
    }
    if (tk.t === '{') {
      this.next();
      return '{';
    }
    if (tk.t === '}') return null;
    this.next();
    return null;
  }

  parseLeftRight(tk) {
    const left = this.parseDelimiter();
    const inner = this.parseSequence(
      (t) => t.t === 'cmd' && t.name === 'right',
      true,
    );
    let right = null;
    const close = this.peek();
    if (close && close.t === 'cmd' && close.name === 'right') {
      this.next();
      right = this.parseDelimiter();
    } else {
      this.fail('\\left 没有配对的 \\right', tk);
    }
    const children = [];
    if (left !== null) children.push(fence(left, 'prefix'));
    for (const node of inner) children.push(node);
    if (right !== null) children.push(fence(right, 'postfix'));
    return { t: 'mrow', children };
  }

  /* ---------------- 环境 ---------------- */

  parseEnvironment() {
    const name = this.parseTextGroup().trim();
    const env = Object.prototype.hasOwnProperty.call(ENVIRONMENTS, name) ? ENVIRONMENTS[name] : null;

    if (name === 'array' || name === 'tabular' || name.startsWith('array')) {
      this.parseTextGroup(); // 列格式说明，丢弃（列对齐用默认值）
    }

    const rows = [];
    let current = [];
    const isRowStop = (t) =>
      t.t === '&' ||
      t.t === 'rowbreak' ||
      (t.t === 'cmd' && (t.name === 'end' || t.name === 'cr'));

    for (;;) {
      const cell = this.parseSequence(isRowStop, true);
      current.push(cell);
      const tk = this.peek();
      if (tk && tk.t === '&') {
        this.next();
        continue;
      }
      if (tk && (tk.t === 'rowbreak' || (tk.t === 'cmd' && tk.name === 'cr'))) {
        this.next();
        this.trySkipOptional(); // \\[2pt]
        rows.push(current);
        current = [];
        continue;
      }
      if (tk && tk.t === 'cmd' && tk.name === 'end') {
        this.next();
        this.parseTextGroup();
        break;
      }
      // 遇到 EOF 或任何无法推进的 token 都必须跳出，否则会死循环
      this.fail('\\begin{' + name + '} 没有配对的 \\end', tk);
      break;
    }
    if (current.length > 0 && current.some((c) => c.length > 0)) rows.push(current);

    const table = {
      t: 'mtable',
      rows: rows.map((r) => r.map((cell) => ({ t: 'mrow', children: cell }))),
    };
    if (env && env.align) table.columnalign = env.align;
    if (rows.length === 0) table.rows = [[{ t: 'mrow', children: [] }]];

    if (env && env.open) {
      const children = [fence(env.open, 'prefix'), table];
      if (env.close) children.push(fence(env.close, 'postfix'));
      return { t: 'mrow', children };
    }
    return table;
  }
}

/** 合并同位置的重复上下标（x^2^n、f''' 之类），不抛错。 */
function mergeScript(old, add) {
  if (!add) return old;
  if (!old) return add;
  if (old.t === 'mo' && add.t === 'mo' && old.text === '′' && add.text === '′') {
    return mo('′'.repeat(old.text.length + 1));
  }
  return { t: 'mrow', children: [old, add] };
}

/** 去掉内部标记字段，避免污染渲染。 */
function stripMarkers(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.bigop === undefined && node.limits === undefined && node.func === undefined) return node;
  const out = Object.assign({}, node);
  delete out.bigop;
  delete out.limits;
  delete out.func;
  return out;
}

/** x^\circ 里的 \circ（∘ U+2218）要换成角度符号 °。 */
function normalizeDegree(node) {
  if (node && node.t === 'mo' && node.text === '∘') return mo('°');
  return node;
}

/* ========================================================================== *
 * 6. 渲染
 * ========================================================================== */

function renderNode(node) {
  if (!node || typeof node !== 'object') return '';
  switch (node.t) {
    case 'mrow':
      return '<mrow>' + (node.children || []).map(renderNode).join('') + '</mrow>';
    case 'mi':
      return '<mi' + attr('mathvariant', node.variant) + '>' + esc(node.text) + '</mi>';
    case 'mn':
      return '<mn' + attr('mathvariant', node.variant) + '>' + esc(node.text) + '</mn>';
    case 'mo':
      return (
        '<mo' +
        attr('mathvariant', node.variant) +
        attr('stretchy', node.stretchy) +
        attr('fence', node.fence) +
        attr('form', node.form) +
        attr('lspace', node.lspace) +
        attr('rspace', node.rspace) +
        attr('largeop', node.largeop) +
        attr('movablelimits', node.movablelimits) +
        '>' +
        esc(node.text) +
        '</mo>'
      );
    case 'mtext':
      return '<mtext' + attr('mathvariant', node.variant) + '>' + esc(node.text) + '</mtext>';
    case 'mspace':
      return (
        '<mspace' +
        attr('width', node.width) +
        attr('linebreak', node.linebreak ? 'newline' : undefined) +
        '></mspace>'
      );
    case 'msup':
      return '<msup>' + renderNode(node.base) + renderNode(node.sup) + '</msup>';
    case 'msub':
      return '<msub>' + renderNode(node.base) + renderNode(node.sub) + '</msub>';
    case 'msubsup':
      return (
        '<msubsup>' +
        renderNode(node.base) +
        renderNode(node.sub) +
        renderNode(node.sup) +
        '</msubsup>'
      );
    case 'munder':
      return '<munder>' + renderNode(node.base) + renderNode(node.under) + '</munder>';
    case 'mover':
      return (
        '<mover' +
        attr('accent', node.accent) +
        '>' +
        renderNode(node.base) +
        renderNode(node.over) +
        '</mover>'
      );
    case 'munderover':
      return (
        '<munderover>' +
        renderNode(node.base) +
        renderNode(node.sub) +
        renderNode(node.sup) +
        '</munderover>'
      );
    case 'mfrac':
      return (
        '<mfrac' +
        attr('linethickness', node.linethickness) +
        attr('bevelled', node.bevelled) +
        '>' +
        renderNode(node.num) +
        renderNode(node.den) +
        '</mfrac>'
      );
    case 'msqrt':
      return '<msqrt>' + (node.children || []).map(renderNode).join('') + '</msqrt>';
    case 'mroot':
      return '<mroot>' + renderNode(node.base) + renderNode(node.index) + '</mroot>';
    case 'mtable': {
      const rows = (node.rows || [])
        .map((r) => '<mtr>' + r.map((c) => '<mtd>' + renderNode(c) + '</mtd>').join('') + '</mtr>')
        .join('');
      return '<mtable' + attr('columnalign', node.columnalign) + '>' + rows + '</mtable>';
    }
    case 'mphantom':
      return '<mphantom>' + (node.children || []).map(renderNode).join('') + '</mphantom>';
    case 'menclose':
      return (
        '<menclose' +
        attr('notation', node.notation || 'box') +
        '>' +
        (node.children || []).map(renderNode).join('') +
        '</menclose>'
      );
    default:
      return '';
  }
}

/** 一串节点 → 单个 MathML 片段（多于一个时包 mrow）。 */
function renderSequence(nodes) {
  const list = (nodes || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return renderNode(list[0]);
  return '<mrow>' + list.map(renderNode).join('') + '</mrow>';
}

/* ========================================================================== *
 * 7. 输入归一化
 * ========================================================================== */

/** 任何输入都安全地变成字符串，永不抛错。 */
function toSourceString(src) {
  if (typeof src === 'string') return src;
  if (src === null || src === undefined) return '';
  if (typeof src === 'number') return Number.isFinite(src) ? String(src) : '';
  if (typeof src === 'boolean' || typeof src === 'bigint') return String(src);
  if (Array.isArray(src)) {
    let out = '';
    for (const item of src) {
      try {
        out += toSourceString(item);
      } catch (err) {
        /* 忽略单个元素失败 */
      }
    }
    return out;
  }
  try {
    return String(src);
  } catch (err) {
    return '';
  }
}

/* ========================================================================== *
 * 8. 公共 API
 * ========================================================================== */

/**
 * 把一段纯 LaTeX（不含 $ 定界符）编译成 MathML 字符串。
 * @param {unknown} src
 * @param {{display?: boolean, strict?: boolean}} [options]
 * @returns {string}
 */
export function latexToMathML(src, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const display = opts.display === true;
  const open = `<math xmlns="${MATHML_NS}" display="${display ? 'block' : 'inline'}">`;
  const source = toSourceString(src);

  let body = '';
  try {
    if (source.trim() === '') return open + '</math>';
    const parser = new Parser(lex(source), opts);
    const nodes = parser.parseSequence(null, false);
    body = renderSequence(nodes);
  } catch (err) {
    if (opts.strict === true && err instanceof LatexError) throw err;
    body = mtextOf(source);
  }
  return open + body + '</math>';
}

/** 兜底降级：把原始源码原样放进 <mtext>。 */
function mtextOf(source) {
  const safe = String(source).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return '<mtext>' + esc(safe) + '</mtext>';
}

function findDollar(s, from, block) {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2; // 跳过转义对：\$ 不是定界符
      continue;
    }
    if (c === '$') {
      if (block) {
        if (s[j + 1] === '$') return j;
        j += 1;
        continue;
      }
      return j;
    }
    j += 1;
  }
  return -1;
}

function findBracket(s, from, closeChar) {
  let j = from;
  while (j < s.length - 1) {
    if (s[j] === '\\') {
      if (s[j + 1] === closeChar) return j;
      j += 2;
      continue;
    }
    j += 1;
  }
  return -1;
}

/**
 * 富文本分词内核：把含内联公式的文本切成 text / math 片段。
 * 识别 $$...$$、\[...\]（display）与 $...$、\(...\)（inline）。
 * 未闭合的定界符按普通文本处理，永不抛错。
 * @param {unknown} text
 * @returns {Array<{kind:'text'|'math', value:string, display:boolean}>}
 */
export function splitRichText(text) {
  const out = [];
  let s;
  try {
    s = toSourceString(text);
  } catch (err) {
    s = '';
  }
  if (s === '') return out;

  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf !== '') {
      out.push({ kind: 'text', value: buf, display: false });
      buf = '';
    }
  };
  const pushMath = (value, display, consumedTo) => {
    flush();
    out.push({ kind: 'math', value, display });
    i = consumedTo;
  };

  while (i < s.length) {
    const c = s[i];

    if (c === '\\') {
      const n = s[i + 1];
      if (n === '[' || n === '(') {
        const closeChar = n === '[' ? ']' : ')';
        const end = findBracket(s, i + 2, closeChar);
        if (end >= 0) {
          const body = s.slice(i + 2, end);
          if (body.trim() !== '') {
            pushMath(body, n === '[', end + 2);
            continue;
          }
        }
      }
      if (n === '$') {
        buf += '\\$';
        i += 2;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '$') {
      if (s[i + 1] === '$') {
        const end = findDollar(s, i + 2, true);
        if (end >= 0) {
          const body = s.slice(i + 2, end);
          if (body.trim() !== '') {
            pushMath(body, true, end + 2);
            continue;
          }
        }
        buf += '$$';
        i += 2;
        continue;
      }
      const end = findDollar(s, i + 1, false);
      if (end >= 0) {
        const body = s.slice(i + 1, end);
        if (body.trim() !== '') {
          pushMath(body, false, end + 1);
          continue;
        }
      }
      buf += '$';
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** 文本片段：还原 \$ 转义后再做五字符 HTML 转义。 */
function escapeTextPart(value) {
  return esc(String(value).replace(/\\\$/g, '$'));
}

/**
 * 把含内联公式的普通文本渲染成可直接 innerHTML 的 HTML 片段。
 * @param {unknown} text
 * @param {{display?: boolean, strict?: boolean}} [options]
 * @returns {string}
 */
export function renderRichText(text, options) {
  const opts = options && typeof options === 'object' ? options : {};
  let parts;
  try {
    parts = splitRichText(text);
  } catch (err) {
    parts = [{ kind: 'text', value: toSourceString(text), display: false }];
  }
  let html = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      html += escapeTextPart(part.value);
      continue;
    }
    try {
      html += latexToMathML(part.value, { display: part.display === true, strict: opts.strict === true });
    } catch (err) {
      if (opts.strict === true) throw err;
      html += mtextOf(part.value);
    }
  }
  return html;
}

export default { latexToMathML, renderRichText, splitRichText, LatexError };
