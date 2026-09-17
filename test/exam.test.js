/**
 * 考卷场景内核测试：蓝图构建（blueprint.js） + 自适应组卷（select.js）
 * 运行：node test/exam.test.js   （node:test 在进程内执行）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBlueprint,
  describeBlueprint,
  normalizeType,
  difficultyToNumber,
  ExamError,
  EXAM_ERROR_CODES,
} from '../src/exam/blueprint.js';
import {
  selectQuestions,
  coverageReport,
  createRng,
  DEFAULT_SEED,
} from '../src/exam/select.js';

/* ==================================================================== *
 * 测试题库（自建，48 道）
 * ==================================================================== */

const FUNC = '函数与导数';
const TRIG = '三角函数';
const SEQ = '数列';
const PROB = '概率统计';
const CONIC = '解析几何';

const SCORE_BY_TYPE = { choice: 5, blank: 5, solve: 10, judge: 2 };

/**
 * 造题辅助。
 * @param {string} id
 * @param {'choice'|'blank'|'solve'|'judge'} type
 * @param {number} difficulty 0..1
 * @param {string[]} knowledge
 * @param {string} stem 可含 $...$ LaTeX
 */
function q(id, type, difficulty, knowledge, stem, options, answer, analysis) {
  const item = {
    id,
    type,
    stem,
    score: SCORE_BY_TYPE[type],
    difficulty,
    knowledge,
    source: 'exam-fixture',
  };
  if (options) item.options = options;
  if (answer !== undefined) item.answer = answer;
  if (analysis) item.analysis = analysis;
  return item;
}

