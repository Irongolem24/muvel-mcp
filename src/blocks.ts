import { randomUUID } from "node:crypto";
import type { Block, DeltaBlock, InlineNode } from "./types.js";

// Text format exchanged with agents: one line per block.
//   episode:  describe → plain text, quote → "> ", comment → "// ", divider → "---"
//   wiki:     paragraph → plain text, h1..h6 → "#".."######", blockquote → "> "
//   read-only blocks (images, tables, lists) → "[이미지:abcd1234]", "[표:abcd1234] …", "[목록:abcd1234] …"
// A hard line break inside a block is written as "<br>". A plain paragraph whose text would
// otherwise look like one of the markers above is escaped with a leading backslash.

const BR = "<br>";
const MAX_LCS_CELLS = 25_000_000;
const READ_ONLY_LINE = /^\[(이미지|표|목록):([0-9a-f]{8})\]/;
const PASTED_ID_PREFIX = /^\[[0-9a-f]{8}\] /;

export type DocKind = "episode" | "wiki";

interface ParsedLine {
  blockType: string;
  content: InlineNode[];
}

function flatten(nodes: InlineNode[] | undefined): string {
  if (!nodes?.length) return "";
  // Nested nodes (list items, table cells) are joined with " / " so their text stays visible.
  const nested = nodes.some((n) => n.content?.length);
  return nodes
    .map((n) => (n.type === "hard_break" ? BR : n.content?.length ? flatten(n.content) : (n.text ?? "")))
    .filter((s) => !nested || s !== "")
    .join(nested ? " / " : "");
}

function blockText(block: Block): string {
  return flatten(block.content) || block.text || "";
}

function textToInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  text.split(BR).forEach((part, i) => {
    if (i > 0) nodes.push({ type: "hard_break" });
    if (part) nodes.push({ type: "text", text: part });
  });
  return nodes;
}

function readOnlyLabel(block: Block, kind: DocKind): string | null {
  switch (block.blockType) {
    case "image":
      return "이미지";
    case "table":
      return kind === "wiki" ? "표" : null;
    case "bullet_list":
    case "ordered_list":
    case "list_item":
      return kind === "wiki" ? "목록" : null;
    default:
      return null;
  }
}

export function isReadOnly(block: Block, kind: DocKind): boolean {
  return readOnlyLabel(block, kind) !== null;
}

/** The plain-paragraph block type for a document kind. */
const plainType = (kind: DocKind) => (kind === "episode" ? "describe" : "paragraph");

