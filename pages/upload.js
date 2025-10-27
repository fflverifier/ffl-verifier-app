import { useState } from "react";
import Papa from "papaparse";
import { supabase } from "../lib/supabaseClient";

export default function UploadPage() {
  // ---------- state ----------
  const [rows, setRows] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [debugInfo, setDebugInfo] = useState(null);

  // ---------- helpers ----------
  const norm = (s) => (s || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normDigits = (s) => (s || "").toString().replace(/\D/g, ""); // digits only for UPC/EAN

  // Pull the first non-empty value from possible header aliases
  const firstVal = (row, names) => {
    for (const n of names) {
      const v =
        row[n] ??
        row[n?.toLowerCase?.()] ??
        row[n?.toUpperCase?.()];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return "";
  };

  // Accepted header aliases
  const ALIAS = {
    upc: ["UPC", "upc", "Upc", "EAN", "ean", "Barcode", "barcode"],
    manufacturer: ["Manufacturer", "manufacturer", "MFR", "mfr", "Brand", "brand", "Maker", "maker"],
    importer: ["Importer", "importer"],
    country: ["Country of Manufacture", "country", "Country", "CountryOfManufacture"],
    model: ["Model", "model"],
    type: ["Type", "type", "Category", "category"],
    caliber: ["Caliber", "caliber", "Cal", "cal"]
  };

  // ---------- file parse ----------
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      // IMPORTANT: trim header names to avoid "UPC " vs "UPC"
      transformHeader: (h) => h.trim(),
      complete: (res) => setRows(res.data),
      error: (err) => setError(err.message),
    });
  };

  // ---------- verify against Supabase catalog (UPC-first, fallback to ATF) ----------
  const verifyData = async () => {
    setLoading(true);
    setError("");
    setDebugInfo(null);
    try {
      const { data: catalog, error: catErr } = await supabase.from("catalog").select("*");
      if (catErr) throw catErr;
      if (!catalog || catalog.length === 0) throw new Error("Catalog is empty or not readable (check RLS / project keys).");

      const checked = rows.map((r) => {
        // Gather upload values (with aliases handled)
        const upcRaw = firstVal(r, ALIAS.upc);
        const upcDigits = normDigits(upcRaw);
        const upcStrict = upcDigits.replace(/^0+/, ""); // strip leading zeros for comparison

        const m = firstVal(r, ALIAS.manufacturer);
        const mo = firstVal(r, ALIAS.model);
        const t = firstVal(r, ALIAS.type);
        const c = firstVal(r, ALIAS.caliber);

        const key = norm(`${m}${mo}${t}${c}`);

        // 1) Try UPC match (robust)
        let match = null;
        if (upcDigits) {
          match = catalog.find((cRow) => {
            const dbUPCStr = String(cRow.upc ?? "").trim();
            const dbDigits = normDigits(dbUPCStr);
            const dbStrict = dbDigits.replace(/^0+/, "");
            return dbDigits === upcDigits || dbStrict === upcStrict;
          });
        }

        // 2) Fallback to ATF combined key if no UPC match
        if (!match) {
          match = catalog.find(
            (cRow) =>
              norm(`${cRow.manufacturer || ""}${cRow.model || ""}${cRow.type || ""}${cRow.caliber || ""}`) === key
          );
        }

        if (!match) return { ...r, Status: "UNKNOWN ❔" };

        // Compare fields ONLY when both upload and catalog values exist
        const cmpPairs = [
          ["manufacturer", m],
          ["model", mo],
          ["type", t],
          ["caliber", c],
          ["importer", firstVal(r, ALIAS.importer)],
          ["country", firstVal(r, ALIAS.country)],
        ];

        const mismatches = cmpPairs.filter(([field, uploadVal]) => {
          const u = norm(uploadVal);
          const v = norm(match[field] || "");
          return u && v && u !== v; // mismatch only if both sides present and differ
        });

        if (mismatches.length > 0) return { ...r, Status: "NOT VERIFIED ⚠️" };
        return { ...r, Status: "VERIFIED ✅" };
      });

      setResults(checked);

      // --------- Build debug info panel ---------
      const uploadUPCs = rows
        .map((r) => {
          const raw = firstVal(r, ALIAS.upc);
          const digits = normDigits(raw);
          const strict = digits.replace(/^0+/, "");
          return { raw, digits, strict };
        })
        .filter((x) => x.raw !== "" || x.digits !== "");

      const catalogUPCs = (catalog || []).slice(0, 50).map((c) => {
        const raw = c.upc ?? "";
        const digits = normDigits(raw);
        const strict = digits.replace(/^0+/, "");
        return { raw, digits, strict };
      });

      const unknownWithUPC = checked.filter(
        (r) => String(r.Status).includes("UNKNOWN") && normDigits(firstVal(r, ALIAS.upc)) !== ""
      );

      setDebugInfo({
        uploadPreview: uploadUPCs.slice(0, 10),
        catalogPreview: catalogUPCs.slice(0, 10),
        unknownUPCCount: unknownWithUPC.length,
        unknownUPCSamples: unknownWithUPC.slice(0, 5).map((r) => ({
          upc: firstVal(r, ALIAS.upc),
          manufacturer: firstVal(r, ALIAS.manufacturer),
          model: firstVal(r, ALIAS.model),
          type: firstVal(r, ALIAS.type),
          caliber: firstVal(r, ALIAS.caliber),
        })),
      });
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

  // ---------- summary counts ----------
  const stats = (() => {
    const total = results.length;
    if (!total) return { total: 0, verified: 0, notVerified: 0, unknown: 0, pv: 0, pnv: 0, pu: 0 };
    const verified = results.filter((r) => String(r.Status).includes("VERIFIED ✅")).length;
    const notVerified = results.filter((r) => String(r.Status).includes("NOT VERIFIED")).length;
    const unknown = results.filter((r) => String(r.Status).includes("UNKNOWN")).length;
    const pct = (n) => Math.round((n / total) * 100);
    return { total, verified, notVerified, unknown, pv: pct(verified), pnv: pct(notVerified), pu: pct(unknown) };
  })();

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

          {/* Summary bar */}
          <div
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              margin: "8px 0 14px 0",
              fontSize: 14,
            }}
          >
            <span style={{ padding: "6px 10px", background: "#e8f5e9", border: "1px solid #c8e6c9", borderRadius: 6 }}>
              VERIFIED: <strong>{stats.verified}</strong> ({stats.pv}%)
            </span>
            <span style={{ padding: "6px 10px", background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 6 }}>
              NOT VERIFIED: <strong>{stats.notVerified}</strong> ({stats.pnv}%)
            </span>
            <span style={{ padding: "6px 10px", background: "#eeeeee", border: "1px solid #cccccc", borderRadius: 6 }}>
              UNKNOWN: <strong>{stats.unknown}</strong> ({stats.pu}%)
            </span>
            <span style={{ padding: "6px 10px", border: "1px dashed #bbb", borderRadius: 6 }}>
              TOTAL: <strong>{stats.total}</strong>
            </span>
          </div>

          {/* Legend */}
          <div style={{ marginTop: 6, marginBottom: 10, display: "flex", gap: 16, fontSize: 14 }}>
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

          {/* Debug panel */}
          {debugInfo && (
            <details style={{ marginTop: 20 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Debug</summary>
              <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 10 }}>
                <div>Unknown rows with a UPC: <strong>{debugInfo.unknownUPCCount}</strong></div>
                <div style={{ marginTop: 8 }}>
                  <div>Uploaded UPCs (first 10):</div>
                  <pre>{JSON.stringify(debugInfo.uploadPreview, null, 2)}</pre>
                </div>
                <div style={{ marginTop: 8 }}>
                  <div>Catalog UPCs (first 10):</div>
                  <pre>{JSON.stringify(debugInfo.catalogPreview, null, 2)}</pre>
                </div>
                {debugInfo.unknownUPCSamples?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div>Sample UNKNOWN rows with UPC:</div>
                    <pre>{JSON.stringify(debugInfo.unknownUPCSamples, null, 2)}</pre>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </main>
  );
}
