/**
 * 表单运行时（浏览器端）。
 *
 * 这里做了一件对整个项目很关键的事：**直接 import 服务端的引擎源码**。
 *
 *   src/core/validate.js  ← Node 里用它校验提交
 *                         ← 浏览器里也用它校验输入
 *
 * 因为引擎是零依赖的纯 ESM，服务端把 `src/` 原样挂在 `/engine/` 下即可复用。
 * 于是「生成即校验」不是靠约定，而是靠**同一份代码**保证的：
 * 前端不可能通过一个后端不接受的输入，因为判定逻辑就是同一个函数。
 *
 * 运行时的职责只有三件：把 Schema 变成 DOM、把 DOM 变回数据、把数据交给校验器。
 */

import {
  defaultValues, resolveVisibility, applyComputations, validateSubmission, completionRatio,
} from '/engine/core/validate.js';

/** 公式渲染：模块缺失时优雅降级为纯文本，绝不让整页挂掉。 */
let renderRichText = text => escapeHtml(String(text ?? '')).replace(/\n/g, '<br>');
try {
  const latex = await import('/engine/latex/mathml.js');
  if (typeof latex.renderRichText === 'function') renderRichText = latex.renderRichText;
  else if (typeof latex.latexToMathML === 'function') {
    renderRichText = text => escapeHtml(String(text ?? '')).replace(/\$([^$]+)\$/g, (_, tex) => latex.latexToMathML(tex));
  }
} catch { /* 保留纯文本降级 */ }

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DRAFT_KEY = `formgen:draft:${location.pathname}`;
const MAX_INLINE_UPLOAD = 2 * 1024 * 1024; // 2MB 以内走 base64 内联，超过则拒绝

const state = {
  schema: null,
  values: {},
  errors: new Map(),
  visible: new Map(),
  submitting: false,
  submitted: false,
  touched: new Set(),
};

const nodes = new Map(); // field.key -> { wrap, input }

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function optionList(field) {
  return (field.options ?? []).map(o => (typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value }));
}

function renderLabel(field) {
  const label = el('label', { class: 'fg-label', for: `fg-${field.key}` });
  label.append(el('span', { class: 'fg-label-text', html: renderRichText(field.label) }));
  if (field.required) label.append(el('span', { class: 'fg-required', title: '必填', text: '*' }));
  if (field.compute) label.append(el('span', { class: 'fg-badge', text: '自动计算' }));
  return label;
}

