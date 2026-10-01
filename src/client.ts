import { API_BASE, TokenProvider } from "./auth.js";
import type {
  Block,
  Clue,
  Comment,
  DeltaBlock,
  Episode,
  Memo,
  Novel,
  NovelDetail,
  Relation,
  SearchResult,
  Snapshot,
  WikiPage,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 60_000;
/** Encode an ID for use as a URL path segment so it can never escape its slot. */
const seg = (id: string) => encodeURIComponent(id);

const CLIENT_VERSION = "2.11.5";
const MAX_CONCURRENT = 4;

export class MuvelApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    const detail =
      body && typeof body === "object" && "message" in body
        ? JSON.stringify((body as { message: unknown }).message)
        : typeof body === "string"
          ? body.slice(0, 300)
          : "";
    super(`Muvel API ${method} ${path} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export class MuvelClient {
  private readonly tokens = new TokenProvider();
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  private async acquire() {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    await this.acquire();
    let res: Response;
    try {
      const token = await this.tokens.get();
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "x-client-version": CLIENT_VERSION,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } finally {
      this.release();
    }
    if (res.status === 401 && !retried) {
      await this.tokens.refresh();
      return this.request<T>(method, path, body, true);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON body; keep as text
    }
    if (!res.ok) throw new MuvelApiError(res.status, method, path, data);
    return data as T;
  }

  // ---- users / novels ----
  me() {
    return this.request<{ id: string; username: string; point: number }>("GET", "/users/me");
  }
  myNovels() {
    return this.request<Novel[]>("GET", "/users/me/novels");
  }
  collaborativeNovels() {
    return this.request<Novel[]>("GET", "/users/me/collaborative-novels");
  }
  novel(novelId: string) {
    return this.request<NovelDetail>("GET", `/novels/${seg(novelId)}`);
  }
  search(novelId: string, q: string, limit = 20, offset = 0) {
    const qs = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    return this.request<SearchResult>("GET", `/novels/${seg(novelId)}/search/v2?${qs}`);
  }

  // ---- episodes ----
  episode(episodeId: string) {
    return this.request<Episode>("GET", `/episodes/${seg(episodeId)}`);
  }
  episodeBlocks(episodeId: string) {
    return this.request<Block[]>("GET", `/episodes/${seg(episodeId)}/blocks`);
  }
  episodeVersion(episodeId: string) {
    return this.request<{ id: string; contentVersion: number }>("GET", `/episodes/${seg(episodeId)}/version`);
  }
  createEpisode(novelId: string, dto: { title: string; episodeType?: number; status?: string; manualLineBreak?: boolean }) {
    return this.request<Episode>("POST", `/novels/${seg(novelId)}/episodes`, { manualLineBreak: false, ...dto });
  }
  updateEpisode(episodeId: string, dto: Record<string, unknown>) {
    return this.request<Episode>("PATCH", `/episodes/${seg(episodeId)}`, dto);
  }
  syncEpisodeBlocks(episodeId: string, deltaBlocks: DeltaBlock[], targetVersion: number) {
    return this.request<{ newContentVersion: number; shouldRefetch?: boolean }>(
      "PATCH",
      `/episodes/${seg(episodeId)}/blocks/sync`,
      { deltaBlocks, forceLatest: false, clientTimestamp: new Date(), targetVersion },
    );
  }

  // ---- snapshots ----
  snapshots(kind: "episodes" | "wiki-pages", id: string) {
    return this.request<Snapshot[]>("GET", `/${seg(kind)}/${seg(id)}/snapshots?view=summary`);
  }
  snapshot(kind: "episodes" | "wiki-pages", id: string, snapshotId: string) {
    return this.request<Snapshot>("GET", `/${seg(kind)}/${seg(id)}/snapshots/${seg(snapshotId)}`);
  }
  saveSnapshot(kind: "episodes" | "wiki-pages", id: string, name?: string) {
    return this.request<Snapshot>("POST", `/${seg(kind)}/${seg(id)}/snapshots`, { reason: "manual", ...(name ? { name } : {}) });
  }
  restoreSnapshot(kind: "episodes" | "wiki-pages", id: string, snapshotId: string) {
    return this.request<unknown>("POST", `/${seg(kind)}/${seg(id)}/snapshots/${seg(snapshotId)}/restore`);
  }

  // ---- comments ----
  comments(episodeId: string) {
    return this.request<Comment[]>("GET", `/episodes/${seg(episodeId)}/comments`);
  }
  createComment(episodeId: string, content: string, blockId?: string) {
    return this.request<unknown>("POST", `/episodes/${seg(episodeId)}/comments`, { content, ...(blockId ? { blockId } : {}) });
  }

  // ---- wiki ----
  wikiPages(novelId: string) {
    return this.request<WikiPage[]>("GET", `/novels/${seg(novelId)}/wiki-pages`);
  }
  wikiPage(wikiPageId: string) {
    return this.request<WikiPage>("GET", `/wiki-pages/${seg(wikiPageId)}`);
  }
  wikiBlocks(wikiPageId: string) {
    return this.request<Block[]>("GET", `/wiki-pages/${seg(wikiPageId)}/blocks`);
  }
  createWikiPage(novelId: string, dto: Record<string, unknown>) {
    return this.request<WikiPage>("POST", `/novels/${seg(novelId)}/wiki-pages`, dto);
  }
  updateWikiPage(wikiPageId: string, dto: Record<string, unknown>) {
    return this.request<WikiPage>("PATCH", `/wiki-pages/${seg(wikiPageId)}`, dto);
  }
  syncWikiBlocks(wikiPageId: string, deltaBlocks: DeltaBlock[], targetVersion: number) {
    return this.request<{ newContentVersion: number; shouldRefetch?: boolean }>(
      "PATCH",
      `/wiki-pages/${seg(wikiPageId)}/blocks/sync`,
      { deltaBlocks, forceLatest: false, clientTimestamp: new Date(), targetVersion },
    );
  }

  // ---- memos ----
  memos(novelId: string) {
    return this.request<Memo[]>("GET", `/novels/${seg(novelId)}/memos`);
  }
  createMemo(novelId: string, text: string) {
    return this.request<Memo>("POST", `/novels/${seg(novelId)}/memos`, { text });
  }
  updateMemo(memoId: string, text: string) {
    return this.request<Memo>("PATCH", `/memos/${seg(memoId)}`, { text });
  }

  // ---- clues (foreshadowing) ----
  clues(novelId: string) {
    return this.request<Clue[]>("GET", `/novels/${seg(novelId)}/episode-clues`);
  }
  createClue(novelId: string, dto: { id: string; title: string; description: string; reference: { kind: string; episodeId: string; blockId: string } }) {
    return this.request<Clue>("POST", `/novels/${seg(novelId)}/episode-clues`, dto);
  }
  updateClue(clueId: string, dto: { title?: string; description?: string }) {
    return this.request<Clue>("PATCH", `/episode-clues/${seg(clueId)}`, dto);
  }
  addClueReference(clueId: string, kind: string, episodeId: string, blockId: string) {
    return this.request<Clue>("PUT", `/episode-clues/${seg(clueId)}/references/${seg(kind)}/${seg(episodeId)}/${seg(blockId)}`);
  }
  removeClueReference(clueId: string, kind: string, episodeId: string, blockId: string) {
    return this.request<Clue>("DELETE", `/episode-clues/${seg(clueId)}/references/${seg(kind)}/${seg(episodeId)}/${seg(blockId)}`);
  }

  // ---- episode ↔ wiki relations ----
  relations(novelId: string) {
    return this.request<Relation[]>("GET", `/novels/${seg(novelId)}/episode-wiki-relations`);
  }
  upsertRelations(novelId: string, relations: { episodeId: string; wikiPageId: string; relevance: string }[]) {
    return this.request<Relation[]>("PUT", `/novels/${seg(novelId)}/episode-wiki-relations`, { relations });
  }
  removeRelation(novelId: string, episodeId: string, wikiPageId: string) {
    return this.request<unknown>("DELETE", `/novels/${seg(novelId)}/episode-wiki-relations/${seg(episodeId)}/${seg(wikiPageId)}`);
  }
}
