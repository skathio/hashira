// Finds where a JSON text first goes wrong, as a line and column. JSON.parse names a position
// for some errors on some Node versions and none for others (Node 26 says only "Unexpected
// token ','"), so the text is scanned here instead of reading the position from the message.
// It is only called after JSON.parse has already failed, so it need not build any value.

'use strict';

const WS = new Set([' ', '\t', '\n', '\r']);
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING_RE = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const LITERALS = ['true', 'false', 'null'];

class Scan {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  ws() {
    while (WS.has(this.text[this.i])) this.i += 1;
  }

  // Matches a sticky regex at the cursor and moves past it, or throws the cursor.
  sticky(re) {
    re.lastIndex = this.i;
    if (!re.test(this.text)) throw this.i;
    this.i = re.lastIndex;
  }

  expect(ch) {
    if (this.text[this.i] !== ch) throw this.i;
    this.i += 1;
  }

  // Parses `open item (, item)* close` or `open close`.
  list(open, close, item) {
    this.expect(open);
    this.ws();
    if (this.text[this.i] === close) {
      this.i += 1;
      return;
    }
    for (;;) {
      item();
      this.ws();
      if (this.text[this.i] === close) {
        this.i += 1;
        return;
      }
      this.expect(',');
      this.ws();
    }
  }

  member() {
    this.sticky(STRING_RE);
    this.ws();
    this.expect(':');
    this.ws();
    this.value();
  }

  value() {
    const ch = this.text[this.i];
    if (ch === '{') return this.list('{', '}', () => this.member());
    if (ch === '[') return this.list('[', ']', () => this.value());
    if (ch === '"') return this.sticky(STRING_RE);
    const word = LITERALS.find((w) => this.text.startsWith(w, this.i));
    if (word) {
      this.i += word.length;
      return undefined;
    }
    return this.sticky(NUMBER_RE);
  }
}

// Returns the 0-based offset of the first error in text, or -1 if the text is valid JSON.
function errorOffset(text) {
  const scan = new Scan(text);
  try {
    scan.ws();
    scan.value();
    scan.ws();
    return scan.i === text.length ? -1 : scan.i;
  } catch (offset) {
    if (typeof offset === 'number') return offset;
    throw offset;
  }
}

// "line L column C" (both 1-based) for an offset into text.
function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `line ${line} column ${column}`;
}

module.exports = { errorOffset, lineColumn };
