/**
 * The SKILL teaches an agent to drive this server. The likeliest silent breakage is the
 * two drifting apart — a renamed tool, a dropped warning — so the invariants that bind
 * them are asserted here rather than left to review.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TOOLS } from "../src/tools/index.js";

const skill = readFileSync(fileURLToPath(new URL("../../../skills/hunch-vpm/SKILL.md", import.meta.url)), "utf8");

describe("skills/hunch-vpm/SKILL.md", () => {
  it("opens with frontmatter carrying a name and a description", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: hunch-vpm$/m);
    expect(frontmatter).toMatch(/^description: /m);
    // Long enough to say when to load it, short enough to stay a description.
    expect(frontmatter.length).toBeGreaterThan(400);
    expect(frontmatter.length).toBeLessThan(1_400);
  });

  it("names every tool this server publishes, and no tool it does not", () => {
    for (const tool of TOOLS) expect(skill, tool.name).toContain(tool.name);
    const mentioned = new Set(skill.match(/vpm_[a-z_]+/g) ?? []);
    expect([...mentioned].sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it("teaches the rule that makes an entry behave unexpectedly", () => {
    expect(skill).toMatch(/refused, not failed/i);
    expect(skill).toMatch(/H = C − V|capacity − vested/);
    // The trap: the ceiling is the OPPOSING book's headroom, not your own.
    expect(skill).toMatch(/Stake on YES vests into NO/);
  });

  it("states plainly who signs and what is at risk", () => {
    expect(skill).toMatch(/your own wallet/i);
    expect(skill).toMatch(/holds no keys/i);
    expect(skill).toMatch(/Stake is at risk/i);
  });

  it("stays under 500 lines", () => {
    expect(skill.split("\n").length).toBeLessThan(500);
  });
});
