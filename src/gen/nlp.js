/**
 * 自然语言 → FormSchema（确定性规则通道）。
 *
 * 为什么要有这一条通道，而不是全部交给大模型？
 *
 *   1. **离线可用**：没有 API key、断网、内网环境都能跑，这是低代码平台的基本盘。
 *   2. **可解释**：每个字段为什么是「下拉框」、为什么必填，都能追溯到一条规则，
 *      `understanding` 把推理过程回放给用户看——大模型的 JSON 做不到这一点。
 *   3. **兜底**：LLM 通道失败（超时、配额、幻觉出非法 Schema）时自动降级到这里，
 *      用户永远拿得到一份能填的表单。
 *
 * 与 LLM 通道共用同一份产物契约（FormSchema），二者可直接对比、可互相修补。
 */

import { normalizeFieldType, normalizeFieldTypeExact, deriveKey, normalizeSchema } from '../core/schema.js';
import { FormgenError } from '../core/errors.js';

// ---------------------------------------------------------------------------
// 语义词典：中文需求里「一个词」到「一个控件」的映射
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   key: string, type: string,
 *   patterns: RegExp,
 *   required?: boolean,
 *   label?: string,
 *   extra?: Record<string, unknown>,
 * }} FieldSemantic
 */

/** @type {FieldSemantic[]} */
const FIELD_SEMANTICS = [
  // —— 身份/联系 ——
  { key: 'name', type: 'text', patterns: /^(姓名|名字|名称|称呼|联系人|申请人|填写人)$/, required: true, extra: { placeholder: '请输入真实姓名', maxLength: 30 } },
  { key: 'phone', type: 'tel', patterns: /(手机号码|手机号|手机|联系电话|联系方式|电话|座机)/, required: true, extra: { placeholder: '11 位手机号' } },
  { key: 'email', type: 'email', patterns: /(电子邮箱|电子邮件|邮箱|邮件地址|email|e-mail)/i, extra: { placeholder: 'name@example.com' } },
  { key: 'idNumber', type: 'idcard', patterns: /(身份证号码|身份证号)|^身份证$/, extra: { help: '仅用于身份核验，18 位，末位可为 X' } },
  { key: 'gender', type: 'radio', patterns: /^性别$/, extra: { options: ['男', '女'] } },
  { key: 'birthday', type: 'date', patterns: /(出生日期|出生年月|^生日$)/ },
  { key: 'age', type: 'integer', patterns: /^年龄$/, extra: { min: 0, max: 120, unit: '岁' } },
  { key: 'address', type: 'textarea', patterns: /(家庭住址|收货地址|通讯地址|详细地址|地址)/, extra: { rows: 3 } },
  { key: 'zipCode', type: 'text', patterns: /(邮政编码|邮编)/, extra: { pattern: '^\\d{6}$', patternMessage: '邮政编码应为 6 位数字' } },

  // —— 组织/学业 ——
  { key: 'company', type: 'text', patterns: /(公司名称|单位名称|所在公司|公司|单位)/ },
  { key: 'department', type: 'select', patterns: /(所在部门|应聘部门|部门|科室)/ },
  { key: 'position', type: 'text', patterns: /(职位|岗位|职务|职位名称)/, extra: { placeholder: '如：前端工程师' } },
  { key: 'school', type: 'text', patterns: /(毕业院校|就读学校|学校名称|学校)/ },
  { key: 'major', type: 'text', patterns: /(所学专业|专业名称|专业)/ },
  { key: 'education', type: 'select', patterns: /(最高学历|学历)/, extra: { options: ['高中及以下', '大专', '本科', '硕士', '博士'] } },
  { key: 'className', type: 'text', patterns: /(所在班级|班级)/ },
  { key: 'studentId', type: 'text', patterns: /(学号)/, extra: { pattern: '^[A-Za-z0-9]{4,20}$', patternMessage: '学号应为 4-20 位字母或数字' } },
  { key: 'employeeId', type: 'text', patterns: /(员工编号|工号)/ },
  { key: 'hireDate', type: 'date', patterns: /(入职日期|入职时间|到岗日期|报到日期)/ },
  { key: 'emergencyContact', type: 'text', patterns: /(紧急联系人姓名|紧急联系人|紧急联络人)/ },
  { key: 'emergencyPhone', type: 'tel', patterns: /(紧急联系电话|紧急联系方式|紧急电话)/ },

  // —— 事务/交易 ——
  { key: 'title', type: 'text', patterns: /^(标题|主题|名称)$/, extra: { maxLength: 60 } },
  { key: 'amount', type: 'number', patterns: /(报销金额|订单金额|金额|价格|单价|预算)|费用$/, extra: { min: 0, precision: 2, unit: '元' } },
  { key: 'quantity', type: 'integer', patterns: /(数量|个数|件数|人数|名额|台数|次数)/, extra: { min: 1 } },
  { key: 'orderNo', type: 'text', patterns: /(订单编号|订单号|流水号|编号)/ },
  { key: 'date', type: 'date', patterns: /^(日期|时间|发生日期)$/ },
  { key: 'datetime', type: 'datetime', patterns: /(日期时间|具体时间|时间点)/ },
  { key: 'category', type: 'select', patterns: /(所属分类|分类|类别|类型)/ },

  // —— 意见/评价 ——
  { key: 'suggestion', type: 'textarea', patterns: /(意见建议|建议|意见|想法|改进方向)/, extra: { rows: 4, placeholder: '欢迎写下你的想法' } },
  { key: 'description', type: 'textarea', patterns: /(问题描述|详细描述|描述|详情|具体情况)/, extra: { rows: 4 } },
  { key: 'remark', type: 'textarea', patterns: /(备注|补充说明|其他说明|其它)/, extra: { rows: 3 } },
  { key: 'satisfaction', type: 'rating', patterns: /(满意度|满意程度|总体评价)/, extra: { max: 5, icon: 'star' } },
  { key: 'rating', type: 'rating', patterns: /(评分|打分|星级|得分)/, extra: { max: 5 } },
  { key: 'score', type: 'number', patterns: /^(成绩|得分|分数|总分)$/, extra: { min: 0, max: 150 } },
  { key: 'reason', type: 'textarea', patterns: /(申请理由|理由|原因)/, extra: { rows: 3 } },

  // —— 上传（专有名词先于泛化名词，否则「身份证照片」会被「照片」抢先命中）——
  { key: 'idCardPhoto', type: 'file', patterns: /(身份证照片|身份证正反面|证件照)/, extra: { accept: 'image/*', maxSizeMB: 5 } },
  { key: 'resume', type: 'file', patterns: /(简历|个人简历)/, extra: { accept: '.pdf,.doc,.docx', maxSizeMB: 10 } },
  { key: 'photo', type: 'file', patterns: /(照片|头像|图片|扫码图)/, extra: { accept: 'image/*', maxSizeMB: 5 } },
  { key: 'attachment', type: 'file', patterns: /(附件|佐证材料|证明材料|文件上传|上传文件|上传附件|相关文件)/, extra: { maxSizeMB: 10 } },
];

