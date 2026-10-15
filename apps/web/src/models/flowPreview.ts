/**
 * A flow as a page prints it without JavaScript: its form fields, what it would do in plain words,
 * and the exact `cast` commands, worked out on the server from example values. Every signature in
 * those commands is read from the ABI the compiler wrote for the contract.
 */
import type { ContractKey, Deployments } from "~/config/deployments";
import {
  castCommand,
  castReadCommand,
  flowById,
  initialValues,
  type Addresses,
  type FlowField,
} from "~/flows";
import { doc, fence, numbered } from "~/lib/md";
import { contractStatus, PUBLIC_RPC, type ContractStatus } from "./common";

export interface FlowPreview {
  id: string;
  title: string;
  action: string;
  contract: ContractStatus;
  /** True when the contract has an address, so the flow can be sent. */
  ready: boolean;
  fields: FlowField[];
  /** What the form starts with in the browser. */
  preset: Record<string, string>;
  /** The values the printed example uses. */
  exampleValues: Record<string, string>;
  summary: string[];
  problems: string[];
  /** Reads to make first: `cast call` lines that send nothing. */
  reads: { label: string; command: string }[];
  steps: { label: string; command: string }[];
}

export function addressesOf(deployments: Deployments): Addresses {
  const out = {} as Addresses;
  for (const key of Object.keys(deployments.contracts) as ContractKey[]) {
    out[key] = deployments.contracts[key].address;
  }
  return out;
}

export function previewFlow(
  flowId: string,
  deployments: Deployments,
  now: Date,
  preset: Record<string, string> = {},
  example: Record<string, string> = {},
): FlowPreview {
  const flow = flowById(flowId);
  if (!flow) throw new Error(`unknown flow ${flowId}`);
  const exampleValues = { ...initialValues(flow, preset), ...example };
  const plan = flow.plan(exampleValues, {
    addresses: addressesOf(deployments),
    now: Math.floor(now.getTime() / 1000),
  });
  const contract = contractStatus(deployments, flow.contract);
  return {
    id: flow.id,
    title: flow.title,
    action: flow.action,
    contract,
    ready: contract.address !== null,
    fields: flow.fields(preset),
    preset,
    exampleValues,
    summary: plan.ok ? plan.summary : [],
    problems: plan.ok ? [] : plan.problems,
    reads: plan.ok
      ? (plan.reads ?? []).map((r) => ({ label: r.label, command: castReadCommand(r, PUBLIC_RPC) }))
      : [],
    steps: plan.ok ? plan.calls.map((c) => ({ label: c.label, command: castCommand(c, PUBLIC_RPC) })) : [],
  };
}

/** The Markdown rendering of a flow preview, shared by every page that has one. */
export function flowMarkdown(preview: FlowPreview): string {
  return doc(
    `### ${preview.title}`,
    preview.ready
      ? `Sent to ${preview.contract.name} at ${preview.contract.address}.`
      : `${preview.contract.name} is ${preview.contract.label}, so this cannot be sent yet. The commands below show exactly what will be sent; \`$${preview.contract.name.replace(/[A-Z]/g, (c, i) => (i ? `_${c}` : c)).toUpperCase()}\` stands for the address.`,
    preview.summary.length > 0 ? numbered(preview.summary) : null,
    preview.problems.length > 0 ? preview.problems.map((p) => `- ${p}`).join("\n") : null,
    preview.reads.length > 0
      ? `Read first (nothing is sent):\n\n${fence(preview.reads.map((s) => `# ${s.label}\n${s.command}`).join("\n\n"), "sh")}`
      : null,
    preview.steps.length > 0
      ? `Then send:\n\n${fence(preview.steps.map((s) => `# ${s.label}\n${s.command}`).join("\n\n"), "sh")}`
      : null,
  ).trimEnd();
}
