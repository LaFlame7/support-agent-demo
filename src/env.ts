// Optional .env in the working directory, e.g. ANTHROPIC_API_KEY for PROPOSER=claude.
// Import first in entry points, before anything reads process.env.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
