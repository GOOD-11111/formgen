/**
 * formgen / 公式渲染层测试
 * 运行方式：
 *   cd formgen && node test/latex.test.js
 *   （若沙箱允许子进程，也可用 node --test test/latex.test.js）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  latexToMathML,
  renderRichText,
  splitRichText,
  LatexError,
} from '../src/latex/mathml.js';

/* ==========================================================================
 * 真实考卷题干样例（用作回归样本）
 * ========================================================================== */

const EXAM_ITEM = String.raw`【题干】已知函数 $f(x)=x^{2}+2x-3$，$g(x)=\dfrac{1}{2}x^{2}-x+1$。
（1）求 $f'(x)$，并解不等式 $f(x)\le 0$；
（2）若 $\forall x\in[-3,\,1]$，不等式 $f(x)\ge m$ 恒成立，求 $m$ 的取值范围；
（3）设 $\alpha,\beta$ 是方程 $f(x)=0$ 的两根，求 $\frac{1}{\alpha}+\frac{1}{\beta}$ 的值。
选项：A. $x\in[-3,1]$　B. $\left(-\infty,-3\right]\cup\left[1,+\infty\right)$
解析：$f'(x)=2x+2$，当 $x=-1$ 时取最小值 $f(-1)=-4$，故 $m\le -4$。
$$\sum_{n=1}^{\infty}\frac{1}{n^{2}}=\frac{\pi^{2}}{6}\qquad \lim_{x\to 0}\frac{\sin x}{x}=1$$`;

const OPEN = '<math xmlns="http://www.w3.org/1998/Math/MathML"';
const OPEN_INLINE = OPEN + ' display="inline">';
const OPEN_BLOCK = OPEN + ' display="block">';
const CLOSE = '</math>';

/* ==========================================================================
 * 测试基础设施：最小 XML 良构检查器
 * ========================================================================== */

const TAG_RE = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

/** 测试侧的最小 XML 转义，用于比对运算符字符。 */
function escXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/** 断言片段是良构 XML：标签配对、属性带引号、文本已转义。 */
function assertWellFormed(fragment, label) {
  assert.equal(typeof fragment, 'string', `${label}: 必须是字符串`);
  TAG_RE.lastIndex = 0;
  const stack = [];
  let last = 0;
  let m;
  const checkText = (text) => {
    if (text === '') return;
    assert.ok(!text.includes('<'), `${label}: 文本中出现未转义的 "<" → ${text}`);
    assert.ok(!text.includes('>'), `${label}: 文本中出现未转义的 ">" → ${text}`);
    const rest = text.replace(ENTITY_RE, '');
    assert.ok(!rest.includes('&'), `${label}: 文本中出现未转义的 "&" → ${text}`);
  };
  while ((m = TAG_RE.exec(fragment)) !== null) {
    checkText(fragment.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2];
    const selfClosing = m[4] === '/';
    if (selfClosing) continue;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `${label}: 结束标签 </${name}> 与 <${top}> 不匹配`);
    } else {
      stack.push(name);
    }
  }
  checkText(fragment.slice(last));
  assert.equal(stack.length, 0, `${label}: 存在未闭合标签 ${stack.join(',')}`);
  assert.ok(fragment.length > 0, `${label}: 片段不能为空`);
}

/** 取出 <math> 内部内容。 */
function body(src, options) {
  const html = latexToMathML(src, options);
  assert.ok(html.startsWith(OPEN), `输出必须以 <math 开头：${html}`);
  assert.ok(html.endsWith(CLOSE), `输出必须以 </math> 结尾：${html}`);
  return html.slice(html.indexOf('>') + 1, html.length - CLOSE.length);
}

/** 断言输出包含某片段，返回完整输出便于继续断言。 */
function includes(src, needle, options) {
  const html = latexToMathML(src, options);
  assert.ok(
    html.includes(needle),
    `latexToMathML(${JSON.stringify(src)}) 应包含 ${needle}\n实际：${html}`,
  );
  return html;
}

/** 断言输出不含某片段。 */
function excludes(src, needle, options) {
  const html = latexToMathML(src, options);
  assert.ok(
    !html.includes(needle),
    `latexToMathML(${JSON.stringify(src)}) 不应包含 ${needle}\n实际：${html}`,
  );
  return html;
}

/* ==========================================================================
 * 1. 基本契约
 * ========================================================================== */

test('基础：latexToMathML 输出带命名空间的 <math> 片段', () => {
  assert.equal(latexToMathML('x'), OPEN_INLINE + '<mi>x</mi>' + CLOSE);
  assert.equal(latexToMathML('x', { display: true }), OPEN_BLOCK + '<mi>x</mi>' + CLOSE);
  assert.equal(latexToMathML('x', { display: false }), OPEN_INLINE + '<mi>x</mi>' + CLOSE);
  assert.equal(body(''), '');
  assert.equal(body('   '), '');
});

test('基础：LatexError 是 Error 的子类', () => {
  const e = new LatexError('boom');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof LatexError);
  assert.equal(e.name, 'LatexError');
  assert.equal(e.message, 'boom');
});

