/**
 * vpm_agent_reputation — who is on the other side.
 *
 * Identity and reputation come from the ERC-8004 registries on Arc; the human-backed
 * flag comes from AgentBook through the venue's own subgraph. The two are reported
 * separately on purpose: they answer different questions, and either can be missing.
 */

import type { AgentRecord } from "../domain.js";
import { ToolError } from "../errors.js";
import { isAddress, money, normalizeAddress, shortAddress, toIso } from "../format.js";
import { defineTool, type ToolDeps, type ToolPayload } from "../tool.js";

interface AgentReputationInput {
  readonly wallet: string;
}

export const agentReputationTool = defineTool<AgentReputationInput>({
  name: "vpm_agent_reputation",
  title: "ERC-8004 identity, reputation and human-backed status",
  description: [
    "Look up one wallet's ERC-8004 identity and reputation on Arc, plus whether it is backed by a verified human through AgentBook, plus what it has done on this venue.",
    "Reach for this when the decision is about trust rather than price: before taking the other side of a book where one wallet holds most of the opposing stake, before treating another agent's entries as a signal, or when deciding how much of your own capital to expose to a counterparty you have not met. An unregistered wallet is not a warning sign by itself — it means there is no on-chain history to price, so size as if you know nothing about it.",
    "Note what this cannot tell you: reputation is about conduct, not about whether a forecast is right. A human-backed agent with good feedback can still be wrong about the market. Read-only.",
  ].join("\n\n"),
  inputSchema: {
    type: "object",
    title: "vpm_agent_reputation input",
    properties: {
      wallet: {
        type: "string",
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "The wallet address to look up, 20 bytes of hex. Case does not matter.",
        examples: ["0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"],
      },
    },
    required: ["wallet"],
    additionalProperties: false,
  },
  async run(input, deps): Promise<ToolPayload> {
    const wallet = normalizeAddress(String(input.wallet ?? ""));
    if (!isAddress(wallet)) {
      throw new ToolError("invalid_input", `"${input.wallet}" is not a 20-byte hex address.`, {
        hint: "Pass a full address, e.g. 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.",
        detail: { field: "wallet" },
      });
    }

    const record = await deps.agents.lookup(wallet);

    return {
      summary: renderSummary(record, deps),
      data: {
        wallet: record.wallet,
        chain: { id: deps.config.chainId, name: deps.config.chainName },
        identity: {
          registered: record.identity.registered,
          burned: record.identity.burned,
          agentId: record.identity.agentId,
          name: record.identity.name,
          metadataUri: record.identity.metadataUri,
          identityRegistry: record.identity.registry,
          explorer:
            deps.config.explorerUrl === undefined ? undefined : `${deps.config.explorerUrl.replace(/\/$/, "")}/address/${record.wallet}`,
        },
        reputation: {
          feedbackCount: record.reputation.feedbackCount,
          activeFeedbackCount: record.reputation.activeFeedbackCount,
          revokedFeedbackCount: record.reputation.revokedFeedbackCount,
          averageScore: record.reputation.averageScore,
          validationCount: record.reputation.validationCount,
          lastSeen:
            record.reputation.lastSeen === undefined
              ? undefined
              : { unix: record.reputation.lastSeen, iso: toIso(record.reputation.lastSeen) },
          registries: deps.config.erc8004Registries,
        },
        humanBacked: {
          // Three states, and they are not the same: yes, no, and nobody asked.
          status: record.humanBacked === undefined ? "unknown" : record.humanBacked ? "backed" : "not_backed",
          source: "AgentBook",
        },
        venue:
          record.venue === undefined
            ? null
            : {
                marketsEntered: record.venue.marketsEntered,
                offered: record.venue.offered === undefined ? undefined : money(record.venue.offered),
                acceptedStake: record.venue.acceptedStake === undefined ? undefined : money(record.venue.acceptedStake),
                claimed: record.venue.claimed === undefined ? undefined : money(record.venue.claimed),
                firstSeen:
                  record.venue.firstSeen === undefined
                    ? undefined
                    : { unix: record.venue.firstSeen, iso: toIso(record.venue.firstSeen) },
              },
        notes: record.notes,
      },
    };
  },
});

function renderSummary(record: AgentRecord, deps: ToolDeps): string {
  const lines: string[] = [];
  const who = shortAddress(record.wallet);

  const id = record.identity.agentId === undefined ? "" : ` as agent ${record.identity.agentId}`;
  const name = record.identity.name === undefined ? "" : ` (${record.identity.name})`;
  if (record.identity.registered) {
    lines.push(`${who} is registered in the ERC-8004 IdentityRegistry on ${deps.config.chainName}${id}${name}.`);
  } else if (record.identity.burned === true) {
    lines.push(
      `${who} was registered in the ERC-8004 IdentityRegistry on ${deps.config.chainName}${id}${name}, but the identity has been burned. Its reputation belongs to an identity that no longer exists.`,
    );
  } else {
    lines.push(`${who} has no ERC-8004 identity on ${deps.config.chainName}.`);
  }

  const { feedbackCount, activeFeedbackCount, revokedFeedbackCount, averageScore, validationCount } = record.reputation;
  if (feedbackCount === undefined && averageScore === undefined && validationCount === undefined) {
    lines.push("No reputation records were readable.");
  } else {
    const parts: string[] = [];
    if (feedbackCount !== undefined) {
      // A revoked entry still counts in the total, so both numbers are reported: a high
      // count that is mostly revoked is not a record to trust.
      const revoked = revokedFeedbackCount === undefined || revokedFeedbackCount === 0 ? "" : `, ${revokedFeedbackCount} revoked`;
      const active = activeFeedbackCount === undefined ? "" : `, ${activeFeedbackCount} still counting`;
      parts.push(`${feedbackCount} feedback record(s)${active}${revoked}`);
    }
    if (averageScore !== undefined) parts.push(`average score ${averageScore}`);
    if (validationCount !== undefined) parts.push(`${validationCount} validation(s)`);
    lines.push(`Reputation: ${parts.join("; ")}.`);
  }

  if (record.humanBacked === true) {
    lines.push("Human-backed: an AgentBook proof binds this wallet to a verified human.");
  } else if (record.humanBacked === false) {
    lines.push("Not human-backed: no AgentBook proof. It can still trade — the venue tiers agents, it does not exclude them.");
  } else {
    lines.push("Human-backed status unknown: AgentBook was not readable, which is not the same as 'no'.");
  }

  if (record.venue !== undefined) {
    const stake = record.venue.acceptedStake;
    const markets = record.venue.marketsEntered ?? 0;
    if (markets === 0 && (stake === undefined || stake === 0n)) {
      lines.push("No activity on this venue yet.");
    } else {
      const claimed = record.venue.claimed;
      lines.push(
        `On this venue: ${markets} market(s) entered${stake === undefined ? "" : `, ${money(stake).display} of accepted stake`}${
          claimed === undefined ? "" : `, ${money(claimed).display} claimed`
        }.`,
      );
    }
  }

  lines.push("");
  lines.push(
    record.identity.registered
      ? "Read this as conduct history, not forecasting skill. It tells you whether a counterparty has a record to lose, not whether it is right."
      : "With no identity and no history there is nothing to price. Treat it as an anonymous counterparty and size accordingly.",
  );

  if (record.notes.length > 0) {
    lines.push("");
    for (const note of record.notes) lines.push(`Note: ${note}`);
  }

  return lines.join("\n");
}
