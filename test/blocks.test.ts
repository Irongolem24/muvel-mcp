import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBlocks, isBlankBlock, renderDoc, resolveBlockId, sortBlocks, splitLines, trailingBlankCount } from "../src/blocks.js";
import type { Block, DeltaBlock } from "../src/types.js";

const blk = (id: string, text: string, order: number, blockType = "describe"): Block => ({
  id,
  content: text ? [{ type: "text", text }] : [],
  blockType,
  attr: {},
  order,
});

/** Apply a delta to blocks the way the server would, for round-trip checks. */
function apply(blocks: Block[], delta: DeltaBlock[]): Block[] {
  const map = new Map(blocks.map((b) => [b.id, { ...b }]));
  for (const d of delta) {
    if (d.action === "delete") map.delete(d.id);
    else if (d.action === "create") map.set(d.id, { id: d.id, content: d.content, blockType: d.blockType, attr: d.attr, order: d.order });
    else Object.assign(map.get(d.id)!, Object.fromEntries(Object.entries(d).filter(([k]) => !["id", "action", "date"].includes(k))));
  }
  return [...map.values()];
}

const base = [blk("a", "하나", 0), blk("b", "둘", 1), blk("c", "셋", 2), blk("d", "넷", 3)];

test("no change produces empty delta", () => {
  const { delta } = diffBlocks(base, ["하나", "둘", "셋", "넷"], "episode");
  assert.equal(delta.length, 0);
});

test("editing one line updates that block in place, keeping its id", () => {
  const { delta, summary } = diffBlocks(base, ["하나", "둘!", "셋", "넷"], "episode");
  assert.deepEqual(summary, { kept: 3, updated: 1, created: 0, deleted: 0 });
  assert.equal(delta.length, 1);
  assert.equal(delta[0].id, "b");
  assert.equal(delta[0].action, "update");
});

test("insertion keeps ids of surrounding blocks and reorders", () => {
  const lines = ["하나", "새 문단", "둘", "셋", "넷"];
  const { delta, summary } = diffBlocks(base, lines, "episode");
  assert.equal(summary.created, 1);
  assert.equal(summary.deleted, 0);
  const after = apply(base, delta);
  assert.equal(renderDoc(after, "episode"), lines.join("\n"));
  assert.ok(after.find((b) => b.id === "b")!.order === 2);
});

test("deletion removes only that block", () => {
  const { delta, summary } = diffBlocks(base, ["하나", "셋", "넷"], "episode");
  assert.deepEqual(summary, { kept: 3, updated: 0, created: 0, deleted: 1 });
  assert.ok(delta.some((d) => d.id === "b" && d.action === "delete"));
});

test("block types round-trip through text", () => {
  const blocks = [blk("a", "지문", 0), blk("b", "인용", 1, "quote"), blk("c", "", 2, "divider"), blk("d", "메모", 3, "comment")];
  const text = renderDoc(blocks, "episode");
  assert.equal(text, "지문\n> 인용\n---\n// 메모");
  const { delta } = diffBlocks(blocks, text.split("\n"), "episode");
  assert.equal(delta.length, 0);
  const fresh = apply([], diffBlocks([], text.split("\n"), "episode").delta);
  assert.deepEqual(fresh.map((b) => b.blockType), ["describe", "quote", "divider", "comment"]);
});

test("hard breaks render as <br> and parse back", () => {
  const b: Block = { id: "x", content: [{ type: "text", text: "위" }, { type: "hard_break" }, { type: "text", text: "아래" }], blockType: "describe", attr: {}, order: 0 };
  assert.equal(renderDoc([b], "episode"), "위<br>아래");
  const created = apply([], diffBlocks([], ["위<br>아래"], "episode").delta)[0];
  assert.deepEqual(created.content, b.content);
});