function parseMarked(line: string, kind: DocKind): ParsedLine | null {
  if (kind === "episode") {
    if (line === "---") return { blockType: "divider", content: [] };
    if (line.startsWith("> ")) return { blockType: "quote", content: textToInline(line.slice(2)) };
    if (line.startsWith("// ")) return { blockType: "comment", content: textToInline(line.slice(3)) };
    return null;
  }
  const heading = /^(#{1,6}) (.*)$/.exec(line);
  if (heading) return { blockType: `h${heading[1].length}`, content: textToInline(heading[2]) };
  if (line.startsWith("> ")) return { blockType: "blockquote", content: textToInline(line.slice(2)) };
  return null;
}

/** Plain text that would be misread as a marker gets a leading backslash. */
function escapePlain(text: string, kind: DocKind): string {
  const looksSpecial =
    text.startsWith("\\") || READ_ONLY_LINE.test(text) || PASTED_ID_PREFIX.test(text) || parseMarked(text, kind) !== null;
  return looksSpecial ? `\\${text}` : text;
}

export function renderBlock(block: Block, kind: DocKind): string {
  const label = readOnlyLabel(block, kind);
  const text = blockText(block);
  if (label) return `[${label}:${shortId(block.id)}]${text ? ` ${text}` : ""}`;
  if (kind === "episode") {
    switch (block.blockType) {
      case "quote":
        return `> ${text}`;
      case "comment":
        return `// ${text}`;
      case "divider":
        return "---";
      default:
        return escapePlain(text, kind);
    }
  }
  const heading = /^h([1-6])$/.exec(block.blockType);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text}`;
  if (block.blockType === "blockquote") return `> ${text}`;
  return escapePlain(text, kind);
}

function parseLine(line: string, kind: DocKind): ParsedLine {
  if (READ_ONLY_LINE.test(line)) {
    throw new Error(
      `'${line.slice(0, 40)}' 줄은 이미지·표·목록 블록이라 내용을 바꾸거나 위치를 옮길 수 없습니다. 이 줄을 원래 내용 그대로, 주변 문단과의 원래 순서대로 두세요. 아무것도 저장하지 않았습니다.`,
    );
  }
  if (PASTED_ID_PREFIX.test(line)) {
    throw new Error(
      `'${line.slice(0, 40)}' 줄 앞에 블록 ID 표시([xxxxxxxx])가 붙어 있습니다. withBlockIds로 읽은 ID 표시는 빼고 본문만 보내세요. 아무것도 저장하지 않았습니다.`,
    );
  }
  if (line.startsWith("\\")) return { blockType: plainType(kind), content: textToInline(line.slice(1)) };
  return parseMarked(line, kind) ?? { blockType: plainType(kind), content: textToInline(line) };
}

export function sortBlocks(blocks: Block[]): Block[] {
  return [...blocks].sort((a, b) => a.order - b.order);
}

export function renderDoc(blocks: Block[], kind: DocKind, withIds = false): string {
  return sortBlocks(blocks)
    .map((b) => (withIds ? `[${shortId(b.id)}] ` : "") + renderBlock(b, kind))
    .join("\n");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function resolveBlockId(blocks: Block[], ref: string): string {
  const key = ref.replace(/^\[|\]$/g, "");
  const matches = blocks.filter((b) => b.id === key || b.id.startsWith(key));
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new Error(`블록 '${ref}'을(를) 찾을 수 없습니다.`);
  throw new Error(`블록 ID '${ref}'이(가) 여러 블록과 일치합니다. 더 긴 ID를 사용하세요.`);
}

/** A block with no visible text (used as vertical spacing by some authors). */
export function isBlankBlock(block: Block, kind: DocKind): boolean {
  return block.blockType !== "divider" && !isReadOnly(block, kind) && blockText(block).trim() === "";
}

/**
 * Split agent text into block lines. In keep mode blank lines become blank blocks, but
 * trailing blank lines beyond `maxTrailingBlank` (how many the document already ends
 * with) are treated as a stray final newline and dropped.
 */
export function splitLines(text: string, keepBlankLines: boolean, maxTrailingBlank = 0): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!keepBlankLines) return lines.filter((l) => l.trim() !== "");
  let trailing = 0;
  while (trailing < lines.length && lines[lines.length - 1 - trailing].trim() === "") trailing++;
  return lines.slice(0, lines.length - Math.max(0, trailing - maxTrailingBlank));
}

export function trailingBlankCount(blocks: Block[], kind: DocKind): number {
  const sorted = sortBlocks(blocks);
  let n = 0;
  while (n < sorted.length && isBlankBlock(sorted[sorted.length - 1 - n], kind)) n++;
  return n;
}

/** Longest common subsequence pairs (oldIndex, newIndex) over equal strings. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0) {
    if (n * m > MAX_LCS_CELLS) {
      // Positional pairing would silently re-point clue/comment block IDs at other paragraphs.
      throw new Error("한 번에 바뀌는 범위가 너무 큽니다. muvel_edit_episode로 나눠서 수정하세요. 아무것도 저장하지 않았습니다.");
    }
    // Table of LCS lengths for the middle section; Uint16 is plenty under MAX_LCS_CELLS.
    const width = m + 1;
    const dp = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * width + j] =
          a[start + i] === b[start + j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
      else j++;
    }
  }

  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/**
 * Read-only lines (images, tables, lists) carry a unique ID, so they are matched first and
 * the LCS runs only between them. Otherwise moving text across an image could leave the
 * image line unmatched, which parseLine rejects as an attempt to move the image.
 */
function anchoredPairs(old: Block[], oldLines: string[], newLines: string[], kind: DocKind): [number, number][] {
  const newIndex = new Map<string, number>();
  newLines.forEach((l, i) => newIndex.set(l, newIndex.has(l) ? -1 : i));
  const anchors: [number, number][] = [];
  let lastNew = -1;
  old.forEach((b, oi) => {
    if (!isReadOnly(b, kind)) return;
    const ni = newIndex.get(oldLines[oi]);
    // Anchors must stay in order; an out-of-order one is a moved block and is left to parseLine.
    if (ni !== undefined && ni > lastNew) {
      anchors.push([oi, ni]);
      lastNew = ni;
    }
  });
  const pairs: [number, number][] = [];
  let po = 0;
  let pn = 0;
  for (const [oi, ni] of [...anchors, [old.length, newLines.length] as [number, number]]) {
    for (const [a, b] of lcsPairs(oldLines.slice(po, oi), newLines.slice(pn, ni))) pairs.push([a + po, b + pn]);
    if (oi < old.length) pairs.push([oi, ni]);
    po = oi + 1;
    pn = ni + 1;
  }
  return pairs;
}

export interface DiffSummary {
  kept: number;
  updated: number;
  created: number;
  deleted: number;
}

/**
 * Compute the delta that turns `oldBlocks` into `newLines`. Unchanged lines keep their
 * block IDs (clue references point at block IDs); changed lines inside the same gap are
 * paired positionally and sent as updates so IDs survive light edits too. Read-only
 * blocks (images, tables, lists) can stay where they are or be removed, never changed.
 * Throws before producing anything if a line is invalid, so nothing is half-saved.
 */
export function diffBlocks(
  oldBlocks: Block[],
  newLines: string[],
  kind: DocKind,
): { delta: DeltaBlock[]; summary: DiffSummary } {
  const old = sortBlocks(oldBlocks);
  const oldLines = old.map((b) => renderBlock(b, kind));
  const pairs = anchoredPairs(old, oldLines, newLines, kind);
  const date = new Date();
  const delta: DeltaBlock[] = [];
  const summary: DiffSummary = { kept: 0, updated: 0, created: 0, deleted: 0 };

  const emitKeep = (oi: number, ni: number) => {
    summary.kept++;
    if (old[oi].order !== ni) delta.push({ id: old[oi].id, action: "update", date, order: ni });
  };
  const emitGap = (oFrom: number, oTo: number, nFrom: number, nTo: number) => {
    // Read-only old blocks in a changed region were removed by the agent; the rest pair up.
    const editable: number[] = [];
    for (let oi = oFrom; oi < oTo; oi++) {
      if (isReadOnly(old[oi], kind)) {
        delta.push({ id: old[oi].id, action: "delete", date });
        summary.deleted++;
      } else editable.push(oi);
    }
    let k = 0;
    for (let ni = nFrom; ni < nTo; ni++) {
      const parsed = parseLine(newLines[ni], kind);
      if (k < editable.length) {
        const ob = old[editable[k++]];
        delta.push({ id: ob.id, action: "update", date, content: parsed.content, blockType: parsed.blockType, attr: ob.attr ?? {}, order: ni });
        summary.updated++;
      } else {
        delta.push({ id: randomUUID(), action: "create", date, content: parsed.content, blockType: parsed.blockType, attr: {}, order: ni });
        summary.created++;
      }
    }
    for (; k < editable.length; k++) {
      delta.push({ id: old[editable[k]].id, action: "delete", date });
      summary.deleted++;
    }
  };

  let po = 0;
  let pn = 0;
  for (const [oi, ni] of pairs) {
    emitGap(po, oi, pn, ni);
    emitKeep(oi, ni);
    po = oi + 1;
    pn = ni + 1;
  }
  emitGap(po, old.length, pn, newLines.length);
  return { delta, summary };
}

export function plainLength(blocks: Block[]): number {
  return blocks.reduce((sum, b) => sum + blockText(b).replaceAll(BR, "").length, 0);
}