/** 48 道题：choice 20 / blank 12 / solve 12 / judge 4，难度 0.1~0.95，多知识点，题干含 LaTeX。 */
const BANK = [
  // ---------------- 选择题 20 ----------------
  q('c01', 'choice', 0.15, [FUNC], '已知 $f(x)=x^{2}-2x$，则 $f(1)=$（　）',
    ['$-1$', '$0$', '$1$', '$2$'], 'A', '代入得 $1-2=-1$。'),
  q('c02', 'choice', 0.35, [FUNC], '函数 $y=\\ln(x-1)$ 的定义域是（　）',
    ['$(0,+\\infty)$', '$(1,+\\infty)$', '$[1,+\\infty)$', '$(-\\infty,1)$'], 'B', '真数大于零。'),
  q('c03', 'choice', 0.45, [FUNC], '函数 $f(x)=x^{3}-3x$ 的极小值为（　）',
    ['$-2$', '$0$', '$2$', '$-1$'], 'A', "$f'(x)=3x^{2}-3$，$x=1$ 处取极小值 $-2$。"),
  q('c04', 'choice', 0.6, [FUNC], '$\\int_{0}^{1} 2x\\,\\mathrm{d}x=$（　）',
    ['$0$', '$1$', '$2$', '$\\dfrac{1}{2}$'], 'B', '原函数 $x^{2}$，代入得 $1$。'),
  q('c05', 'choice', 0.3, [TRIG], '$\\sin 150^{\\circ}=$（　）',
    ['$\\dfrac{1}{2}$', '$-\\dfrac{1}{2}$', '$\\dfrac{\\sqrt{3}}{2}$', '$-\\dfrac{\\sqrt{3}}{2}$'], 'A',
    '$\\sin 150^{\\circ}=\\sin 30^{\\circ}=\\dfrac{1}{2}$。'),
  q('c06', 'choice', 0.4, [TRIG], '函数 $y=2\\sin\\left(2x+\\dfrac{\\pi}{6}\\right)$ 的最小正周期是（　）',
    ['$\\dfrac{\\pi}{2}$', '$\\pi$', '$2\\pi$', '$4\\pi$'], 'B', '$T=\\dfrac{2\\pi}{2}=\\pi$。'),
  q('c07', 'choice', 0.5, [TRIG], '已知 $\\cos\\alpha=\\dfrac{3}{5}$，$\\alpha\\in\\left(0,\\dfrac{\\pi}{2}\\right)$，则 $\\sin\\alpha=$（　）',
    ['$\\dfrac{4}{5}$', '$-\\dfrac{4}{5}$', '$\\dfrac{3}{4}$', '$\\dfrac{5}{4}$'], 'A',
    '同角关系 $\\sin^{2}\\alpha=1-\\dfrac{9}{25}=\\dfrac{16}{25}$。'),
  q('c08', 'choice', 0.65, [TRIG], '在 $\\triangle ABC$ 中，$a=2$，$b=\\sqrt{3}$，$C=30^{\\circ}$，则 $c=$（　）',
    ['$1$', '$\\sqrt{2}$', '$\\sqrt{3}$', '$2$'], 'A',
    '余弦定理 $c^{2}=4+3-2\\cdot 2\\sqrt{3}\\cdot\\dfrac{\\sqrt{3}}{2}=1$。'),
  q('c09', 'choice', 0.35, [SEQ], '等差数列 $\\{a_n\\}$ 中 $a_1=1$，$d=2$，则 $a_5=$（　）',
    ['$7$', '$8$', '$9$', '$11$'], 'C', '$a_5=a_1+4d=9$。'),
  q('c10', 'choice', 0.45, [SEQ], '等比数列 $2,6,18,\\cdots$ 的第 4 项是（　）',
    ['$36$', '$54$', '$72$', '$108$'], 'B', '公比 $q=3$，$a_4=2\\times 3^{3}=54$。'),
  q('c11', 'choice', 0.55, [SEQ], '等差数列前 $n$ 项和 $S_n=n^{2}+2n$，则 $a_3=$（　）',
    ['$5$', '$7$', '$9$', '$11$'], 'B', '$a_3=S_3-S_2=15-8=7$。'),
  q('c12', 'choice', 0.7, [SEQ], '数列 $\\left\\{\\dfrac{1}{n(n+1)}\\right\\}$ 的前 $n$ 项和为（　）',
    ['$\\dfrac{n}{n+1}$', '$\\dfrac{1}{n+1}$', '$\\dfrac{n+1}{n}$', '$1-\\dfrac{1}{n}$'], 'A',
    '裂项相消得 $\\dfrac{n}{n+1}$。'),
  q('c13', 'choice', 0.3, [PROB], '从 5 个不同小球中任取 2 个，不同取法共有（　）',
    ['$10$ 种', '$20$ 种', '$25$ 种', '$5$ 种'], 'A', '$C_5^{2}=10$。'),
  q('c14', 'choice', 0.45, [PROB], '抛掷两枚均匀硬币，恰有一枚正面向上的概率是（　）',
    ['$\\dfrac{1}{4}$', '$\\dfrac{1}{3}$', '$\\dfrac{1}{2}$', '$\\dfrac{3}{4}$'], 'C', '基本事件 4 个，符合条件 2 个。'),
  q('c15', 'choice', 0.55, [PROB], '一组数据 $2,3,3,5,7$ 的中位数是（　）',
    ['$2$', '$3$', '$4$', '$5$'], 'B', '排序后第三个数为 $3$。'),
  q('c16', 'choice', 0.65, [PROB], '若事件 $A$、$B$ 相互独立，$P(A)=0.4$，$P(B)=0.5$，则 $P(AB)=$（　）',
    ['$0.1$', '$0.2$', '$0.45$', '$0.9$'], 'B', '独立事件乘法公式。'),
  q('c17', 'choice', 0.4, [CONIC], '椭圆 $\\dfrac{x^{2}}{9}+\\dfrac{y^{2}}{4}=1$ 的焦距为（　）',
    ['$2\\sqrt{5}$', '$\\sqrt{5}$', '$5$', '$2\\sqrt{13}$'], 'A', '$c=\\sqrt{9-4}=\\sqrt{5}$，焦距 $2c=2\\sqrt{5}$。'),
  q('c18', 'choice', 0.5, [CONIC], '双曲线 $\\dfrac{x^{2}}{4}-\\dfrac{y^{2}}{5}=1$ 的渐近线方程是（　）',
    ['$y=\\pm\\dfrac{1}{2}x$', '$y=\\pm\\dfrac{\\sqrt{5}}{2}x$', '$y=\\pm\\dfrac{2}{\\sqrt{5}}x$', '$y=\\pm 2x$'], 'B',
    '渐近线 $y=\\pm\\dfrac{b}{a}x$。'),
  q('c19', 'choice', 0.6, [CONIC], '抛物线 $y^{2}=8x$ 的准线方程是（　）',
    ['$x=-2$', '$x=2$', '$y=-2$', '$x=-4$'], 'A', '$2p=8$，$p=4$，准线 $x=-2$。'),
  q('c20', 'choice', 0.75, [CONIC], '直线 $y=x+1$ 与圆 $x^{2}+y^{2}=1$ 的公共点个数是（　）',
    ['$0$ 个', '$1$ 个', '$2$ 个', '无法确定'], 'C', '圆心到直线距离 $\\dfrac{\\sqrt{2}}{2}<1$。'),
  // ---------------- 填空题 12 ----------------
  q('b01', 'blank', 0.3, [FUNC], '若 $f(x)=2x+1$，则 $f^{-1}(3)=$ ＿＿＿＿．', null, '1', '令 $2x+1=3$。'),
  q('b02', 'blank', 0.7, [FUNC], '曲线 $y=x^{3}$ 在点 $(1,1)$ 处切线的斜率为 ＿＿＿＿．', null, '3', "$y'=3x^{2}$。"),
  q('b03', 'blank', 0.4, [TRIG], '$\\tan 45^{\\circ}+\\cos 60^{\\circ}=$ ＿＿＿＿．', null, '$\\dfrac{3}{2}$', '$1+\\dfrac{1}{2}$。'),
  q('b04', 'blank', 0.6, [TRIG], '$\\sin x+\\cos x$ 的最大值是 ＿＿＿＿．', null, '$\\sqrt{2}$', '辅助角公式。'),
  q('b05', 'blank', 0.4, [SEQ], '等差数列 $3,7,11,\\cdots$ 的第 10 项是 ＿＿＿＿．', null, '39', '$a_{10}=3+9\\times 4$。'),
  q('b06', 'blank', 0.65, [SEQ], '等比数列 $\\{a_n\\}$ 中 $a_1=2$，$q=3$，则 $S_3=$ ＿＿＿＿．', null, '26', '$\\dfrac{2(3^{3}-1)}{2}$。'),
  q('b07', 'blank', 0.35, [PROB], '从 $1,2,3,4$ 中任取两个不同的数，其和为 $5$ 的概率是 ＿＿＿＿．', null,
    '$\\dfrac{1}{3}$', '符合条件的有 $(1,4),(2,3)$。'),
  q('b08', 'blank', 0.5, [PROB], '若 $X\\sim B(10,0.3)$，则 $E(X)=$ ＿＿＿＿．', null, '3', '$E(X)=np$。'),
  q('b09', 'blank', 0.7, [PROB], '已知 $P(A)=0.5$，$P(AB)=0.2$，则 $P(B\\mid A)=$ ＿＿＿＿．', null, '0.4', '条件概率公式。'),
  q('b10', 'blank', 0.45, [CONIC], '椭圆 $\\dfrac{x^{2}}{25}+\\dfrac{y^{2}}{9}=1$ 的右焦点坐标是 ＿＿＿＿．', null,
    '$(4,0)$', '$c=\\sqrt{25-9}=4$。'),
  q('b11', 'blank', 0.55, [CONIC], '圆 $x^{2}+y^{2}=4$ 上的点到直线 $x+y-4=0$ 距离的最大值是 ＿＿＿＿．', null,
    '$2+2\\sqrt{2}$', '圆心到直线距离 $2\\sqrt{2}$ 加半径 $2$。'),
  q('b12', 'blank', 0.8, [CONIC], '双曲线 $\\dfrac{x^{2}}{a^{2}}-y^{2}=1$ 的离心率为 $\\sqrt{2}$，则 $a=$ ＿＿＿＿．', null,
    '1', '$e^{2}=1+\\dfrac{1}{a^{2}}=2$。'),
  // ---------------- 解答题 12 ----------------
  q('s01', 'solve', 0.5, [FUNC], '已知函数 $f(x)=x^{3}-3x^{2}+2$．（1）求 $f\'(x)$；（2）求 $f(x)$ 的单调区间与极值．',
    null, '极小值 $f(2)=-2$，极大值 $f(0)=2$', "$f'(x)=3x^{2}-6x$。"),
  q('s02', 'solve', 0.65, [FUNC], '已知曲线 $y=x^{3}+ax$ 在 $x=1$ 处的切线斜率为 $4$，求 $a$ 及切线方程．',
    null, '$a=1$，切线 $y=4x-2$', "$y'=3x^{2}+a$。"),
  q('s03', 'solve', 0.85, [FUNC], '设函数 $f(x)=\\ln x-ax$，讨论 $f(x)$ 的单调性并求其最大值．',
    null, '在 $x=\\dfrac{1}{a}$ 处取最大值 $-\\ln a-1$', '含参数分类讨论。'),
  q('s04', 'solve', 0.55, [TRIG], '已知 $\\sin\\alpha=\\dfrac{4}{5}$，$\\alpha\\in\\left(\\dfrac{\\pi}{2},\\pi\\right)$，求 $\\sin 2\\alpha$ 与 $\\cos 2\\alpha$．',
    null, '$\\sin 2\\alpha=-\\dfrac{24}{25}$，$\\cos 2\\alpha=\\dfrac{7}{25}$', '二倍角公式。'),
  q('s05', 'solve', 0.75, [TRIG], '在 $\\triangle ABC$ 中，$a=3$，$b=4$，$C=60^{\\circ}$，求 $c$ 及 $\\triangle ABC$ 的面积．',
    null, '$c=\\sqrt{13}$，$S=3\\sqrt{3}$', '余弦定理 + 面积公式。'),
  q('s06', 'solve', 0.6, [SEQ], '已知等差数列 $\\{a_n\\}$ 满足 $a_3=7$，$a_7=15$，求通项公式与前 $n$ 项和 $S_n$．',
    null, '$a_n=2n+1$，$S_n=n^{2}+2n$', '基本量法。'),
  q('s07', 'solve', 0.8, [SEQ], '求和：$S_n=1\\cdot 2+2\\cdot 2^{2}+3\\cdot 2^{3}+\\cdots+n\\cdot 2^{n}$．',
    null, '$S_n=(n-1)2^{n+1}+2$', '错位相减法。'),
  q('s08', 'solve', 0.55, [PROB], '袋中有 3 个红球 2 个白球，任取 2 球，求恰有 1 个红球的概率．',
    null, '$\\dfrac{3}{5}$', '古典概型。'),
  q('s09', 'solve', 0.75, [PROB], '某射手命中率为 $0.8$，独立射击 3 次，求命中次数 $X$ 的分布列与数学期望．',
    null, '$E(X)=2.4$', '二项分布。'),
  q('s10', 'solve', 0.6, [CONIC], '已知椭圆 $\\dfrac{x^{2}}{4}+y^{2}=1$ 与直线 $y=x+m$ 相交于 $A,B$ 两点，求 $m$ 的取值范围．',
    null, '$-\\sqrt{5}<m<\\sqrt{5}$', '联立判别式。'),
  q('s11', 'solve', 0.7, [CONIC], '已知抛物线 $y^{2}=4x$ 的焦点为 $F$，过 $F$ 的直线交抛物线于 $A,B$，求 $|AB|$ 的最小值．',
    null, '最小值为 $4$', '通径最短。'),
  q('s12', 'solve', 0.95, [CONIC], '已知双曲线 $\\dfrac{x^{2}}{a^{2}}-\\dfrac{y^{2}}{b^{2}}=1$ 上一点 $P$ 满足 $PF_1\\perp PF_2$，求证：$|PF_1|\\cdot|PF_2|=2b^{2}$．',
    null, '略', '定义 + 勾股定理。'),
  // ---------------- 判断题 4（题库噪音，用于验证题型分流） ----------------
  q('j01', 'judge', 0.1, [FUNC], '函数 $y=x^{2}$ 在 $\\mathbb{R}$ 上是增函数．（　）', null, '×', '在 $(-\\infty,0)$ 上递减。'),
  q('j02', 'judge', 0.3, [TRIG], '任意角 $\\alpha$ 都有 $\\sin^{2}\\alpha+\\cos^{2}\\alpha=1$．（　）', null, '√', '同角三角函数基本关系。'),
  q('j03', 'judge', 0.35, [SEQ], '常数列一定是等差数列．（　）', null, '√', '公差为 $0$。'),
  q('j04', 'judge', 0.3, [PROB], '互斥事件一定相互独立．（　）', null, '×', '互斥通常不独立。'),
];