test("wiki headings", () => {
  const created = apply([], diffBlocks([], ["## 개요", "본문", "> 인용"], "wiki").delta);
  assert.deepEqual(created.map((b) => b.blockType), ["h2", "paragraph", "blockquote"]);
  assert.equal(renderDoc(created, "wiki"), "## 개요\n본문\n> 인용");
});

test("image blocks are not morphed into text", () => {
  const blocks = [blk("a", "앞", 0), blk("abc00000-x", "", 1, "image"), blk("c", "뒤", 2)];
  const { delta } = diffBlocks(blocks, ["앞", "새 글", "뒤"], "episode");
  assert.ok(delta.some((d) => d.id === "abc00000-x" && d.action === "delete"));
  assert.ok(delta.some((d) => d.action === "create"));
});

test("an untouched image keeps its place", () => {
  const blocks = [blk("a", "앞", 0), blk("abc00000-x", "", 1, "image"), blk("c", "뒤", 2)];
  const text = renderDoc(blocks, "episode");
  assert.equal(text, "앞\n[이미지:abc00000]\n뒤");
  assert.equal(diffBlocks(blocks, text.split("\n"), "episode").delta.length, 0);
  const { delta } = diffBlocks(blocks, ["앞!", "[이미지:abc00000]", "뒤"], "episode");
  assert.deepEqual(delta.map((d) => [d.id, d.action]), [["a", "update"]]);
});

test("reordering around an image keeps the image block instead of turning it into text", () => {
  const blocks = [blk("a", "A", 0), blk("abc00000-x", "", 1, "image"), blk("c", "C", 2), blk("d", "D", 3)];
  const { delta } = diffBlocks(blocks, ["A", "C", "[이미지:abc00000]", "D"], "episode");
  assert.ok(!delta.some((d) => d.id === "abc00000-x" && d.action === "delete"));
  assert.equal(renderDoc(apply(blocks, delta), "episode"), "A\nC\n[이미지:abc00000]\nD");
});

test("an altered or duplicated image line is rejected", () => {
  const blocks = [blk("a", "A", 0), blk("abc00000-x", "", 1, "image")];
  assert.throws(() => diffBlocks(blocks, ["A", "[이미지:abc00000] 설명 추가"], "episode"), /이미지/);
  assert.throws(() => diffBlocks(blocks, ["[이미지:abc00000]", "A", "[이미지:abc00000]"], "episode"), /이미지/);
});

test("a removed image in a changed region does not stop id pairing", () => {
  const blocks = [blk("a", "A", 0), blk("abc00000-x", "", 1, "image"), blk("c", "C", 2), blk("d", "D", 3), blk("e", "E", 4)];
  const { delta } = diffBlocks(blocks, ["X", "Y", "C2", "D2", "E"], "episode");
  const updated = delta.filter((d) => d.action === "update").map((d) => d.id);
  assert.deepEqual(updated.sort(), ["a", "c", "d"]);
  assert.ok(delta.some((d) => d.id === "abc00000-x" && d.action === "delete"));
});

test("wiki list blocks show their nested text and are read-only", () => {
  const list: Block = {
    id: "dd000000-1",
    blockType: "bullet_list",
    attr: {},
    order: 0,
    content: [
      { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "첫째" }] }] },
      { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "둘째" }] }] },
    ],
  };
  const text = renderDoc([list, blk("p", "문단", 1, "paragraph")], "wiki");
  assert.equal(text, "[목록:dd000000] 첫째 / 둘째\n문단");
  assert.equal(diffBlocks([list, blk("p", "문단", 1, "paragraph")], text.split("\n"), "wiki").delta.length, 0);
  assert.throws(() => diffBlocks([list], ["[목록:dd000000] 첫째 / 셋째"], "wiki"));
});

