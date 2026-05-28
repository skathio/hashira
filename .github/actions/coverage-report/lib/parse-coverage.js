// Coverage parser shim for the `coverage-report` composite action.
//
// Parses three formats hand-rolled (no npm install — Node stdlib only):
//   - lcov   (text, one record per file delimited by `end_of_record`)
//   - cobertura (XML, <coverage line-rate=".." branch-rate=".." ...> with
//                nested <package>/<class> elements)
//   - opencover (XML, <CoverageSession>/<Modules>/<Module>/<Classes>/<Class>
//                with <Summary numSequencePoints=".." visitedSequencePoints=".." .. />)
//
// XML parsing is a deliberately small hand-rolled walker — pulling in a
// proper parser would require `npm install` mid-action, which the action
// is structured to avoid (composite-action portability + iteration scope).
// The walker handles the subset of XML the three formats actually use:
// elements with attributes and nested elements; no namespaces; no CDATA;
// no processing instructions beyond the leading `<?xml ?>`. If a real-world
// file breaks the walker, the right move is to file a follow-up, not to
// silently broaden scope here.
//
// Public API: `parseCoverage({ path, format })` -> { lines_pct, branches_pct, files: [{ path, lines_pct }] }
//   - `format` is one of 'lcov' | 'cobertura' | 'opencover' or undefined
//     for auto-detect from file extension.
//   - Percentages are numbers in [0, 100], rounded to one decimal.
//   - `files` is best-effort per-file; empty if the format doesn't expose it.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pct(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function detectFormat(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.info') || lower.endsWith('lcov')) return 'lcov';
  // Both cobertura and opencover end in .xml; sniff content.
  if (lower.endsWith('.xml')) {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
    if (/<CoverageSession\b/.test(head)) return 'opencover';
    if (/<coverage\b/.test(head)) return 'cobertura';
  }
  throw new Error(
    `parse-coverage: cannot auto-detect format for '${filePath}'. ` +
      `Pass an explicit 'format' (lcov | cobertura | opencover).`
  );
}

// --- lcov ----------------------------------------------------------------

function parseLcov(text) {
  // Per-record: SF:<path>, LF:<lines_found>, LH:<lines_hit>,
  // BRF:<branches_found>, BRH:<branches_hit>, end_of_record.
  const files = [];
  let cur = null;
  let totalLF = 0;
  let totalLH = 0;
  let totalBRF = 0;
  let totalBRH = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'end_of_record') {
      if (cur && cur.path) {
        files.push({ path: cur.path, lines_pct: pct(cur.LH, cur.LF) });
        totalLF += cur.LF;
        totalLH += cur.LH;
        totalBRF += cur.BRF;
        totalBRH += cur.BRH;
      }
      cur = null;
      continue;
    }
    if (!cur) cur = { path: null, LF: 0, LH: 0, BRF: 0, BRH: 0 };
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    if (key === 'SF') cur.path = value;
    else if (key === 'LF') cur.LF = parseInt(value, 10) || 0;
    else if (key === 'LH') cur.LH = parseInt(value, 10) || 0;
    else if (key === 'BRF') cur.BRF = parseInt(value, 10) || 0;
    else if (key === 'BRH') cur.BRH = parseInt(value, 10) || 0;
  }
  return {
    lines_pct: pct(totalLH, totalLF),
    branches_pct: pct(totalBRH, totalBRF),
    files,
  };
}

// --- minimal XML walker --------------------------------------------------
//
// Walks `text` and invokes `onOpen(name, attrs, isSelfClosing, depth)` and
// `onClose(name, depth)` for each tag. `depth` is the XML nesting depth at
// which the element sits: 1 for the document root element, 2 for its
// children, etc. The walker is the single source of truth for depth — it
// increments before invoking `onOpen` for a non-self-closing element, and
// decrements after invoking `onClose` for a non-self-closing element. For
// a self-closing element, both callbacks see the SAME depth value (the
// element's own nesting level) and depth is not retained afterwards.
// Attributes parsed via a small regex. Skips the XML declaration,
// comments, and DOCTYPE.

function walkXml(text, { onOpen, onClose }) {
  let i = 0;
  let depth = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    // Skip <?xml ?>, <!-- -->, <!DOCTYPE ...>
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = text.indexOf('>', i);
    if (gt < 0) break;
    const inner = text.slice(i + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const closeName = inner.slice(1).trim().split(/\s+/)[0];
      onClose(closeName, depth);
      depth -= 1;
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const match = body.match(/^\s*([A-Za-z_][\w:.-]*)\s*([\s\S]*)$/);
    if (!match) continue;
    const name = match[1];
    const attrs = {};
    const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(match[2])) !== null) {
      attrs[am[1]] = am[2];
    }
    if (selfClosing) {
      // Self-closing: both callbacks see the same depth (the element's
      // own nesting level), and depth is not retained.
      const selfDepth = depth + 1;
      onOpen(name, attrs, true, selfDepth);
      onClose(name, selfDepth);
    } else {
      depth += 1;
      onOpen(name, attrs, false, depth);
    }
  }
}

