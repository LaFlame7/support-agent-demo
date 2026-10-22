import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function readJsonl<T>(file: string): T[] {
  return readFileSync(new URL(file, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** Runs fn over items with at most `limit` in flight (keeps API rate limits happy). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export const ratio = (num: number, den: number) => (den === 0 ? 1 : num / den);
export const fmt = (x: number) => x.toFixed(2);

export function writeReport(name: string, markdown: string, json: unknown) {
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${name}.md`, dir), markdown);
  writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(json, null, 2)}\n`);
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
