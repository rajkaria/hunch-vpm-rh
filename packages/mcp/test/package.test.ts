/**
 * The manifest is not imported at runtime (that would drag package.json into the build
 * output), so these assertions are what keeps the reported version honest and the
 * workspace conventions from drifting.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SERVER_NAME, VERSION } from "../src/version.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  name: string;
  version: string;
  license: string;
  type: string;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

describe("package manifest", () => {
  it("reports the version it ships", () => {
    expect(VERSION).toBe(manifest.version);
    expect(SERVER_NAME).toBe("hunch-vpm");
  });

  it("follows the workspace conventions", () => {
    expect(manifest.name).toBe("@hunch-vpm/mcp");
    expect(manifest.license).toBe("MIT");
    expect(manifest.type).toBe("module");
  });

  it("declares the scripts CI runs", () => {
    expect(Object.keys(manifest.scripts)).toEqual(expect.arrayContaining(["build", "typecheck", "test"]));
  });

  it("exposes a stdio binary a host can launch", () => {
    expect(manifest.bin["hunch-vpm-mcp"]).toBe("./dist/index.js");
  });

  it("depends on the client as a workspace package", () => {
    expect(manifest.dependencies["@hunch-vpm/client"]).toBe("workspace:*");
  });
});
