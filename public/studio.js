/**
 * 生成器工作台前端。
 *
 * 预览刻意用 iframe 指向 `/preview/<draftId>`：这样预览里跑的就是**真实的填写页运行时**，
 * 而不是另写一套「预览渲染」——预览与线上不一致是低代码平台最经典的坑，这里从结构上避开。
 */

const $ = id => document.getElementById(id);

const els = {
  input: $('nl-input'),
  mode: $('mode-select'),
  generate: $('generate-btn'),
  example: $('example-btn'),
  status: $('studio-status'),
  understanding: $('understanding'),
  preview: $('preview'),
  publish: $('publish-btn'),
  download: $('download-btn'),
};

let examples = [];
try { examples = JSON.parse($('studio-examples')?.textContent ?? '[]'); } catch { examples = []; }

let current = { draftId: null, schema: null, kind: 'form' };
let exampleIndex = 0;

function setStatus(message, tone = 'info') {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.dataset.tone = tone;
  els.status.hidden = !message;
}

function setBusy(busy) {
  els.generate.disabled = busy;
  els.generate.textContent = busy ? '生成中…' : '生成表单';
}

function renderUnderstanding(payload) {
  if (!els.understanding) return;
  const { understanding, issues = [], channel, fallback, comparison } = payload;
  const parts = [];

  const rows = [];
  if (channel) rows.push(`生成通道：<strong>${escapeHtml(channel === 'llm' ? `大模型 (${payload.llm?.model ?? ''})` : channel === 'rule' ? '规则引擎' : channel)}</strong>`);
  if (fallback) rows.push(`降级原因：<span class="issues">${escapeHtml(fallback.reason)}</span>`);
  if (understanding) {
    rows.push(`识别为：${escapeHtml(understanding.domainLabel ?? '表单')}「${escapeHtml(understanding.title ?? '')}」`);
    rows.push(`字段 ${understanding.fieldCount} 个，分组 ${understanding.groupCount} 个`);
  }
  if (rows.length) parts.push(`<ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul>`);

  const notes = understanding?.notes ?? [];
  if (notes.length) {
    parts.push('<h4>推理回放</h4><ul>' + notes.slice(0, 12).map(n => `<li>${escapeHtml(n)}</li>`).join('') + '</ul>');
  }
  if (issues.length) {
    parts.push('<h4>需要注意</h4><ul class="issues">' + issues.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>');
  }
  if (comparison) {
    parts.push('<h4>双通道对比</h4><ul>'
      + `<li>规则通道：${comparison.rule.fieldCount} 字段 / ${comparison.rule.logicCount} 处逻辑</li>`
      + `<li>大模型通道：${comparison.llm.fieldCount} 字段 / ${comparison.llm.logicCount} 处逻辑</li>`
      + (comparison.onlyInLlm.length ? `<li>仅大模型识别：${comparison.onlyInLlm.map(escapeHtml).join('、')}</li>` : '')
      + (comparison.onlyInRule.length ? `<li>仅规则识别：${comparison.onlyInRule.map(escapeHtml).join('、')}</li>` : '')
      + (comparison.typeDiffs.length ? `<li>类型分歧：${comparison.typeDiffs.map(d => `${escapeHtml(d.label)}(${d.rule} vs ${d.llm})`).join('、')}</li>` : '')
      + `<li>结论：${escapeHtml(comparison.verdict ?? '')}</li>`
      + '</ul>');
  }

  els.understanding.innerHTML = parts.join('') || '<p>没有额外信息</p>';
  els.understanding.hidden = false;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`服务器返回了非 JSON 内容（HTTP ${response.status}）`); }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function generate() {
  const text = els.input.value.trim();
  if (!text) { setStatus('请先写下你的需求', 'error'); els.input.focus(); return; }

  setBusy(true);
  setStatus('正在理解需求…');
  els.publish.disabled = true;
  els.download.disabled = true;

  try {
    const payload = await postJson('/api/generate', { text, mode: els.mode.value });

    if (payload.kind === 'exam') {
      renderExam(payload);
      return;
    }
    if (payload.mode === 'compare') {
      current = { draftId: payload.draftId, schema: payload.schema, kind: 'form' };
      renderUnderstanding(payload);
      showPreview(payload.draftId);
      els.publish.disabled = false;
      els.download.disabled = false;
      setStatus('已用双通道各生成一份，预览使用的是规则通道结果', 'info');
      return;
    }

    current = { draftId: payload.draftId, schema: payload.schema, kind: payload.kind ?? 'form' };
    renderUnderstanding(payload);
    showPreview(payload.draftId);
    els.publish.disabled = false;
    els.download.disabled = false;
    setStatus('生成成功，右侧是可以直接填写的表单', 'info');
  } catch (error) {
    setStatus(`生成失败：${error.message}`, 'error');
    els.preview.innerHTML = `<p class="placeholder">生成失败：${escapeHtml(error.message)}</p>`;
  } finally {
    setBusy(false);
  }
}

