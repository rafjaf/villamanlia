#!/usr/bin/env node
/*
  Safe Markdown migration helper for this repo.

  Goals:
  - Convert common Wikidot/Obsidian markdown constructs into Docsify/Marked-friendly Markdown/HTML.
  - Avoid data loss: dry-run by default, optional writes, timestamped backups, atomic writes.

  Usage:
    node scripts/migrate-markdown.js                 # dry-run
    node scripts/migrate-markdown.js --write         # write changes + backups
    node scripts/migrate-markdown.js --write --root .

  Options:
    --root <dir>            Root directory to scan (default: current working directory)
    --write                 Actually write files (default: false)
    --backup-dir <dir>      Backup directory (default: <root>/.migration-backups)
    --no-backup             Disable backups (NOT recommended)
    --include <substr>      Only process files whose relative path includes this substring (repeatable)
    --exclude <substr>      Skip files whose relative path includes this substring (repeatable)
    --verbose               More detailed per-file output
    --report <file>         Write a JSON report

  Notes:
  - Transformations are skipped inside fenced code blocks (``` ... ```).
  - For villamanlia.wikidot.com links, anchors (#...) are dropped by default because they are rarely stable after conversion.
*/

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_EXCLUDES = [
  '/.git/',
  '/node_modules/',
  '/.migration-backups/',
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    write: false,
    backupDir: null,
    backup: true,
    include: [],
    exclude: [],
    verbose: false,
    report: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--write') args.write = true;
    else if (a === '--backup-dir') args.backupDir = argv[++i];
    else if (a === '--no-backup') args.backup = false;
    else if (a === '--include') args.include.push(argv[++i]);
    else if (a === '--exclude') args.exclude.push(argv[++i]);
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 60).join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  args.root = path.resolve(args.root);
  args.backupDir = args.backupDir ? path.resolve(args.backupDir) : path.join(args.root, '.migration-backups');
  return args;
}

async function walkFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...await walk(full));
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
    return [];
  }
  await walk(rootDir);
  return out;
}

function shouldProcess(relPosix, args) {
  for (const ex of DEFAULT_EXCLUDES) {
    if (relPosix.includes(ex)) return false;
  }
  for (const ex of args.exclude) {
    if (ex && relPosix.includes(ex)) return false;
  }
  if (args.include.length > 0) {
    return args.include.some((inc) => inc && relPosix.includes(inc));
  }
  return true;
}

function splitByFences(text) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let buf = [];
  let inCode = false;

  const flush = () => {
    if (buf.length === 0) return;
    segs.push({ type: inCode ? 'code' : 'text', content: buf.join('\n') });
    buf = [];
  };

  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    if (isFence) {
      buf.push(line);
      flush();
      inCode = !inCode;
      continue;
    }
    buf.push(line);
  }
  flush();
  return segs;
}

function joinSegments(segs, original) {
  const hadCrlf = /\r\n/.test(original);
  const joined = segs.map((s) => s.content).join('\n');
  return hadCrlf ? joined.replace(/\n/g, '\r\n') : joined;
}

function countMatches(re, s) {
  const m = s.match(re);
  return m ? m.length : 0;
}

function safeReplaceAll(s, re, replacer) {
  let count = 0;
  const out = s.replace(re, (...args) => {
    count++;
    return typeof replacer === 'function' ? replacer(...args) : replacer;
  });
  return { out, count };
}

