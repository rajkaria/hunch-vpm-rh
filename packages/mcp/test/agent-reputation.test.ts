import { describe, expect, it } from "vitest";

import { ToolError } from "../src/errors.js";
import { agentReputationTool } from "../src/tools/agent-reputation.js";
import { AGENT, fakeAgents, makeDeps, WALLET } from "./fixtures.js";

describe("vpm_agent_reputation", () => {
  it("reports identity, reputation, human-backed status and venue activity", async () => {
    const payload = await agentReputationTool.run({ wallet: WALLET }, makeDeps());

    expect(payload.summary).toContain("registered in the ERC-8004 IdentityRegistry");
    // A revoked entry still counts in the total, so both numbers are stated.
    expect(payload.summary).toContain("17 feedback record(s), 15 still counting, 2 revoked");
    expect(payload.summary).toContain("Human-backed");
    expect(payload.summary).toContain("4 market(s) entered");

    expect(payload.data["identity"]).toMatchObject({ registered: true, agentId: "42", name: "forecaster" });
    expect(payload.data["humanBacked"]).toMatchObject({ status: "backed", source: "AgentBook" });
    expect(payload.data["venue"]).toMatchObject({ marketsEntered: 4, acceptedStake: { usdc: "2400" } });
  });

  it("says a burned identity is not a live one", async () => {
    const agents = fakeAgents({
      ...AGENT,
      identity: { ...AGENT.identity, registered: false, burned: true },
    });
    const payload = await agentReputationTool.run({ wallet: WALLET }, makeDeps({ agents }));
    expect(payload.summary).toContain("the identity has been burned");
    expect(payload.data["identity"]).toMatchObject({ registered: false, burned: true });
  });

  it("normalizes the address before looking it up", async () => {
    let asked = "";
    const agents = fakeAgents(async () => {
      asked = "seen";
      return AGENT;
    });
    const payload = await agentReputationTool.run({ wallet: WALLET.toUpperCase().replace("0X", "0x") }, makeDeps({ agents }));
    expect(asked).toBe("seen");
    expect(payload.data["wallet"]).toBe(WALLET);
  });

  it("treats an unregistered wallet as unpriced rather than untrustworthy", async () => {
    const agents = fakeAgents({
      ...AGENT,
      identity: { registered: false, burned: undefined, agentId: undefined, name: undefined, metadataUri: undefined, registry: undefined },
      reputation: {
        feedbackCount: undefined,
        activeFeedbackCount: undefined,
        revokedFeedbackCount: undefined,
        averageScore: undefined,
        validationCount: undefined,
        lastSeen: undefined,
      },
      humanBacked: false,
      venue: { marketsEntered: 0, offered: 0n, acceptedStake: 0n, claimed: 0n, firstSeen: undefined },
    });
    const payload = await agentReputationTool.run({ wallet: WALLET }, makeDeps({ agents }));

    expect(payload.summary).toContain("has no ERC-8004 identity");
    expect(payload.summary).toContain("No reputation records were readable");
    expect(payload.summary).toContain("It can still trade");
    expect(payload.summary).toContain("nothing to price");
    expect(payload.data["humanBacked"]).toMatchObject({ status: "not_backed" });
  });

  it("keeps 'unknown' distinct from 'not backed'", async () => {
    const agents = fakeAgents({ ...AGENT, humanBacked: undefined, notes: ["AgentBook was not readable"] });
    const payload = await agentReputationTool.run({ wallet: WALLET }, makeDeps({ agents }));
    expect(payload.data["humanBacked"]).toMatchObject({ status: "unknown" });
    expect(payload.summary).toContain("not the same as 'no'");
    expect(payload.summary).toContain("Note: AgentBook was not readable");
  });

  it("rejects anything that is not a 20-byte address", async () => {
    await expect(agentReputationTool.run({ wallet: "0x1234" }, makeDeps())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(agentReputationTool.run({ wallet: "vitalik.eth" }, makeDeps())).rejects.toBeInstanceOf(ToolError);
  });

  it("surfaces a directory failure rather than pretending the wallet is unknown", async () => {
    const agents = fakeAgents(async () => {
      throw new ToolError("not_configured", "No agent data source is configured.");
    });
    await expect(agentReputationTool.run({ wallet: WALLET }, makeDeps({ agents }))).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("links the wallet on the configured explorer", async () => {
    const payload = await agentReputationTool.run({ wallet: WALLET }, makeDeps());
    expect((payload.data["identity"] as { explorer: string }).explorer).toBe(`https://testnet.arcscan.app/address/${WALLET}`);
  });

  it("says what reputation cannot tell you", () => {
    expect(agentReputationTool.description).toMatch(/conduct, not about whether a forecast is right/);
  });
});