test("plain paragraphs that look like markup are escaped and keep their type", () => {
  const blocks = [blk("a", "---", 0), blk("b", "> 아님", 1), blk("c", "// 주석 아님", 2), blk("d", "\\역슬래시", 3)];
  const text = renderDoc(blocks, "episode");
  assert.equal(text, "\\---\n\\> 아님\n\\// 주석 아님\n\\\\역슬래시");
  assert.equal(diffBlocks(blocks, text.split("\n"), "episode").delta.length, 0);
  const after = apply(blocks, diffBlocks(blocks, ["\\---", "\\> 아님!", "\\// 주석 아님", "\\\\역슬래시"], "episode").delta);
  assert.deepEqual(sortBlocks(after).map((b) => [b.blockType, b.content[0]?.text]), [
    ["describe", "---"],
    ["describe", "> 아님!"],
    ["describe", "// 주석 아님"],
    ["describe", "\\역슬래시"],
  ]);
});

test("pasted block-id prefixes are rejected", () => {
  assert.throws(() => diffBlocks(base, ["[3e2405ee] 하나"], "episode"), /블록 ID/);
});

test("whitespace-only spacer blocks count as blank and survive in keep mode", () => {
  const blocks = [blk("a", "가", 0), blk("s", "　", 1), blk("b", "나", 2)];
  assert.ok(isBlankBlock(blocks[1], "episode"));
  const text = renderDoc(blocks, "episode");
  assert.equal(diffBlocks(blocks, splitLines(text, true), "episode").delta.length, 0);
});

test("large rewrite round-trips", () => {
  const old = Array.from({ length: 300 }, (_, i) => blk(`o${i}`, `문단 ${i}`, i));
  const lines = Array.from({ length: 320 }, (_, i) => (i % 7 === 0 ? `수정 ${i}` : `문단 ${i}`));
  const after = apply(old, diffBlocks(old, lines, "episode").delta);
  assert.equal(renderDoc(after, "episode"), lines.join("\n"));
});

test("splitLines handles CRLF, trailing and blank lines", () => {
  assert.deepEqual(splitLines("a\r\n\r\nb\n\n", false), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\nb\n", true), ["a", "", "b"]);
  assert.deepEqual(splitLines("a\n\nb\n\n", true, 1), ["a", "", "b", ""]);
});

test("a document ending in blank blocks round-trips unchanged", () => {
  const blocks = [blk("a", "가", 0), blk("e1", "", 1), blk("b", "나", 2), blk("e2", "", 3)];
  const lines = splitLines(renderDoc(blocks, "episode"), true, trailingBlankCount(blocks, "episode"));
  assert.equal(diffBlocks(blocks, lines, "episode").delta.length, 0);
  assert.equal(diffBlocks(blocks, splitLines(renderDoc(blocks, "episode") + "\n", true, 1), "episode").delta.length, 0);
});

test("resolveBlockId accepts 8-char prefixes", () => {
  const blocks = [blk("3e2405ee-9c91", "x", 0), blk("62fb2cd6-db9a", "y", 1)];
  assert.equal(resolveBlockId(blocks, "[3e2405ee]"), "3e2405ee-9c91");
  assert.throws(() => resolveBlockId(blocks, "zzzz"));
});

test("moving text across an image keeps the image in place", () => {
  const blocks = [blk("abc00000-x", "", 0, "image"), blk("p", "P", 1), blk("q", "Q", 2)];
  const { delta } = diffBlocks(blocks, ["P", "[이미지:abc00000]", "Q"], "episode");
  assert.ok(!delta.some((d) => d.id === "abc00000-x" && d.action === "delete"));
  const after = apply(blocks, delta);
  assert.equal(renderDoc(after, "episode"), "P\n[이미지:abc00000]\nQ");
});

test("empty wiki tables/lists are not blank spacer blocks", () => {
  const table = blk("ab000000-t", "", 0, "table");
  assert.equal(isBlankBlock(table, "wiki"), false);
  assert.equal(trailingBlankCount([blk("p", "x", 0, "paragraph"), { ...table, order: 1 }], "wiki"), 0);
});
