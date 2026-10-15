/**
 * The interactive half of a transaction flow: a small form, the plan it leads to in plain words,
 * the same plan as `cast send` commands, and (loaded only when asked for) the wallet buttons.
 *
 * It plans with the very function the server used for the printed example (`flows/index.ts`), so
 * what a visitor signs is what the page says. When the contract has no address yet the form still
 * plans; it just cannot send.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  castCommand,
  castReadCommand,
  CONTRACT_NAMES,
  flowById,
  initialValues,
  type Addresses,
  type FlowField,
} from "~/flows";

const WalletSend = lazy(() => import("./WalletSend"));

interface Props {
  flowId: string;
  preset: Record<string, string>;
  addresses: Addresses;
  rpcUrl: string;
  /**
   * Why sending is switched off although the contract has an address: the server asked that address
   * to identify itself and it did not answer as the contract. Null when it did.
   */
  sendBlocked?: string | null;
}

function Field({
  field,
  value,
  onChange,
  id,
}: {
  field: FlowField;
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  const wide = field.kind === "longtext" || field.kind === "checkbox" || field.kind === "bytes32";
  if (field.kind === "checkbox") {
    return (
      <div className="field field--check field--wide">
        <input
          id={id}
          type="checkbox"
          checked={value === "true"}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.checked ? "true" : "false")
          }
        />
        <div>
          <label htmlFor={id}>{field.label}</label>
          {field.help && <p className="field__help">{field.help}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className={`field${wide ? " field--wide" : ""}`}>
      <label htmlFor={id}>{field.label}</label>
      {field.kind === "longtext" ? (
        <textarea
          id={id}
          value={value}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.kind === "select" ? (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="field__row">
          <input
            id={id}
            type="text"
            inputMode={
              field.kind === "imd" || field.kind === "eth"
                ? "decimal"
                : field.kind === "number"
                  ? "numeric"
                  : "text"
            }
            value={value}
            placeholder={field.placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
          />
          {field.unit && <span className="field__unit">{field.unit}</span>}
        </div>
      )}
      {field.help && <p className="field__help">{field.help}</p>}
    </div>
  );
}

export default function FlowRunner({ flowId, preset, addresses, rpcUrl, sendBlocked = null }: Props) {
  const flow = flowById(flowId);
  const [values, setValues] = useState<Record<string, string>>(() =>
    flow ? initialValues(flow, preset) : {},
  );
  const [touched, setTouched] = useState(false);
  const [wallet, setWallet] = useState(false);
  // The plan is drawn from one clock reading, so it does not change under the visitor while they
  // read it. The clock is read again at the moment the wallet step opens: an order's expiry is
  // counted from then, not from when the tab was opened.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const fields = useMemo(() => (flow ? flow.fields({ ...preset, ...values }) : []), [flow, preset, values]);
  const plan = useMemo(
    () => (flow ? flow.plan(values, { addresses, now }) : null),
    [flow, values, addresses, now],
  );

  // The server printed a worked example under this form, open, for readers without JavaScript.
  // Once this form shows a live plan of its own, the example folds away so nothing is said twice.
  const root = useRef<HTMLDivElement>(null);
  const planned = plan?.ok === true;
  useEffect(() => {
    const example = root.current?.closest(".blank")?.querySelector("details.plain");
    if (!example) return;
    if (planned) example.removeAttribute("open");
    else example.setAttribute("open", "");
  }, [planned]);

  if (!flow || !plan) return <p className="small">This form could not be loaded.</p>;

  const contractAddress = addresses[flow.contract];
  const set = (name: string) => (value: string) => {
    setTouched(true);
    setWallet(false);
    setValues((old) => ({ ...old, [name]: value }));
  };
  const hidden = new Set(Object.keys(preset));
  const shown = fields.filter((field) => !hidden.has(field.name) || field.kind !== "select");

  return (
    <div ref={root}>
      {shown.length > 0 && (
        <div className="fields">
          {shown.map((field) => (
            <Field
              key={field.name}
              id={`${flow.id}-${field.name}`}
              field={field}
              value={values[field.name] ?? ""}
              onChange={set(field.name)}
            />
          ))}
        </div>
      )}

      {!plan.ok ? (
        touched || shown.length === 0 ? (
          <ul className="problems" role="status">
            {plan.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : (
          <p className="small">Fill in the form to see exactly what would be sent.</p>
        )
      ) : (
        <>
          <p className="label">What this does</p>
          <ol className="plan">
            {plan.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          {plan.reads && plan.reads.length > 0 && (
            <>
              <p className="label">Read first: nothing is sent</p>
              <div className="cmd">
                {plan.reads.map((item) => (
                  <div className="cmd__row" key={`${item.signature}-${item.label}`}>
                    <p className="cmd__note">{item.label}</p>
                    <pre>{castReadCommand(item, rpcUrl)}</pre>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="label">
            {plan.calls.length === 1 ? "One transaction" : `${plan.calls.length} transactions`}
            {touched ? ", for what you typed" : ""}
          </p>
          <div className="cmd">
            {plan.calls.map((call, index) => (
              <div className="cmd__row" key={`${call.signature}-${index}`}>
                <p className="cmd__note">
                  {index + 1}. {call.label}
                </p>
                <pre>{castCommand(call, rpcUrl)}</pre>
              </div>
            ))}
          </div>

          {contractAddress === null ? (
            <div className="walletline">
              <button className="btn" type="button" disabled>
                {flow.action}
              </button>
              <span className="small">
                Sending is switched off: {CONTRACT_NAMES[flow.contract]} is not launched yet.
              </span>
            </div>
          ) : sendBlocked ? (
            <div className="walletline">
              <button className="btn" type="button" disabled>
                {flow.action}
              </button>
              <span className="small spot">Sending is switched off: {sendBlocked}</span>
            </div>
          ) : wallet ? (
            <Suspense fallback={<p className="small">Loading the wallet connection…</p>}>
              <WalletSend calls={plan.calls} rpcUrl={rpcUrl} action={flow.action} />
            </Suspense>
          ) : (
            <div className="walletline">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setNow(Math.floor(Date.now() / 1000));
                  setWallet(true);
                }}
              >
                {flow.action} with a wallet
              </button>
              <span className="small">
                Or run the commands above from a terminal. Nothing is sent until you confirm in your wallet.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
