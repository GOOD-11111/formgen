/**
 * 种子题库：高中数学。
 *
 * 用 `String.raw` 书写题干——LaTeX 里的 `\frac`、`\infty`、`\mathbb` 若写成普通字符串，
 * 必须逐个写成 `\\frac`，极容易出错；raw 模板让题干与老师在 Word 里写的写法一致。
 *
 * 题库是数据，不是代码：把它换成任意 JSON 数组（`banks/*.json` 同样会被加载）即可接入自己的题。
 */

const q = (id, type, stem, extra) => ({ id, type, stem, ...extra });

export default [
  // ---------------- 集合与常用逻辑 ----------------
  q('m-set-01', 'choice', String.raw`已知集合 $A=\{1,2,3\}$，$B=\{2,3,4\}$，则 $A\cap B=$`, {
    options: [String.raw`$\{2,3\}$`, String.raw`$\{1,2,3,4\}$`, String.raw`$\{1,4\}$`, String.raw`$\{1\}$`],
    answer: 'A', score: 5, difficulty: 0.2, knowledge: ['集合'],
  }),
  q('m-set-02', 'choice', String.raw`命题“$\forall x\in\mathbb{R},\ x^{2}\ge 0$”的否定是`, {
    options: [String.raw`$\exists x\in\mathbb{R},\ x^{2}<0$`, String.raw`$\forall x\in\mathbb{R},\ x^{2}<0$`, String.raw`$\exists x\in\mathbb{R},\ x^{2}\ge 0$`, String.raw`$\forall x\notin\mathbb{R},\ x^{2}<0$`],
    answer: 'A', score: 5, difficulty: 0.32, knowledge: ['常用逻辑用语'],
  }),
  q('m-set-03', 'blank', String.raw`已知集合 $A=\{x\mid x^{2}-3x+2=0\}$，则 $A$ 中所有元素之和为 ______。`, {
    answer: ['3'], score: 5, difficulty: 0.28, knowledge: ['集合'], blanks: 1,
  }),
  q('m-set-04', 'judge', String.raw`若 $a>b$，则 $a^{2}>b^{2}$。`, {
    answer: false, score: 4, difficulty: 0.35, knowledge: ['不等式'],
  }),
  q('m-set-05', 'solve', String.raw`已知集合 $A=\{x\mid -1<x<3\}$，$B=\{x\mid x\ge a\}$。若 $A\subseteq B$，求实数 $a$ 的取值范围。`, {
    answer: String.raw`$a\le -1$`, score: 10, difficulty: 0.55, knowledge: ['集合'],
  }),

  // ---------------- 函数 ----------------
  q('m-fn-01', 'choice', String.raw`函数 $f(x)=\sqrt{2-x}+\dfrac{1}{x-1}$ 的定义域是`, {
    options: [String.raw`$(-\infty,1)\cup(1,2]$`, String.raw`$(-\infty,2]$`, String.raw`$(-\infty,1)\cup(1,2)$`, String.raw`$(1,2]$`],
    answer: 'A', score: 5, difficulty: 0.36, knowledge: ['函数'],
  }),
  q('m-fn-02', 'choice', String.raw`函数 $f(x)=x^{2}-2x+3$ 在区间 $[0,3]$ 上的最小值是`, {
    options: ['1', '2', '3', '6'],
    answer: 'B', score: 5, difficulty: 0.35, knowledge: ['函数'],
  }),
  q('m-fn-03', 'blank', String.raw`已知 $f(x)=2x+1$，则 $f(f(1))=$ ______。`, {
    answer: ['7'], score: 5, difficulty: 0.3, knowledge: ['函数'], blanks: 1,
  }),
  q('m-fn-04', 'choice', String.raw`下列函数中，在其定义域内为奇函数的是`, {
    options: [String.raw`$y=x^{2}$`, String.raw`$y=x^{3}$`, String.raw`$y=2^{x}$`, String.raw`$y=\log_{2}x$`],
    answer: 'B', score: 5, difficulty: 0.3, knowledge: ['函数', '函数的性质'],
  }),
  q('m-fn-05', 'blank', String.raw`已知 $f(x)$ 是定义在 $\mathbb{R}$ 上的偶函数，且 $f(2)=3$，则 $f(-2)=$ ______。`, {
    answer: ['3'], score: 5, difficulty: 0.25, knowledge: ['函数', '函数的性质'], blanks: 1,
  }),
  q('m-fn-06', 'solve', String.raw`已知函数 $f(x)=x^{2}-2ax+3$ 在区间 $[1,+\infty)$ 上单调递增，求实数 $a$ 的取值范围。`, {
    answer: String.raw`$a\le 1$`, score: 10, difficulty: 0.52, knowledge: ['函数', '函数的性质'],
  }),
  q('m-fn-07', 'solve', String.raw`求函数 $f(x)=\log_{2}(x^{2}-4x+5)$ 的单调递增区间。`, {
    answer: String.raw`$(2,+\infty)$`, score: 10, difficulty: 0.58, knowledge: ['函数', '对数函数'],
  }),
  q('m-fn-08', 'choice', String.raw`函数 $y=2^{x}$ 的图象大致是`, {
    options: ['过点 $(0,1)$ 且单调递增的曲线', '过点 $(1,0)$ 且单调递增的曲线', '过点 $(0,1)$ 且单调递减的曲线', '关于 $y$ 轴对称的曲线'],
    answer: 'A', score: 5, difficulty: 0.3, knowledge: ['指数函数'],
  }),

  // ---------------- 三角函数 ----------------
  q('m-tri-01', 'choice', String.raw`$\sin 30^{\circ}$ 的值是`, {
    options: [String.raw`$\dfrac{1}{2}$`, String.raw`$\dfrac{\sqrt{2}}{2}$`, String.raw`$\dfrac{\sqrt{3}}{2}$`, '1'],
    answer: 'A', score: 5, difficulty: 0.2, knowledge: ['三角函数'],
  }),
  q('m-tri-02', 'choice', String.raw`$\cos\dfrac{2\pi}{3}=$`, {
    options: [String.raw`$\dfrac{1}{2}$`, String.raw`$-\dfrac{1}{2}$`, String.raw`$\dfrac{\sqrt{3}}{2}$`, String.raw`$-\dfrac{\sqrt{3}}{2}$`],
    answer: 'B', score: 5, difficulty: 0.3, knowledge: ['三角函数'],
  }),
  q('m-tri-03', 'blank', String.raw`函数 $y=2\sin\left(2x+\dfrac{\pi}{6}\right)$ 的最小正周期是 ______。`, {
    answer: [String.raw`$\pi$`], score: 5, difficulty: 0.4, knowledge: ['三角函数', '三角函数的图象与性质'], blanks: 1,
  }),
  q('m-tri-04', 'blank', String.raw`化简：$\sin(\pi-\alpha)=$ ______。`, {
    answer: [String.raw`$\sin\alpha$`], score: 5, difficulty: 0.35, knowledge: ['三角函数', '诱导公式'], blanks: 1,
  }),
  q('m-tri-05', 'blank', String.raw`$\sin^{2}15^{\circ}+\cos^{2}15^{\circ}=$ ______。`, {
    answer: ['1'], score: 5, difficulty: 0.22, knowledge: ['三角函数', '同角三角函数关系'], blanks: 1,
  }),
  q('m-tri-06', 'choice', String.raw`函数 $y=\sin x$ 的图象的一条对称轴方程是`, {
    options: [String.raw`$x=0$`, String.raw`$x=\dfrac{\pi}{2}$`, String.raw`$x=\pi$`, String.raw`$x=\dfrac{3\pi}{2}$`],
    answer: 'B', score: 5, difficulty: 0.45, knowledge: ['三角函数', '三角函数的图象与性质'],
  }),
  q('m-tri-07', 'solve', String.raw`已知 $\sin\alpha=\dfrac{3}{5}$，且 $\alpha\in\left(\dfrac{\pi}{2},\pi\right)$，求 $\cos\alpha$ 与 $\tan\alpha$ 的值。`, {
    answer: String.raw`$\cos\alpha=-\dfrac{4}{5}$，$\tan\alpha=-\dfrac{3}{4}$`, score: 10, difficulty: 0.5, knowledge: ['三角函数', '同角三角函数关系'],
  }),
  q('m-tri-08', 'solve', String.raw`在 $\triangle ABC$ 中，$a=3$，$b=4$，$C=\dfrac{\pi}{3}$，求边 $c$ 的长。`, {
    answer: String.raw`$c=\sqrt{13}$`, score: 10, difficulty: 0.6, knowledge: ['三角函数', '解三角形'],
  }),
  q('m-tri-09', 'choice', String.raw`要得到函数 $y=\sin\left(2x+\dfrac{\pi}{3}\right)$ 的图象，只需将 $y=\sin 2x$ 的图象`, {
    options: [String.raw`向左平移 $\dfrac{\pi}{6}$ 个单位`, String.raw`向右平移 $\dfrac{\pi}{6}$ 个单位`, String.raw`向左平移 $\dfrac{\pi}{3}$ 个单位`, String.raw`向右平移 $\dfrac{\pi}{3}$ 个单位`],
    answer: 'A', score: 5, difficulty: 0.62, knowledge: ['三角函数', '三角函数的图象与性质'],
  }),

  // ---------------- 数列 ----------------
  q('m-seq-01', 'choice', String.raw`等差数列 $\{a_{n}\}$ 中，$a_{1}=1$，公差 $d=2$，则 $a_{10}=$`, {
    options: ['17', '19', '21', '20'],
    answer: 'B', score: 5, difficulty: 0.28, knowledge: ['数列', '等差数列'],
  }),
  q('m-seq-02', 'blank', String.raw`等比数列 $\{a_{n}\}$ 中，$a_{1}=2$，公比 $q=3$，则 $a_{4}=$ ______。`, {
    answer: ['54'], score: 5, difficulty: 0.3, knowledge: ['数列', '等比数列'], blanks: 1,
  }),
  q('m-seq-03', 'blank', String.raw`$\displaystyle\sum_{k=1}^{10}k=$ ______。`, {
    answer: ['55'], score: 5, difficulty: 0.25, knowledge: ['数列', '数列求和'], blanks: 1,
  }),
  q('m-seq-04', 'choice', String.raw`数列 $1,1,2,3,5,8,\cdots$ 的第 $8$ 项是`, {
    options: ['13', '21', '34', '11'],
    answer: 'B', score: 5, difficulty: 0.42, knowledge: ['数列', '递推数列'],
  }),
  q('m-seq-05', 'solve', String.raw`已知等差数列 $\{a_{n}\}$ 的前 $n$ 项和 $S_{n}=n^{2}+2n$，求通项公式 $a_{n}$。`, {
    answer: String.raw`$a_{n}=2n+1$`, score: 10, difficulty: 0.6, knowledge: ['数列', '等差数列'],
  }),
  q('m-seq-06', 'solve', String.raw`求数列 $\{n\cdot 2^{n}\}$ 的前 $n$ 项和 $S_{n}$。`, {
    answer: String.raw`$S_{n}=(n-1)2^{n+1}+2$`, score: 12, difficulty: 0.78, knowledge: ['数列', '数列求和', '错位相减'],
  }),

  // ---------------- 不等式 ----------------
  q('m-ineq-01', 'choice', String.raw`不等式 $x^{2}-5x+6<0$ 的解集是`, {
    options: [String.raw`$(2,3)$`, String.raw`$(-\infty,2)\cup(3,+\infty)$`, String.raw`$[2,3]$`, String.raw`$(-3,-2)$`],
    answer: 'A', score: 5, difficulty: 0.35, knowledge: ['不等式', '一元二次不等式'],
  }),
  q('m-ineq-02', 'blank', String.raw`若 $a>0$，$b>0$，且 $a+b=4$，则 $ab$ 的最大值是 ______。`, {
    answer: ['4'], score: 5, difficulty: 0.5, knowledge: ['不等式', '基本不等式'], blanks: 1,
  }),
  q('m-ineq-03', 'solve', String.raw`解不等式：$\dfrac{x-1}{x+2}\ge 0$。`, {
    answer: String.raw`$(-\infty,-2)\cup[1,+\infty)$`, score: 10, difficulty: 0.55, knowledge: ['不等式', '分式不等式'],
  }),

  // ---------------- 导数 ----------------
  q('m-der-01', 'blank', String.raw`已知 $f(x)=x^{2}$，则 $f'(1)=$ ______。`, {
    answer: ['2'], score: 5, difficulty: 0.3, knowledge: ['导数', '导数的运算'], blanks: 1,
  }),
  q('m-der-02', 'choice', String.raw`函数 $f(x)=x^{3}-3x$ 的极大值是`, {
    options: ['2', '-2', '0', '1'],
    answer: 'A', score: 5, difficulty: 0.62, knowledge: ['导数', '导数与极值'],
  }),
  q('m-der-03', 'solve', String.raw`求曲线 $y=x^{3}$ 在点 $(1,1)$ 处的切线方程。`, {
    answer: String.raw`$y=3x-2$`, score: 10, difficulty: 0.55, knowledge: ['导数', '导数的几何意义'],
  }),
  q('m-der-04', 'solve', String.raw`已知函数 $f(x)=x^{3}+ax$ 在 $\mathbb{R}$ 上单调递增，求实数 $a$ 的取值范围。`, {
    answer: String.raw`$a\ge 0$`, score: 12, difficulty: 0.7, knowledge: ['导数', '导数与单调性'],
  }),

  // ---------------- 解析几何 ----------------
  q('m-geo-01', 'choice', String.raw`圆 $x^{2}+y^{2}=4$ 的半径是`, {
    options: ['1', '2', '3', '4'],
    answer: 'B', score: 5, difficulty: 0.2, knowledge: ['解析几何', '圆'],
  }),
  q('m-geo-02', 'blank', String.raw`直线 $y=x+1$ 的斜率是 ______。`, {
    answer: ['1'], score: 5, difficulty: 0.2, knowledge: ['解析几何', '直线'],
  }),
  q('m-geo-03', 'solve', String.raw`求过点 $(0,1)$ 且与直线 $y=2x+3$ 平行的直线方程。`, {
    answer: String.raw`$y=2x+1$`, score: 10, difficulty: 0.45, knowledge: ['解析几何', '直线'],
  }),
  q('m-geo-04', 'judge', String.raw`函数 $y=x^{2}$ 在 $\mathbb{R}$ 上是增函数。`, {
    answer: false, score: 4, difficulty: 0.25, knowledge: ['函数', '函数的性质'],
  }),
];
