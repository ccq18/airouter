#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const defaultInputDir = path.join(desktopDir, 'src-tauri', 'target', 'release', 'bundle');
const defaultOutputDir = path.join(desktopDir, 'dist-release');
const defaultRepo = 'ccq18/airouter';

export function inferUpdaterPlatform(assetName) {
  if (/_(?:arm64|aarch64)\.app\.tar\.gz$/.test(assetName)) {
    return 'darwin-aarch64';
  }

  if (/_(?:x64|x86_64)\.app\.tar\.gz$/.test(assetName)) {
    return 'darwin-x86_64';
  }

  if (/_(?:x64|x86_64)(?:-setup)?\.exe\.zip$/.test(assetName) || /_(?:x64|x86_64).*\.nsis\.zip$/.test(assetName)) {
    return 'windows-x86_64';
  }

  if (/_(?:arm64|aarch64)(?:-setup)?\.exe\.zip$/.test(assetName) || /_(?:arm64|aarch64).*\.nsis\.zip$/.test(assetName)) {
    return 'windows-aarch64';
  }

  throw new Error(`Unsupported updater artifact: ${assetName}`);
}

export function normalizeUpdaterAssetName({ assetName, version, arch = process.arch }) {
  if (/\.app\.tar\.gz$/.test(assetName) && !/_(?:arm64|aarch64|x64|x86_64)\.app\.tar\.gz$/.test(assetName)) {
    const productName = assetName.replace(/\.app\.tar\.gz$/, '');
    return `${productName}_${version}_${archLabel(arch)}.app.tar.gz`;
  }

  return assetName;
}

export function buildLatestJson({ version, notes = '', pubDate = new Date().toISOString(), artifacts, githubRepo = defaultRepo }) {
  if (!version || typeof version !== 'string') {
    throw new Error('version is required');
  }

  const platforms = {};
  for (const artifact of artifacts || []) {
    const platform = artifact.platform || inferUpdaterPlatform(artifact.assetName);
    const entry = {
      signature: artifact.signature,
      url: `https://github.com/${githubRepo}/releases/download/v${version}/${artifact.assetName}`,
    };
    if (platform.startsWith('windows-')) {
      entry.installMode = 'passive';
    }
    platforms[platform] = entry;
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

export async function copyFileUnlessSamePath(sourcePath, destinationPath) {
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    return;
  }

  await fs.copyFile(sourcePath, destinationPath);
}

async function collectUpdaterArtifacts(inputDir, version) {
  const files = await listFiles(inputDir);
  const updaterAssets = files.filter(file => {
    const name = path.basename(file);
    return (name.endsWith('.app.tar.gz') || name.endsWith('.exe.zip') || name.endsWith('.nsis.zip') || name.endsWith('.msi.zip'))
      && files.includes(`${file}.sig`);
  });

  const artifacts = [];
  for (const file of updaterAssets) {
    const assetName = normalizeUpdaterAssetName({
      assetName: path.basename(file),
      version,
    });
    artifacts.push({
      sourcePath: file,
      signaturePath: `${file}.sig`,
      assetName,
      signature: (await fs.readFile(`${file}.sig`, 'utf8')).trim(),
      platform: inferUpdaterPlatform(assetName),
    });
  }

  artifacts.sort((left, right) => left.platform.localeCompare(right.platform));
  return artifacts;
}

async function listFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readVersionFromTauriConfig() {
  const raw = await fs.readFile(path.join(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8');
  return JSON.parse(raw).version;
}

async function readReleaseNotes(version) {
  const candidates = [
    path.resolve(desktopDir, '..', 'CHANGELOG.md'),
    path.join(desktopDir, 'CHANGELOG.md'),
  ];

  for (const changelogPath of candidates) {
    const changelog = await fs.readFile(changelogPath, 'utf8').catch(() => '');
    if (!changelog) {
      continue;
    }

    const heading = new RegExp(`^##\\s+v?${escapeRegExp(version)}\\s*$`, 'm').exec(changelog);
    if (!heading || heading.index === undefined) {
      continue;
    }

    const remaining = changelog.slice(heading.index + heading[0].length);
    const nextHeadingIndex = remaining.search(/^##\s+/m);
    return remaining.slice(0, nextHeadingIndex === -1 ? undefined : nextHeadingIndex).trim();
  }

  return '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archLabel(arch) {
  if (arch === 'arm64' || arch === 'aarch64') {
    return 'arm64';
  }
  if (arch === 'x64' || arch === 'x86_64') {
    return 'x64';
  }
  return arch;
}

function parseArgs(argv) {
  const options = {
    inputDir: defaultInputDir,
    outputDir: defaultOutputDir,
    githubRepo: process.env.GITHUB_REPOSITORY || defaultRepo,
    version: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      options.inputDir = path.resolve(argv[++index]);
    } else if (arg === '--output') {
      options.outputDir = path.resolve(argv[++index]);
    } else if (arg === '--repo') {
      options.githubRepo = argv[++index];
    } else if (arg === '--version') {
      options.version = argv[++index].replace(/^v/, '');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version || await readVersionFromTauriConfig();
  const artifacts = await collectUpdaterArtifacts(options.inputDir, version);
  if (artifacts.length === 0) {
    throw new Error(`No signed updater artifacts found in ${options.inputDir}`);
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  for (const artifact of artifacts) {
    await copyFileUnlessSamePath(artifact.sourcePath, path.join(options.outputDir, artifact.assetName));
    await copyFileUnlessSamePath(artifact.signaturePath, path.join(options.outputDir, `${artifact.assetName}.sig`));
  }

  const latest = buildLatestJson({
    version,
    notes: await readReleaseNotes(version),
    artifacts,
    githubRepo: options.githubRepo,
  });
  await fs.writeFile(path.join(options.outputDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Wrote ${path.relative(desktopDir, path.join(options.outputDir, 'latest.json'))}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