/** 决策类字段：以「是否/能否/有无」开头。 */
const BOOLEAN_PREFIX = /^(是否|能否|有无|可否|有没有)/;

/** 「同意条款」类必勾选字段。 */
const CONSENT_PATTERN = /(同意|承诺|确认已阅读|已阅读并同意|授权|知情同意)/;

// ---------------------------------------------------------------------------
// 文本切分工具
// ---------------------------------------------------------------------------

/** 按中英文标点切分句子，保留结构感。 */
export function splitClauses(text) {
  return String(text ?? '')
    .split(/[。；;！!\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

const CONNECTORS = '(?:以及|还有|还要|也要|还需|还需要|另外|同时|并且|而且|加上|再有|其次|然后|最后|首先|接着|和|与|及|、|,|，|包含|包括|要有|需要有|需要|要求|请填写|请上传|填写|收集|录入|添加|提供|补充|：|:)';

/** 去掉短语开头的连接词/引导词。 */
function trimLead(text) {
  let out = text.trim();
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out.replace(new RegExp(`^${CONNECTORS}+`), '').trim();
  }
  return out;
}

/**
 * 把一个字段清单切成独立字段短语。
 *
 * 关键判断：`和/与/及` 只有在**两侧都能独立识别成字段**时才切分，
 * 否则「对公司的建议和意见」会被错误拆成两个字段。
 */
export function splitFieldList(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  // 括号里的内容常常是选项列表（「部门（技术、产品、设计）」），
  // 里面的「、」绝不能参与字段切分——先整体遮蔽，切完再还原。
  /** @type {string[]} */
  const maskedSpans = [];
  const masked = raw.replace(/[（(][^）)]*[）)]/g, match => {
    maskedSpans.push(match);
    return `\u0000${maskedSpans.length - 1}\u0000`;
  });
  const restore = piece => piece.replace(/\u0000(\d+)\u0000/g, (_, i) => maskedSpans[Number(i)] ?? '');

  const coarse = masked.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
  /** @type {string[]} */
  const result = [];

  for (const part of coarse) {
    const pieces = part.split(/(以及|还有|和|与|及)/).map(s => s.trim()).filter(Boolean);
    if (pieces.length <= 1) {
      if (part) result.push(restore(part));
      continue;
    }
    // 交替出现：片段, 连接词, 片段, ...
    const groups = [];
    let buffer = [];
    for (const piece of pieces) {
      if (['以及', '还有', '和', '与', '及'].includes(piece)) {
        groups.push(buffer.join(''));
        buffer = [];
      } else buffer.push(piece);
    }
    groups.push(buffer.join(''));

    const recognizable = groups.filter(Boolean).map(g => guessField(restore(g)));
    const semantics = recognizable.map(s => s?.key).filter(Boolean);
    const allRecognized = recognizable.length === groups.filter(Boolean).length && recognizable.every(Boolean);
    const allDistinct = new Set(semantics).size === groups.filter(Boolean).length;

    // 只在「两侧都是独立字段、且不是同义替换」时才切。
    // 「姓名和手机号」要切；「对公司的建议和意见」不该切——两者都指 suggestion，是同义并列而非两个字段。
    if (groups.length >= 2 && allRecognized && allDistinct && groups.every(g => g.length <= 12)) {
      result.push(...groups.filter(Boolean).map(restore));
    } else {
      result.push(restore(groups.join('和')));
    }
  }
  return result.filter(Boolean);
}

/** 显式类型词。命中说明用户在指名控件类型（「下拉框」「多行文本」），优先级高于语义推断。 */
const TYPE_WORD_PATTERN = /(下拉框|下拉菜单|下拉选择|下拉|单选框|复选框|多行文本|文本域|单行文本|文本框|输入框|文本|开关|滑块|评分|星级|日期时间|日期|时间|上传附件|上传文件|上传|附件|文件|整数|数字|邮箱|手机号|单选|多选)/;

/** 从一段文字里找出用户点名的控件类型词。 */
function matchTypeWord(text) {
  const word = TYPE_WORD_PATTERN.exec(String(text ?? ''))?.[1];
  return word ? normalizeFieldType(word) : null;
}

/** 看起来像「需要写一段话」的内容 → 多行文本。 */
const MULTILINE_HINT = /(说明|描述|原因|理由|备注|详情|情况|话|问题|意见|建议)/;

/**
 * 用语义词典猜一个短语是不是字段。返回猜到的语义或 null。
 *
 * 关键规则：**匹配位置最靠后的语义胜出**。
 *
 * 中文的语义中心词在末尾：「对公司的建议」的中心词是「建议」而不是「公司」，
 * 但它同时命中了 company（因为含「公司」）。早先取「第一个命中的语义」，
 * 结果这个字段被当成公司名。改成「最后命中者胜」后，
 * 「费用发生日期」（含「生日」）这类修饰语撞词的问题也一并对齐了直觉。
 */
export function guessField(phrase) {
  const text = String(phrase ?? '').trim();
  if (!text) return null;

  /** @type {{semantic: object, index: number, length: number}|null} */
  let best = null;
  for (const semantic of FIELD_SEMANTICS) {
    const pattern = new RegExp(semantic.patterns.source, `${semantic.patterns.flags.replace('g', '')}g`);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const index = match.index;
      const length = match[0].length;
      if (!best || index > best.index || (index === best.index && length > best.length)) {
        best = { semantic, index, length };
      }
      if (match[0].length === 0) break; // 防御空匹配死循环
    }
  }
  if (best) return best.semantic;

  if (BOOLEAN_PREFIX.test(text)) return { key: 'flag', type: 'switch', patterns: BOOLEAN_PREFIX };
  if (CONSENT_PATTERN.test(text)) return { key: 'agreement', type: 'switch', patterns: CONSENT_PATTERN, required: true };
  // 只有「整个短语就是一个类型词」才算数，不能因为标签里恰好含「说明」两个字就判成展示块。
  const bare = normalizeFieldTypeExact(text);
  if (bare) return { key: 'field', type: bare, patterns: /./ };
  return null;
}

