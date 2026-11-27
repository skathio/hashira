// Two defects a review of the v3.4.0 Pages work found, one test group each:
//
// - svgProblems read tags straight through comments, CDATA sections and processing
//   instructions, so an unclosed quote inside one opened an attribute value that swallowed the
//   real tag after it, and that tag's on* handler or javascript: URL was never seen. The scan
//   must read those as single tokens, the way an XML parser does.
// - The .gitignore check for the Playwright MCP folder must hold on a fresh checkout, where the
//   folder does not exist: the pattern is directory-only, so it must be asked about as a folder.
//
// Run with:
//   node --test tests/pages-site/review-svg-and-ignore.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const { svgProblems } = require(path.join(REPO, '.github', 'actions', 'docs-build', 'lib', 'html-safety'));

const NS = 'xmlns="http://www.w3.org/2000/svg"';

test('svgProblems sees a handler hidden behind a quote in a comment', () => {
  const text = `<svg ${NS}><!-- <x a=" --><svg onload="alert(document.domain)"/><!-- " --></svg>`;
  assert.ok(svgProblems(text).some((p) => /handler onload/.test(p)), JSON.stringify(svgProblems(text)));
  const click = `<svg ${NS}><!-- <x a=" --><g onclick="alert(1)"/><!-- " --></svg>`;
  assert.ok(svgProblems(click).some((p) => /handler onclick/.test(p)), JSON.stringify(svgProblems(click)));
});

test('svgProblems sees a javascript: URL hidden behind a quote in a comment', () => {
  const text = `<svg ${NS}><!-- <x a=" --><a href="javascript:alert(1)"><text>x</text></a><!-- " --></svg>`;
  assert.ok(svgProblems(text).some((p) => /javascript: URL/.test(p)), JSON.stringify(svgProblems(text)));
});

test('svgProblems sees a handler hidden behind a quote in CDATA or a processing instruction', () => {
  const cdata = `<svg ${NS}><style><![CDATA[ <x a=" ]]></style><svg onload="alert(1)"/><style><![CDATA[ " ]]></style></svg>`;
  assert.ok(svgProblems(cdata).some((p) => /handler onload/.test(p)), JSON.stringify(svgProblems(cdata)));
  const pi = `<?xml version="1.0"?><svg ${NS}><?x <y a=" ?><svg onload="alert(1)"/><?x " ?></svg>`;
  assert.ok(svgProblems(pi).some((p) => /handler onload/.test(p)), JSON.stringify(svgProblems(pi)));
});

test('svgProblems ignores markup that sits only inside a comment, and passes a commented SVG', () => {
  assert.deepEqual(svgProblems(`<svg ${NS}><!-- <g onclick="x"/> --><path d="M0 0h1"/></svg>`), []);
  assert.deepEqual(svgProblems(`<?xml version="1.0"?>\n<!-- logo -->\n<svg ${NS}><path d="M0 0h1"/></svg>`), []);
});

test('the Playwright MCP folder is ignored on a fresh checkout where it does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashira-ignore-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
    fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(dir, '.gitignore'));
    const asked = spawnSync('git', ['check-ignore', '-q', '.playwright-mcp/'], { cwd: dir });
    assert.equal(asked.status, 0, '.playwright-mcp/ is not ignored on a fresh checkout');
    const source = fs.readFileSync(path.join(REPO, 'tests', 'pages-site', 'pages-hardening.test.js'), 'utf8');
    assert.match(source, /'check-ignore', '-q', '\.playwright-mcp\/'/, 'the repo test must ask about the folder form');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('svgProblems refuses an XSLT stylesheet that could write a script element', () => {
  const xslt = `<?xml-stylesheet type="text/xsl" href="#s"?><svg ${NS}><xsl:stylesheet id="s" version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><html xmlns="http://www.w3.org/1999/xhtml"><xsl:element name="script">alert(1)</xsl:element></html></xsl:template></xsl:stylesheet></svg>`;
  const problems = svgProblems(xslt);
  assert.ok(problems.some((p) => /xml-stylesheet/.test(p)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /XSLT/.test(p)), JSON.stringify(problems));
  assert.ok(svgProblems(`<?xml-stylesheet href="style.css"?><svg ${NS}/>`).length > 0);
  assert.deepEqual(svgProblems(`<?xml version="1.0" encoding="UTF-8"?><svg ${NS}><path d="M0 0h1"/></svg>`), []);
});

// 40,000 unclosed openers: the old token pattern rescanned to the end from each one. The
// assertion is that a real handler after them is still found.
test('svgProblems reads past many unclosed tag openers and still finds a later handler', () => {
  const text = `<svg ${NS}>${'<a '.repeat(40000)}<g onload="x"/></svg>`;
  assert.ok(svgProblems(text).some((p) => /handler onload/.test(p)), JSON.stringify(svgProblems(text)));
});
