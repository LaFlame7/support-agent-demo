import { readdirSync, readFileSync } from "node:fs";
import type { Category } from "../domain.js";

export interface KbArticle {
  id: string;
  title: string;
  category: Category;
  tags: string[];
  body: string;
}

export interface KbHit {
  id: string;
  title: string;
  category: Category;
  body: string;
  score: number;
}

const STOPWORDS = new Set(
  "a an the and or but to of in on for with my me i is it its this that be can you your we our have has not no do does how what why when where am are was were from at as by please hi hello thanks".split(" "),
);

export const tokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/** Keyword search over a handful of articles. Swap for pgvector/BM25 in a real help center. */
export class KnowledgeBase {
  constructor(readonly articles: KbArticle[]) {}

  static load(dir = new URL("../../kb/", import.meta.url)): KnowledgeBase {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    return new KnowledgeBase(files.map((f) => parseArticle(readFileSync(new URL(f, dir), "utf8"))));
  }

  get(id: string) {
    return this.articles.find((a) => a.id === id);
  }

  search(query: string, limit = 3): KbHit[] {
    const terms = new Set(tokenize(query));
    return this.articles
      .map((a) => {
        const title = tokenize(a.title);
        const tags = a.tags.flatMap(tokenize);
        const body = tokenize(a.body);
        let score = 0;
        for (const t of terms) {
          if (title.includes(t)) score += 3;
          if (tags.includes(t)) score += 2;
          if (body.includes(t)) score += 1;
        }
        return { id: a.id, title: a.title, category: a.category, body: a.body, score };
      })
      .filter((h) => h.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, limit);
  }
}

function parseArticle(raw: string): KbArticle {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("KB article without front matter");
  const meta = Object.fromEntries(
    match[1]!.split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  if (!meta.id || !meta.title || !meta.category) throw new Error("KB article needs id, title and category");
  return {
    id: meta.id,
    title: meta.title,
    category: meta.category as Category,
    tags: (meta.tags ?? "").split(",").map((t: string) => t.trim()),
    body: match[2]!.trim(),
  };
}