// ---------------------------------------------------------------------------
// 域识别与标题抽取
// ---------------------------------------------------------------------------

const DOMAIN_RULES = [
  { domain: 'exam', patterns: /(试卷|考卷|考题|试题|命题|期中|期末|月考|测验|考试|组卷|答题|交卷)/, label: '考卷' },
  { domain: 'survey', patterns: /(问卷|调查|调研|满意度调查|测评)/, label: '问卷' },
  { domain: 'feedback', patterns: /(反馈|意见收集|投诉|评价表|建议收集)/, label: '反馈表' },
  { domain: 'registration', patterns: /(报名|登记|申请|入驻|应聘|入职|简历投递)/, label: '登记表' },
  { domain: 'collection', patterns: /(收集|采集|汇总|统计表|信息表|台账)/, label: '收集表' },
];

export function detectDomain(text) {
  const source = String(text ?? '');
  for (const rule of DOMAIN_RULES) {
    if (rule.patterns.test(source)) return { domain: rule.domain, label: rule.label };
  }
  return { domain: 'form', label: '表单' };
}

/** 从需求里抽出表单标题。 */
export function extractTitle(text) {
  const source = String(text ?? '').trim();

  const bracket = source.match(/[「【"']([^」】"']{2,30})[」】"']/);
  const named = source.match(/(?:叫做|名为|标题是|名称为|命名为)\s*[「【"']?([^」】"'，,。；;]{2,30})/);
  const made = source.match(/(?:做|建|创建|生成|设计|制作|弄|来|要|需要)\s*(?:一个|一份|一张|个|份|张)?\s*([^，,。；;：:]{2,24}?(?:表|表单|问卷|页面|系统|清单|台账|通知|统计表|信息表|收集表|调查表|登记表|申请表|反馈表|考卷|试卷))/);

  const candidate = bracket?.[1] ?? named?.[1] ?? made?.[1] ?? '';
  const cleaned = candidate
    .replace(/^(一个|一份|一张|个|份|张)/, '')
    .replace(/(?:的)?(?:在线|电子|动态|简单|简易)$/, '')
    .trim();
  if (cleaned) return cleaned;

  const firstClause = splitClauses(source)[0] ?? '';
  const trimmed = firstClause.replace(/^[^，,]{0,6}(?:做|建|生成|创建|设计|制作)/, '').trim();
  return (trimmed || `${detectDomain(source).label}（未命名）`).slice(0, 30);
}

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

/** 分组标题的形态：「基本信息」「一、基本信息」「基本信息：」 */
const GROUP_HEADING = /^(?:[一二三四五六七八九十]+[、.．)）]|\d+[、.．)）])?\s*([^：:]{2,12})\s*[：:]\s*(.*)$/;

