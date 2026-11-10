import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { store, actions, toast } from "../lib/store";
import type { BrokerInfo, PublicSettings } from "../lib/types";

type SettingsData = Awaited<ReturnType<typeof api.settings>>;

export function SettingsModal() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [selected, setSelected] = useState<string>("");
  const close = () => store.set({ settingsOpen: false });

  const load = () => api.settings().then((d) => { setData(d); setSelected((s) => s || d.active); });
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!data) return null;
  const info = data.brokers.find((b) => b.id === selected)!;

  const activate = async () => {
    try {
      await api.updateSettings({ broker: selected });
      toast(`Switched to ${info.name}`, "ok");
      await actions.bootstrap();
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const setLive = async (on: boolean) => {
    if (on && !confirm("Enable live trading? Orders on a real broker will move real money.")) return;
    const r = await api.updateSettings({ liveTradingEnabled: on });
    setData({ ...data, settings: r.settings as PublicSettings });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings">
        <div className="ticket-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">✕</button>
        </div>

        <section>
          <h3>Broker</h3>
          <div className="broker-list">
            {data.brokers.map((b) => (
              <button key={b.id} className={`broker-opt ${selected === b.id ? "on" : ""}`} onClick={() => setSelected(b.id)}>
                <b>{b.name}</b>
                <span className="small muted">
                  {b.id === data.active ? "● active" : b.implemented ? "available" : "adapter scaffold"}
                  {b.live ? " · real money" : " · simulated"}
                </span>
              </button>
            ))}
          </div>

          {info.fields.length > 0 && <CredentialsForm info={info} setFields={data.credentials[info.id] ?? []} onSaved={load} />}

          {!info.implemented && (
            <p className="note">
              The {info.name} adapter is scaffolded: credentials are stored locally, but the API calls still need to be implemented in
              <code> server/src/brokers/live.ts</code>. See <code>docs/BROKERS.md</code>.
            </p>
          )}

          <button className="btn primary" disabled={selected === data.active} onClick={() => void activate()}>
            {selected === data.active ? "Active" : `Use ${info.name}`}
          </button>
        </section>

        <section>
          <h3>Safety</h3>
          <label className="toggle">
            <input type="checkbox" checked={data.settings.liveTradingEnabled} onChange={(e) => void setLive(e.target.checked)} />
            Allow orders on real-money brokers
          </label>
          <p className="small muted">When off, the server rejects every order sent to a live broker. Paper trading is unaffected.</p>
        </section>

        {data.active === "paper" && <PaperReset startingCash={data.settings.paper.startingCash} />}

        <section>
          <h3>Market data</h3>
          <p className="small muted">
            Provider: <b>{data.settings.marketData.provider}</b> · tick {data.settings.marketData.tickMs} ms · UI batch {data.settings.marketData.flushMs} ms.
            Change it in <code>config/settings.local.json</code>.
          </p>
        </section>
      </div>
    </div>
  );
}

function CredentialsForm({ info, setFields, onSaved }: { info: BrokerInfo; setFields: string[]; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [info.id]);

  const save = async () => {
    const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    if (!Object.keys(fields).length) return;
    try {
      await api.saveCredentials(info.id, fields);
      setValues({});
      toast("Credentials saved to config/credentials.local.json", "ok");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  return (
    <form className="creds" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {info.fields.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}{f.required ? " *" : ""} {setFields.includes(f.key) && <em className="set">saved</em>}</span>
          <input
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            placeholder={setFields.includes(f.key) ? "•••••• (leave blank to keep)" : ""}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
          {f.help && <small className="muted">{f.help}</small>}
        </label>
      ))}
      <button className="btn" type="submit">Save credentials</button>
      <p className="small muted">Stored only on this machine (file mode 600, git-ignored). Values are never sent back to the browser.</p>
    </form>
  );
}

function PaperReset({ startingCash }: { startingCash: number }) {
  const [cash, setCash] = useState(String(startingCash));
  const reset = async () => {
    if (!confirm("Reset the paper account? Positions, orders and P&L history will be cleared.")) return;
    try {
      await api.resetPaper(Number(cash));
      await actions.refreshTrading();
      toast("Paper account reset", "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <section>
      <h3>Paper account</h3>
      <div className="row">
        <input type="number" min="1" value={cash} onChange={(e) => setCash(e.target.value)} />
        <button className="btn danger" onClick={() => void reset()}>Reset paper account</button>
      </div>
    </section>
  );
}
