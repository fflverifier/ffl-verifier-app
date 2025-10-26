{results.length > 0 && (
  <div style={{ marginTop: "20px" }}>
    <h3>Results ({results.length} rows)</h3>

    {/* Legend */}
    <div style={{ marginTop: 10, marginBottom: 10, display: "flex", gap: 16, fontSize: 14 }}>
      <span>
        <span style={{ display: "inline-block", width: 12, height: 12, background: "#e8f5e9", border: "1px solid #c8e6c9", marginRight: 6 }} />
        VERIFIED
      </span>
      <span>
        <span style={{ display: "inline-block", width: 12, height: 12, background: "#fff8e1", border: "1px solid #ffe082", marginRight: 6 }} />
        NOT VERIFIED
      </span>
      <span>
        <span style={{ display: "inline-block", width: 12, height: 12, background: "#eeeeee", border: "1px solid #cccccc", marginRight: 6 }} />
        UNKNOWN
      </span>
    </div>

    {/* Table */}
    <table border="1" cellPadding="6" style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          {Object.keys(results[0]).map((k) => (
            <th key={k} style={{ textAlign: "left" }}>{k}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => {
          const statusText = (r.Status || "").toString();
          const bg =
            statusText.includes("VERIFIED") ? "#e8f5e9" :
            statusText.includes("NOT VERIFIED") ? "#fff8e1" :
            "#eeeeee";
          return (
            <tr key={i} style={{ background: bg }}>
              {Object.values(r).map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
)}