/** 从句里出现这些动词，说明它在要求「填写某个东西」。 */
const FILL_VERB = /(填写|填入|填|输入|录入|写上?|上传|选择|选)/;

/**
 * 「……的话 + 动词」才是条件从句。
 *
 * 光看到「的话」不够：「最后写一句想对店长说**的话**」里的「的话」只是名词后缀，
 * 它本身就是一个字段名。真正的条件句在「的话」后面紧跟填写类动词。
 */
const CONDITIONAL_TAIL = /的话\s*[，,]?\s*(?:请|就|则|再|要)?\s*(?:填写|填入|填|输入|录入|写上?|上传|选择|选)/;

/**
 * 判断一个短语是不是**条件从句**而不是字段名。
 *
 *   「如果选其他就填具体问题」      → 条件从句
 *   「需要的话填车牌号」            → 条件从句
 *   「最后写一句想对店长说的话」    → 字段（「的话」是名词后缀）
 *   「备注（选填）」                → 字段
 */
export function isConditionClause(phrase) {
  const text = String(phrase ?? '').trim();
  if (!text) return false;
  if (CONDITIONAL_TAIL.test(text)) return true;
  return /^(如果|若|当|假如)/.test(text) && FILL_VERB.test(text);
}

// ---------------------------------------------------------------------------
// 字段短语解析
// ---------------------------------------------------------------------------

/**
 * 解析单个字段短语。
 * @returns {{field: object|null, notes: string[]}}
 */