function renderExam(payload) {
  const { paper, outline, blueprint } = payload;
  const lines = [];
  lines.push(`<h3>${escapeHtml(blueprint?.title ?? '试卷')}</h3>`);
  lines.push(`<ul>`);
  lines.push(`<li>满分 <strong>${paper.plannedScore ?? blueprint?.totalScore}</strong> 分，实际组卷 ${paper.totalScore} 分</li>`);
  if (blueprint?.duration) lines.push(`<li>考试时长 ${blueprint.duration} 分钟</li>`);
  lines.push(`<li>难度目标 ${paper.report?.difficulty?.target?.toFixed?.(2) ?? '-'}，实际 ${paper.report?.difficulty?.actual?.toFixed?.(2) ?? '-'}</li>`);
  lines.push('</ul>');
  lines.push('<h4>题型分布</h4><ul>' + (paper.sections ?? []).map(s => `<li>${escapeHtml(s.title ?? s.type)}：${s.questions.length} 题 × ${s.scorePer} 分</li>`).join('') + '</ul>');

  const coverage = paper.report?.coverage ?? [];
  if (coverage.length) {
    lines.push('<h4>知识点覆盖</h4><ul>' + coverage.map(c => `<li>${escapeHtml(c.knowledge)}：需 ${c.required} 题，实际 ${c.used} 题 ${c.satisfied ? '✓' : '✗'}</li>`).join('') + '</ul>');
  }
  const warnings = paper.report?.warnings ?? [];
  if (warnings.length) lines.push('<h4>组卷提示</h4><ul class="issues">' + warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') + '</ul>');

  if (payload.draftId) {
    showPreview(payload.draftId);
    els.publish.disabled = false;
    els.download.disabled = true;
    current = { draftId: payload.draftId, schema: payload.schema, kind: 'exam' };
  } else {
    els.preview.innerHTML = `<div class="understanding-final">${lines.join('')}</div>`;
  }

  const notes = paper.report?.suggestions ?? [];
  els.understanding.innerHTML = lines.join('') + (notes.length ? '<h4>给命题老师的建议</h4><ul>' + notes.map(n => `<li>${escapeHtml(n)}</li>`).join('') + '</ul>' : '');
  els.understanding.hidden = false;
  setStatus('已组卷，右侧预览即考生将看到的页面', 'info');
  void outline;
}

function showPreview(draftId) {
  els.preview.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.src = `/preview/${encodeURIComponent(draftId)}`;
  frame.title = '表单预览';
  els.preview.append(frame);
}

async function publish() {
  if (!current.draftId) return;
  els.publish.disabled = true;
  try {
    const payload = await postJson('/api/publish', { draftId: current.draftId });
    setStatus(`已发布：${location.origin}${payload.fillUrl}`, 'info');
    els.preview.innerHTML = `<div class="published">
      <h3>已发布 ✓</h3>
      <p>填写链接：<a href="${escapeHtml(payload.fillUrl)}" target="_blank" rel="noopener">${escapeHtml(location.origin + payload.fillUrl)}</a></p>
      <p>结果页：<a href="${escapeHtml(payload.resultsUrl)}" target="_blank" rel="noopener">${escapeHtml(location.origin + payload.resultsUrl)}</a></p>
      <p class="fg-help">可以把填写链接发给需要提交的人；数据会按同一份 Schema 在服务端再次校验后入库。</p>
    </div>`;
  } catch (error) {
    setStatus(`发布失败：${error.message}`, 'error');
    els.publish.disabled = false;
  }
}

function downloadSchema() {
  if (!current.schema) return;
  const blob = new Blob([JSON.stringify(current.schema, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${current.schema.title ?? 'form'}.schema.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

els.generate?.addEventListener('click', generate);
els.publish?.addEventListener('click', publish);
els.download?.addEventListener('click', downloadSchema);
els.example?.addEventListener('click', () => {
  if (!examples.length) return;
  exampleIndex = (exampleIndex + 1) % examples.length;
  els.input.value = examples[exampleIndex];
  els.input.focus();
});
els.input?.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') generate();
});

// 首屏填一个例子，让用户知道该写什么。
if (els.input && !els.input.value && examples.length) els.input.value = examples[0];
