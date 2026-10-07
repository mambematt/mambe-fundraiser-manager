// Starts a throwaway Postgres for the test run and applies the real migrations.
// Set TEST_DATABASE_URL to use an existing (empty, disposable) database instead.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let pg: EmbeddedPostgres | null = null;
  let dir: string | null = null;

  if (!url) {
    dir = mkdtempSync(join(tmpdir(), "mambe-test-pg-"));
    const port = 54000 + Math.floor(Math.random() * 1000);
    pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("mambe_test");
    url = `postgresql://postgres:postgres@localhost:${port}/mambe_test`;
  }

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  project.provide("databaseUrl", url);

  return async () => {
    await pg?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
