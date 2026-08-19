import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentRecord } from "../src/domain/types.js";
import { EnvironmentStore } from "../src/state/environment-store.js";

function record(id = "env_20260818120000_abc123"): EnvironmentRecord {
  return {
    schemaVersion: 1,
    id,
    provider: "local",
    state: "requested",
    phase: "resolving_source",
    source: {
      requested: "pr:123",
      kind: "pull_request",
      repository: "saleor/saleor",
      cloneRepository: "saleor/saleor",
      cloneUrl: "https://github.com/saleor/saleor.git",
      commit: "a".repeat(40),
      ref: "feature",
      pullRequest: 123,
      baseBranch: "main",
      resolvedAt: "2026-08-18T12:00:00Z",
    },
    createdAt: "2026-08-18T12:00:00Z",
    updatedAt: "2026-08-18T12:00:00Z",
    expiresAt: "2026-08-18T14:00:00Z",
  };
}

describe("EnvironmentStore", () => {
  it("round-trips a validated record with private file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "saleor-yard-store-"));
    const store = new EnvironmentStore(root);
    const value = record();

    await store.save(value);

    expect(await store.get(value.id)).toEqual(value);
    expect(JSON.parse(await readFile(join(root, `${value.id}.json`), "utf8"))).toEqual(value);
  });

  it("does not allow path traversal through an environment ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "saleor-yard-store-"));
    const store = new EnvironmentStore(root);

    await expect(store.get("../../secret")).rejects.toMatchObject({
      code: "invalid_environment_id",
    });
  });

  it("reads records written with the old VM-specific phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "saleor-yard-store-"));
    const value = record();
    await writeFile(
      join(root, `${value.id}.json`),
      JSON.stringify({ ...value, phase: "provisioning_vm" }),
    );

    await expect(new EnvironmentStore(root).get(value.id)).resolves.toMatchObject({
      phase: "allocating_environment",
    });
  });

  it("round-trips local provider connection and access details", async () => {
    const root = await mkdtemp(join(tmpdir(), "saleor-yard-store-"));
    const store = new EnvironmentStore(root);
    const value = record();
    value.providerEnvironment = {
      provider: "local",
      providerId: "sy-pr-123-abc123",
      name: "sy-pr-123-abc123",
      ports: { gateway: 28080, core: 28000, mailpit: 28025, jaeger: 28686 },
    };
    value.access = {
      dashboard: "http://127.0.0.1:28080/",
      graphql: "http://127.0.0.1:28080/graphql/",
      rawGraphql: "http://127.0.0.1:28000/graphql/",
      mailpit: "http://127.0.0.1:28025/",
      jaeger: "http://127.0.0.1:28686/",
    };

    await store.save(value);

    expect(await store.get(value.id)).toEqual(value);
  });

  it("lists newest records first", async () => {
    const root = await mkdtemp(join(tmpdir(), "saleor-yard-store-"));
    const store = new EnvironmentStore(root);
    const older = record("env_20260818110000_aaaaaa");
    const newer = record("env_20260818120000_bbbbbb");
    older.createdAt = "2026-08-18T11:00:00Z";

    await store.save(older);
    await store.save(newer);

    expect((await store.list()).map(({ id }) => id)).toEqual([newer.id, older.id]);
  });
});