/** 标准测试大纲：100 分 = 8×5 + 4×5 + 4×10，分值本身闭合，无需配平。 */
const OUTLINE = {
  title: '高二数学期中测试卷',
  subject: '数学',
  grade: '高二',
  totalScore: 100,
  duration: 90,
  difficulty: 'medium',
  knowledgePoints: [
    { name: FUNC, weight: 0.3 },
    { name: TRIG, weight: 0.2 },
    { name: SEQ, weight: 0.2 },
    { name: PROB, weight: 0.15 },
    { name: CONIC, weight: 0.15 },
  ],
  sections: [
    { type: '选择题', count: 8, scorePer: 5, difficulty: 'medium' },
    { type: '填空题', count: 4, scorePer: 5, difficulty: 'medium' },
    { type: '解答题', count: 4, scorePer: 10, difficulty: 'medium' },
  ],
};

/** 每次调用返回全新蓝图，避免用例之间互相污染。 */
function makeBlueprint(outline = OUTLINE) {
  return buildBlueprint(outline);
}

/** 蓝图计划总分。 */
function plannedScore(bp) {
  return bp.sections.reduce((sum, s) => sum + s.count * s.scorePer, 0);
}

/* ==================================================================== *
 * 1. 题型归一
 * ==================================================================== */

test('normalizeType：中文别名归一为规范题型', () => {
  const cases = [
    // choice
    ['选择题', 'choice'], ['单选', 'choice'], ['单选题', 'choice'], ['单项选择题', 'choice'],
    // multi
    ['多选', 'multi'], ['多选题', 'multi'], ['多项选择题', 'multi'],
    // blank
    ['填空', 'blank'], ['填空题', 'blank'],
    // judge
    ['判断', 'judge'], ['判断题', 'judge'], ['是非题', 'judge'],
    // solve
    ['解答题', 'solve'], ['计算题', 'solve'], ['应用题', 'solve'], ['大题', 'solve'],
    // proof
    ['证明题', 'proof'],
    // essay
    ['论述题', 'essay'], ['简答题', 'essay'], ['作文', 'essay'], ['问答题', 'essay'],
    // 英文（大小写不敏感）
    ['choice', 'choice'], ['CHOICE', 'choice'], ['Multi', 'multi'], ['BLANK', 'blank'],
    ['Judge', 'judge'], ['SOLVE', 'solve'], ['proof', 'proof'], ['Essay', 'essay'],
    // 容错写法
    [' 选择题 ', 'choice'], ['一、选择题', 'choice'], ['2.填空题', 'blank'],
    ['选择题（单项）', 'choice'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeType(input), expected, `normalizeType(${JSON.stringify(input)})`);
  }
});

