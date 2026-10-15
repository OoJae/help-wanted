/**
 * Sends a planned list of contract calls from the visitor's own wallet, one at a time, waiting for
 * each to be mined before offering the next. This site never holds a key and never sees a
 * signature: the wallet signs, and the transaction goes from the wallet to the chain.
 *
 * What each step may do next is decided in `lib/sendStep.ts`, which has no wallet in it and is
 * tested on its own. This file only connects it to the wallet.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import {
  createConfig,
  http,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useSwitchChain,
  WagmiProvider,
} from "wagmi";
import { getBytecode, readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors/injected";
import { erc20Abi } from "@help-wanted/shared/abi";
import type { FlowCall } from "~/flows";
import { canSend, confirmStep, sendStep, shortError, type StepDeps, type StepState } from "~/lib/sendStep";

interface Props {
  calls: FlowCall[];
  rpcUrl: string;
  action: string;
}

const queryClient = new QueryClient();
const configs = new Map<string, ReturnType<typeof createConfig>>();

function configFor(rpcUrl: string) {
  let config = configs.get(rpcUrl);
  if (!config) {
    config = createConfig({
      chains: [mainnet],
      connectors: [injected()],
      transports: { [mainnet.id]: http(rpcUrl) },
    });
    configs.set(rpcUrl, config);
  }
  return config;
}

function TxLink({ hash }: { hash: string }) {
  return <a href={`https://etherscan.io/tx/${hash}`}>{hash.slice(0, 14)}…</a>;
}

function Steps({ calls, rpcUrl, action }: Props) {
  const config = configFor(rpcUrl);
  // The chain the wallet itself is on. (`useChainId` would report the app's configured chain, which
  // is always mainnet here, so it could never show that the wallet is somewhere else.)
  const { address, isConnected, chainId: walletChainId } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending: connecting, error: connectError } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const [states, setStates] = useState<StepState[]>(() => calls.map(() => ({ status: "idle" })));

  const setState = (index: number) => (state: StepState) =>
    setStates((old) => old.map((s, i) => (i === index ? state : s)));

  const next = states.findIndex((s) => s.status !== "done" && s.status !== "skipped");
  const busy = states.some((s) => s.status === "signing" || s.status === "mining");

  function depsFor(call: FlowCall, from: `0x${string}`): StepDeps {
    const to = call.to as `0x${string}`;
    const spender = call.allowance?.spender;
    return {
      hasCode: async () => {
        const code = await getBytecode(config, { address: to, chainId: mainnet.id });
        return code !== undefined && code !== "0x";
      },
      allowance:
        call.allowance && spender
          ? {
              needed: call.allowance.amount,
              read: () =>
                readContract(config, {
                  address: to,
                  abi: erc20Abi,
                  functionName: "allowance",
                  args: [from, spender as `0x${string}`],
                  chainId: mainnet.id,
                }),
            }
          : undefined,
      write: () =>
        writeContract(config, {
          address: to,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args as unknown[],
          chainId: mainnet.id,
          // ETH the call carries (Zap), and a gas limit where the contract must be offered more
          // gas than it uses (a settlement, a rule's fire). Left to the wallet otherwise.
          ...(call.value !== undefined ? { value: call.value } : {}),
          ...(call.gas !== undefined ? { gas: call.gas } : {}),
        }),
      wait: (hash, onReplaced) =>
        waitForTransactionReceipt(config, {
          hash,
          chainId: mainnet.id,
          onReplaced: (replacement) => onReplaced(replacement.reason),
        }),
    };
  }

  function press(index: number) {
    const call = calls[index];
    const state = states[index];
    if (!call || !call.to || !address || !state) return;
    const deps = depsFor(call, address);
    // A step that has a hash is only ever looked up again, never sent again.
    if (state.status === "unconfirmed") void confirmStep(state.hash, deps, setState(index));
    else if (canSend(state)) void sendStep(deps, setState(index));
  }

  if (!isConnected) {
    const connector = connectors[0];
    return (
      <div className="walletline">
        <button
          className="btn"
          type="button"
          disabled={!connector || connecting}
          onClick={() => connector && connect({ connector })}
        >
          {connecting ? "Waiting for the wallet…" : "Connect a wallet"}
        </button>
        <span className="small">
          {connectError
            ? shortError(connectError)
            : connector
              ? "A browser wallet on Ethereum mainnet. This site never sees your key."
              : "No browser wallet was found. The commands above do the same from a terminal."}
        </span>
      </div>
    );
  }

  if (walletChainId !== mainnet.id) {
    return (
      <div className="walletline">
        <button
          className="btn"
          type="button"
          disabled={switching}
          onClick={() => switchChain({ chainId: mainnet.id })}
        >
          {switching ? "Waiting for the wallet…" : "Switch to Ethereum mainnet"}
        </button>
        <span className="small">
          {switchError
            ? shortError(switchError)
            : "Your wallet is on another network. These contracts are on Ethereum mainnet; nothing can be sent until the wallet is too."}
        </span>
      </div>
    );
  }

  return (
    <div>
      <p className="small">
        Connected as <span className="break">{address}</span>.{" "}
        <button className="theme-toggle" type="button" onClick={() => disconnect()}>
          Disconnect
        </button>
      </p>
      <ol className="txsteps">
        {calls.map((call, index) => {
          const state = states[index] ?? { status: "idle" };
          return (
            <li className="txstep" key={`${call.signature}-${index}`}>
              <div>
                <p>
                  <strong>
                    {index + 1}. {call.label}
                  </strong>
                </p>
                <p className="small" role="status">
                  {state.status === "idle" && (index === next ? "Ready." : "Waits for the step before it.")}
                  {state.status === "skipped" && state.note}
                  {state.status === "signing" && "Confirm it in your wallet."}
                  {state.status === "mining" && (
                    <>
                      Sent; waiting to be mined. <TxLink hash={state.hash} />
                    </>
                  )}
                  {state.status === "unconfirmed" && (
                    <>
                      <span className="spot">{state.message}</span> <TxLink hash={state.hash} />
                    </>
                  )}
                  {state.status === "done" && (
                    <>
                      Mined. {state.note} <TxLink hash={state.hash} />
                    </>
                  )}
                  {state.status === "failed" && (
                    <>
                      <span className="spot">{state.message}</span>{" "}
                      {state.hash && <TxLink hash={state.hash} />}
                    </>
                  )}
                </p>
              </div>
              <button
                className="btn"
                type="button"
                disabled={index !== next || busy}
                onClick={() => press(index)}
              >
                {state.status === "unconfirmed"
                  ? "Check again"
                  : state.status === "failed"
                    ? "Try again"
                    : index === calls.length - 1
                      ? action
                      : "Send"}
              </button>
            </li>
          );
        })}
      </ol>
      {next === -1 && <p className="label">All sent.</p>}
    </div>
  );
}

export default function WalletSend(props: Props) {
  return (
    <WagmiProvider config={configFor(props.rpcUrl)}>
      <QueryClientProvider client={queryClient}>
        <Steps {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
