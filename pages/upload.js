import { useState } from "react";
import Papa from "papaparse";
import { supabase } from "../lib/supabaseClient";

export default function UploadPage() {
  // ---------- state ----------
  const [rows, setRows] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // ---------- helpers ----------
  const norm = (s) => (s || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");

  // ---------- file parse ----------
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => setRows(res.data),
      error: (err) => setError(err.message),
    });
  };

  // ---------- verify against Supabase catalog ----------
  const verifyData = async () => {
    setLoading(true);
    setError("");
    try {
      const { data: catalog, error: catErr } = await supabase.from("catalog").select("*");
      if (catErr) throw catErr;
      if (!catalog) throw new Error("No catalog data found.");

      const checked = rows.map((r) => {
        const upc = norm(r.UPC ?? r.upc);
        const key = norm(
          (r.Manufacturer ?? r.manufacturer ?? "") +
            (r.Model ?? r.model ?? "") +
            (r.Type ?? r.type ?? "") +
            (r.Caliber ?? r.caliber ?? "")
        );

        // UPC-first match, else ATF combined key
        let match = null;
        if (upc) {
          match = catalog.find((c) => norm(c.upc) === upc);
        } else {
          match = catalog.find(
            (c) =>
              norm((c.manufacturer ?? "") + (c.model ?? "") + (c.type ?? "") + (c.caliber ?? "")) === key
          );
        }

        if (!match) {
          return { ...r, Status: "UNKNOWN ❔" };
        }

        // Compare fields (Importer/Country = compare-if-both-present)
        const coreFields = ["manufacturer", "model", "type", "caliber"];
        const optFields = ["importer", "country"];

        const mismatchCore = coreFields.filter(
          (f) => norm(r[f] ?? r[f?.toUpperCase?.()] ?? "") !== norm(match[f] ?? "")
        );
        const mismatchOpt = optFields.filter((f) => {
          const uploadVal = norm(r[f] ?? r[f?.toUpperCase?.()] ?? "");
          const catalogVal = norm(match[f] ?? "");
          return uploadVal && catalogVal && uploadVal !== catalogVal;
        });

        const mismatches = [...mismatchCore, ...mismatchOpt];

        if (mismatches.length > 0) {
          return { ...r, Status: "NOT VERIFIED ⚠️" };
        }

        return { ...r, Status: "VERIFIED ✅" };
      });

      setResults(checked);
    } catch (e) {
      setError(e.message || "Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  // ---------- download CSV helper ----------
  const downloadCSV = () => {
    if (results.length === 0) return;
    const headers = Object.keys(results[0]);
    const rowsCsv = results.map((r) =>
      headers.map((h) => JSON.stringify(r[h] ?? "")).join(",")
    );
    const csvContent = [headers.join(","), ...rowsCsv].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ffl-verifier-results.csv";
    link.click();
  };

  // ---------- UI ----------
  return (
    <main style={{ fontFamily: "sans-serif", padding: "40px" }}>
      <h1>FFL Verifier — Upload Tool</h1>

      <input type="file" accept=".csv" onChange={handleFile} />
      <button
        onClick={verifyData}
        disabled={rows.length === 0 || loading}
        style={{ marginLeft: 10, padding: "6px 12px", cursor: "pointer" }}
      >
        {loading ? "Verifying..." : "Run Verification"}
      </button>

      {error && <p style={{ color: "red", marginTop: 12 }}>{error}</p>}

      {results.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h3>Results ({results.length} rows)</h3>

          {/* Legend */}
          <div style={{ marginTop: 10, marginBottom: 10, display: "flex", gap: 16, fontSize: 14 }}>
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  background: "#e8f5e9",
                  border: "1px solid #c8e6c9",
                  marginRight: 6,
                }}
              />
              VERIFIED
            </span>
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  background: "#fff8e1",
                  border: "1px solid #ffe082",
                  marginRight: 6,
                }}
              />
              NOT VERIFIED
            </span>
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  background: "#eeeeee",
                  border: "1px solid #cccccc",
                  marginRight: 6,
                }}
              />
              UNKNOWN
            </span>
          </div>

          {/* Download button */}
          <button
            onClick={downloadCSV}
            style={{ marginBottom: 10, padding: "6px 12px", cursor: "pointer" }}
          >
            ⬇️ Download Results CSV
          </button>

          {/* Table */}
          <table border="1" cellPadding="6" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {Object.keys(results[0]).map((k) => (
                  <th key={k} style={{ textAlign: "left" }}>
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const statusText = String(r.Status || "");
                const bg =
                  statusText.includes("VERIFIED")
                    ? "#e8f5e9"
                    : statusText.includes("NOT VERIFIED")
                    ? "#fff8e1"
                    : "#eeeeee";
                return (
                  <tr key={i} style={{ background: bg }}>
                    {Object.values(r).map((v, j) => (
                      <td key={j}>{String(v ?? "")}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