function encodeLinkTarget(target) {
  // Encode spaces and non-ascii safely but keep slashes.
  return target
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function buildBasenameIndex(allMdRelPosix) {
  const index = new Map();
  for (const rel of allMdRelPosix) {
    const base = path.posix.basename(rel, '.md');
    if (!index.has(base)) index.set(base, new Set());
    index.get(base).add(rel);
  }
  return index;
}

function relLink(fromFileRelPosix, toFileRelPosix) {
  const fromDir = path.posix.dirname(fromFileRelPosix);
  let r = path.posix.relative(fromDir, toFileRelPosix);
  if (!r.startsWith('.')) r = './' + r;
  return r;
}

function applyTransformsToTextSegment(segment, ctx) {
  let s = segment;
  const counts = {};

  // Remove Wikidot UI/quote macros early (before any [[...]] conversions),
  // to avoid them being mistaken for Obsidian wikilinks.
  {
    const re = /^\s*\[\[(?:>\s*|\/?>\s*|module\s+Comments|button\s+print[^\]]*|footnoteblock(?:\s+[^\]]*)?)\]\]\s*$(?:\r?\n)?/gmi;
    const r = safeReplaceAll(s, re, '');
    s = r.out;
    counts.remove_wikidot_ui_macros = (counts.remove_wikidot_ui_macros || 0) + r.count;
  }

  // Normalize odd broken prefixes seen in the corpus.
  {
    const r1 = safeReplaceAll(s, /\bhttps:\*/g, 'https://');
    s = r1.out; counts.fix_https_star = (counts.fix_https_star || 0) + r1.count;
    const r2 = safeReplaceAll(s, /\bhttp:\*/g, 'http://');
    s = r2.out; counts.fix_http_star = (counts.fix_http_star || 0) + r2.count;
  }

  // Remove TOC macros (whole-line only).
  {
    const re = /^\s*\[\[(?:toc|f>toc)\]\]\s*$(?:\r?\n)?/gmi;
    const r = safeReplaceAll(s, re, '');
    s = r.out; counts.remove_toc = (counts.remove_toc || 0) + r.count;
  }

  // Convert Wikidot container macros to HTML.
  {
    const open = (name) => new RegExp(`^\\s*\\[\\[${name}([^\\]]*)\\]\\]\\s*$`, 'gmi');
    const close = (name) => new RegExp(`^\\s*\\[\\[\\/${name}\\]\\]\\s*$`, 'gmi');

    for (const tag of ['div', 'span', 'iframe']) {
      const rOpen = safeReplaceAll(s, open(tag), (_m, attrs) => `<${tag}${attrs}>`);
      s = rOpen.out; counts[`wikidot_${tag}_open`] = (counts[`wikidot_${tag}_open`] || 0) + rOpen.count;

      const rClose = safeReplaceAll(s, close(tag), `</${tag}>`);
      s = rClose.out; counts[`wikidot_${tag}_close`] = (counts[`wikidot_${tag}_close`] || 0) + rClose.count;
    }

    const rSizeOpen = safeReplaceAll(s, /\[\[size\s+smaller\]\]/g, '<small>');
    s = rSizeOpen.out; counts.wikidot_size_open = (counts.wikidot_size_open || 0) + rSizeOpen.count;
    const rSizeClose = safeReplaceAll(s, /\[\[\/size\]\]/g, '</small>');
    s = rSizeClose.out; counts.wikidot_size_close = (counts.wikidot_size_close || 0) + rSizeClose.count;

    // Raw html wrapper: just remove markers.
    const rHtmlOpen = safeReplaceAll(s, /^\s*\[\[html\]\]\s*$/gmi, '');
    s = rHtmlOpen.out; counts.wikidot_html_open = (counts.wikidot_html_open || 0) + rHtmlOpen.count;
    const rHtmlClose = safeReplaceAll(s, /^\s*\[\[\/html\]\]\s*$/gmi, '');
    s = rHtmlClose.out; counts.wikidot_html_close = (counts.wikidot_html_close || 0) + rHtmlClose.count;
  }

  // Convert inline Wikidot footnotes into inline notes.
  {
    const re = /\[\[footnote\]\]([\s\S]*?)\[\[\/footnote\]\]/g;
    const r = safeReplaceAll(s, re, (_m, inner) => {
      const clean = String(inner).replace(/\s+/g, ' ').trim();
      return clean.length ? `*(Note : ${clean})*` : '';
    });
    s = r.out; counts.wikidot_footnote = (counts.wikidot_footnote || 0) + r.count;
  }

  // Convert external link shorthand: [http://example Label] -> [Label](http://example)
  {
    const re = /\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g;
    const r = safeReplaceAll(s, re, (_m, url, label) => `[${label}](${url})`);
    s = r.out; counts.external_shorthand = (counts.external_shorthand || 0) + r.count;
  }

  // Convert Obsidian embeds: ![[path|1346]] -> <img src="path" width="1346" /> ; ![[path|]] -> ![](path)
  {
    const re = /!\[\[([^\]|#]+?)(?:#[^\]|]+)?\s*(?:\|\s*([^\]]*))?\]\]/g;
    const r = safeReplaceAll(s, re, (_m, targetRaw, opt) => {
      const target = String(targetRaw).trim();
      const option = (opt ?? '').trim();
      const hasImageExt = /\.(png|jpe?g|gif|webp|svg)$/i.test(target);
      if (!hasImageExt) {
        // Not an image embed; leave as-is (safer).
        return _m;
      }
      const enc = encodeLinkTarget(target);
      if (/^\d+$/.test(option)) {
        return `<img src="${enc}" width="${option}" />`;
      }
      return `![](${enc})`;
    });
    s = r.out; counts.obsidian_embed = (counts.obsidian_embed || 0) + r.count;
  }

  // Convert Obsidian wikilinks: [[target|label]] -> [label](target.md)
  {
    const re = /\[\[([^\]|#]+?)(#[^\]|]+)?\s*(?:\|\s*([^\]]+))?\]\]/g;
    const r = safeReplaceAll(s, re, (_m, targetRaw, anchorRaw, labelRaw) => {
      const target0 = String(targetRaw).trim();
      const anchor = anchorRaw ? String(anchorRaw).trim() : '';
      const label = (labelRaw ? String(labelRaw) : '').trim();

      // Do not touch absolute URLs.
      if (/^[a-z]+:\/\//i.test(target0)) return _m;

      // Only convert "path-like" targets. This prevents converting Wikidot macros
      // (e.g. [[>]]) and other non-path constructs into bogus links.
      if (!/^[A-Za-z0-9 _./-]+$/.test(target0)) return _m;

      // If it's clearly a file with extension other than .md, keep extension.
      const hasExt = /\.[a-z0-9]{1,8}$/i.test(target0);
      let target = target0;
      if (!hasExt) target = `${target0}.md`;

      const visible = label || path.posix.basename(target0);
      return `[${visible}](${encodeLinkTarget(target)}${anchor})`;
    });
    s = r.out; counts.obsidian_wikilink = (counts.obsidian_wikilink || 0) + r.count;
  }

  // Convert internal Wikidot links (when uniquely resolvable).
  // Example: http://villamanlia.wikidot.com/pnj#toc6 -> ../saga/pnj.md (anchor dropped)
  {
    const re = /\bhttps?:\/\/villamanlia\.wikidot\.com\/([a-z0-9\-]+)(#[^\s)\]]+)?/gi;
    const r = safeReplaceAll(s, re, (_m, slug, _anchor) => {
      const key = String(slug).toLowerCase();
      const candidates = ctx.basenameIndex.get(key);
      if (!candidates || candidates.size === 0) {
        ctx.unresolvedWikidot.add(key);
        return _m;
      }
      if (candidates.size > 1) {
        ctx.ambiguousWikidot.set(key, [...candidates].sort());
        return _m;
      }
      const only = [...candidates][0];
      const rel = relLink(ctx.fileRelPosix, only);
      ctx.rewrittenWikidot.set(key, only);
      return rel;
    });
    s = r.out; counts.wikidot_internal_link = (counts.wikidot_internal_link || 0) + r.count;
  }

  // Note: additional footer handling happens in stripCommonWikidotFooter().

  return { out: s, counts };
}

function stripCommonWikidotFooter(fullText, footerInfo) {
  // Only operate if footer markers appear near the end.
  const tailWindow = 6000;
  const tailStart = Math.max(0, fullText.length - tailWindow);
  const tail = fullText.slice(tailStart);

  const idxFoot = tail.lastIndexOf('[[footnoteblock');
  const idxComments = tail.lastIndexOf('[[module Comments]]');
  const idxPrint = tail.lastIndexOf('[[button print');

  const hasFooter = idxFoot !== -1 || idxComments !== -1 || idxPrint !== -1;
  if (!hasFooter) return fullText;

  let cutInTail = idxFoot;
  if (cutInTail === -1) cutInTail = idxComments;
  if (cutInTail === -1) cutInTail = idxPrint;
  if (cutInTail === -1) return fullText;

  // Try to include a preceding signature macro block if present.
  const lookback = 1200;
  const before = tail.slice(Math.max(0, cutInTail - lookback), cutInTail);
  const mSig = before.match(/\[\[>\]\]\s*[\r\n]+([^\r\n]+?)\s*[\r\n]+\[\[\/?>\]\]/i);
  const signatureName = mSig ? mSig[1].trim() : null;

  // Try to cut from the start of a nearby [[div]] wrapper if present.
  let cutStartInTail = cutInTail;
  const idxQuote = before.lastIndexOf('[[>]]');
  if (idxQuote !== -1) {
    cutStartInTail = Math.min(cutStartInTail, Math.max(0, cutInTail - lookback + idxQuote));
  }
  const idxDiv = before.lastIndexOf('[[div]]');
  if (idxDiv !== -1) {
    cutStartInTail = Math.min(cutStartInTail, Math.max(0, cutInTail - lookback + idxDiv));
  }

  const cutStart = tailStart + cutStartInTail;
  const removedLen = fullText.length - cutStart;

  let newText = fullText.slice(0, cutStart).replace(/[ \t]+$/gm, '').replace(/\s+$/g, '');

  if (signatureName) {
    newText += `\n\n---\n\n${signatureName}\n`;
    footerInfo.signatureAdded = signatureName;
  } else {
    newText += '\n';
  }

  footerInfo.footerStripped = true;
  footerInfo.removedBytes = removedLen;
  return newText;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const allFiles = await walkFiles(args.root);
  const mdFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.md'));
  const mdRelPosix = mdFiles
    .map((f) => toPosix(path.relative(args.root, f)))
    .filter((rel) => shouldProcess('/' + rel, args));

  // Build basename index for wikidot link rewriting.
  const basenameIndex = buildBasenameIndex(mdRelPosix);

  const runId = nowStamp();
  const backupRoot = path.join(args.backupDir, runId);

  const report = {
    runId,
    root: args.root,
    write: args.write,
    backup: args.backup,
    backupRoot: args.write && args.backup ? backupRoot : null,
    totals: {
      filesScanned: mdRelPosix.length,
      filesChanged: 0,
      filesWritten: 0,
    },
    perFile: [],
    wikidot: {
      rewritten: {},
      unresolved: [],
      ambiguous: {},
    },
  };

  const unresolvedWikidot = new Set();
  const ambiguousWikidot = new Map();
  const rewrittenWikidot = new Map();

  for (const rel of mdRelPosix) {
    const abs = path.join(args.root, rel);
    const original = await fsp.readFile(abs, 'utf8');

    const ctx = {
      fileRelPosix: rel,
      basenameIndex,
      unresolvedWikidot,
      ambiguousWikidot,
      rewrittenWikidot,
    };

    const segs = splitByFences(original);
    const mergedCounts = {};
    const footerInfo = { footerStripped: false, signatureAdded: null, removedBytes: 0 };

    const newSegs = segs.map((seg) => {
      if (seg.type === 'code') return seg;
      const r = applyTransformsToTextSegment(seg.content, ctx);
      for (const [k, v] of Object.entries(r.counts)) {
        if (!v) continue;
        mergedCounts[k] = (mergedCounts[k] || 0) + v;
      }
      return { ...seg, content: r.out };
    });

    let updated = joinSegments(newSegs, original);
    updated = stripCommonWikidotFooter(updated, footerInfo);

    const changed = updated !== original;

    if (changed) report.totals.filesChanged++;

    const fileEntry = {
      file: rel,
      changed,
      counts: mergedCounts,
      footer: footerInfo,
    };

    report.perFile.push(fileEntry);

    if (args.verbose) {
      const keys = Object.keys(mergedCounts).filter((k) => mergedCounts[k] > 0).sort();
      const summary = keys.map((k) => `${k}:${mergedCounts[k]}`).join(', ');
      if (changed) console.log(`[CHANGE] ${rel}${summary ? ' — ' + summary : ''}`);
      else console.log(`[OK]     ${rel}`);
    } else {
      if (changed) console.log(`[CHANGE] ${rel}`);
    }

    if (args.write && changed) {
      if (args.backup) {
        const backupPath = path.join(backupRoot, rel);
        await ensureDir(path.dirname(backupPath));
        await fsp.writeFile(backupPath, original, 'utf8');
      }
      await writeFileAtomic(abs, updated);
      report.totals.filesWritten++;
    }
  }

  report.wikidot.rewritten = Object.fromEntries([...rewrittenWikidot.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  report.wikidot.unresolved = [...unresolvedWikidot].sort();
  report.wikidot.ambiguous = Object.fromEntries([...ambiguousWikidot.entries()].sort((a, b) => a[0].localeCompare(b[0])));

  if (args.report) {
    const outPath = path.resolve(args.report);
    await ensureDir(path.dirname(outPath));
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`\nWrote report: ${outPath}`);
  }

  console.log(`\nScanned: ${report.totals.filesScanned}`);
  console.log(`Changed: ${report.totals.filesChanged}`);
  console.log(`Written: ${report.totals.filesWritten}${args.write ? '' : ' (dry-run)'}`);
  if (!args.write) {
    console.log('\nDry-run only. Re-run with --write to apply changes.');
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
