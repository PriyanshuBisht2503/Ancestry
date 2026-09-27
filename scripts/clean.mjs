#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['out', 'dist', 'media', 'coverage'];

await Promise.all(targets.map((t) => rm(path.join(root, t), { recursive: true, force: true })));
console.log(`[ancestry] removed: ${targets.join(', ')}`);
