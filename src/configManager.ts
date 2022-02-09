import path, { resolve } from "path";
import fs from "fs";

import {
  LaunchConfig,
  ComputedNetwork,
  Node,
  Parachain,
  Override,
  RelayChainConfig,
  NodeConfig,
  envVars,
} from "./types";
import { getSha256 } from "./utils";
import { DEFAULT_ADDER_COLLATOR_BIN, DEFAULT_CHAIN, DEFAULT_CHAIN_SPEC_COMMAND, DEFAULT_COLLATOR_IMAGE, DEFAULT_COMMAND, DEFAULT_GENESIS_GENERATE_SUBCOMMAND, DEFAULT_GLOBAL_TIMEOUT, DEFAULT_IMAGE, DEFAULT_WASM_GENERATE_SUBCOMMAND, DEV_ACCOUNTS, GENESIS_STATE_FILENAME, GENESIS_WASM_FILENAME, P2P_PORT, RPC_WS_PORT, ZOMBIE_WRAPPER } from "./constants";
import { generateKeyForNode } from "./keys";


const debug = require("debug")("zombie::config-manager");

// get the path of the zombie wrapper
export const zombieWrapperPath = resolve(
  __dirname,
  `../scripts/${ZOMBIE_WRAPPER}`
);

const DEFAULT_ENV: envVars[] = [
  { name: "COLORBT_SHOW_HIDDEN", value: "1" },
  { name: "RUST_BACKTRACE", value: "FULL" },
];

