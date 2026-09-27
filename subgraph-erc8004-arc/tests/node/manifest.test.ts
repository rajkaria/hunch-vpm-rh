/**
 * Conformance checks for the manifest, the ABIs and the schema.
 *
 * The matchstick suite proves the handlers do the right thing once an event reaches them. This
 * suite proves the right events reach them: a subgraph whose manifest names a signature that
 * differs from the deployed ABI by one parameter type indexes nothing at all, silently, and
 * looks healthy the whole time. Anchoring the manifest to ABIs taken from the verified
 * implementation contracts is the only way to catch that before deployment.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface AbiInput {
  readonly name: string;
  readonly type: string;
  readonly indexed?: boolean;
}

interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiInput[];
}

interface EventHandler {
  readonly event: string;
  readonly handler: string;
}

interface DataSource {
  readonly name: string;
  readonly network: string;
  readonly source: { readonly address: string; readonly abi: string; readonly startBlock: number };
  readonly mapping: {
    readonly file: string;
    readonly entities: readonly string[];
    readonly abis: readonly { readonly name: string; readonly file: string }[];
    readonly eventHandlers: readonly EventHandler[];
  };
}

interface Manifest {
  readonly specVersion: string;
  readonly schema: { readonly file: string };
  readonly dataSources: readonly DataSource[];
}

interface NetworkEntry {
  readonly address: string;
  readonly startBlock: number;
}

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

const manifest = parse(read("subgraph.yaml")) as Manifest;
const networks = JSON.parse(read("networks.json")) as Record<string, Record<string, NetworkEntry>>;
const schema = read("schema.graphql");

/**
 * A manifest event string may be folded across lines by YAML and spaces the ABI form does not
 * use. Collapse to the ABI's own spelling: one space only before an `indexed` type.
 */
function normalizeSignature(signature: string): string {
  return signature
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function abiEventSignature(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? [])
    .map((input) => `${input.indexed === true ? "indexed " : ""}${input.type}`)
    .join(",");
  return `${entry.name ?? ""}(${inputs})`;
}

