/**
 * Source byte-offset mapping for byte-accurate, reformat-free codemods (golden principle 7).
 *
 * Parsers report 1-based line / 0-based character column; codemods need UTF-8 byte offsets.
 * `SourceMap` converts between them. Line splitting keeps terminators (\n, \r\n, \r) so byte
 * accounting matches the source exactly.
 */

const _encoder = new TextEncoder();

function byteLen(s: string): number {
  return _encoder.encode(s).length;
}

/** Split into lines keeping their terminators — the equivalent of Python splitlines(keepends=True). */
function splitKeepEnds(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") {
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    } else if (c === "\r") {
      if (source[i + 1] === "\n") {
        lines.push(source.slice(start, i + 2));
        i++;
      } else {
        lines.push(source.slice(start, i + 1));
      }
      start = i + 1;
    }
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
}

export class SourceMap {
  readonly source: string;
  private readonly lines: string[];
  private readonly lineStart: number[];

  constructor(source: string) {
    this.source = source;
    this.lines = splitKeepEnds(source);
    this.lineStart = [0];
    let b = 0;
    for (const line of this.lines) {
      b += byteLen(line);
      this.lineStart.push(b);
    }
  }

  /** Byte offset of (1-based line, 0-based character column). */
  offset(line: number, col: number): number {
    const base = this.lineStart[line - 1] ?? 0;
    const lineText = line - 1 < this.lines.length ? (this.lines[line - 1] ?? "") : "";
    return base + byteLen(lineText.slice(0, col));
  }

  lineStartOffset(line: number): number {
    return this.lineStart[line - 1] ?? 0;
  }
}