function renderControl(field) {
  const id = `fg-${field.key}`;
  const value = state.values[field.key];
  const common = { id, name: field.key, 'data-key': field.key };

  switch (field.type) {
    case 'textarea':
      return el('textarea', { ...common, rows: field.rows ?? 3, placeholder: field.placeholder ?? '', maxlength: field.maxLength });

    case 'number': case 'integer':
      return el('input', {
        ...common, type: 'number', value: value ?? '',
        min: field.min, max: field.max, step: field.step ?? (field.type === 'integer' ? 1 : 'any'),
        placeholder: field.placeholder ?? '',
      });

    case 'tel': return el('input', { ...common, type: 'tel', value: value ?? '', placeholder: field.placeholder ?? '请输入手机号', inputmode: 'numeric' });
    case 'email': return el('input', { ...common, type: 'email', value: value ?? '', placeholder: field.placeholder ?? 'name@example.com' });
    case 'url': return el('input', { ...common, type: 'url', value: value ?? '', placeholder: field.placeholder ?? 'https://' });
    case 'idcard': return el('input', { ...common, type: 'text', value: value ?? '', placeholder: field.placeholder ?? '18 位身份证号', maxlength: 18 });
    case 'date': return el('input', { ...common, type: 'date', value: value ?? '', min: field.minDate, max: field.maxDate });
    case 'datetime': return el('input', { ...common, type: 'datetime-local', value: String(value ?? '').replace('Z', '').slice(0, 16) });
    case 'time': return el('input', { ...common, type: 'time', value: value ?? '' });

    case 'select': {
      const select = el('select', { ...common, multiple: field.multiple || undefined });
      select.append(el('option', { value: '', text: field.placeholder ?? '请选择' }));
      for (const option of optionList(field)) {
        select.append(el('option', { value: option.value, text: option.label, selected: field.multiple ? (value ?? []).includes(option.value) : value === option.value }));
      }
      return select;
    }

    case 'radio': {
      const group = el('div', { class: `fg-options${field.inline ? ' fg-inline' : ''}`, role: 'radiogroup' });
      for (const [index, option] of optionList(field).entries()) {
        const inputId = `${id}-${index}`;
        group.append(el('label', { class: 'fg-option', for: inputId }, [
          el('input', { type: 'radio', id: inputId, name: field.key, value: option.value, 'data-key': field.key, checked: value === option.value }),
          el('span', { html: renderRichText(option.label) }),
        ]));
      }
      return group;
    }

    case 'checkbox': {
      const group = el('div', { class: `fg-options${field.inline ? ' fg-inline' : ''}` });
      const selected = Array.isArray(value) ? value : [];
      for (const [index, option] of optionList(field).entries()) {
        const inputId = `${id}-${index}`;
        group.append(el('label', { class: 'fg-option', for: inputId }, [
          el('input', { type: 'checkbox', id: inputId, name: field.key, value: option.value, 'data-key': field.key, checked: selected.includes(option.value) }),
          el('span', { html: renderRichText(option.label) }),
        ]));
      }
      return group;
    }

    case 'switch':
      return el('label', { class: 'fg-switch' }, [
        el('input', { ...common, type: 'checkbox', checked: value === true, role: 'switch' }),
        el('span', { class: 'fg-switch-track' }, [el('span', { class: 'fg-switch-thumb' })]),
        el('span', { class: 'fg-switch-text', text: value === true ? (field.onLabel ?? '是') : (field.offLabel ?? '否') }),
      ]);

    case 'rating': {
      const max = field.max ?? 5;
      const min = field.min ?? 0;
      const group = el('div', { class: 'fg-rating', role: 'radiogroup' });
      for (let i = max; i >= (min || 1); i -= 1) {
        const inputId = `${id}-${i}`;
        group.append(el('label', { class: 'fg-star', for: inputId, title: `${i} 分` }, [
          el('input', { type: 'radio', id: inputId, name: field.key, value: String(i), 'data-key': field.key, checked: Number(value) === i }),
          el('span', { text: '★' }),
        ]));
      }
      group.append(el('output', { class: 'fg-rating-value', text: value ? `${value} 分` : '' }));
      return group;
    }

    case 'slider': {
      const wrap = el('div', { class: 'fg-slider' });
      const output = el('output', { text: value === '' || value === undefined ? String(field.min ?? 0) : String(value) });
      wrap.append(el('input', {
        ...common, type: 'range', value: value === '' || value === undefined ? (field.min ?? 0) : value,
        min: field.min ?? 0, max: field.max ?? 100, step: field.step ?? 1,
      }), output);
      return wrap;
    }

    case 'file': {
      const wrap = el('div', { class: 'fg-file' });
      const input = el('input', { ...common, type: 'file', accept: field.accept, multiple: field.multiple || undefined });
      const list = el('ul', { class: 'fg-file-list' });
      const current = field.multiple ? (Array.isArray(value) ? value : []) : (value ? [value] : []);
      for (const item of current) list.append(el('li', { text: `${item.name} (${formatSize(item.size)})` }));
      wrap.append(input, list);
      return wrap;
    }

    case 'matrix': {
      const table = el('table', { class: 'fg-matrix' });
      const head = el('tr', {}, [el('th', { text: '' }), ...optionList(field).map(o => el('th', { text: o.label }))]);
      table.append(el('thead', {}, [head]));
      const body = el('tbody');
      const current = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
      const rows = (field.rows ?? []).map(r => (typeof r === 'string' ? { value: r, label: r } : r));
      for (const [rowIndex, row] of rows.entries()) {
        const cells = [el('th', { text: row.label })];
        for (const [colIndex, option] of optionList(field).entries()) {
          const inputId = `${id}-${rowIndex}-${colIndex}`;
          cells.push(el('td', {}, [el('input', {
            type: 'radio', id: inputId, name: `${field.key}.${row.value}`, value: option.value,
            'data-key': field.key, 'data-row': row.value, checked: current[row.value] === option.value,
          })]));
        }
        body.append(el('tr', {}, cells));
      }
      table.append(body);
      return table;
    }

    case 'question': {
      const question = field.question ?? {};
      const wrap = el('div', { class: 'fg-question' });
      const options = optionList({ options: question.options });

      if (question.type === 'choice' || question.type === 'multi') {
        const type = question.type === 'multi' ? 'checkbox' : 'radio';
        const selected = question.type === 'multi' ? (Array.isArray(value) ? value : []) : value;
        for (const [index, option] of options.entries()) {
          const inputId = `${id}-${index}`;
          wrap.append(el('label', { class: 'fg-option fg-question-option', for: inputId }, [
            el('input', {
              type, id: inputId, name: field.key, value: option.value,
              'data-key': field.key, 'data-question': question.type, checked: type === 'radio' ? selected === option.value : selected.includes(option.value),
            }),
            el('span', { class: 'fg-option-key', text: option.value }),
            el('span', { html: renderRichText(option.label.replace(new RegExp(`^${escapeRegExp(option.value)}[\\.、]?\\s*`), '')) }),
          ]));
        }
      } else if (question.type === 'judge') {
        for (const [index, label] of ['对', '错'].entries()) {
          const inputId = `${id}-j${index}`;
          wrap.append(el('label', { class: 'fg-option fg-inline-option', for: inputId }, [
            el('input', { type: 'radio', id: inputId, name: field.key, value: label === '对' ? 'true' : 'false', 'data-key': field.key, 'data-question': 'judge', checked: (value === true && label === '对') || (value === false && label === '错') }),
            el('span', { text: label }),
          ]));
        }
      } else if (question.type === 'blank') {
        const blanks = Number(question.blanks) || Math.max(1, (String(question.stem ?? '').match(/_{2,}|＿{2,}/g) ?? []).length);
        const list = Array.isArray(value) ? value : [''];
        const grid = el('div', { class: 'fg-blanks' });
        for (let i = 0; i < blanks; i += 1) {
          grid.append(el('div', { class: 'fg-blank' }, [
            el('span', { class: 'fg-blank-no', text: `第 ${i + 1} 空` }),
            el('input', { type: 'text', class: 'fg-blank-input', 'data-key': field.key, 'data-blank': String(i), value: list[i] ?? '', placeholder: '填写答案' }),
          ]));
        }
        wrap.append(grid);
      } else {
        const rows = question.type === 'proof' ? 6 : 5;
        wrap.append(el('textarea', { ...common, rows, placeholder: '请写出你的解答过程…' }));
      }
      return wrap;
    }

    default:
      return el('input', { ...common, type: 'text', value: value ?? '', placeholder: field.placeholder ?? '' });
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function renderField(field) {
  if (field.type === 'section') {
    return { node: el('h3', { class: 'fg-section', html: renderRichText(field.label) }), field };
  }
  if (field.type === 'statement') {
    return { node: el('div', { class: 'fg-statement', html: renderRichText(field.content ?? '') }), field };
  }

  const wrap = el('div', { class: 'fg-field', 'data-field': field.key });
  const head = el('div', { class: 'fg-field-head' }, [renderLabel(field)]);
  if (field.type === 'question' && field.question) {
    head.append(el('span', { class: 'fg-question-score', text: `${field.question.score ?? 0} 分` }));
  }
  wrap.append(head);

  if (field.type === 'question' && field.question?.stem) {
    wrap.append(el('div', { class: 'fg-stem', html: renderRichText(field.question.stem) }));
  }

  const control = renderControl(field);
  const controlWrap = el('div', { class: 'fg-control' }, [control]);
  wrap.append(controlWrap);

  if (field.help) wrap.append(el('p', { class: 'fg-help', html: renderRichText(field.help) }));
  const errorNode = el('p', { class: 'fg-error', hidden: true });
  wrap.append(errorNode);

  nodes.set(field.key, { wrap, input: control, errorNode, field });
  return { node: wrap, field };
}

function renderForm() {
  const root = document.getElementById('formgen-root');
  root.innerHTML = '';

  if (state.schema.description) {
    root.append(el('p', { class: 'fg-description', html: renderRichText(state.schema.description) }));
  }
  if (state.schema.settings?.notice) {
    root.append(el('div', { class: 'fg-notice', html: renderRichText(state.schema.settings.notice) }));
  }

  for (const group of state.schema.groups) {
    const section = el('section', { class: 'fg-group', 'data-group': group.key });
    if (group.title) section.append(el('h2', { class: 'fg-group-title', text: group.title }));
    if (group.description) section.append(el('p', { class: 'fg-group-desc', html: renderRichText(group.description) }));
    const body = el('div', { class: 'fg-group-body' });
    for (const field of group.fields) {
      const { node } = renderField(field);
      if (field.columns === 2) node.classList.add('fg-col-2');
      body.append(node);
    }
    section.append(body);
    root.append(section);
  }

  const submitText = state.schema.settings?.submitText ?? '提交';
  const actions = el('div', { class: 'fg-actions' }, [
    el('button', { type: 'submit', class: 'fg-submit', id: 'formgen-submit', text: submitText }),
    el('button', { type: 'button', class: 'fg-reset', id: 'formgen-clear', text: '清空重填' }),
  ]);
  root.append(actions);
}

// ---------------------------------------------------------------------------
// DOM ⇄ 数据
// ---------------------------------------------------------------------------

function readValue(field) {
  const entry = nodes.get(field.key);
  if (!entry) return state.values[field.key];

  if (field.type === 'matrix') {
    const result = {};
    for (const row of (field.rows ?? [])) {
      const rowValue = typeof row === 'string' ? row : row.value;
      const checked = entry.wrap.querySelector(`input[data-row="${CSS.escape(rowValue)}"]:checked`);
      if (checked) result[rowValue] = checked.value;
    }
    return result;
  }
  if (field.type === 'question') {
    const question = field.question ?? {};
    if (question.type === 'multi') {
      return [...entry.wrap.querySelectorAll(`input[type="checkbox"]:checked`)].map(i => i.value);
    }
    if (question.type === 'choice') {
      const checked = entry.wrap.querySelector('input[type="radio"]:checked');
      return checked ? checked.value : '';
    }
    if (question.type === 'judge') {
      const checked = entry.wrap.querySelector('input[type="radio"]:checked');
      return checked ? checked.value === 'true' : '';
    }
    if (question.type === 'blank') {
      return [...entry.wrap.querySelectorAll('input[data-blank]')].map(i => i.value);
    }
    const textarea = entry.wrap.querySelector('textarea');
    return textarea ? textarea.value : '';
  }
  if (field.type === 'checkbox') {
    return [...entry.wrap.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
  }
  if (field.type === 'radio' || field.type === 'rating') {
    const checked = entry.wrap.querySelector('input[type="radio"]:checked');
    return checked ? checked.value : '';
  }
  if (field.type === 'switch') {
    const input = entry.wrap.querySelector('input[type="checkbox"]');
    return input ? input.checked : false;
  }
  if (field.type === 'file') {
    const input = entry.wrap.querySelector('input[type="file"]');
    const existing = state.values[field.key];
    if (!input || !input.files || input.files.length === 0) return existing ?? (field.multiple ? [] : null);
    return existing ?? (field.multiple ? [] : null);
  }
  if (field.type === 'slider') {
    const input = entry.wrap.querySelector('input[type="range"]');
    return input ? input.value : '';
  }
  const input = entry.wrap.querySelector('input, textarea, select');
  if (!input) return state.values[field.key];
  if (field.type === 'select' && field.multiple) return [...input.selectedOptions].map(o => o.value);
  return input.value;
}

function collectValues() {
  for (const group of state.schema.groups) {
    for (const field of group.fields) {
      if (field.type === 'section' || field.type === 'statement') continue;
      if (field.compute) continue;
      state.values[field.key] = readValue(field);
    }
  }
  return state.values;
}

// ---------------------------------------------------------------------------
// 刷新：可见性 → 计算 → 错误
// ---------------------------------------------------------------------------

function refresh(options = {}) {
  const values = collectValues();
  state.values = applyComputations(state.schema, values);
  state.visible = resolveVisibility(state.schema, state.values);

  for (const group of state.schema.groups) {
    const groupVisible = state.visible.get(group.fields[0]?.key) !== false;
    const section = document.querySelector(`[data-group="${CSS.escape(group.key)}"]`);
    if (section) section.hidden = !groupVisible;

    for (const field of group.fields) {
      const entry = nodes.get(field.key);
      if (!entry) continue;
      const visible = state.visible.get(field.key) !== false;
      entry.wrap.hidden = !visible;
      if (!visible) continue;

      if (field.compute) {
        const target = entry.wrap.querySelector('input, textarea, select, output');
        const computed = state.values[field.key];
        if (target && 'value' in target) target.value = computed === undefined || computed === null ? '' : String(computed);
        else if (target) target.textContent = computed === undefined || computed === null ? '' : String(computed);
      }
      if (field.type === 'slider') {
        const output = entry.wrap.querySelector('output');
        if (output) output.textContent = String(state.values[field.key] ?? '');
      }
      if (field.type === 'switch') {
        const text = entry.wrap.querySelector('.fg-switch-text');
        if (text) text.textContent = state.values[field.key] === true ? (field.onLabel ?? '是') : (field.offLabel ?? '否');
      }
      if (field.type === 'rating') {
        const output = entry.wrap.querySelector('.fg-rating-value');
        if (output) output.textContent = state.values[field.key] ? `${state.values[field.key]} 分` : '';
      }

      // 只在用户碰过、或提交过之后才展示错误，避免一进页面满屏红字。
      if (options.showErrors || state.touched.has(field.key)) showFieldError(field.key);
    }
  }

  updateProgress();
  saveDraft();
}

function showFieldError(key) {
  const entry = nodes.get(key);
  if (!entry) return;
  const message = state.errors.get(key);
  entry.errorNode.hidden = !message;
  entry.errorNode.textContent = message ?? '';
  entry.wrap.classList.toggle('fg-invalid', Boolean(message));
}

function updateProgress() {
  const bar = document.getElementById('formgen-progress-bar');
  const text = document.getElementById('formgen-progress-text');
  if (!bar) return;
  const { filled, total, ratio } = completionRatio(state.schema, state.values);
  bar.style.width = `${Math.round(ratio * 100)}%`;
  if (text) text.textContent = `${filled} / ${total} 项已填`;
}

function saveDraft() {
  try {
    const serializable = {};
    for (const [key, value] of Object.entries(state.values)) {
      if (key.startsWith('_')) continue;
      serializable[key] = value;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ values: serializable, at: Date.now() }));
  } catch { /* 隐私模式/超额：忽略 */ }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.values) return null;
    return parsed;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// 文件上传（内联 base64）
// ---------------------------------------------------------------------------

async function readFiles(field, fileList) {
  const files = [...fileList];
  const results = [];
  for (const file of files) {
    if (file.size > MAX_INLINE_UPLOAD) {
      state.errors.set(field.key, `${file.name} 超过 ${formatSize(MAX_INLINE_UPLOAD)} 上限，请压缩后再上传`);
      showFieldError(field.key);
      continue;
    }
    const dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    results.push({ name: file.name, size: file.size, type: file.type, ...(dataUrl ? { dataUrl } : {}) });
  }
  return field.multiple ? results : results[0];
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bindEvents() {
  const root = document.getElementById('formgen-root');

  root.addEventListener('input', event => {
    const target = event.target;
    if (!target || !(target instanceof HTMLElement)) return;
    const fieldKey = target.dataset?.key;
    if (fieldKey) state.touched.add(fieldKey);

    if (target instanceof HTMLInputElement && target.type === 'file') return;
    refresh();
  });

  root.addEventListener('change', async event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'file') { refresh(); return; }
    const fieldKey = target.dataset.key;
    const field = findField(fieldKey);
    if (!field) return;
    const files = await readFiles(field, target.files);
    if (files && (Array.isArray(files) ? files.length : true)) {
      state.values[fieldKey] = files;
      const entry = nodes.get(fieldKey);
      const list = entry?.wrap.querySelector('.fg-file-list');
      if (list) {
        list.innerHTML = '';
        for (const item of (Array.isArray(files) ? files : [files])) {
          list.append(el('li', { text: `${item.name} (${formatSize(item.size)})` }));
        }
      }
      state.errors.delete(fieldKey);
      showFieldError(fieldKey);
    }
    refresh();
  });

  root.addEventListener('blur', event => {
    const fieldKey = event.target?.dataset?.key;
    if (!fieldKey) return;
    state.touched.add(fieldKey);
    validateAll({ silent: true });
    showFieldError(fieldKey);
  }, true);

  document.getElementById('formgen-clear')?.addEventListener('click', () => {
    if (!confirm('确定要清空所有已填内容吗？')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    state.values = defaultValues(state.schema);
    state.errors.clear();
    state.touched.clear();
    renderForm();
    bindEvents();
    refresh();
  });

  document.getElementById('formgen-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    await submit();
  });
}

