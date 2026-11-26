// The sidebar label for a page that has no label in pages.json's `sidebar`: its H1 as GitHub reads
// it, skipping fenced code blocks (a `# comment` line in a bash sample is not a heading), with
// code and emphasis marks dropped and a link reduced to its text. VitePress renders sidebar
// text as HTML, so `&` and `<` are written as entities. A page with no H1, or an empty one,
// gets the fallback, so it never shows as a blank entry.

'use strict';

const FENCE = /^ {0,3}(`{3,}|~{3,})/
// `# Title`, up to three spaces in, with optional closing hashes: `# Title #`.
const ATX_H1 = /^ {0,3}#(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
// A paragraph underlined with `=` is an H1 too.
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/
const INDENTED_CODE = /^(?: {4}|\t)/

function label(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .trim()
}

// A fence closes on a line of the same character, at least as long, and nothing else.
function closes(fence, marker, line) {
  return Boolean(marker) && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker
}

// The lines outside fenced code blocks. A fence opens as a blank line, which ends a paragraph.
function* proseLines(markdown) {
  let fence = null
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(FENCE)?.[1]
    if (fence) {
      fence = closes(fence, marker, line) ? null : fence
    } else if (marker) {
      fence = marker
      yield ''
    } else {
      yield line
    }
  }
}

// The H1 text on this line, or null when the line is not one. `paragraph` holds the text
// lines just above, which an `===` line turns into a heading.
function headingOf(line, paragraph) {
  const atx = line.match(ATX_H1)
  if (atx) {
    return atx[1] ?? ''
  }
  return paragraph.length && SETEXT_H1.test(line) ? paragraph.join(' ') : null
}

// Only paragraph text can be underlined into a heading: a blank line or indented code ends it.
function withLine(paragraph, line) {
  const ends = line.trim() === '' || (!paragraph.length && INDENTED_CODE.test(line))
  return ends ? [] : [...paragraph, line.trim()]
}

function h1Label(markdown, fallback) {
  if (typeof markdown !== 'string') {
    return fallback
  }
  let paragraph = []
  for (const line of proseLines(markdown)) {
    const heading = headingOf(line, paragraph)
    const text = heading === null ? '' : label(heading)
    if (text) {
      return text
    }
    paragraph = heading === null ? withLine(paragraph, line) : []
  }
  return fallback
}

module.exports = { h1Label };