export async function generateNetworkSpec(
  config: LaunchConfig
): Promise<ComputedNetwork> {
  let globalOverrides: Override[] = [];
  if (config.relaychain.default_overrides) {
    globalOverrides = await Promise.all(
      config.relaychain.default_overrides.map(async (override) => {
        const valid_local_path = await getLocalOverridePath(
          config.configBasePath,
          override.local_path
        );
        return {
          local_path: valid_local_path,
          remote_name: override.remote_name,
        };
      })
    );
  }

  let networkSpec: any = {
    configBasePath: config.configBasePath,
    relaychain: {
      defaultImage: config.relaychain.default_image || DEFAULT_IMAGE,
      defaultCommand: config.relaychain.default_command || DEFAULT_COMMAND,
      nodes: [],
      chain: config.relaychain.chain || DEFAULT_CHAIN,
      overrides: globalOverrides,
    },
    parachains: []
  };

  if(config.relaychain.genesis) networkSpec.relaychain.genesis = config.relaychain.genesis;
  const chainName = config.relaychain.chain || DEFAULT_CHAIN;

  // settings
  networkSpec.settings = {
    timeout: DEFAULT_GLOBAL_TIMEOUT,
    ...(config.settings ? config.settings : {}),
  };

  // default provider
  if (!networkSpec.settings.provider)
    networkSpec.settings.provider = "kubernetes";

  // if we don't have a path to the chain-spec leave undefined to create
  if (config.relaychain.chain_spec_path) {
    const chainSpecPath = resolve(
      process.cwd(),
      config.relaychain.chain_spec_path
    );
    if (!fs.existsSync(chainSpecPath)) {
      console.error("Chain spec provided does not exist: ", chainSpecPath);
      process.exit();
    } else {
      networkSpec.relaychain.chainSpecPath = chainSpecPath;
    }
  } else {
    // Create the chain spec
    networkSpec.relaychain.chainSpecCommand = config.relaychain
      .chain_spec_command
      ? config.relaychain.chain_spec_command
      : DEFAULT_CHAIN_SPEC_COMMAND.replace(
          "{{chainName}}",
          networkSpec.relaychain.chain
        ).replace("{{DEFAULT_COMMAND}}", networkSpec.relaychain.defaultCommand);
  }

  const relayChainBootnodes: string[] = [];
  for (const node of config.relaychain.nodes || []) {
    const nodeSetup = await getNodeFromConfig(networkSpec, node, relayChainBootnodes, globalOverrides);
    networkSpec.relaychain.nodes.push(nodeSetup);
  }

  for(const nodeGroup of config.relaychain.node_groups || []) {
    for(let i=0;i < nodeGroup.count; i++) {
      let node: NodeConfig = {
        name: `${nodeGroup.name}-${i}`,
        image: nodeGroup.image || networkSpec.relaychain.defaultImage,
        command: nodeGroup.command,
        args: nodeGroup.args?.filter( arg => ! DEV_ACCOUNTS.includes(arg.toLocaleLowerCase().replace("--",""))),
        validator: true, // groups are always validators
        env: nodeGroup.env,
        overrides: nodeGroup.overrides
      }
      const nodeSetup = await getNodeFromConfig(networkSpec, node, relayChainBootnodes, globalOverrides);
      networkSpec.relaychain.nodes.push(nodeSetup);
    }
  }

  if(networkSpec.relaychain.nodes.length < 1) {
    throw new Error("No NODE defined in config, please review.");
  }

  if (config.parachains && config.parachains.length) {
    for (const parachain of config.parachains) {
      let computedStatePath,
        computedStateCommand,
        computedWasmPath,
        computedWasmCommand;
      const bootnodes = relayChainBootnodes;
      const collatorBinary = parachain.collator.commandWithArgs
        ? parachain.collator.commandWithArgs.split(" ")[0]
        : parachain.collator.command
        ? parachain.collator.command
        : DEFAULT_ADDER_COLLATOR_BIN;

      if (parachain.genesis_state_path) {
        const genesisStatePath = resolve(
          process.cwd(),
          parachain.genesis_state_path
        );
        if (!fs.existsSync(genesisStatePath)) {
          console.error(
            "Genesis spec provided does not exist: ",
            genesisStatePath
          );
          process.exit();
        } else {
          computedStatePath = genesisStatePath;
        }
      } else {
        computedStateCommand = parachain.genesis_state_generator
          ? parachain.genesis_state_generator
          : `${collatorBinary} ${DEFAULT_GENESIS_GENERATE_SUBCOMMAND}`;

        if(! collatorBinary.includes("adder")) {
          computedStateCommand += ` --parachain-id ${parachain.id}`;
        }

        computedStateCommand += ` > {{CLIENT_REMOTE_DIR}}/${GENESIS_STATE_FILENAME}`;
      }

      if (parachain.genesis_wasm_path) {
        const genesisWasmPath = resolve(
          process.cwd(),
          parachain.genesis_wasm_path
        );
        if (!fs.existsSync(genesisWasmPath)) {
          console.error(
            "Genesis spec provided does not exist: ",
            genesisWasmPath
          );
          process.exit();
        } else {
          computedWasmPath = genesisWasmPath;
        }
      } else {
        computedWasmCommand = parachain.genesis_wasm_generator
          ? parachain.genesis_wasm_generator
          : `${collatorBinary} ${DEFAULT_WASM_GENERATE_SUBCOMMAND} > {{CLIENT_REMOTE_DIR}}/${GENESIS_WASM_FILENAME}`;
      }

      let args: string[] = [];
      if (parachain.collator.args) args = args.concat(parachain.collator.args);

      const env = [
        { name: "COLORBT_SHOW_HIDDEN", value: "1" },
        { name: "RUST_BACKTRACE", value: "FULL" },
      ];
      if (parachain.collator.env) env.push(...parachain.collator.env);

      let parachainSetup: Parachain = {
        id: parachain.id,
        addToGenesis:
          parachain.addToGenesis === undefined ? true : parachain.addToGenesis, // add by default
        collator: {
          name: getUniqueName(parachain.collator.name || "collator"),
          command: collatorBinary,
          commandWithArgs: parachain.collator.commandWithArgs,
          image: parachain.collator.image || DEFAULT_COLLATOR_IMAGE,
          chain: networkSpec.relaychain.chain,
          args: parachain.collator.args || [],
          env: env,
          bootnodes
        },
      };

      parachainSetup = {
        ...parachainSetup,
        ...(parachain.balance ? { balance: parachain.balance } : {}),
        ...(computedWasmPath ? { genesisWasmPath: computedWasmPath } : {}),
        ...(computedWasmCommand
          ? { genesisWasmGenerator: computedWasmCommand }
          : {}),
        ...(computedStatePath ? { genesisStatePath: computedStatePath } : {}),
        ...(computedStateCommand
          ? { genesisStateGenerator: computedStateCommand }
          : {}),
      };

      networkSpec.parachains.push(parachainSetup);
    }
  }

  networkSpec.types = config.types ? config.types : {};

  return networkSpec as ComputedNetwork;
}

