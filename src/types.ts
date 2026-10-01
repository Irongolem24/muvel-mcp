// Shapes observed from the muvel.app API (2026-10-01). Only fields we use are typed.

export interface InlineNode {
  type: string; // "text" | "hard_break" | ...
  text?: string;
  marks?: unknown[];
  content?: InlineNode[];
}

export interface Block {
  id: string;
  content: InlineNode[];
  text?: string;
  blockType: string;
  attr: Record<string, unknown>;
  order: number;
}

export type DeltaBlock =
  | { id: string; action: "create"; date: Date; content: InlineNode[]; blockType: string; attr: Record<string, unknown>; order: number }
  | { id: string; action: "update"; date: Date; content?: InlineNode[]; blockType?: string; attr?: Record<string, unknown>; order?: number }
  | { id: string; action: "delete"; date: Date };

export interface Novel {
  id: string;
  title: string;
  description: string;
  episodeCount: number;
  tags: string[];
  updatedAt: string;
}

export interface Episode {
  id: string;
  novelId: string;
  title: string;
  description: string;
  authorComment: string;
  episodeType: number;
  status: string;
  order: number;
  tags: string[];
  contentLength: number;
  contentVersion: number;
  pointOfView: string | null;
  updatedAt: string;
}

export interface WikiPage {
  id: string;
  novelId: string;
  title: string;
  summary: string | null;
  namespace: string;
  category: string;
  alternativeTitles: string[];
  attributes?: [string, string][];
  tags: string[];
  importance: number | null;
  contentVersion?: number;
  updatedAt: string;
}

export interface NovelDetail extends Novel {
  episodes: Episode[];
  wikiPages: WikiPage[];
}

export interface Memo {
  id: string;
  text: string;
  order: number;
  updatedAt?: string;
}

export interface ClueReference {
  kind: "setup" | "payoff";
  episodeId: string;
  blockId: string;
  target?: { state: string; episodeTitle?: string; episodeOrder?: number };
}

export interface Clue {
  id: string;
  title: string;
  description: string;
  references: ClueReference[];
}

export interface Relation {
  episodeId: string;
  wikiPageId: string;
  relevance: "high" | "medium" | "low";
}

export interface Comment {
  id: string;
  content: string;
  createdAt: string;
  isAi: boolean;
  parentId: string | null;
  author?: { username: string };
}

export interface Snapshot {
  id: string;
  reason: string;
  name: string | null;
  contentVersion: number;
  contentLength: number;
  createdAt: string;
  blocks?: Block[];
}

export interface SearchHit {
  id: string;
  searchCategory: "Episode" | "EpisodeBlock" | "WikiPage" | "WikiBlock";
  searchSubCategory: string | number;
  title?: string;
  summary?: string | null;
  content?: string;
  order?: number | string;
  episodeId?: string;
  episodeTitle?: string;
  wikiPageId?: string;
  wikiPageName?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  estimatedTotalHits: number;
}