export function parseFieldPhrase(phrase, index, usedKeys) {
  /** @type {string[]} */
  const notes = [];
  const rawPhrase = String(phrase ?? '').trim();
  let text = rawPhrase;
  if (!text) return { field: null, notes };

  // 1) 摘出括号里的提示（选项、必填标记、范围都藏在这里）
  const hints = [];
  text = text.replace(/[（(]([^）)]*)[）)]/g, (_, inner) => { hints.push(String(inner)); return ' '; }).trim();

  // 2) 去掉「上传/填写/请」这类动词前缀
  text = trimLead(text).replace(/^(请|需|要|想|希望)+/, '').trim();

  const hintText = hints.join('；');
  const haystack = `${text} ${hintText}`;

  // 3) 必填/选填判定
  let required = null;
  if (/(必填|必须填|必须填写|必选|一定要填|务必填)/.test(haystack)) { required = true; notes.push(`「${text}」按需求标记为必填`); }
  else if (/(选填|可选|非必填|不填也可|如有请填|没有可不填|自愿)/.test(haystack)) required = false;

  // 4) 多选判定
  const multiple = /(多选|可多选|多项选择|复选)/.test(haystack);

  // 5) 显式类型词优先于语义猜测
  let explicitType = matchTypeWord(haystack);
  if (explicitType && multiple && (explicitType === 'checkbox' || explicitType === 'select')) {
    // 「下拉多选」要保留下拉的选项列表语义，「多选」本身则是复选框
    explicitType = /下拉/.test(haystack) ? 'select' : 'checkbox';
  }

  // 6) 语义词典（同一套「最后命中者胜」规则，保证与 splitFieldList 的判断一致）
  let semantic = guessField(text);

  // 7) 选项抽取
  const optionSource = /(选项|可选值|枚举)\s*[：:]\s*([^；;]+)/.exec(hintText)?.[2] ?? hintText;
  let options = optionSource ? extractOptions(optionSource) : null;
  if (!options && semantic?.extra?.options) options = [...semantic.extra.options];

  // 7.5) 兜底抢救
  // 用户明确写了「填写 X / 写一句 X / 上传 X」，但词典不认识 X 时，
  // **绝不能把字段丢掉**——漏字段比判错类型严重得多：
  // 判错类型用户一眼能看出来并改，漏字段则意味着他以为收到了数据，其实什么都没收到。
  let salvaged = false;
  if (!explicitType && !semantic && !options) {
    // 注意要在**原始短语**上找动词：trimLead 已经把「请填写」这类引导词剥掉了，
    // 在剥完的文本里找动词永远找不到，这条兜底就成了死代码。
    const rescued = /(?:填写|填入|输入|录入|写一句|写上|写|提交|上传|提供|补充)\s*([^，,。；;]{2,18})/.exec(rawPhrase)?.[1]
      ?.trim()
      ?.replace(/^(你的|您的|我的|贵公司的?|其)/, '')
      ?.trim();
    if (rescued && rescued.length >= 2) {
      text = rescued;
      semantic = guessField(text);
      salvaged = true;
      notes.push(`「${rescued}」不在内置词典里，已按${MULTILINE_HINT.test(rescued) ? '多行文本' : '单行文本'}处理，可自行调整类型`);
    }
  }

  const type = explicitType ?? semantic?.type ?? (salvaged ? (MULTILINE_HINT.test(text) ? 'textarea' : 'text') : null);

  if (!type && !options) return { field: null, notes };

  // 8) 数值约束
  const extra = { ...(semantic?.extra ?? {}) };
  const range = /(\d+(?:\.\d+)?)\s*(?:[-~—至到]|\s*到\s*)\s*(\d+(?:\.\d+)?)/.exec(haystack);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      extra.min = min;
      extra.max = max;
      notes.push(`「${text}」识别到取值范围 ${min}-${max}`);
    }
  }
  const atLeast = /至少\s*(\d+)/.exec(haystack)?.[1];
  const atMost = /最多\s*(\d+)/.exec(haystack)?.[1];
  const maxChars = /(\d+)\s*字以内|不超过\s*(\d+)\s*字/.exec(haystack);
  if (maxChars) extra.maxLength = Number(maxChars[1] ?? maxChars[2]);

  // 9) 最终类型决策
  let finalType = type;
  if (!finalType) finalType = options ? (multiple ? 'checkbox' : 'select') : 'text';
  // 有选项的字段必须落到选择型控件上，否则选项会无处安放。
  if (options && !['select', 'radio', 'checkbox'].includes(finalType)) {
    finalType = multiple ? 'checkbox' : 'select';
  }
  if (multiple && finalType === 'radio') finalType = 'checkbox';
  if (multiple && finalType === 'select') extra.multiple = true;
  if (range && finalType === 'rating') extra.max = Number(range[2]);

  // 数值型的 min/max 只对数值控件有意义，丢弃会误导的属性
  if (!['number', 'integer', 'rating', 'slider', 'checkbox', 'select'].includes(finalType)) {
    delete extra.min;
    delete extra.max;
  }

  // 10) 标签与 key
  // 只剥离「控件词」和置尾动词，绝不剥离「日期/金额/备注/电话」这类本身就可能是标签的名词——
  // 否则「入职日期」会被削成「入职」，「费用发生日期」会被削成「费用发生」。
  let label = text
    .replace(/^(请|需|要|想|希望)+/, '')
    .replace(/^(下拉框|下拉菜单|下拉选择|下拉|单选框|复选框|多行文本|文本域|单行文本|文本框|输入框|文本|上传|填写)+/, '')
    .replace(/(上传|填写)$/, '')
    .replace(/的$/, '')
    .trim();
  // 剥完什么都不剩，说明整个短语就是个控件词，回退到原短语
  if (!label) label = text || semantic?.label || `字段${index + 1}`;
  label = label.replace(/^[、,，\s]+|[、,，\s]+$/g, '');
  if (!label) label = `字段${index + 1}`;

  // 'field' / 'flag' 只是「判出了类型、没判出语义」的占位，不能拿来当字段 key。
  const semanticKey = semantic && !['field', 'flag'].includes(semantic.key) ? semantic.key : null;
  const key = semanticKey && !usedKeys.has(semanticKey) ? semanticKey : deriveKey(label, index, usedKeys);
  usedKeys.add(key);

  /** @type {Record<string, unknown>} */
  const field = { key, label, type: finalType };
  if (options) field.options = options;

  const finalRequired = required ?? semantic?.required ?? false;
  if (finalRequired) field.required = true;
  if (atLeast && ['checkbox', 'select'].includes(finalType)) field.min = Number(atLeast);
  if (atMost) {
    if (['checkbox', 'select', 'file'].includes(finalType)) field.max = Number(atMost);
    else if (Number.isFinite(Number(atMost))) field.maxLength = Number(atMost);
  }

  for (const [k, v] of Object.entries(extra)) {
    if (field[k] === undefined) field[k] = v;
  }

  // 11) 说明文字
  const helpHint = hints.find(h => /(说明|提示|格式|例如|如：)/.test(h) && !/(必填|选填|多选)/.test(h));
  if (helpHint) field.help = helpHint.replace(/^(说明|提示|格式)\s*[：:]?\s*/, '');
  if (!field.help && semantic?.extra?.help) field.help = semantic.extra.help;

  return { field, notes };
}

