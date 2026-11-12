#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateTaskObject } from '../task-store/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node scripts/install.mjs [--dest DIR] [--force] [--help]

Install local runtime files (no downloads or account changes).
Default destination: ~/.codex/super-agent
Existing destinations require --force; updates retain a sibling backup.`;
const fail = message => { throw new Error(message); };
function lstat(p) { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function checkPath(p) {
  const absolute = path.resolve(p);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = lstat(current);
    if (st?.isSymbolicLink()) fail(`Symlink path refused: ${current}`);
    if (st && current !== absolute && !st.isDirectory()) fail(`Not a directory: ${current}`);
  }
}
function inside(child, parent) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function mkdirPrivate(dir, created) {
  if (lstat(dir)) { checkPath(dir); if (!fs.lstatSync(dir).isDirectory()) fail(`Not a directory: ${dir}`); return; }
  mkdirPrivate(path.dirname(dir), created);
  fs.mkdirSync(dir, { mode: 0o700 });
  created.push(dir);
}
function checkState(dest) {
  const dir = path.join(dest, '.state');
  const st = lstat(dir);
  if (!st) return;
  checkPath(dir);
  if (!st.isDirectory()) fail('Invalid task state directory');
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const entry = lstat(file);
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) fail(`Unknown task state entry: ${name}`);
    if (name.endsWith('.lock') || name.endsWith('.gate')) fail(`Task lock or gate exists: ${name}`);
    if (!name.endsWith('.json') || entry.size > 16 * 1024 * 1024) fail(`Unknown task state entry: ${name}`);
    let task;
    try { task = JSON.parse(fs.readFileSync(file, 'utf8')); validateTaskObject(task, name.slice(0, -5), dest); }
    catch (e) { fail(`Invalid task state ${name}: ${e.message}`); }
    if (['RUNNING', 'REVIEWING'].includes(task.status) || task.owner !== null || task.activeChild !== null) fail(`Task may be active: ${name}`);
  }
}
function atomicWrite(target, bytes, mode) {
  const tmp = path.join(path.dirname(target), `.super-agent-install-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function main() {
  let dest = path.join(os.homedir(), '.codex', 'super-agent'), force = false, seenDest = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log(usage); return; }
    if (args[i] === '--force') { force = true; continue; }
    if (args[i] === '--dest' && !seenDest && args[i + 1] && !args[i + 1].startsWith('--')) { dest = args[++i]; seenDest = true; continue; }
    fail(`Invalid argument: ${args[i]}\n${usage}`);
  }
  dest = path.resolve(dest);
  checkPath(root); checkPath(dest);
  if (inside(dest, root) || inside(root, dest)) fail('Destination overlaps the source tree');
  const existing = lstat(dest);
  if (existing && !existing.isDirectory()) fail('Destination exists and is not a directory');
  if (existing && !force) fail('Destination already exists; use --force to update');
  if (lstat(path.join(dest, '.git'))) fail('Refusing a Git-root destination');
  if (existing) checkState(dest);
  const manifestPath = path.join(root, 'scripts', 'runtime-files.json');
  checkPath(manifestPath);
  const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) fail('Invalid runtime manifest');
  const entries = files.map(name => {
    if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..')) fail('Unsafe runtime manifest path');
    const src = path.join(root, name), dst = path.join(dest, name);
    checkPath(src); checkPath(dst);
    const st = lstat(src), old = lstat(dst);
    if (!st?.isFile()) fail(`Source file missing or invalid: ${name}`);
    if (old && !old.isFile()) fail(`Destination file is not regular: ${name}`);
    return { name, dst, data: fs.readFileSync(src), mode: old ? old.mode & 0o7777 : name === 'cli.mjs' ? 0o700 : 0o600, old: old ? { data: fs.readFileSync(dst), mode: old.mode & 0o7777 } : null };
  });
  const created = [], written = [];
  let backup = null;
  try {
    if (existing) {
      backup = path.join(path.dirname(dest), `.${path.basename(dest)}-backup-${randomUUID()}`);
      checkPath(backup);
      fs.mkdirSync(backup, { mode: 0o700 });
      const backupDirs = [];
      for (const e of entries) if (e.old) {
        const file = path.join(backup, 'files', e.name);
        mkdirPrivate(path.dirname(file), backupDirs);
        fs.writeFileSync(file, e.old.data, { flag: 'wx', mode: e.old.mode });
        fs.chmodSync(file, e.old.mode);
      }
      fs.writeFileSync(path.join(backup, 'rollback.json'), JSON.stringify({ version: 1, destination: dest, files: entries.map(e => ({ path: e.name, existed: !!e.old, mode: e.old?.mode ?? null })) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(backup, 'runtime-files.json'), JSON.stringify(files, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    mkdirPrivate(dest, created);
    for (const e of entries) {
      checkPath(e.dst);
      mkdirPrivate(path.dirname(e.dst), created);
      atomicWrite(e.dst, e.data, e.mode);
      written.push(e);
    }
  } catch (error) {
    const errors = [];
    for (const e of written.reverse()) try {
      checkPath(e.dst);
      if (e.old) atomicWrite(e.dst, e.old.data, e.old.mode); else fs.unlinkSync(e.dst);
    } catch (rollbackError) { errors.push(`${e.name}: ${rollbackError.message}`); }
    for (const dir of created.reverse()) try { fs.rmdirSync(dir); } catch (err) { if (!['ENOENT', 'ENOTEMPTY'].includes(err.code)) errors.push(`${dir}: ${err.message}`); }
    if (errors.length) error.message += `; rollback incomplete: ${errors.join('; ')}${backup ? `; backup: ${backup}` : ''}`;
    else if (backup) error.message += `; backup retained: ${backup}`;
    throw error;
  }
  console.log(`Installed to ${dest}${backup ? `\nBackup: ${backup}` : ''}`);
}
try { main(); } catch (error) { console.error(`Installation failed: ${error.message}`); process.exitCode = 1; }
