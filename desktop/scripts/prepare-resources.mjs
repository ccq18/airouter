import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(desktopDir, '..');
const destinationDir = path.join(desktopDir, 'src-tauri', 'resources', 'airouter');
const dependencyMarkerFile = '.airouter-dependencies.sha256';

const entries = [
  'run.js',
  'openai.js',
  'package.json',
  'package-lock.json',
  'openai.json.example',
  'openai-api-key.json.example',
  'app',
  'public'
];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyEntry(entry) {
  const source = path.join(rootDir, entry);
  const destination = path.join(destinationDir, entry);

  if (!(await exists(source))) {
    throw new Error(`Missing required airouter resource: ${source}`);
  }

  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter(sourcePath) {
      return path.basename(sourcePath) !== '.DS_Store';
    }
  });
}

await fs.rm(destinationDir, { recursive: true, force: true });
await fs.mkdir(destinationDir, { recursive: true });

for (const entry of entries) {
  await copyEntry(entry);
}

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const installResult = spawnSync(npmCommand, ['ci', '--omit=dev', '--ignore-scripts'], {
  cwd: destinationDir,
  stdio: 'inherit',
  shell: isWindows
});
if (installResult.error) {
  throw new Error(`Failed to install bundled airouter dependencies: ${installResult.error.message}`);
}
if (installResult.status !== 0) {
  throw new Error(`Bundled airouter dependency install exited with status ${installResult.status}`);
}

const packageLock = await fs.readFile(path.join(destinationDir, 'package-lock.json'));
const dependencyMarker = createHash('sha256').update(packageLock).digest('hex');
await fs.writeFile(
  path.join(destinationDir, 'node_modules', dependencyMarkerFile),
  `${dependencyMarker}\n`
);

console.log(`Prepared airouter resources at ${destinationDir}`);
