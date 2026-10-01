// End-to-end check over real MCP stdio against a scratch novel.
// Usage: MUVEL_E2E_NOVEL=<novelId> npm run e2e   (creates and then permanently deletes test data)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MuvelClient } from "../src/client.js";

const NOVEL = process.env.MUVEL_E2E_NOVEL;
if (!NOVEL) throw new Error("MUVEL_E2E_NOVEL is required");

const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const api = new MuvelClient();

const call = async (name: string, args: Record<string, unknown>, expectError = false) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content.map((c) => c.text).join("\n");
  console.log(`\n▶ ${name} ${res.isError ? "(error)" : ""}\n${text.slice(0, 700)}`);
  if (!!res.isError !== expectError) throw new Error(`${name}: unexpected ${res.isError ? "error" : "success"}`);
  return text;
};
const grab = (text: string, key: string) => new RegExp(`${key}: ([0-9a-f-]{36})`).exec(text)![1];

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const created: { episodes: string[]; wiki: string[]; memos: string[]; clues: string[] } = { episodes: [], wiki: [], memos: [], clues: [] };
try {
  await call("muvel_list_novels", {});
  await call("muvel_get_novel", { novelId: NOVEL });

  const ep = grab(await call("muvel_create_episode", { novelId: NOVEL, title: "E2E 회차", status: "planned", text: "첫 문단.\n“대사.”\n---\n마지막 문단." }), "episodeId");
  created.episodes.push(ep);
  const read1 = await call("muvel_read_episode", { episodeId: ep, withBlockIds: true });
  const v1 = Number(/contentVersion: (\d+)/.exec(read1)![1]);
  const firstBlock = /\[([0-9a-f]{8})\] 첫 문단/.exec(read1)![1];

  await call("muvel_write_episode", { episodeId: ep, text: "x", mode: "replace" }, true); // missing expectedVersion
  await call("muvel_write_episode", { episodeId: ep, text: "x", mode: "replace", expectedVersion: v1 - 1 }, true); // stale
  await call("muvel_edit_episode", { episodeId: ep, edits: [{ find: "없는 문장", replace: "y" }] }, true);
  await call("muvel_edit_episode", { episodeId: ep, edits: [{ find: "“대사.”", replace: "“대사를 고쳤다.”\n새로 끼운 문단." }] });
  await call("muvel_write_episode", { episodeId: ep, text: "덧붙인 문단.", mode: "append" });
  const read2 = await call("muvel_read_episode", { episodeId: ep, withBlockIds: true });
  if (!read2.includes(`[${firstBlock}] 첫 문단.`)) throw new Error("block id of untouched paragraph changed");
  const body = read2.split("---본문---\n")[1].replace(/\[[0-9a-f]{8}\] /g, "");
  if (body !== "첫 문단.\n“대사를 고쳤다.”\n새로 끼운 문단.\n---\n마지막 문단.\n덧붙인 문단.") throw new Error("unexpected body:\n" + body);
  const v2 = Number(/contentVersion: (\d+)/.exec(read2)![1]);
  await call("muvel_write_episode", { episodeId: ep, text: body.replace("마지막 문단.", "마지막 문단을 바꿈."), mode: "replace", expectedVersion: v2 });
  await call("muvel_update_episode_info", { episodeId: ep, description: "E2E 설명", status: "revision" });
  await call("muvel_list_snapshots", { target: "episode", id: ep });

  const wiki = grab(
    await call("muvel_create_wiki_page", {
      novelId: NOVEL, title: "E2E 인물", category: "character", summary: "테스트 인물", alternativeTitles: ["이투이"],
      attributes: [["age", "20"]], content: "## 개요\n테스트용 인물이다.\n## 성격\n차분하다.",
    }),
    "wikiPageId",
  );
  created.wiki.push(wiki);
  await call("muvel_edit_wiki_page", { wikiPageId: wiki, edits: [{ find: "차분하다.", replace: "차분하지만 고집이 세다." }] });
  await call("muvel_update_wiki_page", { wikiPageId: wiki, importance: 4 });
  await call("muvel_read_wiki_page", { wikiPageId: wiki });
  await call("muvel_read_wiki", { novelId: NOVEL, category: "character" });

  const memo = grab(await call("muvel_create_memo", { novelId: NOVEL, text: "E2E 메모" }), "memoId");
  created.memos.push(memo);
  await call("muvel_update_memo", { memoId: memo, text: "E2E 메모 수정" });
  await call("muvel_list_memos", { novelId: NOVEL });

  const clue = grab(await call("muvel_create_clue", { novelId: NOVEL, title: "E2E 복선", description: "설명", episodeId: ep, blockId: firstBlock }), "clueId");
  created.clues.push(clue);
  await call("muvel_list_clues", { novelId: NOVEL, unresolvedOnly: true });
  const lastBlock = /\[([0-9a-f]{8})\] 덧붙인/.exec(await call("muvel_read_episode", { episodeId: ep, withBlockIds: true }))![1];
  await call("muvel_link_clue", { clueId: clue, kind: "payoff", episodeId: ep, blockId: lastBlock });
  await call("muvel_list_clues", { novelId: NOVEL });

  await call("muvel_set_relations", { novelId: NOVEL, relations: [{ episodeId: ep, wikiPageId: wiki, relevance: "high" }] });
  await call("muvel_list_relations", { novelId: NOVEL });
  await call("muvel_add_comment", { episodeId: ep, content: "E2E 코멘트", blockId: firstBlock });
  await call("muvel_list_comments", { episodeId: ep });
  await call("muvel_read_episodes", { novelId: NOVEL });
  await call("muvel_search", { novelId: NOVEL, query: "프롤로그" });

  const snaps = await call("muvel_list_snapshots", { target: "episode", id: ep });
  const snapId = /snapshotId: ([0-9a-f-]{36})/.exec(snaps)![1];
  await call("muvel_read_snapshot", { target: "episode", id: ep, snapshotId: snapId });
  await call("muvel_restore_snapshot", { target: "episode", id: ep, snapshotId: snapId });
  await call("muvel_read_episode", { episodeId: ep });
  console.log("\nE2E PASSED");
} finally {
  // Permanent cleanup of everything created above (the MCP server deliberately has no delete tools).
  for (const id of created.clues) await api.request("DELETE", `/episode-clues/${id}`).catch(console.error);
  for (const id of created.memos) await api.request("DELETE", `/memos/${id}`).catch(console.error);
  for (const id of created.wiki) {
    await api.request("DELETE", `/wiki-pages/${id}`).catch(console.error);
    await api.request("DELETE", `/wiki-pages/${id}/force`).catch(console.error);
  }
  for (const id of created.episodes) {
    await api.request("DELETE", `/episodes/${id}`).catch(console.error);
    await api.request("DELETE", `/episodes/${id}?force=true`).catch(console.error);
  }
  console.log("cleanup done");
  await client.close();
}