test('normalizeType：无法识别时抛 ExamError 且 code 正确', () => {
  for (const bad of ['连线题', '作图', 'unknown-type', '', null, undefined, 42, {}]) {
    assert.throws(
      () => normalizeType(bad),
      (err) => {
        assert.ok(err instanceof ExamError, '应为 ExamError 实例');
        assert.equal(err.name, 'ExamError');
        assert.equal(err.code, EXAM_ERROR_CODES.UNKNOWN_TYPE);
        assert.equal(err.code, 'BLUEPRINT_UNKNOWN_TYPE');
        return true;
      },
      `normalizeType(${JSON.stringify(bad)}) 应抛错`,
    );
  }
});

test('difficultyToNumber：词表映射与数值 clamp', () => {
  assert.equal(difficultyToNumber('easy'), 0.25);
  assert.equal(difficultyToNumber('medium'), 0.55);
  assert.equal(difficultyToNumber('hard'), 0.82);
  assert.equal(difficultyToNumber('mixed'), 0.55);
  assert.equal(difficultyToNumber('EASY'), 0.25);
  assert.equal(difficultyToNumber(0.7), 0.7);
  assert.equal(difficultyToNumber(0), 0);
  assert.equal(difficultyToNumber(1), 1);
  assert.equal(difficultyToNumber(1.7), 1, '超过 1 应 clamp');
  assert.equal(difficultyToNumber(-3), 0, '小于 0 应 clamp');
  assert.equal(difficultyToNumber(undefined), 0.55, '缺省按中等');
});

/* ==================================================================== *
 * 2. 默认蓝图推导
 * ==================================================================== */

test('buildBlueprint：缺省 sections 时按 150 分配比表推导', () => {
  const bp = buildBlueprint({ title: '高三数学模拟卷', subject: '数学', grade: '高三', totalScore: 150, difficulty: 'medium' });
  assert.equal(bp.totalScore, 150);
  assert.equal(plannedScore(bp), 150);
  assert.equal(bp.sections.length, 3);
  const byType = Object.fromEntries(bp.sections.map((s) => [s.type, s]));
  assert.equal(byType.choice.count, 12);
  assert.equal(byType.choice.scorePer, 5);
  assert.equal(byType.choice.score, 60);
  assert.equal(byType.blank.count, 4);
  assert.equal(byType.blank.score, 20);
  assert.equal(byType.solve.count, 5);
  assert.equal(byType.solve.score, 70);
  // 中文序号标题
  assert.equal(bp.sections[0].title, '一、选择题');
  assert.equal(bp.sections[1].title, '二、填空题');
  assert.equal(bp.sections[2].title, '三、解答题');
  // 难度标签与时长
  assert.equal(bp.difficultyLabel, 'medium');
  assert.equal(bp.difficulty, 0.55);
  assert.equal(bp.duration, 120);
});

test('buildBlueprint：难度档位影响默认配比（较难卷含证明题）', () => {
  const easy = buildBlueprint({ totalScore: 150, difficulty: 'easy' });
  assert.equal(plannedScore(easy), 150);
  assert.equal(easy.sections.find((s) => s.type === 'choice').count, 15, '容易卷客观题更多');
  assert.equal(easy.difficultyLabel, 'easy');

  const hard = buildBlueprint({ totalScore: 150, difficulty: 'hard' });
  assert.equal(plannedScore(hard), 150);
  assert.ok(hard.sections.some((s) => s.type === 'proof'), '较难卷应含证明题');
  assert.equal(hard.difficultyLabel, 'hard');

  // 其它总分按比例缩放且仍精确闭合
  for (const total of [100, 120, 200, 60]) {
    const bp = buildBlueprint({ totalScore: total, difficulty: 'mixed' });
    assert.equal(bp.totalScore, total, `总分 ${total}`);
    assert.equal(plannedScore(bp), total, `总分 ${total} 应精确配平`);
    assert.ok(bp.sections.length >= 2);
    assert.ok(bp.sections.every((s) => s.count >= 1 && s.scorePer > 0));
  }
});

