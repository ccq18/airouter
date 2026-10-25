const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');
const { buildReport, renderMarkdown } = require('./protocol-compatibility-report');
const { validateCatalog } = require('./protocol-compatibility-catalog');
async function main() {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  const output = args.length === 2 && args[0] === '--output' ? path.resolve(args[1]) : null;
  if (args.length && !output) throw Error('Usage: node scripts/check-protocol-compatibility.js [--output /absolute/report-prefix]');
  validateCatalog();
  const command = require('../package.json').scripts['test:protocol'].split(/\s+/);
  if (command.shift() !== 'node' || command.shift() !== '--test' || command.some(file => !/^test\/[\w.-]+\.test\.js$/.test(file))) throw Error('Unsupported protocol script: expected explicit Node test files');
  const events = [];
  const stream = run({ files: command.map(file => path.join(root, file)), concurrency: 2 });
  for await (const event of stream) if (['test:pass', 'test:fail'].includes(event.type)) events.push(event);
  const report = buildReport(events, undefined, { root });
  const markdown = renderMarkdown(report);
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(output + '.md', markdown);
    console.log('Compatibility reports: ' + output + '.{json,md}');
  }
  console.log(JSON.stringify({ ok: report.ok, summary: report.summary, regressions: { boundary: report.regressions.boundary, other: report.regressions.other } }, null, 2));
  for (const cell of report.cells.filter(cell => !['compatible', 'no_equivalent'].includes(cell.status))) console.error(cell.key + ': ' + cell.status + '\n' + (cell.error || 'Required positive evidence missing'));
  for (const item of report.regressions.failures) console.error(item.file + ': ' + item.name + ': ' + item.status + '\n' + (item.error || 'Test was not verified'));
  if (!report.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