function loadAbi(file: string): readonly AbiEntry[] {
  return JSON.parse(read(file.replace(/^\.\//, ""))) as readonly AbiEntry[];
}

// Confirmed on Arc testnet (chainId 5042002) against the deployed ERC-1967 proxies. The
// startBlocks are the proxies' own creation blocks, so nothing before them can be missed.
const EXPECTED_SOURCES: Record<string, { address: string; startBlock: number }> = {
  IdentityRegistry: {
    address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    startBlock: 29241340,
  },
  ReputationRegistry: {
    address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    startBlock: 29241344,
  },
  ValidationRegistry: {
    address: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    startBlock: 29241349,
  },
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("manifest", () => {
  it("declares exactly the three ERC-8004 registries", () => {
    expect(manifest.dataSources.map((d) => d.name)).toEqual([
      "IdentityRegistry",
      "ReputationRegistry",
      "ValidationRegistry",
    ]);
  });

  it("targets arc-testnet, where the registries are actually deployed", () => {
    for (const dataSource of manifest.dataSources) {
      expect(dataSource.network).toBe("arc-testnet");
    }
  });

  it.each(Object.keys(EXPECTED_SOURCES))(
    "%s points at the confirmed address and creation block",
    (name) => {
      const dataSource = manifest.dataSources.find((d) => d.name === name);
      expect(dataSource).toBeDefined();
      const expected = EXPECTED_SOURCES[name];
      expect(expected).toBeDefined();
      expect(dataSource?.source.address).toBe(expected?.address);
      expect(dataSource?.source.startBlock).toBe(expected?.startBlock);
    },
  );

  it("names a handler that the mapping file actually exports", () => {
    for (const dataSource of manifest.dataSources) {
      const source = read(dataSource.mapping.file.replace(/^\.\//, ""));
      for (const { handler } of dataSource.mapping.eventHandlers) {
        expect(
          source.includes(`export function ${handler}(`),
          `${dataSource.mapping.file} does not export ${handler}`,
        ).toBe(true);
      }
    }
  });

  it("writes only entities it declared", () => {
    for (const dataSource of manifest.dataSources) {
      const source = read(dataSource.mapping.file.replace(/^\.\//, ""));
      // Every `new X(` in a mapping is an entity constructor; the manifest must list it or
      // graph-node rejects the write at runtime rather than at build time.
      const constructed = [...source.matchAll(/new ([A-Z]\w+)\(/g)].map((match) => match[1]);
      for (const entity of constructed) {
        if (entity === undefined || !schema.includes(`type ${entity} @entity`)) continue;
        expect(
          dataSource.mapping.entities,
          `${dataSource.name} constructs ${entity} without declaring it`,
        ).toContain(entity);
      }
    }
  });
});

describe("event signatures match the deployed ABIs", () => {
  for (const dataSource of manifest.dataSources) {
    const abiRef = dataSource.mapping.abis.find((a) => a.name === dataSource.source.abi);
    const abi = loadAbi(abiRef?.file ?? "");
    const available = new Set(
      abi.filter((entry) => entry.type === "event").map(abiEventSignature),
    );

    for (const { event, handler } of dataSource.mapping.eventHandlers) {
      it(`${dataSource.name}.${handler} handles a real ${event.split("(")[0]} event`, () => {
        const normalized = normalizeSignature(event);
        expect(
          available.has(normalized),
          `${normalized} is not in ${abiRef?.file}. Available: ${[...available].join(", ")}`,
        ).toBe(true);
      });
    }
  }

  it("keeps the ABIs free of hand-edited stubs", () => {
    // The ABIs were taken from the verified implementations behind the proxies. A truncated or
    // hand-written replacement is the likeliest way for the signatures above to drift.
    const expectedEventCounts: Record<string, number> = {
      "abis/IdentityRegistry.json": 12,
      "abis/ReputationRegistry.json": 6,
      "abis/ValidationRegistry.json": 5,
    };
    for (const [file, count] of Object.entries(expectedEventCounts)) {
      const events = loadAbi(file).filter((entry) => entry.type === "event");
      expect(events.length, `${file} event count`).toBe(count);
    }
  });

  it("indexes the parameters the registries actually index", () => {
    // Getting these wrong is not a build error: graph-node would decode garbage from the wrong
    // side of the topic/data split.
    const reputation = loadAbi("abis/ReputationRegistry.json");
    const newFeedback = reputation.find((e) => e.type === "event" && e.name === "NewFeedback");
    const indexed = (newFeedback?.inputs ?? []).filter((i) => i.indexed === true).map((i) => i.name);
    expect(indexed).toEqual(["agentId", "clientAddress", "indexedTag1"]);

    const validation = loadAbi("abis/ValidationRegistry.json");
    const response = validation.find((e) => e.type === "event" && e.name === "ValidationResponse");
    const responseIndexed = (response?.inputs ?? [])
      .filter((i) => i.indexed === true)
      .map((i) => i.name);
    expect(responseIndexed).toEqual(["validatorAddress", "agentId", "requestHash"]);
  });
});

describe("networks.json", () => {
  it("covers every data source on both Arc networks", () => {
    for (const network of ["arc-testnet", "arc"]) {
      for (const dataSource of manifest.dataSources) {
        expect(networks[network]?.[dataSource.name], `${network}/${dataSource.name}`).toBeDefined();
      }
    }
  });

  it("agrees with the manifest on arc-testnet", () => {
    for (const dataSource of manifest.dataSources) {
      const entry = networks["arc-testnet"]?.[dataSource.name];
      expect(entry?.address).toBe(dataSource.source.address);
      expect(entry?.startBlock).toBe(dataSource.source.startBlock);
    }
  });

  it("leaves arc mainnet as an obvious placeholder", () => {
    // No ERC-8004 registry is deployed on Arc mainnet yet. A wrong-but-plausible address would
    // be far worse than one that is visibly unset.
    for (const dataSource of manifest.dataSources) {
      const entry = networks["arc"]?.[dataSource.name];
      expect(entry?.address).toBe(ZERO_ADDRESS);
      expect(entry?.startBlock).toBe(0);
    }
  });
});

describe("schema stays compatible with the standardized ERC-8004 shape", () => {
  const requiredEntities = [
    "Agent",
    "Capability",
    "Feedback",
    "Validation",
    "Endpoint",
    "Registry",
    "Client",
    "Validator",
    "CapabilityStat",
    "RegistryDayData",
  ];

  it.each(requiredEntities)("declares %s", (entity) => {
    expect(schema).toContain(`type ${entity} @entity`);
  });

  function fieldsOf(entity: string): string {
    const start = schema.indexOf(`type ${entity} @entity`);
    expect(start, `${entity} not found`).toBeGreaterThan(-1);
    const end = schema.indexOf("\n}", start);
    return schema.slice(start, end);
  }

  it("keeps every standardized Agent field", () => {
    // Renaming any of these is what would force a Base consumer to branch on chain.
    const agent = fieldsOf("Agent");
    for (const field of [
      "id: ID!",
      "owner: Bytes!",
      "tokenId: BigInt!",
      "metadataURI: String!",
      "name: String",
      "endpoints: [Endpoint!]!",
      "capabilities: [Capability!]!",
      "registeredAt: BigInt!",
      "feedbackCount: BigInt!",
      "averageScore: BigDecimal!",
      "validationCount: BigInt!",
    ]) {
      expect(agent, `Agent.${field}`).toContain(field);
    }
  });

  it("keeps every standardized Feedback field", () => {
    const feedback = fieldsOf("Feedback");
    for (const field of ["score: BigDecimal!", "tags: [String!]!", "author: Bytes!", "revoked: Boolean!"]) {
      expect(feedback, `Feedback.${field}`).toContain(field);
    }
  });

  it("keeps every standardized Validation field", () => {
    const validation = fieldsOf("Validation");
    for (const field of ["request: String!", "response: Int", "status: ValidationStatus!"]) {
      expect(validation, `Validation.${field}`).toContain(field);
    }
  });

  it("leaves Validation.response nullable so a pending request is distinguishable", () => {
    // response 0 is a real verdict: the validator rejected. Only null means "no answer yet".
    expect(fieldsOf("Validation")).toContain("response: Int\n");
  });
});

describe("chain ids", () => {
  const helpers = read("src/helpers.ts");

  it("maps both Arc networks to their real chain ids", () => {
    expect(helpers).toContain('if (network == "arc") return BigInt.fromI32(5042);');
    expect(helpers).toContain('if (network == "arc-testnet") return BigInt.fromI32(5042002);');
  });

  it("also maps the chains the standardized schema already covers", () => {
    // Same mapping source, pointed at another chain, must produce the same CAIP-2 ids the
    // existing deployments use or cross-chain ids would not line up.
    for (const [network, chainId] of [
      ["mainnet", 1],
      ["base", 8453],
      ["bsc", 56],
      ["matic", 137],
      ["sepolia", 11155111],
      ["chapel", 97],
      ["monad-testnet", 10143],
    ] as const) {
      expect(helpers).toContain(`if (network == "${network}") return BigInt.fromI32(${chainId});`);
    }
  });
});