test('buildBlueprint：知识点权重归一到总和 1', () => {
  const bp = makeBlueprint();
  const sum = bp.knowledgePoints.reduce((a, k) => a + k.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`);
  assert.deepEqual(bp.knowledgePoints.map((k) => k.name), [FUNC, TRIG, SEQ, PROB, CONIC]);
  assert.ok(Math.abs(bp.knowledgePoints[0].weight - 0.3) < 1e-9);
});

/* ==================================================================== *
 * 3. 总分配平
 * ==================================================================== */

test('buildBlueprint：总分不闭合时自动配平（sum === totalScore 且 adjustments 非空）', () => {
  const bp = buildBlueprint({
    title: '配平用例',
    totalScore: 100,
    sections: [
      { type: '选择题', count: 12, scorePer: 5 }, // 60
      { type: '填空题', count: 4, scorePer: 5 },  // 20
      { type: '解答题', count: 6, scorePer: 5 },  // 30 → 合计 110，需配平到 100
    ],
  });
  assert.equal(plannedScore(bp), 100);
  assert.equal(plannedScore(bp), bp.totalScore);
  assert.ok(bp.adjustments.length > 0, 'adjustments 应非空');
  assert.ok(bp.adjustments.every((a) => typeof a === 'string' && a.length > 0));
  assert.ok(bp.adjustments.some((a) => a.includes('调整为')), '应说明分值/题量调整');
  // 题量保持不变（本题型结构可容纳调整）
  assert.deepEqual(bp.sections.map((s) => s.count), [12, 4, 6]);
  // 每题分值仍为正、且为 0.5 的整数倍
  for (const s of bp.sections) {
    assert.ok(s.scorePer > 0);
    assert.ok(Number.isInteger(s.scorePer * 2), `scorePer=${s.scorePer} 应为 0.5 的整数倍`);
    assert.equal(s.score, s.count * s.scorePer, '分区小计 = 题量 × 每题分值');
  }
  // 相对分值权重仍然保持「解答题 > 填空/选择」的基本格局
  assert.ok(bp.sections[2].scorePer >= bp.sections[1].scorePer - 1e-9);
});

test('buildBlueprint：多种不闭合写法都能精确配平（含反推题量）', () => {
  const cases = [
    { totalScore: 100, sections: [{ type: '选择题', count: 10, scorePer: 5 }, { type: '解答题', count: 3, scorePer: 20 }] }, // 110 → 100
    { totalScore: 150, sections: [{ type: '选择题', count: 12, scorePer: 5 }, { type: '填空题', count: 4, scorePer: 5 }, { type: '解答题', count: 6, scorePer: 5 }] }, // 110 → 150
    { totalScore: 120, sections: [{ type: '解答题', score: 70 }, { type: '选择题', score: 50 }] }, // 只给分值 → 反推题量
    { totalScore: 80, sections: [{ type: '判断题', count: 10, scorePer: 2 }, { type: '解答题', count: 2, scorePer: 25 }] }, // 70 → 80
    { totalScore: 66, sections: [{ type: '选择题', count: 7, scorePer: 3 }, { type: '证明题', count: 3, scorePer: 20 }] }, // 81 → 66
  ];
  for (const outline of cases) {
    const bp = buildBlueprint(outline);
    assert.equal(bp.totalScore, outline.totalScore);
    assert.equal(plannedScore(bp), bp.totalScore, `${JSON.stringify(outline)} 应精确配平`);
    assert.ok(bp.sections.every((s) => s.count >= 1 && s.scorePer > 0));
    assert.ok(bp.adjustments.length > 0, `不闭合输入必然产生调整说明：${JSON.stringify(outline)}`);
    for (const a of bp.adjustments) assert.match(a, /[\u4e00-\u9fa5]/, '调整说明应为中文');
  }
  // 只给分值 → 反推题量
  const inferred = buildBlueprint({ totalScore: 100, sections: [{ type: '选择题', score: 40 }, { type: '解答题', score: 60 }] });
  assert.equal(plannedScore(inferred), 100);
  assert.ok(inferred.sections.every((s) => s.count >= 1));
  assert.equal(inferred.sections[0].count, 8, '选择题 40 分 ÷ 常见 5 分/题 = 8 道');
  assert.ok(inferred.adjustments.some((a) => a.includes('反推')));
});

test('buildBlueprint：随机大纲 fuzz —— 总分始终精确配平', () => {
  const rng = createRng(20240501);
  const types = ['choice', 'multi', 'blank', 'judge', 'solve', 'proof', 'essay'];
  const totals = [50, 60, 100, 120, 150, 200];
  for (let i = 0; i < 300; i += 1) {
    const totalScore = totals[Math.floor(rng() * totals.length)];
    const n = 1 + Math.floor(rng() * 4);
    const sections = [];
    for (let j = 0; j < n; j += 1) {
      const s = { type: types[Math.floor(rng() * types.length)] };
      if (rng() < 0.85) s.count = 1 + Math.floor(rng() * 20);
      if (rng() < 0.7) s.scorePer = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15][Math.floor(rng() * 10)];
      if (rng() < 0.4) s.score = 5 + Math.floor(rng() * 60);
      if (rng() < 0.3) s.difficulty = rng();
      sections.push(s);
    }
    const outline = { totalScore, sections };
    const bp = buildBlueprint(outline);
    const sum = plannedScore(bp);
    assert.equal(sum, bp.totalScore, `fuzz#${i} ${JSON.stringify(outline)} → 配平失败`);
    assert.equal(bp.totalScore, totalScore);
    assert.ok(bp.sections.every((s) => Number.isInteger(s.count) && s.count >= 1));
    assert.ok(bp.sections.every((s) => s.scorePer > 0 && Number.isInteger(s.scorePer * 2)));
  }
});

/* ==================================================================== *
 * 4. 非法输入
 * ==================================================================== */

test('buildBlueprint：非法输入抛 ExamError 且 code 正确', () => {
  const cases = [
    [{ totalScore: 0, sections: [{ type: '选择题', count: 5, scorePer: 5 }] }, 'BLUEPRINT_INVALID_TOTAL_SCORE'],
    [{ totalScore: -20, sections: [{ type: '选择题', count: 5, scorePer: 5 }] }, 'BLUEPRINT_INVALID_TOTAL_SCORE'],
    [{ totalScore: 'abc', sections: [{ type: '选择题', count: 5, scorePer: 5 }] }, 'BLUEPRINT_INVALID_TOTAL_SCORE'],
    [{ totalScore: 100, sections: [{ type: '选择题', count: 0 }] }, 'BLUEPRINT_INVALID_COUNT'],
    [{ totalScore: 100, sections: [{ type: '选择题', count: -3 }] }, 'BLUEPRINT_INVALID_COUNT'],
    [{ totalScore: 100, sections: [{ type: '选择题', count: 5, scorePer: -1 }] }, 'BLUEPRINT_INVALID_SCORE'],
    [{ totalScore: 100, sections: [{ type: '连线题', count: 5, scorePer: 5 }] }, 'BLUEPRINT_UNKNOWN_TYPE'],
    [{ sections: [] }, 'BLUEPRINT_EMPTY_SECTIONS'],
    [{}, 'BLUEPRINT_EMPTY_SECTIONS'],
    [null, 'BLUEPRINT_INVALID_OUTLINE'],
    [[], 'BLUEPRINT_INVALID_OUTLINE'],
    ['大纲', 'BLUEPRINT_INVALID_OUTLINE'],
  ];
  for (const [outline, code] of cases) {
    assert.throws(
      () => buildBlueprint(outline),
      (err) => {
        assert.ok(err instanceof ExamError, `${JSON.stringify(outline)} 应抛 ExamError`);
        assert.equal(err.code, code, `${JSON.stringify(outline)} 的 code`);
        assert.ok(err.message.length > 0);
        return true;
      },
      `buildBlueprint(${JSON.stringify(outline)}) 应抛错`,
    );
  }
  // 错误码常量表稳定
  assert.equal(EXAM_ERROR_CODES.EMPTY_SECTIONS, 'BLUEPRINT_EMPTY_SECTIONS');
  assert.equal(EXAM_ERROR_CODES.INVALID_TOTAL_SCORE, 'BLUEPRINT_INVALID_TOTAL_SCORE');
});

test('buildBlueprint：空 sections 但给出总分时可推导默认蓝图', () => {
  const bp = buildBlueprint({ totalScore: 150, sections: [] });
  assert.ok(bp.sections.length > 0);
  assert.equal(plannedScore(bp), 150);
});

