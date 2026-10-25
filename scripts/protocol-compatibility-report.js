const path = require('node:path');
const { requestCells, responseCells, caseKey } = require('./protocol-compatibility-catalog');
function evidenceKey(file, name) { return file + '\0' + name; }
function errorText(data) {
  const error = data.details?.error;
  return [...new Set([error?.message, error?.cause?.message].filter(Boolean))].join('\n') || 'Test failed';
}
function buildReport(events, cells = [...requestCells(), ...responseCells()], options = {}) {
  const root = options.root || path.resolve(__dirname, '..'), evidence = new Map();
  for (const event of events) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const data = event.data, file = path.isAbsolute(data.file || '') ? path.relative(root, data.file).split(path.sep).join('/') : data.file;
    const key = evidenceKey(file, data.name);
    if (!evidence.has(key)) evidence.set(key, []);
    evidence.get(key).push({ status: data.skip || data.todo ? 'unverified' : event.type === 'test:pass' ? 'passed' : 'failed', file, name: data.name,
      ...(event.type === 'test:fail' ? { error: errorText(data) } : {}) });
  }
  const claimed = new Set(), keys = new Set();
  const rows = cells.map(cell => {
    const key = caseKey(cell.point, cell.source, cell.backend, cell.wire, cell.stream);
    if (keys.has(key)) throw Error('Duplicate planned cell: ' + key);
    keys.add(key);
    if (!cell.applicable) {
      if (!cell.reason) throw Error('No-equivalence reason is required: ' + key);
      return { ...cell, key, status: cell.exclusion === 'native_only' ? 'unsupported' : 'no_equivalent' };
    }
    const id = evidenceKey(cell.file, cell.name), records = evidence.get(id) || [];
    claimed.add(id);
    const status = records.length === 0 ? 'uncovered' : records.length !== 1 ? 'invalid' : records[0].status === 'unverified' ? 'unverified'
      : records[0].status === 'passed' ? 'compatible' : cell.knownGap ? 'unimplemented' : 'incompatible';
    return { ...cell, key, status, evidence: cell.evidence || (cell.file.includes('.integration.') ? 'http' : 'unit'), ...(records[0]?.error ? { error: records[0].error } : {}), ...(status === 'invalid' ? { error: 'Duplicate test results cannot establish unique evidence' } : {}) };
  });
  const summary = Object.fromEntries(['compatible', 'incompatible', 'unimplemented', 'uncovered', 'unverified', 'invalid', 'no_equivalent', 'unsupported'].map(status => [status, rows.filter(row => row.status === status).length]));
  const regressions = { boundary: { passed: 0, failed: 0, unverified: 0 }, other: { passed: 0, failed: 0, unverified: 0 }, failures: [] };
  for (const [id, records] of evidence) if (!claimed.has(id)) for (const record of records) {
    const kind = /^(REJECTION|FAULT|CANCEL|AUTH)\b|reject|unsupported|unowned|invalid|cannot|native or explicitly rejected|preserved, mapped, or rejected/i.test(record.name) ? 'boundary' : 'other';
    regressions[kind][record.status]++;
    if (record.status !== 'passed') regressions.failures.push(record);
  }
  const requiredFailures = rows.filter(row => !['compatible', 'no_equivalent', 'unsupported'].includes(row.status));
  return { version: 1, scope: 'Native protocol contracts only: controlled HTTP and unit evidence; cross-protocol conversion is unsupported; no real supplier requests',
    coverage: { points: new Set(rows.map(row => row.point)).size, cells: rows.length, uniqueRequiredTests: claimed.size,
      compatibleHttpCells: rows.filter(row => row.status === 'compatible' && row.evidence === 'http').length,
      compatibleUnitCells: rows.filter(row => row.status === 'compatible' && row.evidence === 'unit').length, realSupplierChecks: 0 },
    ok: requiredFailures.length === 0 && regressions.failures.length === 0, summary, cells: rows, regressions };
}
const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
function renderMarkdown(report) {
  const lines = ['# Airouter 逐点兼容性验收', '', report.scope, '',
    `门禁：${report.ok ? '通过' : '失败'}。兼容通过 ${report.summary.compatible}；兼容失败 ${report.summary.incompatible}；未实现 ${report.summary.unimplemented}；未覆盖 ${report.summary.uncovered}；未验证 ${report.summary.unverified}；证据无效 ${report.summary.invalid}；无等价映射 ${report.summary.no_equivalent}；产品范围不支持 ${report.summary.unsupported}。`, '',
    '仅原生协议验收计入兼容通过数。跨协议转换已退出产品范围；边界拒绝、安全及其他回归不计入兼容通过数。单元格是一个兼容点及其协议/格式组合。', '',
    `清单 ${report.coverage.points} 个兼容点、${report.coverage.cells} 个单元格；通过证据中 HTTP ${report.coverage.compatibleHttpCells} 格、单元 ${report.coverage.compatibleUnitCells} 格；真实供应商验证 ${report.coverage.realSupplierChecks} 项。`, '',
    '| 兼容点 | 通过 | 失败 | 未实现 | 未覆盖/未验证/无效 | 无等价/不支持 |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const point of [...new Set(report.cells.map(cell => cell.point))]) {
    const cells = report.cells.filter(cell => cell.point === point), count = statuses => cells.filter(cell => statuses.includes(cell.status)).length;
    lines.push(`| ${point} | ${count(['compatible'])} | ${count(['incompatible'])} | ${count(['unimplemented'])} | ${count(['uncovered', 'unverified', 'invalid'])} | ${count(['no_equivalent', 'unsupported'])} |`);
  }
  lines.push('', '## 兼容性缺口', '', '| 兼容点 | 入口 → 后端 | 上游 → 客户端格式 | 状态 | 证据 |', '| --- | --- | --- | --- | --- |');
  for (const cell of report.cells.filter(cell => !['compatible', 'no_equivalent', 'unsupported'].includes(cell.status))) lines.push(`| ${cell.point} | ${cell.source} → ${cell.backend} | ${cell.wire} → ${cell.stream ? 'sse' : 'json'} | ${cell.status} | ${escape(cell.error || 'Required positive test was not executed')} |`);
  lines.push('', '## 无等价映射及产品范围不支持的组合', '', '| 兼容点 | 入口 → 后端 | 原因 |', '| --- | --- | --- |');
  const exclusions = new Set();
  for (const cell of report.cells.filter(cell => ['no_equivalent', 'unsupported'].includes(cell.status))) {
    const key = [cell.point, cell.source, cell.backend].join('|'); if (exclusions.has(key)) continue; exclusions.add(key);
    lines.push(`| ${cell.point} | ${cell.source} → ${cell.backend} | ${escape(cell.reason)} |`);
  }
  lines.push('', '## 边界及其他回归', '', '```json', JSON.stringify(report.regressions, null, 2), '```', '');
  return lines.join('\n');
}
module.exports = { buildReport, renderMarkdown };