// --- cobertura -----------------------------------------------------------

function parseCobertura(text) {
  let rootLineRate = null;
  let rootBranchRate = null;
  let curFile = null;
  let fileLinesValid = 0;
  let fileLinesCovered = 0;
  // Some Coverlet emitters (and ReportGenerator's cobertura output) emit
  // <lines> both at the <class> level AND inside each <method>. The same
  // lines are then reported twice. We count only class-level <line>
  // elements — i.e., skip <line> while we're inside a <method>.
  let inMethod = false;
  const files = [];
  walkXml(text, {
    onOpen(name, attrs) {
      if (name === 'coverage' && rootLineRate === null) {
        if (attrs['line-rate'] !== undefined) rootLineRate = parseFloat(attrs['line-rate']);
        if (attrs['branch-rate'] !== undefined) rootBranchRate = parseFloat(attrs['branch-rate']);
      } else if (name === 'class') {
        // Flush previous file if any.
        if (curFile) {
          files.push({ path: curFile, lines_pct: pct(fileLinesCovered, fileLinesValid) });
        }
        curFile = attrs.filename || attrs.name || null;
        fileLinesValid = 0;
        fileLinesCovered = 0;
      } else if (name === 'method') {
        inMethod = true;
      } else if (name === 'line' && curFile && !inMethod) {
        // Cobertura <line number=".." hits=".." />
        fileLinesValid += 1;
        if (parseInt(attrs.hits || '0', 10) > 0) fileLinesCovered += 1;
      }
    },
    onClose(name) {
      if (name === 'method') inMethod = false;
    },
  });
  if (curFile) {
    files.push({ path: curFile, lines_pct: pct(fileLinesCovered, fileLinesValid) });
  }
  return {
    lines_pct: rootLineRate === null ? 0 : Math.round(rootLineRate * 1000) / 10,
    branches_pct: rootBranchRate === null ? 0 : Math.round(rootBranchRate * 1000) / 10,
    files,
  };
}

// --- opencover -----------------------------------------------------------

function parseOpenCover(text) {
  // Walk to find each <File uid=".." fullPath=".." /> and per-<Class> Summary.
  // Class -> Files mapping isn't trivial because <Method> references <FileRef
  // uid=".."/>; we report file paths by aggregating <Method> sequence points
  // grouped by their FileRef. For simplicity, we report aggregate root
  // percentages from the top-level <Summary>, and per-file lines_pct by
  // aggregating sequence points (<SequencePoint vc=".."/>) under each method
  // attributed to a FileRef.
  const fileById = new Map();
  const fileStats = new Map(); // uid -> { total, covered }
  let curFileUid = null;
  let rootCovered = null;
  let rootTotal = null;
  walkXml(text, {
    onOpen(name, attrs, _selfClosing, depth) {
      if (name === 'File' && attrs.uid && attrs.fullPath) {
        fileById.set(attrs.uid, attrs.fullPath);
      } else if (name === 'FileRef' && attrs.uid) {
        curFileUid = attrs.uid;
        if (!fileStats.has(curFileUid)) fileStats.set(curFileUid, { total: 0, covered: 0 });
      } else if (name === 'SequencePoint' && curFileUid) {
        const stat = fileStats.get(curFileUid);
        stat.total += 1;
        if (parseInt(attrs.vc || '0', 10) > 0) stat.covered += 1;
      } else if (name === 'Method') {
        curFileUid = null;
      } else if (name === 'Summary' && depth === 2 && rootCovered === null) {
        // The top-level <CoverageSession> is at depth 1, so its direct
        // <Summary> child sits at depth 2. Per-<Class> <Summary> elements
        // are deeper (>= 6). Capturing only depth-2 ensures we read the
        // CoverageSession-level totals regardless of XML reordering.
        rootTotal = parseInt(attrs.numSequencePoints || '0', 10);
        rootCovered = parseInt(attrs.visitedSequencePoints || '0', 10);
      }
    },
    onClose() {
      // No-op; depth is tracked by the walker.
    },
  });
  const files = [];
  for (const [uid, stat] of fileStats.entries()) {
    const p = fileById.get(uid);
    if (!p) continue;
    files.push({ path: p, lines_pct: pct(stat.covered, stat.total) });
  }
  return {
    lines_pct: pct(rootCovered || 0, rootTotal || 0),
    branches_pct: 0, // opencover branch coverage requires its own roll-up; not implemented in v1.
    files,
  };
}

// --- entry point ---------------------------------------------------------

function parseCoverage({ path: filePath, format }) {
  if (!filePath) throw new Error('parse-coverage: `path` is required.');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`parse-coverage: file not found: ${resolved}`);
  }
  const fmt = format || detectFormat(resolved);
  const text = fs.readFileSync(resolved, 'utf8');
  switch (fmt) {
    case 'lcov':
      return parseLcov(text);
    case 'cobertura':
      return parseCobertura(text);
    case 'opencover':
      return parseOpenCover(text);
    default:
      throw new Error(`parse-coverage: unsupported format '${fmt}'.`);
  }
}

module.exports = { parseCoverage, detectFormat };