/* ==================================================================== *
 * 5. describeBlueprint
 * ==================================================================== */

test('describeBlueprint：输出多行中文摘要', () => {
  const text = describeBlueprint(makeBlueprint());
  assert.equal(typeof text, 'string');
  const lines = text.split('\n');
  assert.ok(lines.length >= 6, '应为多行摘要');
  assert.ok(text.includes('高二数学期中测试卷'));
  assert.ok(text.includes('总分 100 分'));
  assert.ok(text.includes('一、选择题'));
  assert.ok(text.includes(FUNC) && text.includes('30%'));
  assert.ok(/[\u4e00-\u9fa5]/.test(text));
  assert.equal(describeBlueprint(null), '（无效的命题蓝图）');
});

/* ==================================================================== *
 * 6. createRng
 * ==================================================================== */

test('createRng：同种子完全一致、异种子不同，取值落在 [0,1)', () => {
  const a = createRng(20240501);
  const b = createRng(20240501);
  const c = createRng(42);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  const seqC = Array.from({ length: 20 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA.concat(seqC)) {
    assert.ok(v >= 0 && v < 1, `随机数应在 [0,1)，实际 ${v}`);
  }
  assert.equal(DEFAULT_SEED, 20240501);
});

/* ==================================================================== *
 * 7. selectQuestions：确定性与结构
 * ==================================================================== */

test('契约：paper / report 字段名与需求完全一致', () => {
  const { paper, report } = selectQuestions(BANK, makeBlueprint(), { seed: 1 });
  assert.deepEqual(
    Object.keys(paper).sort(),
    ['blueprint', 'generatedAt', 'plannedScore', 'sections', 'seed', 'totalScore'],
  );
  assert.deepEqual(
    Object.keys(report).sort(),
    ['coverage', 'difficulty', 'perSection', 'score', 'seed', 'suggestions', 'warnings'],
  );
  assert.deepEqual(Object.keys(report.score).sort(), ['actual', 'deviation', 'planned']);
  assert.deepEqual(Object.keys(report.difficulty).sort(), ['actual', 'histogram', 'target']);
  assert.deepEqual(Object.keys(report.difficulty.histogram).sort(), ['easy', 'hard', 'medium']);
  assert.deepEqual(
    Object.keys(report.perSection[0]).sort(),
    ['avgDifficulty', 'filled', 'id', 'needed', 'scoreActual', 'scorePlanned', 'targetDifficulty', 'title', 'type'],
  );
  assert.deepEqual(
    Object.keys(report.coverage[0]).sort(),
    ['knowledge', 'required', 'satisfied', 'used', 'weight'],
  );
  // 分区 = BlueprintSection & { questions }
  assert.deepEqual(
    Object.keys(paper.sections[0]).sort(),
    ['count', 'difficulty', 'id', 'knowledge', 'questions', 'score', 'scorePer', 'title', 'type'],
  );
});

test('selectQuestions：同 seed 两次结果完全一致（deepStrictEqual）', () => {
  const bp = makeBlueprint();
  const first = selectQuestions(BANK, bp, { seed: 2024 });
  const second = selectQuestions(BANK, makeBlueprint(), { seed: 2024 });
  assert.deepStrictEqual(second.paper, first.paper);
  assert.deepStrictEqual(second.report, first.report);
  // generatedAt 是合法 ISO 时间
  assert.equal(typeof first.paper.generatedAt, 'string');
  assert.equal(new Date(first.paper.generatedAt).toISOString(), first.paper.generatedAt);
  assert.equal(first.paper.seed, 2024);
  assert.equal(first.report.seed, 2024);
});

test('selectQuestions：不同 seed 产出不同卷', () => {
  const bp = makeBlueprint();
  const a = selectQuestions(BANK, bp, { seed: 1 });
  const b = selectQuestions(BANK, bp, { seed: 999 });
  const idsOf = (r) => r.paper.sections.map((s) => s.questions.map((qq) => qq.id).join(',')).join('|');
  assert.notEqual(idsOf(a), idsOf(b), '不同 seed 的选题目录应不同');
  // 默认 seed 生效
  const d1 = selectQuestions(BANK, makeBlueprint());
  assert.equal(d1.paper.seed, DEFAULT_SEED);
  assert.notEqual(idsOf(d1), idsOf(a));
});

test('selectQuestions：题型数量与分值严格满足蓝图', () => {
  const bp = makeBlueprint();
  const { paper, report } = selectQuestions(BANK, bp, { seed: DEFAULT_SEED });

  assert.equal(paper.sections.length, bp.sections.length);
  for (let i = 0; i < bp.sections.length; i += 1) {
    const planned = bp.sections[i];
    const actual = paper.sections[i];
    assert.equal(actual.type, planned.type);
    assert.equal(actual.count, planned.count);
    assert.equal(actual.questions.length, planned.count, `${actual.title} 题量应严格等于 ${planned.count}`);
    for (const question of actual.questions) {
      assert.equal(question.type, planned.type, '选题题型必须与分区一致');
      assert.ok(question.score > 0);
      assert.ok(Array.isArray(question.knowledge) && question.knowledge.length > 0);
      assert.ok(question.stem.length > 0);
    }
  }
  // 各题型分值恒等于 count × scorePer（题库每题分值与蓝图一致）
  assert.equal(paper.plannedScore, 100);
  assert.equal(paper.totalScore, 100);
  assert.equal(report.score.planned, 100);
  assert.equal(report.score.actual, 100);
  assert.equal(report.score.deviation, 0);

  // perSection 契约字段
  assert.equal(report.perSection.length, bp.sections.length);
  for (const ps of report.perSection) {
    for (const key of ['id', 'type', 'title', 'needed', 'filled', 'avgDifficulty', 'targetDifficulty', 'scorePlanned', 'scoreActual']) {
      assert.ok(Object.prototype.hasOwnProperty.call(ps, key), `perSection 缺少字段 ${key}`);
    }
    assert.equal(ps.filled, ps.needed);
    assert.equal(ps.scoreActual, ps.scorePlanned);
    assert.ok(Math.abs(ps.avgDifficulty - ps.targetDifficulty) <= 0.18,
      `${ps.title} 平均难度 ${ps.avgDifficulty} 应贴近目标 ${ps.targetDifficulty}`);
  }

  // 难度报告
  const hist = report.difficulty.histogram;
  assert.equal(hist.easy + hist.medium + hist.hard, paper.sections.reduce((a, s) => a + s.questions.length, 0));
  assert.ok(report.difficulty.actual > 0 && report.difficulty.actual < 1);
  assert.equal(report.difficulty.target, bp.difficulty);

  // 覆盖报告
  assert.ok(Array.isArray(report.coverage) && report.coverage.length === bp.knowledgePoints.length);
  for (const c of report.coverage) {
    for (const key of ['knowledge', 'weight', 'required', 'used', 'satisfied']) {
      assert.ok(Object.prototype.hasOwnProperty.call(c, key), `coverage 缺少字段 ${key}`);
    }
  }
  assert.ok(report.coverage.every((c) => c.satisfied), '题库充足时应覆盖全部知识点');
  assert.deepEqual(report.warnings, [], '题库充足、蓝图闭合时不应有 warnings');
});

test('selectQuestions：题库充足时同卷内不重复用题', () => {
  const { paper } = selectQuestions(BANK, makeBlueprint(), { seed: 7 });
  const ids = paper.sections.flatMap((s) => s.questions.map((x) => x.id));
  assert.equal(new Set(ids).size, ids.length, '同卷内题目不应重复');
});

test('selectQuestions：LaTeX 题干原样保留', () => {
  const { paper } = selectQuestions(BANK, makeBlueprint(), { seed: 3 });
  const stems = paper.sections.flatMap((s) => s.questions.map((x) => x.stem));
  assert.ok(stems.some((s) => s.includes('$')), '题库含 LaTeX 题干，选中题目应保留 $...$');
  for (const s of stems) assert.equal(typeof s, 'string');
});

/* ==================================================================== *
 * 8. 题库不足：尽力而为 + warnings
 * ==================================================================== */

test('selectQuestions：题库不足时不抛错，返回尽力而为的卷子 + 中文 warnings', () => {
  const bp = makeBlueprint();
  const tiny = BANK.filter((x) => x.id === 'c01' || x.id === 'c02' || x.id === 'b01');
  let result;
  assert.doesNotThrow(() => { result = selectQuestions(tiny, bp, { seed: 11 }); });
  const { paper, report } = result;

  assert.ok(report.warnings.length > 0, 'warnings 应非空');
  assert.ok(report.warnings.every((w) => typeof w === 'string' && w.length > 0));
  assert.ok(report.warnings.every((w) => /[\u4e00-\u9fa5]/.test(w)), 'warnings 应为中文');
  assert.ok(report.warnings.some((w) => w.includes('题量不足')), '应说明题型题量不足');
  assert.ok(report.warnings.some((w) => w.includes('重复用题')), '应说明发生了重复用题');
  assert.ok(report.suggestions.length > 0, '应给出补充建议');
  assert.ok(report.suggestions.some((s) => s.includes('建议补充')), '建议应包含补充题量');
  // 该题型题库里还有题 → 允许重复用题填满；题型完全没有题 → 只能留空并告警
  for (const s of paper.sections) {
    const poolSize = tiny.filter((x) => x.type === s.type).length;
    assert.equal(s.questions.length, poolSize > 0 ? s.count : 0, `${s.title} 的填充数量`);
  }
  const solveSection = paper.sections.find((s) => s.type === 'solve');
  assert.equal(solveSection.questions.length, 0, '题库无解答题时该分区留空');
  assert.ok(report.warnings.some((w) => w.includes('解答题')), '应点名缺题的题型');
  assert.ok(paper.totalScore > 0);
  assert.ok(Math.abs(report.score.deviation) > 0, '题库不足时实际总分必然偏离');
});

test('selectQuestions：空题库 / 非法蓝图 / 非数组题库均不抛错', () => {
  const cases = [
    [[], makeBlueprint()],
    [null, makeBlueprint()],
    ['not-an-array', makeBlueprint()],
    [BANK, null],
    [BANK, {}],
    [BANK, { sections: [{ type: '连线题', count: 3 }] }],
    [[], null],
    [BANK.filter((x) => !x.id), buildBlueprint({ totalScore: 60 })],
  ];
  for (const [bank, bp] of cases) {
    let result;
    assert.doesNotThrow(() => { result = selectQuestions(bank, bp, { seed: 5 }); });
    assert.ok(result.paper && result.report, '应始终返回 { paper, report }');
    assert.ok(Array.isArray(result.paper.sections));
    assert.ok(Array.isArray(result.report.warnings));
    assert.ok(Array.isArray(result.report.suggestions));
    assert.equal(typeof result.report.score.planned, 'number');
    assert.equal(typeof result.report.difficulty.actual, 'number');
    assert.ok(result.report.difficulty.histogram);
  }
  // 空题库必须给出明确警告
  const empty = selectQuestions([], makeBlueprint(), { seed: 5 });
  assert.ok(empty.report.warnings.some((w) => w.includes('题库为空')));
  assert.equal(empty.paper.totalScore, 0);
  assert.ok(new Set(empty.paper.sections.map((s) => s.id)).size === empty.paper.sections.length, '分区 id 唯一');
});

test('selectQuestions：allowReuse 语义', () => {
  const bp = makeBlueprint();
  const scarce = BANK.filter((x) => x.type === 'choice' && x.knowledge.includes(FUNC));
  const off = selectQuestions(scarce, bp, { seed: 2, allowReuse: false });
  const on = selectQuestions(scarce, bp, { seed: 2, allowReuse: true });
  assert.ok(off.report.warnings.some((w) => w.includes('重复用题')), 'allowReuse:false 且题库不足应告警');
  assert.doesNotThrow(() => selectQuestions(scarce, bp, { seed: 2, allowReuse: true }));
  assert.equal(on.paper.sections[0].questions.length, bp.sections[0].count);
});

test('selectQuestions：options 缺省值与容差参数生效', () => {
  const bp = makeBlueprint();
  const a = selectQuestions(BANK, bp, { seed: 100 });
  const b = selectQuestions(BANK, bp, { seed: 100, attempts: 1 });
  const c = selectQuestions(BANK, bp, { seed: 100, attempts: 60, difficultyTolerance: 0.3, allowReuse: false });
  assert.equal(a.paper.seed, 100);
  // 轮数不同不报错，且都是合法卷子
  for (const r of [a, b, c]) {
    assert.ok(r.paper.sections.every((s) => s.questions.length === s.count));
  }
  // attempts 越多，选优结果不应更差（此处用分值偏差做弱断言）
  assert.ok(Math.abs(b.report.score.deviation) >= Math.abs(a.report.score.deviation) - 1e-9);
});

/* ==================================================================== *
 * 9. coverageReport
 * ==================================================================== */

test('coverageReport：题库充足时 satisfied 全为 true', () => {
  const bp = makeBlueprint();
  const rep = coverageReport(BANK, bp);

  assert.equal(rep.feasible, true, '题库充足应判定为可行');
  assert.equal(rep.totalQuestions, BANK.length);
  assert.equal(rep.usableQuestions, BANK.length);
  assert.equal(rep.ignoredQuestions, 0);
  assert.equal(rep.score.required, 100);
  assert.ok(rep.score.available >= 100);

  assert.equal(rep.sections.length, bp.sections.length);
  assert.ok(rep.sections.every((s) => s.satisfied), '各分区 satisfied 应全为 true');
  assert.ok(rep.sections.every((s) => s.available >= s.needed));
  assert.ok(rep.sections.every((s) => s.missing === 0));

  assert.equal(rep.knowledge.length, bp.knowledgePoints.length);
  assert.ok(rep.knowledge.every((k) => k.satisfied), '各知识点 satisfied 应全为 true');
  assert.ok(rep.knowledge.every((k) => k.availableScore >= k.required));

  assert.deepEqual(rep.warnings, []);
  assert.deepEqual(rep.suggestions, []);
});

test('coverageReport：题库不足时指出缺口且不抛错', () => {
  const bp = makeBlueprint();
  const tiny = BANK.slice(0, 2);
  const rep = coverageReport(tiny, bp);
  assert.equal(rep.feasible, false);
  assert.ok(rep.usableQuestions < BANK.length);
  assert.ok(rep.sections.some((s) => !s.satisfied));
  assert.ok(rep.sections.some((s) => s.missing > 0));
  assert.ok(rep.knowledge.some((k) => !k.satisfied));
  assert.ok(rep.warnings.length > 0);
  assert.ok(rep.suggestions.length > 0);
  assert.ok(rep.warnings.every((w) => /[\u4e00-\u9fa5]/.test(w)));

  // 非法输入同样不抛错
  assert.doesNotThrow(() => coverageReport(null, bp));
  assert.doesNotThrow(() => coverageReport(BANK, null));
  const broken = coverageReport(BANK, null);
  assert.equal(broken.feasible, false);
  assert.ok(broken.warnings.length > 0);
});

test('coverageReport：忽略题型/分值非法的题目并统计', () => {
  const dirty = BANK.concat([
    { id: 'x1', type: '连线题', stem: '连线', score: 5, difficulty: 0.5, knowledge: [FUNC] },
    { id: 'x2', type: 'choice', stem: '缺分值', score: 0, difficulty: 0.5, knowledge: [FUNC] },
    null,
  ]);
  const rep = coverageReport(dirty, makeBlueprint());
  assert.equal(rep.totalQuestions, BANK.length + 3);
  assert.equal(rep.usableQuestions, BANK.length);
  assert.equal(rep.ignoredQuestions, 3);
  assert.ok(rep.warnings.some((w) => w.includes('被忽略')));
});

/* ==================================================================== *
 * 10. 端到端：默认蓝图 + 真实组卷
 * ==================================================================== */

test('端到端：默认 150 分蓝图组卷可用（并在题库分值不匹配时如实告警）', () => {
  const bp = buildBlueprint({
    title: '高三数学模拟卷', subject: '数学', grade: '高三',
    totalScore: 150, duration: 120, difficulty: 'medium',
    knowledgePoints: [{ name: FUNC, weight: 0.4 }, { name: TRIG, weight: 0.3 }, { name: SEQ, weight: 0.3 }],
  });
  const { paper, report } = selectQuestions(BANK, bp, { seed: 20240501 });

  assert.equal(paper.plannedScore, 150);
  assert.equal(paper.sections.length, bp.sections.length);
  for (let i = 0; i < bp.sections.length; i += 1) {
    assert.equal(paper.sections[i].questions.length, bp.sections[i].count, '每个分区都应按蓝图填满');
  }
  // paper.totalScore 恒等于实际选中题目分值之和
  const actual = paper.sections.reduce(
    (sum, s) => sum + s.questions.reduce((a, x) => a + x.score, 0),
    0,
  );
  assert.equal(paper.totalScore, actual);
  assert.equal(report.score.actual, actual);
  assert.equal(report.score.deviation, actual - 150);
  // 本测试题库的解答题每题 10 分，而默认蓝图规划 14 分/题 → 实际总分必然低于计划，必须如实告警
  assert.ok(report.warnings.some((w) => w.includes('实际总分')), '分值不匹配时应提示实际总分偏差');
  assert.ok(report.perSection.every((s) => s.filled === s.needed));

  const text = describeBlueprint(paper.blueprint);
  assert.ok(text.includes('总分 150 分'));
  assert.ok(text.includes('一、选择题'));
});

test('端到端：题库分值与蓝图一致时实际总分等于计划总分', () => {
  // 让蓝图每题分值与题库一致：选择 5、填空 5、解答 10
  const bp = buildBlueprint({
    title: '高二数学期末卷', subject: '数学', grade: '高二',
    totalScore: 150, duration: 120, difficulty: 'medium',
    knowledgePoints: [
      { name: FUNC, weight: 0.25 }, { name: TRIG, weight: 0.2 }, { name: SEQ, weight: 0.2 },
      { name: PROB, weight: 0.2 }, { name: CONIC, weight: 0.15 },
    ],
    sections: [
      { type: '选择题', count: 12, scorePer: 5, difficulty: 'medium' },
      { type: '填空题', count: 4, scorePer: 5, difficulty: 'medium' },
      { type: '解答题', count: 7, scorePer: 10, difficulty: 'medium' },
    ],
  });
  assert.equal(plannedScore(bp), 150);
  const { paper, report } = selectQuestions(BANK, bp, { seed: 20240501 });
  assert.equal(paper.totalScore, 150, '题库每题分值与蓝图一致时实际总分应等于计划总分');
  assert.equal(report.score.deviation, 0);
  assert.equal(report.warnings.length, 0, `题库充足时不应有告警：${JSON.stringify(report.warnings)}`);
  assert.ok(report.coverage.every((c) => c.satisfied), '知识点覆盖应全部达标');
  assert.equal(paper.sections.flatMap((s) => s.questions).length, 23);
});
