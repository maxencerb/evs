/**
 * `paths.ts` — from a module id to the file it names, and to how a message shows that file.
 */

import { relative } from 'node:path';

import { normalizePath } from 'vite';

/** The file a module id names: the id without its query. */
export function fileOf(id: string): string {
  return id.replace(/\?.*$/, '');
}

/** `file` relative to the project root, with forward slashes: what a message shows. */
export function displayPath(file: string, root: string): string {
  return normalizePath(relative(root, file));
}