/** 从提示文本里抽选项。 */
export function extractOptions(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const explicit = /(?:选项|可选值|枚举)\s*[：:]\s*(.+)$/.exec(raw)?.[1] ?? raw;
  const parts = explicit
    .split(/[\/、|｜]|或者|或/)
    .map(s => s.replace(/^[（(【\[]|[）)】\]]$/g, '').trim())
    .filter(s => s && s.length <= 20 && !/(必填|选填|多选|单选|范围|说明|提示|例如|请|以上|以下)$/.test(s));

  const unique = [...new Set(parts)];
  return unique.length >= 2 ? unique : null;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析表单类需求。
 *
 * @param {string} text 自然语言需求
 * @param {{source?: string, defaultTitle?: string}} [options]
 * @returns {{schema: object, issues: string[], understanding: object}}
 */
export function parseRequirement(text, options = {}) {
  const source = String(text ?? '').trim();
  if (!source) throw new FormgenError('NLP_EMPTY_INPUT', '需求文本为空');

  const domain = detectDomain(source);
  const title = options.defaultTitle ?? extractTitle(source);
  const clauses = splitClauses(source);

  /** @type {Array<{title: string, fields: object[]}>} */
  const groups = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const issues = [];

  const usedKeys = new Set();
  let fieldIndex = 0;
  let currentGroup = { title: '', fields: [] };

  const pushCurrent = () => {
    if (currentGroup.fields.length) groups.push(currentGroup);
  };

  for (const clause of clauses) {
    const headingMatch = GROUP_HEADING.exec(clause);
    let body = clause;
    if (headingMatch && headingMatch[2] && headingMatch[1].length <= 12) {
      const headingText = headingMatch[1];
      // 反例：「做一个客户满意度调查问卷：姓名、手机号…」——冒号前是**标题句**，不是分组标题。
      // 判据：含动词、等于表单标题、或过长。
      const looksLikeTitle = /(做|建|生成|创建|设计|制作|需要|帮我|想要|来个)/.test(headingText)
        || headingText === title
        || headingText.length > 10;
      if (!looksLikeTitle) {
        pushCurrent();
        currentGroup = { title: headingText, fields: [] };
        body = headingMatch[2];
        notes.push(`识别到分组「${headingText}」`);
      }
    }

    // 去掉「做一个 XX 表：」这类标题前缀，只在冒号前有实义内容时才剥。
    const listText = body.replace(/^[^：:]{3,}[：:]/, '');
    const phrases = splitFieldList(listText);

    for (const phrase of phrases) {
      // 条件从句（「如果…就填写 X」「……的话，填 X」）归 extractConditions 统一处理，
      // 不能当字段短语解析：否则既会造出垃圾字段（「的话填方便回电时间」），
      // 又会让真正的目标字段被创建两次。
      if (isConditionClause(phrase)) continue;

      const { field, notes: fieldNotes } = parseFieldPhrase(phrase, fieldIndex, usedKeys);
      if (!field) continue;
      fieldIndex += 1;
      currentGroup.fields.push(field);
      notes.push(...fieldNotes);
    }
  }
  pushCurrent();

  if (!groups.length) {
    throw new FormgenError('NLP_NO_FIELD', `没能从需求里识别出任何字段。请把需求写得更具体，例如：「做一个报名表，包含姓名、手机号、意向部门（技术/产品）」`, { detail: { source } });
  }

  // 条件逻辑：扫描「如果是/选择X时/……的话，填写Y」
  const conditionalHints = extractConditions(source, groups, usedKeys);
  notes.push(...conditionalHints.notes);
  issues.push(...conditionalHints.issues);

  // 字段顺序应follow需求里被提到的先后。
  // 联动补建的字段是最后追加的，不重排就会跑到表单末尾，读起来很突兀——
  // 用户叙述的顺序本身就是他期望的填写顺序。
  for (const group of groups) {
    group.fields = group.fields
      .map((field, order) => ({ field, order, at: source.indexOf(field.label) }))
      .sort((a, b) => {
        if (a.at >= 0 && b.at >= 0) return a.at - b.at || a.order - b.order;
        if (a.at >= 0 !== b.at >= 0) return a.at >= 0 ? -1 : 1;
        return a.order - b.order;
      })
      .map(item => item.field);
  }

  // 考卷类需求不应走表单通道
  if (domain.domain === 'exam') {
    notes.push('检测到考卷类需求，建议使用考卷通道（formgen exam）以获得组卷与自动评分能力');
  }

  const { schema, issues: normalizeIssues } = normalizeSchema({
    title,
    kind: domain.domain === 'survey' ? 'survey' : (domain.domain === 'collection' ? 'collection' : 'form'),
    description: '',
    groups,
    settings: {
      submitText: domain.domain === 'survey' ? '提交问卷' : '提交',
      successMessage: '提交成功，感谢你的填写！',
    },
    meta: { source: options.source ?? 'nlp', sourceText: source, generator: 'rule-based' },
  }, { source: options.source ?? 'nlp' });

  schema.meta.notes = notes.slice(0, 40);
  issues.push(...normalizeIssues);

  return {
    schema,
    issues,
    understanding: {
      domain: domain.domain,
      domainLabel: domain.label,
      title,
      fieldCount: fieldIndex,
      groupCount: groups.length,
      notes,
      clauses,
    },
  };
}

/**
 * 抽取条件显示逻辑。
 *
 * 支持的说法：
 *   「选择技术部时，需要填写技术栈」
 *   「如果是技术部，请填写使用的技术栈」
 *   「只有选了需要发票，才填写抬头」
 */
function extractConditions(source, groups, usedKeys) {
  const notes = [];
  const issues = [];
  const allFields = groups.flatMap(g => g.fields);
  const optionValue = option => (typeof option === 'string' ? option : option?.value);
  const lastGroup = () => groups[groups.length - 1] ?? groups[0];

  /** 找到目标字段；不存在且名字合理时补建一个（用户说了要填的东西不该被丢掉）。 */
  const ensureTarget = targetText => {
    const found = allFields.find(f => f.label === targetText)
      ?? allFields.find(f => f.label.length >= 2 && targetText.includes(f.label));
    if (found) return { target: found, created: false };
    if (targetText.length < 2 || targetText.length > 16) return { target: null, created: false };

    const target = {
      key: deriveKey(targetText, allFields.length, usedKeys),
      label: targetText,
      // 同样先看用户有没有点名控件类型（「方便回电时间」→ 时间），再退回文本推断。
      type: matchTypeWord(targetText) ?? (MULTILINE_HINT.test(targetText) ? 'textarea' : 'text'),
    };
    lastGroup().fields.push(target);
    allFields.push(target);
    return { target, created: true };
  };

  const bind = (trigger, targetText, expression, conditionLabel) => {
    const { target, created } = ensureTarget(targetText);
    if (!target || target.key === trigger.key) return false;
    if (created) notes.push(`需求里提到的「${targetText}」原本没有对应字段，已自动补建`);
    target.visibleWhen = expression;
    notes.push(`联动：${trigger.label} ${conditionLabel} 时显示「${target.label}」`);
    return true;
  };

  let matched = 0;

  // 形式一：「如果 / 选择 X 时，填写 Y」——触发条件在句子里被明确写出来。
  // 捕获类必须把「、」也算作边界：它是字段清单的分隔符。
  // 否则目标捕获会试图吞掉后面整串字段，撞上 16 字上限后整个匹配直接失败。
  const explicitPattern = /(?:如果|若|当|选择|选了|勾选|填了)\s*[「"']?([^「」"'，,。；;、]{1,14}?)[」"']?\s*(?:时|的话|则|就|，|,)?\s*(?:需要|请|则|就|必须|要)?\s*(?:填写|填|选择|上传|录入|输入)\s*[「"']?([^「」"'，,。；;、]{1,16}?)[」"']?(?=[，,。；;、]|$)/g;

  let match;
  while ((match = explicitPattern.exec(source)) !== null) {
    // 触发条件的写法可能是「如果选其他」「勾选是」——动词要剥掉才找得到选项值。
    const triggerText = match[1].trim().replace(/^(是|了|选|选择|勾选|填|填写)+/, '');
    const targetText = match[2].trim();
    if (!triggerText || !targetText) continue;

    // 触发条件可能是某个字段的标签，也可能是某个字段的**某个选项**（「如果是素食…」）。
    const trigger = allFields.find(f => f.label === triggerText)
      ?? allFields.find(f => (f.options ?? []).some(o => optionValue(o) === triggerText))
      ?? allFields.find(f => f.label.length >= 2 && triggerText.includes(f.label));
    if (!trigger) continue;

    if (bind(trigger, targetText, `${trigger.key} == "${triggerText}"`, `= 「${triggerText}」`)) matched += 1;

    // 触发字段是选择型但选项里没有这个取值时补上——需求里出现过的取值理应可选。
    if (['select', 'radio', 'checkbox'].includes(trigger.type) && triggerText.length <= 20) {
      if (!Array.isArray(trigger.options)) trigger.options = [];
      if (!trigger.options.some(o => optionValue(o) === triggerText)) {
        trigger.options.push(triggerText);
        notes.push(`为「${trigger.label}」补充选项「${triggerText}」`);
      }
    }
  }

  // 形式二：「……的话，填写 Y」——触发条件是**紧邻其前刚被提到过的那个字段**。
  // 「是否需要停车位，需要的话填车牌号」是中文里极常见的说法，
  // 但句子里并没有再点名触发字段，只能靠「离它最近的那个字段」来推断。
  const implicitPattern = /的?话\s*[，,]?\s*(?:请|就|则|再|要)?\s*(?:填写|填|输入|录入|上传|写上?)\s*([^，,。；;、]{2,16})/g;
  while ((match = implicitPattern.exec(source)) !== null) {
    const targetText = match[1].trim();
    if (!targetText) continue;

    const before = source.slice(0, match.index);
    let trigger = null;
    let latest = -1;
    for (const field of allFields) {
      const at = before.lastIndexOf(field.label);
      if (at > latest) { latest = at; trigger = field; }
    }
    if (!trigger || latest < 0) continue;

    // switch 类字段直接判真值；选择类字段判「已填写」。
    const expression = trigger.type === 'switch'
      ? `${trigger.key} == true`
      : `!empty(${trigger.key})`;
    if (bind(trigger, targetText, expression, trigger.type === 'switch' ? '开启' : '已填写')) matched += 1;
  }

  if (matched === 0 && /(如果|若|当|条件|联动|的话)/.test(source)) {
    issues.push('需求里似乎含有条件逻辑，但未能可靠解析；建议在生成的表单上用可视化编辑器手动补充');
  }
  return { notes, issues };
}

/** 供 CLI / 测试使用的便捷包装：只拿 Schema。 */
export function generateSchemaFromText(text, options = {}) {
  return parseRequirement(text, options).schema;
}
