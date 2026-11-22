import "./dashboard.css";

// Scoreboard-shaped skeleton (spec 6.14, state_loading_*.png): same grid and
// heights as the real page so nothing shifts when data lands. Shimmer is the
// global .skel (static under prefers-reduced-motion). The generic
// (app)/loading.tsx still covers every other route.
function Sk({ w, h, className = "", style }: { w: string; h: string; className?: string; style?: React.CSSProperties }) {
  return <i className={`skel block ${className}`} style={{ width: w, height: h, ...style }} />;
}

const PAPER_SK = { background: "#d9c9a0" } as const;

export default function DashboardLoading() {
  return (
    <main className="sb-page" aria-busy="true">
      <p role="status" className="sr-only">Loading your scoreboard…</p>
      <div aria-hidden="true" style={{ display: "contents" }}>
        <section className="board sb-board hero sb-hero">
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div className="sb-bl"><span>Net profit</span><Sk w="84px" h="10px" /></div>
            <div style={{ margin: "16px 0 14px" }}><Sk w="min(100%,420px)" h="104px" style={{ borderRadius: 6 }} /></div>
            <div className="sb-chips"><Sk w="110px" h="24px" /><Sk w="190px" h="24px" /><Sk w="140px" h="24px" /></div>
            <div style={{ display: "grid", gap: 7, marginTop: 14 }}><Sk w="96%" h="10px" /><Sk w="78%" h="10px" /></div>
            <div className="sb-heroSpark" style={{ display: "flex", alignItems: "end" }}><Sk w="100%" h="70px" style={{ opacity: 0.6 }} /></div>
          </div>
          <div>
            <div className="sb-bl"><span>Line score</span><Sk w="180px" h="26px" /></div>
            <div style={{ display: "grid", gridTemplateColumns: "62px repeat(5,minmax(0,1fr))", gap: 6, marginTop: 14, alignItems: "center" }}>
              {Array.from({ length: 4 }).map((_, r) => [
                <Sk key={`l${r}`} w="46px" h="10px" />,
                ...Array.from({ length: 5 }).map((__, c) => <Sk key={`${r}-${c}`} w="100%" h="46px" />),
              ])}
            </div>
            <div style={{ display: "flex", alignItems: "end", gap: 34, height: 150, marginTop: 18, padding: "0 30px" }}>
              {[40, 56, 90, 110].map((h) => <Sk key={h} w="100%" h={`${h}px`} style={{ flex: 1 }} />)}
            </div>
          </div>
        </section>
        <div className="sb-grid2">
          <section className="board sb-board">
            <div className="sb-bl"><span>Score progression · cumulative P&amp;L</span></div>
            <Sk w="100%" h="300px" className="sb-cum" style={{ marginTop: 12 }} />
          </section>
          <section className="sb-back">
            <div className="sb-bl"><span>Back of the card · flip of the month</span></div>
            <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
              <Sk w="96px" h="134px" style={PAPER_SK} />
              <div style={{ flex: 1, display: "grid", gap: 10, alignContent: "center" }}>
                <Sk w="90%" h="26px" style={PAPER_SK} /><Sk w="50%" h="38px" style={PAPER_SK} /><Sk w="70%" h="10px" style={PAPER_SK} />
              </div>
            </div>
            {Array.from({ length: 4 }).map((_, i) => <Sk key={i} w="100%" h="22px" style={{ marginTop: 12, background: "#e3d5ae" }} />)}
          </section>
        </div>
        <section className="sb-kp">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="board sb-board">
              <Sk w="120px" h="10px" /><Sk w="70%" h="44px" style={{ margin: "14px 0 10px" }} /><Sk w="50%" h="10px" /><Sk w="100%" h="40px" style={{ marginTop: 12 }} />
            </div>
          ))}
        </section>
        <section className="sb-row3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="board sb-board">
              <Sk w="110px" h="10px" /><Sk w="80%" h="56px" style={{ margin: "14px 0" }} /><Sk w="60%" h="10px" />
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
