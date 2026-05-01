import {
  useHostContext,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

interface PodRow {
  name: string;
  phase: string | null;
  ready: boolean;
  nodeName: string | null;
  ip: string | null;
  createdAt: string | null;
  leaseId: string | null;
  environmentId: string | null;
}

interface PvcRow {
  name: string;
  size: string | null;
  storageClass: string | null;
  phase: string | null;
  createdAt: string | null;
  createdByLeaseId: string | null;
  environmentId: string | null;
}

interface EnvironmentInventory {
  environmentId: string;
  pods: PodRow[];
  pvcs: PvcRow[];
}

interface InventoryData {
  namespace: string | null;
  environments: EnvironmentInventory[];
  error?: string | null;
}

export function SettingsPage(_props: PluginSettingsPageProps) {
  const ctx = useHostContext();
  const companyId = ctx.companyId ?? null;
  const { data, loading, error, refresh } = usePluginData<InventoryData>("inventory", {
    companyId: companyId ?? "",
  });

  if (!companyId) {
    return <div style={textStyle}>Select a company to see plugin-owned resources.</div>;
  }
  if (loading && !data) {
    return <div style={textStyle}>Loading inventory…</div>;
  }
  if (error) {
    return <div style={errorStyle}>Failed to load inventory: {error.message}</div>;
  }
  if (!data) return null;

  const totalPods = data.environments.reduce((acc, env) => acc + env.pods.length, 0);
  const totalPvcs = data.environments.reduce((acc, env) => acc + env.pvcs.length, 0);

  return (
    <div style={containerStyle}>
      <div style={metricsRowStyle}>
        <Metric label="Environments" value={String(data.environments.length)} />
        <Metric label="Lease pods" value={String(totalPods)} />
        <Metric label="Persistent volume claims" value={String(totalPvcs)} />
        <Metric label="Namespace" value={data.namespace ?? "—"} mono />
      </div>

      {data.error ? <div style={errorStyle}>Listing error: {data.error}</div> : null}

      {data.environments.length === 0 ? (
        <div style={{ ...textStyle, fontStyle: "italic" }}>
          No plugin-owned resources for this company in {data.namespace ?? "this namespace"}.
        </div>
      ) : (
        data.environments.map((env) => <EnvironmentSection key={env.environmentId} env={env} />)
      )}

      <div>
        <button onClick={refresh} style={buttonStyle}>Refresh</button>
      </div>
    </div>
  );
}

function EnvironmentSection({ env }: { env: EnvironmentInventory }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        border: "1px solid var(--border, rgba(127,127,127,0.3))",
        borderRadius: 8,
        padding: 14,
        background: "var(--card, transparent)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Environment</h3>
        <Mono>{env.environmentId}</Mono>
      </div>

      <div>
        <Subheader>Lease pods ({env.pods.length})</Subheader>
        <Table
          headers={["Name", "Phase", "Ready", "Node", "IP", "Lease ID", "Age"]}
          rows={env.pods.map((p) => [
            <Mono key="n">{p.name}</Mono>,
            <Pill key="p" tone={pillTone(p.phase, "Running")}>{p.phase ?? "Unknown"}</Pill>,
            p.ready ? "Yes" : "No",
            p.nodeName ?? "—",
            <Mono key="ip">{p.ip ?? "—"}</Mono>,
            <Mono key="l">{p.leaseId ?? "—"}</Mono>,
            formatRelative(p.createdAt),
          ])}
          emptyMessage="No lease pods."
        />
      </div>

      <div>
        <Subheader>Persistent volume claims ({env.pvcs.length})</Subheader>
        <Table
          headers={["Name", "Size", "Storage class", "Phase", "Created by lease", "Age"]}
          rows={env.pvcs.map((v) => [
            <Mono key="n">{v.name}</Mono>,
            v.size ?? "—",
            v.storageClass ?? "—",
            <Pill key="p" tone={pillTone(v.phase, "Bound")}>{v.phase ?? "Unknown"}</Pill>,
            <Mono key="l">{v.createdByLeaseId ?? "—"}</Mono>,
            formatRelative(v.createdAt),
          ])}
          emptyMessage="No PVCs."
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives — plain HTML/JSX so the slot bundle stays self-contained.
// The host's CSS variables (--border, --muted-foreground, etc.) flow in
// because the slot is mounted into the host's DOM.
// ---------------------------------------------------------------------------

function Subheader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--muted-foreground, #888)",
        marginBottom: 6,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {children}
    </div>
  );
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        border: "1px solid var(--border, rgba(127,127,127,0.3))",
        borderRadius: 6,
        padding: "10px 12px",
        background: "var(--card, transparent)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--muted-foreground, #888)", marginBottom: 4 }}>{label}</div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 600,
          fontFamily: mono ? "var(--font-mono, ui-monospace, monospace)" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Table({
  headers,
  rows,
  emptyMessage,
}: {
  headers: string[];
  rows: React.ReactNode[][];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ ...textStyle, fontStyle: "italic", padding: "8px 0" }}>{emptyMessage}</div>
    );
  }
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border, rgba(127,127,127,0.3))", borderRadius: 6 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--border, rgba(127,127,127,0.3))",
                  fontWeight: 600,
                  color: "var(--muted-foreground, #888)",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "6px 10px",
                    borderTop: i === 0 ? "none" : "1px solid var(--border, rgba(127,127,127,0.15))",
                    verticalAlign: "top",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5 }}>
      {children}
    </span>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "ok" | "warn" | "error" | "neutral" }) {
  const palette: Record<typeof tone, { bg: string; fg: string }> = {
    ok: { bg: "rgba(34,197,94,0.15)", fg: "rgb(34,197,94)" },
    warn: { bg: "rgba(245,158,11,0.15)", fg: "rgb(245,158,11)" },
    error: { bg: "rgba(239,68,68,0.15)", fg: "rgb(239,68,68)" },
    neutral: { bg: "rgba(127,127,127,0.15)", fg: "rgb(127,127,127)" },
  };
  const colors = palette[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

function pillTone(phase: string | null, okPhase: string): "ok" | "warn" | "error" | "neutral" {
  if (phase === okPhase) return "ok";
  if (phase === "Failed" || phase === "Lost") return "error";
  if (phase === "Pending") return "warn";
  return "neutral";
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

const containerStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 16 };
const metricsRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
};
const textStyle: React.CSSProperties = { padding: 12, fontSize: 13, color: "var(--muted-foreground, #888)" };
const errorStyle: React.CSSProperties = { padding: 12, fontSize: 13, color: "rgb(239,68,68)" };
const buttonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 12px",
  border: "1px solid var(--border, rgba(127,127,127,0.4))",
  borderRadius: 4,
  background: "transparent",
  cursor: "pointer",
};
