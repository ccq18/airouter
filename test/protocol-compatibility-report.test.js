const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, renderMarkdown } = require('../scripts/protocol-compatibility-report');
const { validateCatalog, requestCells, responseCells } = require('../scripts/protocol-compatibility-catalog');
const cell = (point = 'request.temperature', extra = {}) => ({ point, source: 'chat_completions', backend: 'responses', wire: 'json', stream: false, file: 'test/contract.test.js', name: point, applicable: true, kind: 'acceptance', ...extra });
const event = (name, status = 'pass', extra = {}) => ({ type: 'test:' + status, data: { name, file: '/repo/test/contract.test.js', ...extra } });

test('report cannot use a passing rejection test as evidence for an absent positive case', () => {
  const report = buildReport([event('reject unsupported temperature')], [cell()], { root: '/repo' });
  assert.equal(report.cells[0].status, 'uncovered'); assert.equal(report.ok, false);
  assert.equal(report.summary.compatible, 0); assert.equal(report.regressions.boundary.passed, 1);
});
test('failed known mapping remains unimplemented and fails the delivery gate', () => {
  const report = buildReport([event('request.reasoning', 'fail', { details: { error: new Error('400 unsupported') } })], [cell('request.reasoning', { knownGap: true })], { root: '/repo' });
  assert.equal(report.cells[0].status, 'unimplemented'); assert.equal(report.ok, false);
  assert.match(report.cells[0].error, /400 unsupported/);
});
test('skip, todo, duplicate events and the wrong file never count as compatible', () => {
  for (const events of [[event('request.temperature', 'pass', { skip: true })], [event('request.temperature', 'fail', { todo: true })], [event('request.temperature'), event('request.temperature')], [event('request.temperature', 'pass', { file: '/repo/test/other.test.js' })]]) {
    const report = buildReport(events, [cell()], { root: '/repo' });
    assert.equal(report.ok, false); assert.notEqual(report.cells[0].status, 'compatible');
  }
});
test('a resolved known gap turns compatible only after the strict positive case actually passes', () => {
  const report = buildReport([event('request.reasoning')], [cell('request.reasoning', { knownGap: true })], { root: '/repo' });
  assert.equal(report.ok, true); assert.equal(report.cells[0].status, 'compatible');
});
test('no-equivalence cells remain explicit exclusions while unrelated failures still fail the gate', () => {
  const spec = [cell('request.stop', { applicable: false, reason: 'Responses has no stop field' })];
  const report = buildReport([event('cancellation regression', 'fail')], spec, { root: '/repo' });
  assert.equal(report.cells[0].status, 'no_equivalent'); assert.equal(report.summary.compatible, 0); assert.equal(report.ok, false);
  assert.match(renderMarkdown(report), /Responses has no stop field/);
});
test('catalog covers independent request inventory and the entire nine-direction response matrix', () => {
  assert.equal(validateCatalog(), true);
  assert.equal(responseCells().filter(c => c.point.startsWith('response.') && ['response.text-cache', 'response.refusal', 'response.truncation', 'response.usage-absent', 'response.usage-partial', 'response.parallel-tools-two-rounds'].includes(c.point)).length, 216);
  assert.deepEqual(requestCells().filter(c => c.knownGap && c.applicable), [], 'the eight implemented cells no longer remain declared gaps');
});
test('an unexpected regression in a supported contract is incompatible, never relabeled as a planned limitation', () => {
  const report = buildReport([event('request.temperature', 'fail')], [cell()], { root: '/repo' });
  assert.equal(report.cells[0].status, 'incompatible'); assert.equal(report.summary.unimplemented, 0); assert.equal(report.ok, false);
});
test('planned duplicate cells and exclusions without reasons are rejected', () => {
  assert.throws(() => buildReport([], [cell(), cell()], { root: '/repo' }), /Duplicate planned/);
  assert.throws(() => buildReport([], [cell('stop', { applicable: false })], { root: '/repo' }), /reason is required/);
});
