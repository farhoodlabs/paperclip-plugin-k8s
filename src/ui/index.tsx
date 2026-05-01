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
  companyId: string | null;
}

interface PvcRow {
  name: string;
  size: string | null;
  storageClass: string | null;
  phase: string | null;
  createdAt: string | null;
  createdByLeaseId: string | null;
  companyId: string | null;
}

interface InventoryData {
  namespace: string | null;
  pods: PodRow[];
  pvcs: PvcRow[];
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

  return (
    <div style={containerStyle}>
      <div style={metricsRowStyle}>
        <Metric label="Lease pods" value={String(data.pods.length)} />
        <Metric label="Persistent volume claims" value={String(data.pvcs.length)} />
        <Metric label="Namespace" value={data.namespace ?? "—"} mono />
      </div>

      {data.error ? <div style={errorStyle}>Listing error: {data.error}</div> : null}

      <Section title="Lease pods">
        <Table
          headers={["Name", "Phase", "Ready", "Node", "IP", "Lease ID", "Company", "Age"]}
          rows={data.pods.map((p) => [
            <Mono key="n">{p.name}</Mono>,
            <Pill key="p" tone={pillTone(p.phase, "Running")}>{p.phase ?? "Unknown"}</Pill>,
            p.ready ? "Yes" : "No",
            p.nodeName ?? "—",
            <Mono key="ip">{p.ip ?? "—"}</Mono>,
            <Mono key="l">{p.leaseId ?? "—"}</Mono>,
            <Mono key="c">{p.companyId ? p.companyId.slice(0, 8) : "—"}</Mono>,
            formatRelative(p.createdAt),
          ])}
          emptyMessage="No plugin-owned lease pods in this namespace."
        />
      </Section>

      <Section title="Persistent volume claims">
        <Table
          headers={["Name", "Size", "Storage class", "Phase", "Created by lease", "Company", "Age"]}
          rows={data.pvcs.map((v) => [
            <Mono key="n">{v.name}</Mono>,
            v.size ?? "—",
            v.storageClass ?? "—",
            <Pill key="p" tone={pillTone(v.phase, "Bound")}>{v.phase ?? "Unknown"}</Pill>,
            <Mono key="l">{v.createdByLeaseId ?? "—"}</Mono>,
            <Mono key="c">{v.companyId ? v.companyId.slice(0, 8) : "—"}</Mono>,
            formatRelative(v.createdAt),
          ])}
          emptyMessage="No plugin-owned PVCs in this namespace."
        />
      </Section>

      <div>
        <button onClick={refresh} style={buttonStyle}>Refresh</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives — plain HTML/JSX so the slot bundle stays self-contained.
// The host's CSS variables (--border, --muted-foreground, etc.) flow in
// because the slot is mounted into the host's DOM.
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h3>
      {children}
    </section>
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
      <div style={{ ...textStyle, fontStyle: "italic" }}>{emptyMessage}</div>
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