test('基础：源码中不存在 eval / new Function', () => {
  const src = readFileSync(new URL('../src/latex/mathml.js', import.meta.url), 'utf8');
  assert.ok(!/\beval\s*\(/.test(src), '不允许出现 eval(');
  assert.ok(!/\bnew\s+Function\s*\(/.test(src), '不允许出现 new Function(');
  assert.ok(!/\bFunction\s*\(\s*['"`]/.test(src), '不允许出现 Function 构造器');
});

/* ==========================================================================
 * 2. 原子、分组、空格
 * ========================================================================== */

test('原子：数字、标识符、普通运算符', () => {
  assert.equal(body('12'), '<mn>12</mn>');
  assert.equal(body('3.14'), '<mn>3.14</mn>');
  assert.equal(body('a'), '<mi>a</mi>');
  includes('x+y', '<mo>+</mo>');
  includes('a-b', '<mo>−</mo>');
  includes('a=b', '<mo>=</mo>');
  includes('(a)', '<mo>(</mo>');
  includes('f(x)', '<mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo>');
});

test('分组：{...} 产生 mrow，单元素分组不额外包装', () => {
  assert.equal(body('{x}'), '<mi>x</mi>');
  assert.equal(body('{x+y}'), '<mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>');
  assert.equal(body('{}'), '<mrow></mrow>');
});

test('空格：\\ , \\, \\; \\quad \\qquad \\! 及数学模式空白', () => {
  includes('a\\ b', '<mspace width="0.333em"></mspace>');
  includes('a\\,b', '<mspace width="0.167em"></mspace>');
  includes('a\\;b', '<mspace width="0.278em"></mspace>');
  includes('a\\:b', '<mspace width="0.222em"></mspace>');
  includes('a\\quad b', '<mspace width="1em"></mspace>');
  includes('a\\qquad b', '<mspace width="2em"></mspace>');
  assert.equal(body('a \\! b'), '<mrow><mi>a</mi><mi>b</mi></mrow>');
});

/* ==========================================================================
 * 3. 上下标
 * ========================================================================== */

test('上下标：^ _ 与多字符参数', () => {
  assert.equal(body('x^2'), '<msup><mi>x</mi><mn>2</mn></msup>');
  assert.equal(body('a_i'), '<msub><mi>a</mi><mi>i</mi></msub>');
  assert.equal(
    body('x_i^2'),
    '<msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup>',
  );
  includes('x^{2n+1}', '<msup><mi>x</mi><mrow>');
  includes('x^{2n+1}', '<mi>n</mi><mo>+</mo><mn>1</mn>');
  includes('a_{i,j}', '<msub><mi>a</mi><mrow><mi>i</mi><mo>,</mo><mi>j</mi></mrow></msub>');
  includes('x^\\alpha', '<msup><mi>x</mi><mi>α</mi></msup>');
  // TeX 语义：x^12 等于 x^1 后面跟 2
  assert.equal(
    body('x^12'),
    '<mrow><msup><mi>x</mi><mn>1</mn></msup><mn>2</mn></mrow>',
  );
  includes('e^{-x}', '<mo>−</mo><mi>x</mi>');
});

test('上下标：撇号与 \\prime', () => {
  assert.equal(body("f'"), '<msup><mi>f</mi><mo>′</mo></msup>');
  assert.equal(body("f''"), '<msup><mi>f</mi><mo>′′</mo></msup>');
  assert.equal(body('f^{\\prime}'), '<msup><mi>f</mi><mo>′</mo></msup>');
  includes("f'(x)", '<msup><mi>f</mi><mo>′</mo></msup>');
});

/* ==========================================================================
 * 4. 分式与根式
 * ========================================================================== */

test('分式：\\frac \\dfrac \\tfrac \\cfrac 与无括号参数', () => {
  assert.equal(body('\\frac{a}{b}'), '<mfrac><mi>a</mi><mi>b</mi></mfrac>');
  assert.equal(body('\\dfrac{a}{b}'), '<mfrac><mi>a</mi><mi>b</mi></mfrac>');
  assert.equal(body('\\tfrac{a}{b}'), '<mfrac><mi>a</mi><mi>b</mi></mfrac>');
  assert.equal(body('\\cfrac{a}{b}'), '<mfrac><mi>a</mi><mi>b</mi></mfrac>');
  assert.equal(body('\\frac12'), '<mfrac><mn>1</mn><mn>2</mn></mfrac>');
  assert.equal(
    body('\\frac 1 2'),
    '<mfrac><mn>1</mn><mn>2</mn></mfrac>',
  );
  includes('\\frac{\\pi}{2}', '<mfrac><mi>π</mi><mn>2</mn></mfrac>');
});

test('分式：\\binom 使用无横线分式加圆括号', () => {
  const html = includes('\\binom{n}{k}', 'linethickness="0"');
  assert.ok(html.includes('form="prefix"'));
  assert.ok(html.includes('form="postfix"'));
  assert.ok(html.includes('<mi>n</mi>'));
  assert.ok(html.includes('<mi>k</mi>'));
});

test('根式：\\sqrt 与带次数的 \\sqrt[n]{}', () => {
  assert.equal(body('\\sqrt{x}'), '<msqrt><mi>x</mi></msqrt>');
  assert.equal(body('\\sqrt[3]{x}'), '<mroot><mi>x</mi><mn>3</mn></mroot>');
  includes('\\sqrt{x^{2}+1}', '<msqrt>');
  includes('\\sqrt[3]{8}', '<mroot><mn>8</mn><mn>3</mn></mroot>');
});

/* ==========================================================================
 * 5. 大运算符
 * ========================================================================== */

test('大运算符：\\sum \\prod \\int \\oint \\iint 的上下限走 munderover', () => {
  const sum = includes('\\sum_{n=1}^{\\infty}', '<munderover>');
  assert.ok(sum.includes('<mo>∑</mo>'));
  assert.ok(sum.includes('∞'));
  assert.equal(
    body('\\sum_{i=1}^{n}i'),
    '<mrow><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><mi>i</mi></mrow>',
  );
  includes('\\sum_{k=0}^{n}', '<mo>∑</mo>');
  includes('\\prod_{i=1}^{n}', '<mo>∏</mo>');
  includes('\\int_0^1', '<munderover><mo>∫</mo>');
  includes('\\oint_C', '<munder><mo>∮</mo>');
  includes('\\iint_D', '<munder><mo>∬</mo>');
  includes('\\bigcup_{i=1}^{n}', '<mo>⋃</mo>');
});

test('大运算符：\\lim 的极限走 munder', () => {
  const lim = includes('\\lim_{x\\to 0}', '<munder>');
  assert.ok(lim.includes('<mi mathvariant="normal">lim</mi>'));
  assert.ok(lim.includes('<mo>→</mo>'));
  includes('\\lim_{n\\to\\infty}a_n', '<munder>');
  includes('\\max_{x\\in A}', '<munder><mi mathvariant="normal">max</mi>');
  includes('\\sup_{n}', '<munder><mi mathvariant="normal">sup</mi>');
});

/* ==========================================================================
 * 6. 定界符
 * ========================================================================== */

test('定界符：\\left \\right 各种括号', () => {
  const p = includes('\\left(x\\right)', '<mo stretchy="true" fence="true" form="prefix">(</mo>');
  assert.ok(p.includes('<mo stretchy="true" fence="true" form="postfix">)</mo>'));
  includes('\\left[x\\right]', '>[</mo>');
  includes('\\left\\{x\\right\\}', '>{</mo>');
  includes('\\left|x\\right|', '>|</mo>');
  includes('\\left\\langle x\\right\\rangle', '>⟨</mo>');
  includes('\\left\\lvert x\\right\\rvert', '>|</mo>');
  includes('\\left\\lfloor x\\right\\rfloor', '>⌊</mo>');
  includes('\\left\\lceil x\\right\\rceil', '>⌈</mo>');
  const d = body('\\left.x\\right.');
  assert.equal(d, '<mrow><mi>x</mi></mrow>');
  includes('\\left(\\frac{a}{b}\\right)', '<mfrac>');
});

test('定界符：尺寸修饰 \\big \\Big \\bigg \\Bigg 只吃不报错', () => {
  assert.equal(body('\\big(x\\big)'), '<mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow>');
  assert.equal(body('\\Big[x\\Big]'), '<mrow><mo>[</mo><mi>x</mi><mo>]</mo></mrow>');
  includes('\\bigg\\{x\\bigg\\}', '<mi>x</mi>');
  includes('\\Biggl\\langle x\\Biggr\\rangle', '<mi>x</mi>');
  assertWellFormed(latexToMathML('\\bigl(\\Bigl[\\biggl\\{\\Biggl|x\\Biggr|\\biggr\\}\\Bigr]\\bigr)'), 'size-mods');
});

test('定界符：无 \\left 的普通括号与 \\langle 等', () => {
  includes('\\langle x,\\rangle', '<mo>⟨</mo>');
  includes('\\lVert x\\rVert', '<mo>‖</mo>');
  includes('\\{1,2\\}', '<mo>{</mo>');
});

/* ==========================================================================
 * 7. 希腊字母与符号表
 * ========================================================================== */

test('希腊字母：小写与大写', () => {
  const lower = {
    '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ϵ',
    '\\varepsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ', '\\vartheta': 'ϑ',
    '\\iota': 'ι', '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν',
    '\\xi': 'ξ', '\\pi': 'π', '\\rho': 'ρ', '\\varrho': 'ϱ', '\\sigma': 'σ',
    '\\varsigma': 'ς', '\\tau': 'τ', '\\upsilon': 'υ', '\\phi': 'ϕ', '\\varphi': 'φ',
    '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
  };
  for (const [cmd, ch] of Object.entries(lower)) {
    assert.equal(body(cmd), `<mi>${ch}</mi>`, `${cmd} 应渲染为 ${ch}`);
  }
  const upper = {
    '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ', '\\Xi': 'Ξ',
    '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Upsilon': 'Υ', '\\Phi': 'Φ', '\\Psi': 'Ψ',
    '\\Omega': 'Ω',
  };
  for (const [cmd, ch] of Object.entries(upper)) {
    assert.equal(body(cmd), `<mi mathvariant="normal">${ch}</mi>`, `${cmd} 应直排渲染为 ${ch}`);
  }
});

test('关系与运算符号表', () => {
  const table = {
    '\\ne': '≠', '\\neq': '≠', '\\lt': '<', '\\gt': '>', '\\le': '≤', '\\leq': '≤',
    '\\ge': '≥', '\\geq': '≥', '\\approx': '≈', '\\equiv': '≡', '\\sim': '∼',
    '\\simeq': '≃', '\\cong': '≅', '\\propto': '∝', '\\pm': '±', '\\mp': '∓',
    '\\times': '×', '\\div': '÷', '\\cdot': '⋅', '\\ast': '∗', '\\star': '⋆',
    '\\circ': '∘', '\\bullet': '∙', '\\oplus': '⊕', '\\otimes': '⊗', '\\infty': '∞',
    '\\partial': '∂', '\\nabla': '∇', '\\angle': '∠', '\\perp': '⊥', '\\parallel': '∥',
    '\\triangle': '△', '\\because': '∵', '\\therefore': '∴', '\\dots': '…',
    '\\ldots': '…', '\\cdots': '⋯', '\\vdots': '⋮', '\\ddots': '⋱',
  };
  for (const [cmd, ch] of Object.entries(table)) {
    const html = latexToMathML(cmd);
    const want = `>${escXml(ch)}</mo>`;
    assert.ok(html.includes(want) || html.includes(`>${escXml(ch)}</mi>`), `${cmd} → ${ch}（实际 ${html}）`);
  }
});

test('集合与逻辑符号表', () => {
  const table = {
    '\\in': '∈', '\\notin': '∉', '\\ni': '∋', '\\subset': '⊂', '\\subseteq': '⊆',
    '\\supset': '⊃', '\\supseteq': '⊇', '\\cup': '∪', '\\cap': '∩', '\\setminus': '∖',
    '\\emptyset': '∅', '\\varnothing': '∅', '\\forall': '∀', '\\exists': '∃',
    '\\nexists': '∄', '\\neg': '¬', '\\land': '∧', '\\lor': '∨', '\\implies': '⟹',
    '\\iff': '⟺', '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←',
    '\\leftrightarrow': '↔', '\\Rightarrow': '⇒', '\\Leftarrow': '⇐',
    '\\Leftrightarrow': '⇔', '\\mapsto': '↦', '\\uparrow': '↑', '\\downarrow': '↓',
  };
  for (const [cmd, ch] of Object.entries(table)) {
    assert.ok(latexToMathML(cmd).includes(`>${ch}</mo>`), `${cmd} → ${ch}`);
  }
});

/* ==========================================================================
 * 8. 字体、文本与函数名
 * ========================================================================== */

test('黑板体与正体/文本命令', () => {
  assert.equal(body('\\mathbb{R}'), '<mi mathvariant="double-struck">R</mi>');
  assert.equal(body('\\mathbb{N}'), '<mi mathvariant="double-struck">N</mi>');
  assert.equal(body('\\mathbb{Z}'), '<mi mathvariant="double-struck">Z</mi>');
  assert.equal(body('\\mathbb{Q}'), '<mi mathvariant="double-struck">Q</mi>');
  assert.equal(body('\\mathbb{C}'), '<mi mathvariant="double-struck">C</mi>');
  assert.equal(body('\\mathbb{P}'), '<mi mathvariant="double-struck">P</mi>');
  assert.equal(body('\\mathrm{d}'), '<mi mathvariant="normal">d</mi>');
  assert.equal(body('\\mathbf{v}'), '<mi mathvariant="bold">v</mi>');
  assert.equal(body('\\mathit{x}'), '<mi mathvariant="italic">x</mi>');
  assert.equal(body('\\mathsf{A}'), '<mi mathvariant="sans-serif">A</mi>');
  assert.equal(body('\\mathtt{x}'), '<mi mathvariant="monospace">x</mi>');
  assert.equal(body('\\mathcal{L}'), '<mi mathvariant="script">L</mi>');
  assert.equal(body('\\text{甲}'), '<mtext>甲</mtext>');
  assert.equal(body('\\textbf{甲}'), '<mtext mathvariant="bold">甲</mtext>');
  assert.equal(body('\\operatorname{arg max}'), '<mi mathvariant="normal">arg max</mi>');
});

test('中文与 Unicode 在 \\text 中原文保留', () => {
  assert.equal(body('\\text{当且仅当}'), '<mtext>当且仅当</mtext>');
  assert.equal(body('\\text{a<b}'), '<mtext>a&lt;b</mtext>');
  includes('\\text{速度 v}', '<mtext>速度 v</mtext>');
  // 数学模式里裸写中文也不丢内容
  includes('甲+乙', '<mtext>甲</mtext>');
});

test('函数名直排', () => {
  const fns = [
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'gcd', 'deg', 'arg',
    'max', 'min', 'sup', 'inf', 'lim',
  ];
  for (const fn of fns) {
    const html = latexToMathML(`\\${fn}`);
    assert.ok(
      html.includes(`<mi mathvariant="normal">${fn}</mi>`),
      `\\${fn} 应为直排函数名，实际 ${html}`,
    );
  }
  assert.equal(body('\\sin x'), '<mrow><mi mathvariant="normal">sin</mi><mi>x</mi></mrow>');
  includes('\\sin^{2}x', '<msup><mi mathvariant="normal">sin</mi>');
});

/* ==========================================================================
 * 9. 装饰
 * ========================================================================== */

test('装饰：向量、横线、帽子、点', () => {
  includes('\\vec{a}', '<mover accent="true"><mi>a</mi><mo stretchy="false">→</mo></mover>');
  includes('\\overrightarrow{AB}', '<mover accent="true">');
  includes('\\overrightarrow{AB}', '<mo stretchy="true">→</mo>');
  includes('\\bar{x}', '<mo stretchy="false">¯</mo>');
  includes('\\overline{AB}', '<mo stretchy="true">‾</mo>');
  includes('\\underline{x}', '<munder>');
  includes('\\hat{x}', '<mo stretchy="false">^</mo>');
  includes('\\widehat{AB}', '<mo stretchy="true">^</mo>');
  includes('\\tilde{x}', '<mo stretchy="false">~</mo>');
  includes('\\dot{x}', '<mo stretchy="false">˙</mo>');
  includes('\\ddot{x}', '<mo stretchy="false">¨</mo>');
  includes('\\overbrace{a+b}', '<mo stretchy="true">⏞</mo>');
  includes('\\underbrace{a+b}', '<mo stretchy="true">⏟</mo>');
});

/* ==========================================================================
 * 10. 单位与角度
 * ========================================================================== */

test('单位与角度：^\\circ、\\%、\\degree、\\prime', () => {
  includes('30^\\circ', '<msup><mn>30</mn><mo>°</mo></msup>');
  includes('90^{\\circ}', '<mo>°</mo>');
  includes('50\\%', '<mo>%</mo>');
  includes('\\degree', '<mo>°</mo>');
  includes("x'", '<mo>′</mo>');
  assert.equal(body('\\circ'), '<mo>∘</mo>');
});

/* ==========================================================================
 * 11. 矩阵与分段函数
 * ========================================================================== */

test('矩阵：matrix / pmatrix / bmatrix / vmatrix / Bmatrix', () => {
  const m = body('\\begin{matrix}a&b\\\\c&d\\end{matrix}');
  assert.ok(m.startsWith('<mtable>'), m);
  assert.equal((m.match(/<mtr>/g) || []).length, 2);
  assert.equal((m.match(/<mtd>/g) || []).length, 4);
  assert.ok(m.includes('<mi>d</mi>'));

  const p = includes('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', 'form="prefix"');
  assert.ok(p.includes('form="postfix"'));
  assert.ok(p.includes('<mtable>'));

  includes('\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}', '>[</mo>');
  includes('\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}', '>|</mo>');
  includes('\\begin{Bmatrix}a&b\\\\c&d\\end{Bmatrix}', '>{</mo>');
});

test('分段函数：cases 环境', () => {
  const c = includes('\\begin{cases}x^{2} & x\\ge 0\\\\-x & x<0\\end{cases}', 'columnalign="left left"');
  assert.ok(c.includes('form="prefix"'));
  assert.ok(c.includes('>{</mo>'));
  assert.equal((c.match(/<mtr>/g) || []).length, 2);
  assert.equal((c.match(/<mtd>/g) || []).length, 4);
});

test('矩阵：换行、\\hline、\\begin 不闭合的健壮性', () => {
  includes('\\begin{matrix}a\\\\b\\\\c\\end{matrix}', '<mi>c</mi>');
  includes('\\begin{matrix}\\hline a&b\\end{matrix}', '<mi>a</mi>');
  assertWellFormed(latexToMathML('\\begin{pmatrix}a&b'), 'unclosed-env');
  assertWellFormed(latexToMathML('\\begin{matrix}\\end{matrix}'), 'empty-env');
});

/* ==========================================================================
 * 12. 其它常考命令
 * ========================================================================== */

test('其它：\\displaystyle \\limits 被吃掉但不影响输出', () => {
  assert.equal(body('\\displaystyle\\sum_{i=1}^{n}'), body('\\sum_{i=1}^{n}'));
  assert.equal(body('\\sum\\limits_{i=1}^{n}'), body('\\sum_{i=1}^{n}'));
  assert.equal(body('\\textstyle x'), '<mi>x</mi>');
  assert.equal(body('\\nolimits x'), '<mi>x</mi>');
});

test('其它：\\not \\bmod \\pmod', () => {
  includes('\\not=', '<mo>≠</mo>');
  includes('\\not\\in', '<mo>∉</mo>');
  includes('a\\bmod b', '>mod</mo>');
  includes('a\\pmod{n}', '>mod</mo>');
  includes('a\\pmod{n}', '<mi>n</mi>');
});

test('其它：\\overset \\underset \\stackrel', () => {
  assert.equal(
    body('\\overset{a}{b}'),
    '<mover accent="false"><mi>b</mi><mi>a</mi></mover>',
  );
  includes('\\underset{a}{b}', '<munder>');
  includes('\\overset{\\text{def}}{=}', '<mover');
  includes('\\stackrel{\\triangle}{=}', '<mover');
});

test('其它：\\boxed \\phantom', () => {
  includes('\\boxed{x}', '<menclose notation="box"><mi>x</mi></menclose>');
  includes('\\phantom{abc}', '<mphantom>');
  const ph = body('\\phantom{x}');
  assert.ok(!ph.includes('<mi>x</mi>') === false || ph.includes('mphantom'));
  assertWellFormed(latexToMathML('\\boxed{\\frac{1}{2}}'), 'boxed');
});

/* ==========================================================================
 * 13. 富文本
 * ========================================================================== */

test('富文本：中英混排 + 行内/块级公式', () => {
  const html = renderRichText(EXAM_ITEM);
  assert.ok(html.includes('已知函数'), '中文原文应保留');
  assert.ok(html.includes('<math'), '应含 MathML');
  assert.ok(html.includes('display="inline"'), '应有行内公式');
  assert.ok(html.includes('display="block"'), '$$...$$ 应输出块级公式');
  assert.ok(html.includes('<msup><mi>f</mi><mo>′</mo></msup>'), "f'(x) 应正确编译");
  assert.ok(html.includes('<mtable>') === false, '本例不含矩阵');
  assertWellFormed(html, 'EXAM_ITEM');
});

test('富文本：四种定界符', () => {
  assert.equal(
    renderRichText('a $x$ b'),
    `a ${OPEN_INLINE}<mi>x</mi>${CLOSE} b`,
  );
  assert.equal(
    renderRichText('a \\(x\\) b'),
    `a ${OPEN_INLINE}<mi>x</mi>${CLOSE} b`,
  );
  assert.equal(
    renderRichText('a $$x$$ b'),
    `a ${OPEN_BLOCK}<mi>x</mi>${CLOSE} b`,
  );
  assert.equal(
    renderRichText('a \\[x\\] b'),
    `a ${OPEN_BLOCK}<mi>x</mi>${CLOSE} b`,
  );
});

test('富文本：反斜杠转义的 \\$ 不是定界符', () => {
  assert.equal(renderRichText('价格 \\$5'), '价格 $5');
  const parts = splitRichText('价格 \\$5');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'text');
  assert.equal(parts[0].value, '价格 \\$5');
  assert.equal(renderRichText('\\$a\\$ 与 $b$'), `$a$ 与 ${OPEN_INLINE}<mi>b</mi>${CLOSE}`);
});

test('富文本：HTML 转义', () => {
  assert.equal(renderRichText('a<b & c'), 'a&lt;b &amp; c');
  assert.equal(renderRichText('1 < 2 > 0'), '1 &lt; 2 &gt; 0');
  assert.equal(renderRichText('他说"好"'), '他说&quot;好&quot;');
  assert.equal(renderRichText("it's"), 'it&#39;s');
  assert.equal(renderRichText('x < y 且 $a<b$'), 'x &lt; y 且 ' + OPEN_INLINE + '<mrow><mi>a</mi><mo>&lt;</mo><mi>b</mi></mrow>' + CLOSE);
  assert.equal(renderRichText(''), '');
});

test('富文本：未闭合定界符按文本处理，不抛错', () => {
  assert.equal(renderRichText('只有 $ 一个'), '只有 $ 一个');
  assert.equal(renderRichText('没有结束 $$x'), '没有结束 $$x');
  // 未闭合的 \[ \( 无法判定为公式，反斜杠原样保留（只有 \$ 会被还原成 $）
  assert.equal(renderRichText('\\[x'), '\\[x');
  assert.equal(renderRichText('a\\(b'), 'a\\(b');
  assert.equal(renderRichText('\\$ 与 $x$ 混排'), '$ 与 ' + OPEN_INLINE + '<mi>x</mi>' + CLOSE + ' 混排');
});

/* ==========================================================================
 * 14. splitRichText 分词
 * ========================================================================== */

test('splitRichText：分词结果正确', () => {
  assert.deepEqual(splitRichText(''), []);
  assert.deepEqual(splitRichText(null), []);
  assert.deepEqual(splitRichText(undefined), []);
  assert.deepEqual(splitRichText('abc'), [{ kind: 'text', value: 'abc', display: false }]);
  assert.deepEqual(splitRichText('$x$'), [{ kind: 'math', value: 'x', display: false }]);
  assert.deepEqual(splitRichText('$$x$$'), [{ kind: 'math', value: 'x', display: true }]);
  assert.deepEqual(splitRichText('\\(x\\)'), [{ kind: 'math', value: 'x', display: false }]);
  assert.deepEqual(splitRichText('\\[x\\]'), [{ kind: 'math', value: 'x', display: true }]);
  assert.deepEqual(splitRichText('解 $x^2$ 得'), [
    { kind: 'text', value: '解 ', display: false },
    { kind: 'math', value: 'x^2', display: false },
    { kind: 'text', value: ' 得', display: false },
  ]);
  assert.deepEqual(splitRichText('$$a$$ 和 $b$'), [
    { kind: 'math', value: 'a', display: true },
    { kind: 'text', value: ' 和 ', display: false },
    { kind: 'math', value: 'b', display: false },
  ]);
  // 公式内部的 \$ 不结束公式
  assert.deepEqual(splitRichText('$a\\$b$c'), [
    { kind: 'math', value: 'a\\$b', display: false },
    { kind: 'text', value: 'c', display: false },
  ]);
});

/* ==========================================================================
 * 15. 健壮性（属性测试）
 * ========================================================================== */

const HOSTILE_INPUTS = [
  '',
  ' ',
  '\n\t',
  null,
  undefined,
  0,
  42,
  -1,
  true,
  false,
  NaN,
  {},
  [],
  Symbol('s'),
  () => {},
  '\\frac{',
  '\\frac{}{}',
  '\\frac',
  '{{{{',
  '}}}}',
  '{{{x}',
  '$',
  '$$',
  '$$$$',
  '\\',
  '\\\\',
  '\\unknowncmd{x}',
  '\\unknowncmd',
  '\\foo\\bar\\baz{1}{2}',
  '\\begin{matrix}',
  '\\end{matrix}',
  '\\right)',
  '\\left(',
  '^{2}',
  '_{}',
  'x^',
  'x_',
  '^',
  '_',
  '&',
  '\\text{',
  '\\text',
  '\\sqrt[',
  '\\left\\{',
  '\\begin{}',
  '\\begin{cases}a',
  '😀🎉',
  '\u0000\u0001',
  'a'.repeat(20000),
  '{'.repeat(200) + 'x' + '}'.repeat(200),
  '\\frac{'.repeat(60) + 'x',
  'x^' + '{2}'.repeat(50),
  '\\begin{pmatrix}' + 'a&b\\\\'.repeat(30) + '\\end{pmatrix}',
];

test('健壮性：任何输入都返回字符串且不抛错', () => {
  for (const input of HOSTILE_INPUTS) {
    let out;
    assert.doesNotThrow(() => {
      out = latexToMathML(input);
    }, `latexToMathML(${String(input).slice(0, 40)}) 不应抛错`);
    assert.equal(typeof out, 'string', '输出必须是字符串');
    assert.ok(out.startsWith(OPEN), `输出必须以 <math 开头：${out.slice(0, 80)}`);
    assert.ok(out.endsWith(CLOSE), '输出必须以 </math> 结尾');
    assertWellFormed(out, `latexToMathML(${String(input).slice(0, 30)})`);
  }
});

test('健壮性：renderRichText / splitRichText 对畸形输入不抛错', () => {
  for (const input of HOSTILE_INPUTS) {
    assert.doesNotThrow(() => renderRichText(input), `renderRichText 不应抛错`);
    assert.doesNotThrow(() => splitRichText(input), `splitRichText 不应抛错`);
    assert.equal(typeof renderRichText(input), 'string');
    assert.ok(Array.isArray(splitRichText(input)));
  }
  assert.equal(renderRichText(null), '');
  assert.equal(renderRichText(undefined), '');
  assert.equal(renderRichText(123), '123');
});

test('健壮性：未知命令降级为可见字面量且不吞内容', () => {
  const html = includes('\\unknowncmd{x}', '<mtext>\\unknowncmd</mtext>');
  assert.ok(html.includes('<mi>x</mi>'), '未知命令后的分组内容必须保留');
  const multi = latexToMathML('a \\foo b \\qux{c} d');
  assert.ok(multi.includes('\\foo'));
  assert.ok(multi.includes('\\qux'));
  assert.ok(multi.includes('<mi>a</mi>') && multi.includes('<mi>d</mi>'));
  assert.ok(multi.includes('<mi>c</mi>'));
  // 未知命令不带花括号时同样可见
  assert.ok(latexToMathML('\\zzz').includes('\\zzz'));
});

test('健壮性：深层嵌套 200 层不爆栈且保留内容', () => {
  const deep = '{'.repeat(200) + 'x' + '}'.repeat(200);
  const html = latexToMathML(deep);
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('<mi>x</mi>'), '深层嵌套内容不能丢失');
  assertWellFormed(html, 'deep-200');
  const deeper = '{'.repeat(2000) + 'y' + '}'.repeat(2000);
  assert.doesNotThrow(() => latexToMathML(deeper));
  assert.equal(typeof latexToMathML(deeper), 'string');
});

test('健壮性：超长输入线性处理', () => {
  const long = Array.from({ length: 3000 }, (_, i) => `x_{${i}}`).join('+');
  const html = latexToMathML(long);
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 3000);
  assertWellFormed(html, 'long');
});

test('健壮性：确定性随机 fuzz（固定种子，属性断言）', () => {
  const PIECES = [
    '\\frac', '{', '}', '^', '_', '\\sqrt[', ']', '\\left', '\\right', '\\begin{matrix}',
    '\\end{matrix}', '&', '\\\\', '\\text{', '$', '$$', '\\[', '\\(', 'x', '1', '12', '.',
    '+', '-', '=', '<', '\\alpha', '\\unknowncmd', '\\bar', '\\not', '|', '\\hspace{1cm}',
    '\\kern2pt', '\\limits', '\\sum', '\\overset', '~', '%', '#', '\\,', '\\quad', ' ',
    '中', '文', '😀', '\\mathbb{R}', '\\operatorname{arg max}', '\\phantom', "'", '\\',
  ];
  let seed = 20240607;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 3000; i += 1) {
    const n = Math.floor(rnd() * 18);
    let src = '';
    for (let k = 0; k < n; k += 1) src += PIECES[Math.floor(rnd() * PIECES.length)];
    let out;
    assert.doesNotThrow(() => {
      out = latexToMathML(src, { display: rnd() > 0.5 });
    }, `fuzz 输入不应抛错：${JSON.stringify(src)}`);
    assert.equal(typeof out, 'string');
    assert.ok(out.startsWith(OPEN) && out.endsWith(CLOSE));
    assertWellFormed(out, `fuzz:${JSON.stringify(src).slice(0, 60)}`);
    assert.doesNotThrow(() => renderRichText(src));
    assert.doesNotThrow(() => splitRichText(src));
  }
});

test('严格模式：仅显式 strict 时才抛 LatexError', () => {
  assert.doesNotThrow(() => latexToMathML('\\unknowncmd{x}'));
  assert.throws(() => latexToMathML('\\unknowncmd{x}', { strict: true }), LatexError);
  assert.throws(() => latexToMathML('\\frac{', { strict: true }), LatexError);
  assert.throws(() => latexToMathML('}', { strict: true }), LatexError);
  assert.throws(() => latexToMathML('\\left(x', { strict: true }), LatexError);
  assert.doesNotThrow(() => latexToMathML('x^2', { strict: true }));
});

/* ==========================================================================
 * 16. 输出合法性抽查
 * ========================================================================== */

test('补充：\\hspace \\middle \\xrightarrow 等长尾命令', () => {
  includes('\\hspace{1cm}x', '<mspace width="1cm"></mspace>');
  includes('\\hspace{2em}x', '<mspace width="2em"></mspace>');
  includes('\\kern2pt x', '<mspace width="2pt"></mspace>');
  assert.equal(body('\\hspace{abc}x'), '<mi>x</mi>');
  includes('\\left(x\\middle|y\\right)', '<mo stretchy="true">|</mo>');
  includes('\\xrightarrow{f}', '<mover accent="false"><mo stretchy="true">→</mo><mi>f</mi></mover>');
  includes('\\xleftarrow{g}', '<mo stretchy="true">←</mo>');
  includes('\\text{a\\{b\\}c}', '<mtext>a{b}c</mtext>');
  includes('\\text{中文 $x$}', '<mtext>中文 $x$</mtext>');
  includes('\\overbrace{a+b}^{n}', '<mo stretchy="true">⏞</mo>');
  includes('\\begin{aligned}a&=b\\\\c&=d\\end{aligned}', 'columnalign="right left"');
});

test('补充：考卷题干端到端渲染可直接 innerHTML', () => {
  const html = renderRichText(EXAM_ITEM);
  assertWellFormed(html, 'EXAM_ITEM-e2e');
  // 中英混排、行内、块级、矩阵、集合、极限都要出现
  assert.ok(html.includes('的取值范围'));
  assert.ok(html.includes('<mfrac>'));
  assert.ok(html.includes('<munderover>'));
  assert.ok(html.includes('<msqrt>') === false, '本例无根式');
  assert.ok(html.includes('display="block"'));
  assert.ok(!html.includes('\\le'), '公式不应残留 LaTeX 源码');
  assert.ok(!html.includes('\\frac'), '公式不应残留 LaTeX 源码');
  assert.ok(!/<\s*mrow\s*\/>/.test(html), '不产生自闭合标签');
});

test('输出合法性：一组真实公式的 MathML 都良构', () => {
  const samples = [
    'f(x)=x^{2}+2x-3',
    "f'(x)=2x+2",
    '\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}',
    '\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}}=\\frac{\\pi^{2}}{6}',
    '\\int_{0}^{1}x^{2}\\,dx=\\frac{1}{3}',
    '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1',
    '\\left(\\frac{a}{b}\\right)^{n}',
    '\\begin{cases}x^{2},&x\\ge 0\\\\-x,&x<0\\end{cases}',
    '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}^{-1}',
    '\\forall\\varepsilon>0,\\ \\exists\\delta>0',
    'A\\cup B=\\{x\\mid x\\in A\\ \\text{或}\\ x\\in B\\}',
    '\\vec{a}\\cdot\\vec{b}=|\\vec{a}||\\vec{b}|\\cos\\theta',
    '\\overline{AB}\\parallel\\overline{CD}',
    '\\binom{n}{k}=\\frac{n!}{k!(n-k)!}',
    '\\sqrt[3]{-27}=-3',
    '\\mathbb{R}^{n}\\to\\mathbb{R}^{m}',
    '\\alpha\\beta\\gamma\\ \\Gamma\\Delta\\Theta',
    '\\boxed{\\frac{1}{2}}',
    '\\overset{\\text{def}}{=}',
    '\\frac{\\partial z}{\\partial x}',
    'x\\not= y',
    '\\text{当 }x>0\\text{ 时}',
  ];
  for (const s of samples) {
    assertWellFormed(latexToMathML(s, { display: true }), s);
    assertWellFormed(renderRichText(`题：$${s}$ 结束`), `rich:${s}`);
  }
});

test('输出合法性：属性一律双引号且无裸标签', () => {
  const html = latexToMathML('\\left(\\frac{\\sum_{i=1}^{n}x_{i}}{n}\\right)^{2}');
  assert.ok(html.includes('xmlns="http://www.w3.org/1998/Math/MathML"'));
  const tags = html.match(/<[^>]*>/g) || [];
  assert.ok(tags.length >= 10, `应识别出足够多的标签，实际 ${tags.length}`);
  const strictTag = /^<\/?[a-zA-Z][\w:.-]*(?:\s+[\w:.-]+="[^"]*")*\s*\/?>$/;
  for (const tag of tags) {
    assert.match(tag, strictTag, `标签 ${tag} 的属性必须全部加双引号`);
  }
  assertWellFormed(html, 'attrs');
});