function findField(key) {
  for (const group of state.schema.groups) {
    for (const field of group.fields) if (field.key === key) return field;
  }
  return null;
}

function validateAll(options = {}) {
  collectValues();
  const result = validateSubmission(state.schema, state.values, { partial: false });
  state.values = result.values;
  state.errors = new Map(result.errors.map(e => [e.key, e.message]));
  if (!options.silent) {
    for (const group of state.schema.groups) {
      for (const field of group.fields) showFieldError(field.key);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

async function submit() {
  if (state.submitting || state.submitted) return;
  const result = validateAll();

  if (!result.ok) {
    const first = document.querySelector('.fg-invalid');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setStatus(`还有 ${result.errors.length} 项需要修正`, 'error');
    return;
  }

  state.submitting = true;
  const button = document.getElementById('formgen-submit');
  if (button) { button.disabled = true; button.textContent = '提交中…'; }
  setStatus('正在提交…', 'info');

  try {
    const response = await fetch(location.pathname.replace(/\/fill\/?$/, '') + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formId: state.schema.id,
        values: state.values,
        meta: { completedRatio: completionRatio(state.schema, state.values).ratio },
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message ?? `服务器返回 ${response.status}`);
    }
    state.submitted = true;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    showSuccess(payload);
  } catch (error) {
    state.submitting = false;
    if (button) { button.disabled = false; button.textContent = state.schema.settings?.submitText ?? '提交'; }
    setStatus(`提交失败：${error.message}`, 'error');
  }
}

function setStatus(message, tone) {
  const node = document.getElementById('formgen-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
}

function showSuccess(payload) {
  const body = document.getElementById('formgen-body');
  if (!body) return;
  const message = payload?.message ?? state.schema.settings?.successMessage ?? '提交成功，感谢你的填写！';
  body.innerHTML = '';
  body.append(el('div', { class: 'fg-success' }, [
    el('div', { class: 'fg-success-icon', text: '✓' }),
    el('h2', { text: '提交成功' }),
    el('p', { text: message }),
    el('p', { class: 'fg-success-meta', text: `提交编号：${payload?.submissionId ?? '-'}` }),
    el('a', { class: 'fg-link', href: location.pathname.replace(/\/fill\/?$/, ''), text: '返回表单首页' }),
  ]));
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function boot() {
  const holder = document.getElementById('formgen-schema');
  if (!holder) return;
  try {
    state.schema = JSON.parse(holder.textContent);
  } catch (error) {
    document.getElementById('formgen-root').textContent = `Schema 解析失败：${error.message}`;
    return;
  }

  state.values = defaultValues(state.schema);
  const draft = loadDraft();
  if (draft) {
    // 草稿优先于默认值：用户上次填的东西不该因为刷新就丢。
    for (const [key, value] of Object.entries(draft.values)) {
      if (key in state.values) state.values[key] = value;
    }
    setStatus('已恢复上次未提交的草稿', 'info');
  }

  renderForm();
  bindEvents();
  refresh();
}

boot();

export { state, refresh, validateAll };
