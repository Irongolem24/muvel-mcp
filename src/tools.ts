import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffBlocks, isBlankBlock, plainLength, renderDoc, resolveBlockId, shortId, splitLines, trailingBlankCount, type DocKind } from "./blocks.js";
import type { MuvelClient } from "./client.js";
import type { Block, Episode, WikiPage } from "./types.js";

const EPISODE_TYPES: Record<number, string> = {
  0: "회차",
  1: "그룹(편/장 구분)",
  2: "프롤로그",
  3: "에필로그",
  4: "외전",
  5: "메모",
  6: "단편",
};
const EPISODE_STATUS = ["planned", "in_progress", "revision", "completed"] as const;
const WIKI_CATEGORIES = ["character", "location", "item", "organization", "event", "worldSetting", "story", "other"] as const;
const RELEVANCE = ["high", "medium", "low"] as const;

const AUTO_SNAPSHOT = process.env.MUVEL_AUTO_SNAPSHOT !== "0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

function guard<A>(fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return { content: [{ type: "text", text: `오류: ${(err as Error).message}` }], isError: true };
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

function episodeHeader(ep: Episode, blocks?: Block[]): string {
  const lines = [
    `# ${ep.title}`,
    `- episodeId: ${ep.id}`,
    `- 순서(order): ${ep.order} · 유형: ${EPISODE_TYPES[ep.episodeType] ?? ep.episodeType} · 상태: ${ep.status}`,
    `- 글자 수(공백 제외): ${blocks ? plainLength(blocks) : ep.contentLength} · contentVersion: ${ep.contentVersion}`,
  ];
  if (ep.description) lines.push(`- 설명: ${ep.description}`);
  if (ep.authorComment) lines.push(`- 작가의 말: ${ep.authorComment}`);
  if (ep.pointOfView) lines.push(`- 시점: ${ep.pointOfView}`);
  if (ep.tags?.length) lines.push(`- 태그: ${ep.tags.join(", ")}`);
  return lines.join("\n");
}

function wikiHeader(w: WikiPage): string {
  const lines = [`# ${w.title}`, `- wikiPageId: ${w.id}`, `- 분류: ${w.category} · 중요도: ${w.importance ?? "-"}`];
  if (w.contentVersion !== undefined) lines.push(`- contentVersion: ${w.contentVersion}`);
  if (w.alternativeTitles?.length) lines.push(`- 다른 이름: ${w.alternativeTitles.join(", ")}`);
  if (w.summary) lines.push(`- 요약: ${w.summary}`);
  if (w.attributes?.length) lines.push(`- 속성: ${w.attributes.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (w.tags?.length) lines.push(`- 태그: ${w.tags.join(", ")}`);
  return lines.join("\n");
}

const FORMAT_NOTE =
  "본문 형식: 한 줄 = 한 블록(문단). 회차: 일반 지문/대사는 그대로, '> '=인용 블록, '// '=코멘트 블록, '---'=구분선. " +
  "위키: '# '~'###### '=제목, '> '=인용, 그 외=문단. 블록 내부 줄바꿈은 '<br>'. " +
  "'[이미지:…]', '[표:…]', '[목록:…]' 줄은 수정·이동 불가(그대로 두거나 줄을 빼서 삭제). " +
  "일반 문단인데 위 표시처럼 시작하는 줄은 맨 앞에 '\\'가 붙어 있습니다(예: '\\---'); 일반 문단으로 쓰려면 '\\'를 유지하세요.";

export function registerTools(server: McpServer, api: MuvelClient, opts: { readOnly: boolean }) {
  // ---------------------------------------------------------------- read

  server.registerTool(
    "muvel_list_novels",
    {
      title: "소설 목록",
      description: "로그인한 사용자의 Muvel 클라우드 소설 목록(내 소설 + 공동 작업 소설)을 반환합니다.",
      annotations: READ,
    },
    guard(async () => {
      const [mine, collab] = await Promise.all([api.myNovels(), api.collaborativeNovels().catch(() => [])]);
      const fmt = (n: (typeof mine)[number]) => `- ${n.title} (회차 ${n.episodeCount}) · novelId: ${n.id} · 수정: ${n.updatedAt}`;
      const out = ["## 내 소설", ...mine.map(fmt)];
      if (collab.length) out.push("", "## 공동 작업 소설", ...collab.map(fmt));
      return out.join("\n");
    }),
  );

  server.registerTool(
    "muvel_get_novel",
    {
      title: "소설 개요",
      description:
        "소설의 메타데이터, 전체 회차 목록(순서·상태·글자 수·contentVersion), 위키 문서 목록(분류·요약), 메모/복선 개수를 반환합니다. 작업 시작 시 가장 먼저 호출하세요.",
      inputSchema: { novelId: z.string() },
      annotations: READ,
    },
    guard(async ({ novelId }) => {
      const [novel, memos, clues] = await Promise.all([
        api.novel(novelId),
        api.memos(novelId).catch(() => []),
        api.clues(novelId).catch(() => []),
      ]);
      const out = [`# ${novel.title}`, `- novelId: ${novel.id}`];
      if (novel.description) out.push(`- 소개: ${novel.description}`);
      if (novel.tags?.length) out.push(`- 태그: ${novel.tags.join(", ")}`);
      out.push(`- 메모 ${memos.length}개 · 복선 ${clues.length}개`, "", `## 회차 (${novel.episodes.length})`);
      for (const ep of [...novel.episodes].sort((a, b) => a.order - b.order)) {
        const type = ep.episodeType === 0 ? "" : ` [${EPISODE_TYPES[ep.episodeType] ?? ep.episodeType}]`;
        out.push(`- #${ep.order}${type} ${ep.title} · ${ep.status} · ${ep.contentLength}자 · v${ep.contentVersion} · episodeId: ${ep.id}`);
      }
      out.push("", `## 위키 (${novel.wikiPages.length})`);
      const byCat = new Map<string, WikiPage[]>();
      for (const w of novel.wikiPages) byCat.set(w.category, [...(byCat.get(w.category) ?? []), w]);
      for (const [cat, pages] of byCat) {
        out.push(`### ${cat}`);
        for (const w of pages) {
          const alt = w.alternativeTitles?.length ? ` (${w.alternativeTitles.join(", ")})` : "";
          out.push(`- ${w.title}${alt}${w.summary ? ` — ${w.summary}` : ""} · wikiPageId: ${w.id}`);
        }
      }
      return out.join("\n");
    }),
  );

  server.registerTool(
    "muvel_read_episode",
    {
      title: "회차 읽기",
      description:
        `회차 메타데이터와 본문을 반환합니다. withBlockIds=true면 각 줄 앞에 [블록ID 앞 8자리]를 붙입니다(복선·코멘트를 특정 문단에 연결할 때 필요). ${FORMAT_NOTE}`,
      inputSchema: { episodeId: z.string(), withBlockIds: z.boolean().default(false) },
      annotations: READ,
    },
    guard(async ({ episodeId, withBlockIds }) => {
      const [ep, blocks] = await Promise.all([api.episode(episodeId), api.episodeBlocks(episodeId)]);
      return `${episodeHeader(ep, blocks)}\n\n---본문---\n${renderDoc(blocks, "episode", withBlockIds)}`;
    }),
  );

  server.registerTool(
    "muvel_read_episodes",
    {
      title: "여러 회차 읽기",
      description:
        "여러 회차 본문을 순서대로 한 번에 읽습니다(흐름·개연성·설정 충돌 검사용). fromOrder/toOrder로 범위를 정하거나 episodeIds로 직접 지정합니다. maxChars를 넘으면 그 회차부터 생략하고 알려줍니다.",
      inputSchema: {
        novelId: z.string(),
        fromOrder: z.number().optional(),
        toOrder: z.number().optional(),
        episodeIds: z.array(z.string()).optional(),
        maxChars: z.number().int().positive().default(150_000),
      },
      annotations: READ,
    },
    guard(async ({ novelId, fromOrder, toOrder, episodeIds, maxChars }) => {
      const novel = await api.novel(novelId);
      let eps = [...novel.episodes].sort((a, b) => a.order - b.order).filter((e) => e.episodeType !== 1);
      if (episodeIds?.length) eps = eps.filter((e) => episodeIds.includes(e.id));
      if (fromOrder !== undefined) eps = eps.filter((e) => e.order >= fromOrder);
      if (toOrder !== undefined) eps = eps.filter((e) => e.order <= toOrder);
      const blocks = await Promise.all(eps.map((e) => api.episodeBlocks(e.id)));
      const parts: string[] = [];
      let used = 0;
      for (let i = 0; i < eps.length; i++) {
        const body = renderDoc(blocks[i], "episode");
        if (used + body.length > maxChars && parts.length) {
          const rest = eps.slice(i).map((e) => `#${e.order} ${e.title}`).join(", ");
          parts.push(`\n[maxChars(${maxChars}) 초과로 생략: ${rest}]`);
          break;
        }
        used += body.length;
        parts.push(`${episodeHeader(eps[i], blocks[i])}\n\n${body}`);
      }
      return parts.length ? parts.join("\n\n=====\n\n") : "해당 범위에 회차가 없습니다.";
    }),
  );

  server.registerTool(
    "muvel_read_wiki_page",
    {
      title: "위키 문서 읽기",
      description: `위키 문서의 메타데이터(분류·별칭·속성·요약)와 본문을 반환합니다. ${FORMAT_NOTE}`,
      inputSchema: { wikiPageId: z.string() },
      annotations: READ,
    },
    guard(async ({ wikiPageId }) => {
      const [w, blocks] = await Promise.all([api.wikiPage(wikiPageId), api.wikiBlocks(wikiPageId)]);
      return `${wikiHeader(w)}\n\n---본문---\n${renderDoc(blocks, "wiki") || "(본문 없음)"}`;
    }),
  );

  server.registerTool(
    "muvel_read_wiki",
    {
      title: "위키 전체 읽기",
      description: "소설의 위키 문서들을 본문까지 한 번에 읽습니다(설정 충돌 검사·설정 요약용). category로 분류를 거를 수 있습니다.",
      inputSchema: {
        novelId: z.string(),
        category: z.enum(WIKI_CATEGORIES).optional(),
        maxChars: z.number().int().positive().default(150_000),
      },
      annotations: READ,
    },
    guard(async ({ novelId, category, maxChars }) => {
      let pages = (await api.wikiPages(novelId)).filter((w) => w.namespace === "document");
      if (category) pages = pages.filter((w) => w.category === category);
      const details = await Promise.all(pages.map((w) => Promise.all([api.wikiPage(w.id), api.wikiBlocks(w.id)])));
      const parts: string[] = [];
      let used = 0;
      for (let i = 0; i < details.length; i++) {
        const [w, blocks] = details[i];
        const text = `${wikiHeader(w)}\n\n${renderDoc(blocks, "wiki") || "(본문 없음)"}`;
        if (used + text.length > maxChars && parts.length) {
          parts.push(`\n[maxChars 초과로 생략: ${details.slice(i).map(([p]) => p.title).join(", ")}]`);
          break;
        }
        used += text.length;
        parts.push(text);
      }
      return parts.length ? parts.join("\n\n=====\n\n") : "위키 문서가 없습니다.";
    }),
  );

  server.registerTool(
    "muvel_search",
    {
      title: "소설 내 검색",
      description: "소설의 회차·위키 제목과 본문을 검색합니다. 최근 수정 내용은 검색 인덱스 반영이 늦을 수 있습니다.",
      inputSchema: { novelId: z.string(), query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) },
      annotations: READ,
    },
    guard(async ({ novelId, query, limit }) => {
      const res = await api.search(novelId, query, limit);
      if (!res.hits.length) return `'${query}' 검색 결과가 없습니다.`;
      const lines = res.hits.map((h) => {
        switch (h.searchCategory) {
          case "Episode":
            return `- [회차] #${h.order} ${h.title} · episodeId: ${h.id}`;
          case "EpisodeBlock":
            return `- [회차 본문] ${h.episodeTitle ?? ""} · episodeId: ${h.episodeId} · 블록 ${shortId(h.id)}: ${h.content}`;
          case "WikiPage":
            return `- [위키] ${h.title} (${h.searchSubCategory})${h.summary ? ` — ${h.summary}` : ""} · wikiPageId: ${h.id}`;
          case "WikiBlock":
            return `- [위키 본문] ${h.wikiPageName} · wikiPageId: ${h.wikiPageId}: ${h.content}`;
          default:
            return `- ${JSON.stringify(h)}`;
        }
      });
      return `검색 '${query}' — 총 ${res.estimatedTotalHits}건 중 ${res.hits.length}건\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "muvel_list_memos",
    { title: "메모 목록", description: "소설에 달린 메모(아이디어·자유 메모) 전체를 반환합니다.", inputSchema: { novelId: z.string() }, annotations: READ },
    guard(async ({ novelId }) => {
      const memos = await api.memos(novelId);
      if (!memos.length) return "메모가 없습니다.";
      return memos.map((m) => `## memoId: ${m.id}\n${m.text}`).join("\n\n");
    }),
  );

  server.registerTool(
    "muvel_list_clues",
    {
      title: "복선 목록",
      description: "소설의 복선 목록과 각 복선의 설치(setup)·회수(payoff) 위치를 반환합니다. 회수 위치가 없으면 '미회수'입니다.",
      inputSchema: { novelId: z.string(), unresolvedOnly: z.boolean().default(false) },
      annotations: READ,
    },
    guard(async ({ novelId, unresolvedOnly }) => {
      let clues = await api.clues(novelId);
      if (unresolvedOnly) clues = clues.filter((c) => !c.references.some((r) => r.kind === "payoff"));
      if (!clues.length) return "복선이 없습니다.";
      return clues
        .map((c) => {
          const paid = c.references.some((r) => r.kind === "payoff");
          const refs = c.references.map(
            (r) => `  - ${r.kind === "setup" ? "설치" : "회수"}: #${r.target?.episodeOrder ?? "?"} ${r.target?.episodeTitle ?? ""} (episodeId: ${r.episodeId}, 블록 ${shortId(r.blockId)})`,
          );
          return [`## ${c.title} ${paid ? "[회수됨]" : "[미회수]"} · clueId: ${c.id}`, c.description, ...refs].filter(Boolean).join("\n");
        })
        .join("\n\n");
    }),
  );

  server.registerTool(
    "muvel_list_relations",
    {
      title: "회차-위키 등장 관계",
      description: "어떤 회차에 어떤 위키 문서(인물·장소 등)가 등장하는지, 관련도(high/medium/low)와 함께 반환합니다.",
      inputSchema: { novelId: z.string() },
      annotations: READ,
    },
    guard(async ({ novelId }) => {
      const [rels, novel] = await Promise.all([api.relations(novelId), api.novel(novelId)]);
      if (!rels.length) return "등록된 등장 관계가 없습니다.";
      const ep = new Map(novel.episodes.map((e) => [e.id, e]));
      const wk = new Map(novel.wikiPages.map((w) => [w.id, w.title]));
      const byEp = new Map<string, string[]>();
      for (const r of rels) byEp.set(r.episodeId, [...(byEp.get(r.episodeId) ?? []), `${wk.get(r.wikiPageId) ?? r.wikiPageId}(${r.relevance})`]);
      return [...byEp]
        .sort(([a], [b]) => (ep.get(a)?.order ?? 0) - (ep.get(b)?.order ?? 0))
        .map(([id, names]) => `- #${ep.get(id)?.order ?? "?"} ${ep.get(id)?.title ?? id}: ${names.join(", ")}`)
        .join("\n");
    }),
  );

  server.registerTool(
    "muvel_list_comments",
    { title: "회차 코멘트", description: "회차에 달린 코멘트(피드백) 목록을 반환합니다.", inputSchema: { episodeId: z.string() }, annotations: READ },
    guard(async ({ episodeId }) => {
      const comments = await api.comments(episodeId);
      if (!comments.length) return "코멘트가 없습니다.";
      return comments.map((c) => `- [${c.createdAt}] ${c.author?.username ?? "?"}: ${c.content}`).join("\n");
    }),
  );

  server.registerTool(
    "muvel_list_snapshots",
    {
      title: "스냅샷(버전 기록) 목록",
      description: "회차 또는 위키 문서의 스냅샷 목록을 반환합니다.",
      inputSchema: { target: z.enum(["episode", "wiki"]), id: z.string() },
      annotations: READ,
    },
    guard(async ({ target, id }) => {
      const list = await api.snapshots(target === "episode" ? "episodes" : "wiki-pages", id);
      if (!list.length) return "스냅샷이 없습니다.";
      return list.map((s) => `- ${s.createdAt} · ${s.reason}${s.name ? ` "${s.name}"` : ""} · v${s.contentVersion} · ${s.contentLength}자 · snapshotId: ${s.id}`).join("\n");
    }),
  );

  server.registerTool(
    "muvel_read_snapshot",
    {
      title: "스냅샷 읽기",
      description: "특정 스냅샷 시점의 본문을 반환합니다(이전 버전과 비교할 때 사용).",
      inputSchema: { target: z.enum(["episode", "wiki"]), id: z.string(), snapshotId: z.string() },
      annotations: READ,
    },
    guard(async ({ target, id, snapshotId }) => {
      const s = await api.snapshot(target === "episode" ? "episodes" : "wiki-pages", id, snapshotId);
      return `스냅샷 ${s.createdAt} (${s.reason}${s.name ? `, "${s.name}"` : ""}, v${s.contentVersion})\n\n${renderDoc(s.blocks ?? [], target)}`;
    }),
  );

  if (opts.readOnly) return;

  // ---------------------------------------------------------------- write

  const snapshotBefore = async (kind: "episodes" | "wiki-pages", id: string, blocks: Block[], what: string) => {
    if (!AUTO_SNAPSHOT || !blocks.length) return "";
    const snap = await api.saveSnapshot(kind, id, `AI(MCP) ${what} 이전`);
    return ` 수정 전 스냅샷 저장됨(snapshotId: ${snap.id}).`;
  };

  const keepBlank = (kind: DocKind, blocks: Block[], explicit: boolean | undefined) => explicit ?? blocks.some((b) => isBlankBlock(b, kind));

  interface Loaded {
    blocks: Block[];
    version: number;
  }

  async function loadDocument(kind: DocKind, id: string): Promise<Loaded> {
    const [meta, blocks] =
      kind === "episode" ? await Promise.all([api.episode(id), api.episodeBlocks(id)]) : await Promise.all([api.wikiPage(id), api.wikiBlocks(id)]);
    if (typeof meta.contentVersion !== "number") throw new Error("서버 응답에 contentVersion이 없어 안전하게 수정할 수 없습니다.");
    return { blocks, version: meta.contentVersion };
  }

  const versionMismatch = (expected: number, actual: number) =>
    new Error(`contentVersion이 다릅니다(예상 ${expected}, 현재 ${actual}). 그 사이 앱 등에서 수정되었습니다. 다시 읽은 뒤 작업하세요. 아무것도 저장하지 않았습니다.`);

  /**
   * Diff `newText` against the exact blocks it was derived from (`loaded`) and save it.
   * The server applies stale writes instead of rejecting them, so the version is checked
   * again right before syncing to keep the race window to a single round-trip.
   */
  async function saveDocument(kind: DocKind, id: string, loaded: Loaded, newText: string, opts: { expectedVersion?: number; keepBlankLines?: boolean; what: string }) {
    const isEp = kind === "episode";
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== loaded.version) throw versionMismatch(opts.expectedVersion, loaded.version);
    const lines = splitLines(newText, keepBlank(kind, loaded.blocks, opts.keepBlankLines), trailingBlankCount(loaded.blocks, kind));
    const { delta, summary } = diffBlocks(loaded.blocks, lines, kind);
    if (!delta.length) return "변경 사항이 없습니다.";
    // Snapshot first (it doesn't bump contentVersion) so the re-check sits right before the sync.
    const snapMsg = await snapshotBefore(isEp ? "episodes" : "wiki-pages", id, loaded.blocks, opts.what);
    const latest = isEp ? (await api.episodeVersion(id)).contentVersion : (await api.wikiPage(id)).contentVersion;
    if (latest !== loaded.version) throw versionMismatch(loaded.version, latest ?? -1);
    let res: { newContentVersion: number; shouldRefetch?: boolean };
    try {
      res = isEp ? await api.syncEpisodeBlocks(id, delta, loaded.version) : await api.syncWikiBlocks(id, delta, loaded.version);
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
        throw new Error("저장 요청이 시간 초과되었습니다. 서버에는 저장되었을 수 있으니 다시 읽어 확인한 뒤 작업하세요.");
      }
      throw err;
    }
    let msg = `저장 완료: 유지 ${summary.kept} · 수정 ${summary.updated} · 추가 ${summary.created} · 삭제 ${summary.deleted} 블록. 새 contentVersion: ${res.newContentVersion}.${snapMsg}`;
    if (res.shouldRefetch) msg += " 경고: 서버가 저장 중 다른 변경과 병합했다고 알려왔습니다. 결과를 다시 읽어 확인하세요.";
    return msg;
  }

  async function applyEdits(kind: DocKind, id: string, edits: { find: string; replace: string; replaceAll?: boolean }[], expectedVersion?: number) {
    const loaded = await loadDocument(kind, id);
    let text = renderDoc(loaded.blocks, kind);
    for (const [i, e] of edits.entries()) {
      const count = text.split(e.find).length - 1;
      if (count === 0) throw new Error(`edits[${i}]: '${e.find.slice(0, 60)}'을(를) 본문에서 찾을 수 없습니다. 아무것도 저장하지 않았습니다.`);
      if (count > 1 && !e.replaceAll)
        throw new Error(`edits[${i}]: '${e.find.slice(0, 60)}'이(가) ${count}번 나옵니다. 더 긴 문맥을 포함하거나 replaceAll=true를 쓰세요. 아무것도 저장하지 않았습니다.`);
      text = e.replaceAll ? text.split(e.find).join(e.replace) : text.replace(e.find, () => e.replace);
    }
    // Edits keep whatever blank-line structure the rendered text already has.
    return saveDocument(kind, id, loaded, text, { expectedVersion, keepBlankLines: true, what: "부분 수정" });
  }

  /** Fill a freshly created document; on failure, report the new ID so the agent doesn't create a duplicate. */
  async function fillNew(kind: DocKind, id: string, version: number, text: string, label: string) {
    try {
      const { delta, summary } = diffBlocks([], splitLines(text, false), kind);
      const res = kind === "episode" ? await api.syncEpisodeBlocks(id, delta, version) : await api.syncWikiBlocks(id, delta, version);
      return ` · 본문 ${summary.created}블록 저장 · contentVersion: ${res.newContentVersion}`;
    } catch (err) {
      throw new Error(`${label}은(는) 만들어졌지만(ID: ${id}) 본문 저장에 실패했습니다: ${(err as Error).message} 새로 만들지 말고 이 ID에 본문을 쓰세요.`);
    }
  }

  server.registerTool(
    "muvel_create_episode",
    {
      title: "회차 만들기",
      description: `새 회차를 만들고(목록 맨 뒤에 추가) 본문을 채웁니다. AI 초안은 status='planned'로 두는 것을 권장합니다. ${FORMAT_NOTE}`,
      inputSchema: {
        novelId: z.string(),
        title: z.string().min(1),
        text: z.string().optional(),
        status: z.enum(EPISODE_STATUS).optional(),
        episodeType: z.number().int().min(0).max(6).optional().describe("0=회차 1=그룹 2=프롤로그 3=에필로그 4=외전 5=메모 6=단편"),
        description: z.string().optional(),
      },
      annotations: WRITE,
    },
    guard(async ({ novelId, title, text, status, episodeType, description }) => {
      const ep = await api.createEpisode(novelId, { title, status, episodeType });
      if (description) await api.updateEpisode(ep.id, { description }).catch((err: Error) => {
        throw new Error(`회차는 만들어졌지만(episodeId: ${ep.id}) 설명 저장에 실패했습니다: ${err.message}`);
      });
      let msg = `회차 생성: '${ep.title}' (#${ep.order}) · episodeId: ${ep.id}`;
      if (text?.trim()) msg += await fillNew("episode", ep.id, ep.contentVersion, text, `회차 '${ep.title}'`);
      return msg;
    }),
  );

  server.registerTool(
    "muvel_update_episode_info",
    {
      title: "회차 정보 수정",
      description: "회차의 제목·설명·상태·작가의 말·태그를 수정합니다(본문은 수정하지 않음).",
      inputSchema: {
        episodeId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(EPISODE_STATUS).optional(),
        authorComment: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    guard(async ({ episodeId, ...dto }) => {
      const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      if (!Object.keys(patch).length) return "수정할 항목이 없습니다.";
      const ep = await api.updateEpisode(episodeId, patch);
      return `회차 정보 수정 완료: ${episodeHeader(ep)}`;
    }),
  );

  server.registerTool(
    "muvel_write_episode",
    {
      title: "회차 본문 덮어쓰기",
      description:
        `회차 본문 전체를 text로 교체합니다(mode='append'면 끝에 덧붙임). 바뀐 줄만 서버에 반영하고 바뀌지 않은 문단의 블록 ID는 유지합니다. ` +
        `수정 전에 스냅샷을 자동 저장합니다. 다른 사람(앱)과 동시에 수정하는 것을 막기 위해 muvel_read_episode에서 받은 contentVersion을 expectedVersion으로 넘기세요. ` +
        `일부만 고칠 때는 muvel_edit_episode가 더 안전합니다. ${FORMAT_NOTE}`,
      inputSchema: {
        episodeId: z.string(),
        text: z.string(),
        mode: z.enum(["replace", "append"]).default("replace"),
        expectedVersion: z.number().int().optional(),
        keepBlankLines: z.boolean().optional().describe("빈 줄을 빈 블록으로 저장할지. 생략하면 기존 회차에 빈 블록이 있을 때만 유지"),
      },
      annotations: OVERWRITE,
    },
    guard(async ({ episodeId, text, mode, expectedVersion, keepBlankLines }) => {
      if (mode === "replace" && expectedVersion === undefined) {
        throw new Error("mode='replace'에는 expectedVersion이 필요합니다. muvel_read_episode로 읽은 contentVersion을 넘기세요.");
      }
      const loaded = await loadDocument("episode", episodeId);
      let full = text;
      if (mode === "append") {
        const current = renderDoc(loaded.blocks, "episode");
        full = current ? `${current}\n${text}` : text;
      }
      return saveDocument("episode", episodeId, loaded, full, {
        expectedVersion,
        // Appending must not reshape the existing part; new text follows the episode's blank-line style.
        keepBlankLines: mode === "append" ? keepBlank("episode", loaded.blocks, keepBlankLines) : keepBlankLines,
        what: mode === "append" ? "이어쓰기" : "본문 교체",
      });
    }),
  );

  const editSchema = z.array(
    z.object({
      find: z.string().min(1).describe("본문에서 찾을 정확한 문자열(여러 줄 가능). 본문에서 딱 한 번만 나와야 함"),
      replace: z.string().describe("바꿀 문자열. 줄바꿈을 넣으면 문단이 나뉨"),
      replaceAll: z.boolean().optional(),
    }),
  ).min(1);

  server.registerTool(
    "muvel_edit_episode",
    {
      title: "회차 부분 수정",
      description:
        `회차 본문에서 find 문자열을 replace로 바꿉니다(여러 개를 한 번에 적용, 하나라도 실패하면 아무것도 저장하지 않음). 퇴고·오탈자 수정·문단 삽입에 사용하세요. 수정 전 스냅샷을 자동 저장합니다. ${FORMAT_NOTE}`,
      inputSchema: { episodeId: z.string(), edits: editSchema, expectedVersion: z.number().int().optional() },
      annotations: OVERWRITE,
    },
    guard(async ({ episodeId, edits, expectedVersion }) => applyEdits("episode", episodeId, edits, expectedVersion)),
  );

  const wikiMeta = {
    summary: z.string().optional(),
    category: z.enum(WIKI_CATEGORIES).optional(),
    alternativeTitles: z.array(z.string()).optional().describe("별칭·다른 이름(검색·자동 링크에 사용)"),
    attributes: z.array(z.tuple([z.string(), z.string()])).optional().describe("속성 [키, 값] 목록. 예: [['age','17'],['gender','남성']]. 전체 교체됨"),
    importance: z.number().int().min(1).max(5).optional(),
    tags: z.array(z.string()).optional(),
  };

  server.registerTool(
    "muvel_create_wiki_page",
    {
      title: "위키 문서 만들기",
      description: `위키 문서(인물·장소·조직·설정 등)를 만듭니다. content는 본문입니다. ${FORMAT_NOTE}`,
      inputSchema: { novelId: z.string(), title: z.string().min(1), content: z.string().optional(), ...wikiMeta },
      annotations: WRITE,
    },
    guard(async ({ novelId, title, content, ...meta }) => {
      const patch = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
      let w = await api.createWikiPage(novelId, { title, ...(meta.category ? { category: meta.category } : {}) });
      if (Object.keys(patch).length) {
        const createdId = w.id;
        w = await api.updateWikiPage(createdId, patch).catch((err: Error) => {
          throw new Error(`위키 문서는 만들어졌지만(wikiPageId: ${createdId}) 속성 저장에 실패했습니다: ${err.message}`);
        });
      }
      let msg = `위키 문서 생성: '${w.title}' (${w.category}) · wikiPageId: ${w.id}`;
      if (content?.trim()) {
        if (typeof w.contentVersion !== "number") {
          throw new Error(`위키 문서는 만들어졌지만(wikiPageId: ${w.id}) contentVersion을 알 수 없어 본문을 쓰지 않았습니다.`);
        }
        msg += await fillNew("wiki", w.id, w.contentVersion, content, `위키 문서 '${w.title}'`);
      }
      return msg;
    }),
  );

  server.registerTool(
    "muvel_update_wiki_page",
    {
      title: "위키 문서 수정",
      description:
        `위키 문서의 메타데이터(제목·요약·분류·별칭·속성 등)를 수정하고, content를 주면 본문 전체를 교체합니다(바뀐 줄만 반영, 스냅샷 자동 저장). 부분 수정은 muvel_edit_wiki_page를 쓰세요. ${FORMAT_NOTE}`,
      inputSchema: { wikiPageId: z.string(), title: z.string().optional(), content: z.string().optional(), expectedVersion: z.number().int().optional(), ...wikiMeta },
      annotations: OVERWRITE,
    },
    guard(async ({ wikiPageId, content, expectedVersion, ...meta }) => {
      const out: string[] = [];
      // Body first: a metadata PATCH bumps contentVersion and would invalidate expectedVersion.
      if (content !== undefined) {
        out.push(await saveDocument("wiki", wikiPageId, await loadDocument("wiki", wikiPageId), content, { expectedVersion, what: "본문 교체" }));
      }
      const patch = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length) {
        try {
          const w = await api.updateWikiPage(wikiPageId, patch);
          out.push(`메타데이터 수정 완료:\n${wikiHeader(w)}`);
        } catch (err) {
          throw new Error([...out, `메타데이터 수정 실패: ${(err as Error).message}`].join("\n"));
        }
      }
      return out.join("\n") || "수정할 항목이 없습니다.";
    }),
  );

  server.registerTool(
    "muvel_edit_wiki_page",
    {
      title: "위키 문서 부분 수정",
      description: `위키 본문에서 find 문자열을 replace로 바꿉니다(하나라도 실패하면 저장 안 함). 스냅샷 자동 저장. ${FORMAT_NOTE}`,
      inputSchema: { wikiPageId: z.string(), edits: editSchema, expectedVersion: z.number().int().optional() },
      annotations: OVERWRITE,
    },
    guard(async ({ wikiPageId, edits, expectedVersion }) => applyEdits("wiki", wikiPageId, edits, expectedVersion)),
  );

  server.registerTool(
    "muvel_create_memo",
    { title: "메모 만들기", description: "소설에 메모를 추가합니다.", inputSchema: { novelId: z.string(), text: z.string().min(1) }, annotations: WRITE },
    guard(async ({ novelId, text }) => `메모 생성 · memoId: ${(await api.createMemo(novelId, text)).id}`),
  );

  server.registerTool(
    "muvel_update_memo",
    { title: "메모 수정", description: "메모 내용을 교체합니다.", inputSchema: { memoId: z.string(), text: z.string().min(1) }, annotations: OVERWRITE },
    guard(async ({ memoId, text }) => {
      await api.updateMemo(memoId, text);
      return "메모 수정 완료";
    }),
  );

  server.registerTool(
    "muvel_create_clue",
    {
      title: "복선 등록",
      description:
        "복선을 등록하고 설치(setup) 위치를 연결합니다. blockId는 muvel_read_episode(withBlockIds=true)에서 본 [블록ID](앞 8자리 가능)입니다.",
      inputSchema: { novelId: z.string(), title: z.string().min(1), description: z.string().default(""), episodeId: z.string(), blockId: z.string() },
      annotations: WRITE,
    },
    guard(async ({ novelId, title, description, episodeId, blockId }) => {
      const fullBlockId = resolveBlockId(await api.episodeBlocks(episodeId), blockId);
      const clue = await api.createClue(novelId, { id: randomUUID(), title, description, reference: { kind: "setup", episodeId, blockId: fullBlockId } });
      return `복선 등록: '${clue.title}' · clueId: ${clue.id}`;
    }),
  );

  server.registerTool(
    "muvel_update_clue",
    {
      title: "복선 수정",
      description: "복선의 제목·설명을 수정합니다.",
      inputSchema: { clueId: z.string(), title: z.string().optional(), description: z.string().optional() },
      annotations: WRITE,
    },
    guard(async ({ clueId, title, description }) => {
      const c = await api.updateClue(clueId, { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) });
      return `복선 수정 완료: '${c.title}'`;
    }),
  );

  server.registerTool(
    "muvel_link_clue",
    {
      title: "복선 위치 연결/해제",
      description: "복선에 설치(setup) 또는 회수(payoff) 위치(회차의 특정 블록)를 연결하거나, remove=true로 연결을 해제합니다.",
      inputSchema: { clueId: z.string(), kind: z.enum(["setup", "payoff"]), episodeId: z.string(), blockId: z.string(), remove: z.boolean().default(false) },
      annotations: WRITE,
    },
    guard(async ({ clueId, kind, episodeId, blockId, remove }) => {
      const fullBlockId = resolveBlockId(await api.episodeBlocks(episodeId), blockId);
      if (remove) await api.removeClueReference(clueId, kind, episodeId, fullBlockId);
      else await api.addClueReference(clueId, kind, episodeId, fullBlockId);
      return `복선 ${kind === "setup" ? "설치" : "회수"} 위치 ${remove ? "해제" : "연결"} 완료`;
    }),
  );

  server.registerTool(
    "muvel_set_relations",
    {
      title: "회차-위키 등장 관계 설정",
      description: "회차에 등장하는 위키 문서(인물·장소 등)를 등록/갱신합니다. remove=true면 해당 관계들을 삭제합니다.",
      inputSchema: {
        novelId: z.string(),
        relations: z.array(z.object({ episodeId: z.string(), wikiPageId: z.string(), relevance: z.enum(RELEVANCE).default("medium") })).min(1),
        remove: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    guard(async ({ novelId, relations, remove }) => {
      if (remove) {
        for (const [i, r] of relations.entries()) {
          await api.removeRelation(novelId, r.episodeId, r.wikiPageId).catch((err: Error) => {
            throw new Error(`${i}건 삭제 후 relations[${i}]에서 실패: ${err.message}`);
          });
        }
        return `등장 관계 ${relations.length}건 삭제`;
      }
      await api.upsertRelations(novelId, relations);
      return `등장 관계 ${relations.length}건 등록/갱신`;
    }),
  );

  server.registerTool(
    "muvel_add_comment",
    {
      title: "회차 코멘트 달기",
      description: "회차에 코멘트(평가·피드백)를 남깁니다. 500자 이하. blockId를 주면 해당 문단에 연결됩니다.",
      inputSchema: { episodeId: z.string(), content: z.string().min(1).max(500), blockId: z.string().optional() },
      annotations: WRITE,
    },
    guard(async ({ episodeId, content, blockId }) => {
      const fullBlockId = blockId ? resolveBlockId(await api.episodeBlocks(episodeId), blockId) : undefined;
      await api.createComment(episodeId, content, fullBlockId);
      return "코멘트 등록 완료";
    }),
  );

  server.registerTool(
    "muvel_create_snapshot",
    {
      title: "스냅샷 저장",
      description: "회차 또는 위키 문서의 현재 상태를 이름 붙인 스냅샷으로 저장합니다.",
      inputSchema: { target: z.enum(["episode", "wiki"]), id: z.string(), name: z.string().optional() },
      annotations: WRITE,
    },
    guard(async ({ target, id, name }) => {
      const s = await api.saveSnapshot(target === "episode" ? "episodes" : "wiki-pages", id, name);
      return `스냅샷 저장 · snapshotId: ${s.id} (v${s.contentVersion})`;
    }),
  );

  server.registerTool(
    "muvel_restore_snapshot",
    {
      title: "스냅샷 복원",
      description: "회차 또는 위키 문서를 스냅샷 시점으로 되돌립니다. 되돌리기 전에 현재 상태를 스냅샷으로 저장합니다.",
      inputSchema: { target: z.enum(["episode", "wiki"]), id: z.string(), snapshotId: z.string() },
      annotations: OVERWRITE,
    },
    guard(async ({ target, id, snapshotId }) => {
      const kind = target === "episode" ? "episodes" : "wiki-pages";
      const backup = await api.saveSnapshot(kind, id, "AI(MCP) 스냅샷 복원 이전");
      await api.restoreSnapshot(kind, id, snapshotId);
      return `복원 완료. 복원 전 상태는 snapshotId: ${backup.id}에 저장되어 있습니다.`;
    }),
  );
}

