

const fs = require('fs');
const path = require('path');

const CWD = process.cwd();
const args = process.argv.slice(2);

const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

const OUT_FILE = path.resolve(CWD, getArg('out', 'codebase.txt'));
const FORCE = args.includes('--force');

// ---------- skip rules ----------
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  'logs',
  'tmp',
  '.pnpm-store',
]);

const SKIP_PATTERNS = [
  /^\.env(\..+)?$/,           // .env, .env.local, .env.production ...
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /\.log$/,
  /\.lock$/,                  // pnpm-lock.yaml, package-lock.json, etc.
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^reap\.js$/,
  /^codebase\.txt$/,
  /^.*\.tsbuildinfo$/,
  /^\.eslintcache$/,
];

// Only these extensions get dumped (everything else skipped)
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.vue', '.svelte', '.astro',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1',
  '.yml', '.yaml', '.toml', '.ini',
  '.sql', '.graphql', '.gql',
  '.prisma',                  // Prisma schema
  '.txt', '.xml', '.svg',
  '.dockerfile',
]);

// Special filenames without extensions worth including
const SPECIAL_FILES = new Set([
  'Dockerfile',
  '.gitignore',
  '.dockerignore',
  '.npmrc',
]);

const shouldSkipDir  = (n) => SKIP_DIRS.has(n) || SKIP_PATTERNS.some((re) => re.test(n));
const shouldSkipFile = (n) => SKIP_PATTERNS.some((re) => re.test(n));

// ---------- run ----------
if (fs.existsSync(OUT_FILE) && !FORCE) {
  console.error(`✗ ${path.basename(OUT_FILE)} already exists. Use --force to overwrite.`);
  process.exit(1);
}

const parts = [];
let fileCount = 0;
let totalBytes = 0;

parts.push(`# Backend codebase dump`);
parts.push(`# Generated : ${new Date().toISOString()}`);
parts.push(`# Root      : ${CWD}`);
parts.push(`# Files     : (filled in at the end)`);
parts.push('');

function includeFile(abs, rel) {
  const header = `\n${'='.repeat(80)}\nFILE: ${rel}\n${'='.repeat(80)}\n`;
  parts.push(header);
  try {
    const content = fs.readFileSync(abs, 'utf8');
    parts.push(content);
    totalBytes += content.length;
  } catch (err) {
    parts.push(`// (could not read: ${err.message})`);
  }
  parts.push('\n');
  fileCount++;
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (abs === OUT_FILE) continue;
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(abs);
      continue;
    }

    if (!entry.isFile()) continue;
    if (shouldSkipFile(entry.name)) continue;

    // Include if: known extension OR special filename
    const ext = path.extname(entry.name).toLowerCase();
    const isSpecial = SPECIAL_FILES.has(entry.name);
    if (!TEXT_EXT.has(ext) && !isSpecial) continue;

    includeFile(abs, path.relative(CWD, abs));
  }
}

walk(CWD);

// Patch the header with the count
parts[3] = `# Files     : ${fileCount}`;

fs.writeFileSync(OUT_FILE, parts.join('\n'), 'utf8');

const kb = (totalBytes / 1024).toFixed(1);

console.log(`\n✅  Done.`);
console.log(`   File    : ${path.relative(CWD, OUT_FILE)}`);
console.log(`   Files   : ${fileCount}`);
console.log(`   Size    : ${kb} KB\n`);