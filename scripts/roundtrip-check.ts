// Read-only safety check: for every episode and wiki page of the user's novels, render the
// blocks to text and diff that text back. Any non-zero delta means writing unchanged text
// would modify the document, i.e. a format round-trip bug. Never writes anything.
// Usage: npm run roundtrip-check
import { diffBlocks, isBlankBlock, renderDoc, splitLines, trailingBlankCount, type DocKind } from "../src/blocks.js";
import { MuvelClient } from "../src/client.js";
import type { Block } from "../src/types.js";

const api = new MuvelClient();
let checked = 0;
const failures: string[] = [];

const check = (label: string, blocks: Block[], kind: DocKind) => {
  checked++;
  const lines = splitLines(renderDoc(blocks, kind), blocks.some((b) => isBlankBlock(b, kind)), trailingBlankCount(blocks, kind));
  const { delta } = diffBlocks(blocks, lines, kind);
  if (delta.length) failures.push(`${label}: ${delta.length} unexpected changes ${JSON.stringify(delta).slice(0, 200)}`);
};

for (const novel of await api.myNovels()) {
  const detail = await api.novel(novel.id);
  for (const e of detail.episodes) check(`${novel.title} / ${e.title}`, await api.episodeBlocks(e.id), "episode");
  for (const w of detail.wikiPages) check(`${novel.title} / wiki ${w.title}`, await api.wikiBlocks(w.id), "wiki");
}
console.log(`checked ${checked} documents, ${failures.length} failures`);
for (const f of failures) console.log(`- ${f}`);
process.exitCode = failures.length ? 1 : 0;
