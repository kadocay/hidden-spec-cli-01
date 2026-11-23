// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`. Implements all of SPEC.md v1:
// the command line, output and exit codes, safe paths, format detection,
// three-tier line matching (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits
// (section 9) and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --- section 5 helpers: a file is lines plus whether it ends with a line break. ---
const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const both = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function splitFile(content: string): { lines: string[]; trailing: boolean; crlf: boolean } {
  if (content === '') return { lines: [], trailing: false, crlf: false };
  const crlf = content.includes('\r\n');
  const parts = content.split('\n');
  const trailing = parts[parts.length - 1] === '';
  if (trailing) parts.pop();
  const lines = crlf ? parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) : parts;
  return { lines, trailing, crlf };
}
function joinFile(lines: string[], trailing: boolean, crlf: boolean): string {
  if (lines.length === 0) return '';
  const br = crlf ? '\r\n' : '\n';
  return lines.join(br) + (trailing ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.set(oldP, newP);
  }
}

type Edit = (tree: Tree) => void;
type HunkLine = { text: string; isCtx: boolean };

/** All occurrences of O in lines at the first tier (0, 1 or 2) with at least one, or null. */
function occurrences(lines: string[], old: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trail : both;
    const o = old.map(norm);
    const positions: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (norm(lines[i + j]!) !== o[j]) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * Replace O (at position `at`, found at `tier`) by N in a file.
 * Context lines of N are written as the file's own matched lines; at tier 2 the
 * other lines of N are re-indented from O's first-line indent P to the file's F.
 * `noNlAtEnd` is true when a `\` line follows the hunk's last context or `+` line:
 * then a replacement that runs to the end of the file leaves no trailing break.
 * `forceTrail` (unified only) makes a replacement that runs to the end of the file
 * end with a line break unless `noNlAtEnd`; other formats keep the file's own
 * trailing break when they reach the end.
 */
function applyReplace(
  file: { lines: string[]; trailing: boolean; crlf: boolean },
  old: HunkLine[],
  nw: HunkLine[],
  tier: number,
  at: number,
  noNlAtEnd: boolean,
  forceTrail: boolean,
): { lines: string[]; trailing: boolean; crlf: boolean } {
  const P = old.length > 0 ? leadWs(old[0]!.text) : '';
  const F = at < file.lines.length ? leadWs(file.lines[at]!) : '';
  const oldCtxIdx: number[] = [];
  old.forEach((l, idx) => { if (l.isCtx) oldCtxIdx.push(idx); });
  const repl: string[] = [];
  let r = 0;
  for (const l of nw) {
    if (l.isCtx) {
      repl.push(file.lines[at + oldCtxIdx[r]!]!);
      r += 1;
    } else if (tier === 2 && l.text !== '' && l.text.trim() !== '' && l.text.startsWith(P)) {
      repl.push(F + l.text.slice(P.length));
    } else {
      repl.push(l.text);
    }
  }
  const lines = [...file.lines.slice(0, at), ...repl, ...file.lines.slice(at + old.length)];
  const reachesEnd = at + old.length === file.lines.length;
  const trailing = reachesEnd ? (forceTrail ? !noNlAtEnd : file.trailing) : file.trailing;
  return { lines, trailing, crlf: file.crlf };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- section 6: unified diffs. ---
function parseDiffGit(line: string): { oldP: string; newP: string } | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return { oldP: x, newP: y };
}
function parsePathLine(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function parseHunkHeader(line: string): { a: number; c: number } | null {
  const m = HUNK_RE.exec(line);
  if (m === null) return null;
  return { a: Number(m[1]), c: Number(m[2]) };
}
type UniHunk = { a: number; old: HunkLine[]; nw: HunkLine[]; noNlAtEnd: boolean };

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    // Find the next section start.
    let secAt = -1;
    let dg: { oldP: string; newP: string } | null = null;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) {
        const g = parseDiffGit(l);
        if (g === null) throw new Exit2(`error: parse ${j + 1}`);
        secAt = j; dg = g; break;
      }
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) { secAt = j; break; }
    }
    if (secAt < 0) break;
    i = secAt;
    let oldPath: string | null = dg ? dg.oldP : null;
    let newPath: string | null = dg ? dg.newP : null;
    let isCreate = false;
    let isDelete = false;
    let sawPaths = false;
    i += dg ? 1 : 0;
    // Header lines until the first hunk or the next section.
    const hunks: UniHunk[] = [];
    let headerDone = false;
    while (i < lines.length && !headerDone) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('@@')) { headerDone = true; break; }
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (sawPaths) break;
        oldPath = parsePathLine(l);
        newPath = parsePathLine(lines[i + 1]!);
        sawPaths = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) { oldPath = l.slice('rename from '.length).trim(); i += 1; continue; }
      if (l.startsWith('rename to ')) { newPath = l.slice('rename to '.length).trim(); i += 1; continue; }
      if (l === 'new file mode' || l.startsWith('new file mode ')) { isCreate = true; i += 1; continue; }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) { isDelete = true; i += 1; continue; }
      i += 1;
    }
    // Hunks.
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) {
        const h = parseHunkHeader(l);
        if (h === null) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
        const body: string[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); i += 1; continue; }
          break;
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        const old: HunkLine[] = [];
        const nw: HunkLine[] = [];
        for (const b of body) {
          if (b.startsWith(' ')) { old.push({ text: b.slice(1), isCtx: true }); nw.push({ text: b.slice(1), isCtx: true }); }
          else if (b.startsWith('-')) old.push({ text: b.slice(1), isCtx: false });
          else if (b.startsWith('+')) nw.push({ text: b.slice(1), isCtx: false });
          else if (b === '') { old.push({ text: '', isCtx: true }); nw.push({ text: '', isCtx: true }); }
        }
        let noNlAtEnd = false;
        for (let k = 0; k < body.length; k++) {
          const b = body[k]!;
          if ((b.startsWith(' ') || b.startsWith('+') || b === '') && body[k + 1] === '\\' || (b.startsWith(' ') || b.startsWith('+')) && (body[k + 1] ?? '').startsWith('\\')) {
            // A `\` line right after the last context or `+` line.
            if (k === body.length - 2 || body.slice(k + 2).every((x) => x.startsWith('\\'))) noNlAtEnd = true;
          }
        }
        // Simpler, exact rule: a `\` line immediately after the last context/`+` line.
        {
          let lastCP = -1;
          for (let k = 0; k < body.length; k++) {
            const b = body[k]!;
            if (b.startsWith(' ') || b.startsWith('+') || b === '') lastCP = k;
          }
          noNlAtEnd = lastCP >= 0 && (body[lastCP + 1] ?? '').startsWith('\\');
        }
        hunks.push({ a: h.a, old, nw, noNlAtEnd });
        continue;
      }
      break;
    }
    // The section is one edit.
    if (oldPath === null && newPath === null) { i = secAt + 1; continue; }
    const op = oldPath ?? '';
    const np = newPath ?? '';
    if (op === '/dev/null') isCreate = true;
    if (np === '/dev/null') isDelete = true;
    if (isCreate && !sawPaths && dg === null) { /* creation named only by new file mode; path from rename/diff */ }
    const target = isCreate ? np : op;
    if (target === '' || target === '/dev/null') {
      if (isCreate && np !== '' && np !== '/dev/null') { /* ok */ } else { i = secAt + 1; continue; }
    }
    const hs = hunks;
    edits.push((tree) => {
      if (isCreate) {
        const p = np;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of hs) for (const l of h.nw) if (!l.isCtx) plus.push(l.text);
        const last = hs[hs.length - 1];
        const trailing = last ? !last.noNlAtEnd : true;
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (trailing ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const p = op;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const isMove = op !== np;
      const p = op;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      let file = splitFile(cur);
      let d = 0;
      for (const h of hs) {
        if (h.old.length === 0) {
          const at = Math.min(h.a + d, file.lines.length);
          const nw = h.nw.map((l) => ({ text: l.text, isCtx: l.isCtx }));
          const res = applyReplace(file, [], nw, 0, at, h.noNlAtEnd, true);
          file = res;
        } else {
          const occ = occurrences(file.lines, h.old.map((l) => l.text), strict);
          if (occ === null) throw new Fail('no-match', p);
          const want = h.a - 1 + d;
          let best = occ.positions[0]!;
          for (const pos of occ.positions) {
            if (Math.abs(pos - want) < Math.abs(best - want)) best = pos;
          }
          const res = applyReplace(file, h.old, h.nw, occ.tier, best, h.noNlAtEnd, true);
          file = res;
        }
        d += h.nw.length - h.old.length;
      }
      const content = joinFile(file.lines, file.trailing, file.crlf);
      if (isMove) tree.move(p, np, content);
      else tree.now.set(p, content);
    });
  }
  return edits;
}

// --- section 7: SEARCH/REPLACE blocks. ---
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { sIdx = j; break; }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eqIdx = j; break; }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { repIdx = j; break; }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const file = splitFile(cur);
      const occ = occurrences(file.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', p);
      if (occ.positions.length > 1) throw new Fail('ambiguous', p);
      const res = applyReplace(
        file,
        oldLines.map((t) => ({ text: t, isCtx: false })),
        newLines.map((t) => ({ text: t, isCtx: false })),
        occ.tier,
        occ.positions[0]!,
        false,
        false,
      );
      tree.now.set(p, joinFile(res.lines, res.trailing, res.crlf));
    });
    prevPath = p;
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

// --- section 8: V4A patches. ---
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) { if (!blank(lines[j]!)) { last = j; break; } }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i += 1;
      const body: string[] = [];
      while (i < last && !lines[i]!.startsWith('*** ')) {
        const b = lines[i]!;
        if (b.startsWith('+')) body.push(b.slice(1));
        else if (b === '') body.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      type Chunk = { anchor: string | null; old: HunkLine[]; nw: HunkLine[]; eof: boolean };
      const chunks: Chunk[] = [];
      while (i < last && !lines[i]!.startsWith('*** ')) {
        let anchor: string | null = null;
        let eof = false;
        if (lines[i]!.startsWith('@@')) {
          anchor = lines[i]!.slice(2).trim();
          i += 1;
        }
        const old: HunkLine[] = [];
        const nw: HunkLine[] = [];
        let sawBody = false;
        while (i < last) {
          const b = lines[i]!;
          if (b === '*** End of File') { eof = true; i += 1; break; }
          if (b.startsWith('*** ')) break;
          if (b.startsWith('@@')) break;
          if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') {
            sawBody = true;
            if (b.startsWith(' ')) { old.push({ text: b.slice(1), isCtx: true }); nw.push({ text: b.slice(1), isCtx: true }); }
            else if (b.startsWith('-')) old.push({ text: b.slice(1), isCtx: false });
            else if (b.startsWith('+')) nw.push({ text: b.slice(1), isCtx: false });
            else { old.push({ text: '', isCtx: true }); nw.push({ text: '', isCtx: true }); }
            i += 1;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (!sawBody && anchor === null && chunks.length === 0) {
          // A first chunk must start at a body line; an empty one is an error unless it is only a move.
          if (moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
          break;
        }
        // Blank lines at the end of a body are not part of it (SPEC 8: blank lines
        // at the end of a section are not part of it).
        while (old.length > 0 && old[old.length - 1]!.isCtx && old[old.length - 1]!.text === '') old.pop();
        while (nw.length > 0 && nw[nw.length - 1]!.isCtx && nw[nw.length - 1]!.text === '') nw.pop();
        chunks.push({ anchor, old, nw, eof });
        if (eof) break;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let file = splitFile(cur);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            // First line at or after the cursor equal to the anchor at the first tier with one.
            let found = -1;
            const occ = occurrences(file.lines.slice(cursor), [ch.anchor], strict);
            if (occ !== null) found = cursor + occ.positions[0]!;
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          if (ch.old.length === 0) {
            const at = ch.eof ? file.lines.length : cursor;
            const res = applyReplace(file, [], ch.nw.map((l) => ({ text: l.text, isCtx: l.isCtx })), 0, at, false, false);
            file = res;
            cursor = at + ch.nw.length;
            continue;
          }
          const sub = file.lines.slice(cursor);
          const occ = occurrences(sub, ch.old.map((l) => l.text), strict);
          if (occ === null) throw new Fail('no-match', p);
          let at = cursor + occ.positions[0]!;
          if (ch.eof) {
            const ok = occ.positions.some((pos) => cursor + pos + ch.old.length === file.lines.length);
            if (!ok) throw new Fail('no-match', p);
            at = file.lines.length - ch.old.length;
          }
          const res = applyReplace(file, ch.old, ch.nw, occ.tier, at, false, false);
          file = res;
          cursor = at + ch.nw.length;
        }
        const content = joinFile(file.lines, file.trailing, file.crlf);
        if (moveTo !== null) tree.move(p, moveTo, content);
        else tree.now.set(p, content);
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveNew = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.now.get(oldP) === null && tree.now.get(newP) !== null && tree.now.get(newP) !== undefined && tree.original(newP) === null) moveNew.set(newP, oldP);
  }
  const moveOld = new Set<string>([...moveNew.values()]);
  const entries: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveNew.has(p)) entries.push({ key: p, line: `R ${moveNew.get(p)} -> ${p}` });
    else if (moveOld.has(p)) continue;
    else entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