// TODO: move this fn to other module.
export function generateBootnodeSpec(config: ComputedNetwork): Node {
  const nodeSetup: Node = {
    name: "bootnode",
    key: "0000000000000000000000000000000000000000000000000000000000000001",
    command: config.relaychain.defaultCommand || DEFAULT_COMMAND,
    image: config.relaychain.defaultImage || DEFAULT_IMAGE,
    chain: config.relaychain.chain,
    port: P2P_PORT,
    wsPort: RPC_WS_PORT,
    validator: false,
    args: [
      "--ws-external",
      "--rpc-external",
      "--listen-addr",
      "/ip4/0.0.0.0/tcp/30333/ws"
    ],
    env: [],
    bootnodes: [],
    telemetryUrl: "",
    overrides: [],
    zombieRole: "bootnode"
  };

  return nodeSetup;
}

interface UsedNames {
  [properyName: string]: number;
}

let mUsedNames: UsedNames = {};

export function getUniqueName(name: string): string {
  let uniqueName;
  if (!mUsedNames[name]) {
    mUsedNames[name] = 1;
    uniqueName = name;
  } else {
    uniqueName = `${name}-${mUsedNames[name]}`;
    mUsedNames[name] += 1;
  }
  return uniqueName;
}

async function getLocalOverridePath(
  configBasePath: string,
  definedLocalPath: string
): Promise<string> {
  // let check if local_path is full or relative
  let local_real_path = definedLocalPath;
  if (!fs.existsSync(definedLocalPath)) {
    // check relative to config
    local_real_path = path.join(configBasePath, definedLocalPath);
    if (!fs.existsSync(local_real_path))
      throw new Error(
        "Invalid override config, only fullpaths or relative paths (from the config) are allowed"
      );
  }

  return local_real_path;
}

function isValidatorbyArgs(nodeArgs: string[]): boolean {
  const defaultAccounts = ["alice", "bob", "charlie", "dave", "eve", "ferdie"];
  const validatorAccount = defaultAccounts.find((acc) =>
    nodeArgs.includes(`--${acc}`)
  );
  return validatorAccount ? true : false;
}

async function getNodeFromConfig(networkSpec:any, node: NodeConfig, relayChainBootnodes: string[], globalOverrides: Override[]): Promise<Node> {
  const command = node.command
    ? node.command
    : networkSpec.relaychain.defaultCommand;
  const image = node.image ? node.image : networkSpec.relaychain.defaultImage;
  let args: string[] = [];
  if (node.args) args = args.concat(node.args);
  if (node.extra_args) args = args.concat(node.extra_args);

  const env = (node.env) ? DEFAULT_ENV.concat(node.env) : DEFAULT_ENV;

  let nodeOverrides: Override[] = [];
  if (node.overrides) {
    nodeOverrides = await Promise.all(
      node.overrides.map(async (override) => {
        const valid_local_path = await getLocalOverridePath(
          networkSpec.configBasePath,
          override.local_path
        );
        return {
          local_path: valid_local_path,
          remote_name: override.remote_name,
        };
      })
    );
  }

  const isValidator = node.validator
    ? true
    : isValidatorbyArgs(args)
    ? true
    : false;

  // enable --prometheus-external by default
  const prometheusExternal =
  networkSpec.settings?.prometheus !== undefined
      ? networkSpec.settings.prometheus
      : true;

  const nodeName = getUniqueName(node.name);
  const accountsForNode = await generateKeyForNode();
  // build node Setup
  const nodeSetup: Node = {
    name: nodeName,
    key: getSha256(nodeName),
    accounts: accountsForNode,
    command: command || DEFAULT_COMMAND,
    commandWithArgs: node.commandWithArgs,
    image: image || DEFAULT_IMAGE,
    wsPort: node.wsPort ? node.wsPort : RPC_WS_PORT,
    port: node.port ? node.port : P2P_PORT,
    chain: networkSpec.relaychain.chain,
    validator: isValidator,
    args,
    env,
    bootnodes: relayChainBootnodes,
    telemetryUrl: networkSpec.settings?.telemetry
      ? "ws://telemetry:8000/submit 0"
      : "",
    telemetry: networkSpec.settings?.telemetry ? true : false,
    prometheus: prometheusExternal,
    overrides: [...globalOverrides, ...nodeOverrides],
    addToBootnodes: node.add_to_bootnodes ? true : false
  };

  return nodeSetup;
}