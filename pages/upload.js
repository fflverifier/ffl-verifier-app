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
  const normDigits = (s) => (s || "").toString().replace(/\D/g, ""); // digits only
  const strip0 = (s) => (s || "").replace(/^0+/, "");

  // Pull the first non-empty value from possible header aliases
  const firstVal = (row, names) => {
    for (const n of names) {
      const v = row[n] ?? row[n?.toLowerCase?.()] ?? row[n?.toUpperCase?.()];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return "";
  };

  // Accepted header aliases (canonical names listed first)
  const ALIAS = {
    upc: ["UPC", "upc", "Upc", "EAN", "ean", "Barcode", "barcode"],

    // ATF core fields
    manufacturer: ["Manufacturer", "manufacturer", "MFR", "mfr", "Brand", "brand", "Maker", "maker"],
    model: ["Model", "model"],
    type: ["Type", "type", "Category", "category"],
    caliber: ["Caliber", "caliber", "Cal", "cal"],

    // ATF optional fields
    importer: ["Importer", "importer"],
    country: ["Country of Manufacture", "Country", "country", "CountryOfManufacture"],
  };

  const buildAtfKey = (obj) =>
    norm(`${obj.manufacturer || ""}${obj.model || ""}${obj.type || ""}${obj.caliber || ""}`);

  // ---------- file parse ----------
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(), // avoid "UPC " vs "UPC"
      complete: (res) => setRows(res.data),
      error: (err) => setError(err.message),
    });
  };

  // ---------- verify (UPC-first; if no UPC then ATF fields only) ----------
  const verifyData = async () => {
    setLoading(true);
    setError("");
    setDebugInfo(null);

    try {
      // Collect UPCs to fetch; detect if any rows lack UPC (to enable ATF-only path)
      const upcKeys = new Set();
      let needAtfOnly = false;
      const previewUploadUPCs = [];

      for (const r of rows) {
        const raw = firstVal(r, ALIAS.upc);
        const d = normDigits(raw);
        if (d) {
          upcKeys.add(d);
          if (previewUploadUPCs.length < 10) {
            previewUploadUPCs.push({ raw, digits: d, strict: strip0(d) });
          }
        } else {
          needAtfOnly = true;
        }
      }

      // ---- 1) Fetch only UPCs we need (fast path)
      let { data: catalogUpc, error: upcErr } = await supabase
        .from("catalog")
        .select("id, upc, manufacturer, model, type, caliber, importer, country")
        .in("upc", Array.from(upcKeys));

      if (upcErr) throw upcErr;
      catalogUpc ||= [];

      // Build maps from UPC subset
      const upcMap = new Map(); // UPC digits -> array of catalog rows (handle duplicates)
      const matchKeyMap = new Map(); // ATF core key -> array (will be extended if we fetch full catalog)

      const previewCatalogUPCs = [];
      for (const cRow of catalogUpc) {
        const d = normDigits(cRow?.upc ?? "");
        if (!d) continue;

        if (!upcMap.has(d)) upcMap.set(d, []);
        upcMap.get(d).push(cRow);

        const mk = buildAtfKey(cRow);
        if (!matchKeyMap.has(mk)) matchKeyMap.set(mk, []);
        matchKeyMap.get(mk).push(cRow);

        if (previewCatalogUPCs.length < 10) {
          previewCatalogUPCs.push({ raw: cRow.upc ?? "", digits: d, strict: strip0(d) });
        }
      }

      // ---- 2) If any upload rows *lack UPC*, fetch minimal full catalog once to support ATF-only fallback
      if (needAtfOnly) {
        const { data: catalogAll, error: allErr } = await supabase
          .from("catalog")
          .select("id, upc, manufacturer, model, type, caliber, importer, country");
        if (allErr) throw allErr;

        for (const cRow of catalogAll || []) {
          const mk = buildAtfKey(cRow);
          if (!matchKeyMap.has(mk)) matchKeyMap.set(mk, []);
          matchKeyMap.get(mk).push(cRow);
        }
      }

      // ---------- scoring to pick best candidate when duplicates exist ----------
      const scoreCandidate = (uploadRow, c) => {
        let s = 0;

        // Core ATF fields weigh more
        const uMf = norm(firstVal(uploadRow, ALIAS.manufacturer));
        const uMo = norm(firstVal(uploadRow, ALIAS.model));
        const uTy = norm(firstVal(uploadRow, ALIAS.type));
        const uCa = norm(firstVal(uploadRow, ALIAS.caliber));
        if (uMf && uMf === norm(c.manufacturer)) s += 3;
        if (uMo && uMo === norm(c.model))        s += 3;
        if (uTy && uTy === norm(c.type))         s += 2;
        if (uCa && uCa === norm(c.caliber))      s += 2;

        // Optional ATF fields (only if both present)
        const uIm = norm(firstVal(uploadRow, ALIAS.importer));
        const uCo = norm(firstVal(uploadRow, ALIAS.country));
        if (uIm && uIm === norm(c.importer)) s += 1;
        if (uCo && uCo === norm(c.country))  s += 1;

        return s;
      };

      // ---------- verify each upload row ----------
      const checked = rows.map((r) => {
        const upcRaw = firstVal(r, ALIAS.upc);
        const d = normDigits(upcRaw);

        const m  = firstVal(r, ALIAS.manufacturer);
        const mo = firstVal(r, ALIAS.model);
        const t  = firstVal(r, ALIAS.type);
        const c  = firstVal(r, ALIAS.caliber);
        const im = firstVal(r, ALIAS.importer);
        const co = firstVal(r, ALIAS.country);

        const mk = buildAtfKey({ manufacturer: m, model: mo, type: t, caliber: c });

        // A) UPC-first if provided
        let candidates = [];
        if (d && upcMap.has(d)) {
          candidates = upcMap.get(d);
        }

        // B) If no UPC or no UPC match, fall back to ATF fields only (core fields)
        if ((!d || candidates.length === 0) && mk && matchKeyMap.has(mk)) {
          candidates = matchKeyMap.get(mk);
        }

        if (!candidates || candidates.length === 0) {
          return { ...r, Status: "UNKNOWN ❔" };
        }

        // Choose the best candidate by score
        const best = candidates
          .map((cRow) => ({ cRow, score: scoreCandidate(r, cRow) }))
          .sort((a, b) => b.score - a.score)[0]?.cRow;

        if (!best) return { ...r, Status: "UNKNOWN ❔" };

        // Comparison rules:
        // - Core ATF fields must match when both sides have values
        // - Optional ATF fields only compared if both have values
        const cmp = (u, v) => {
          const nu = norm(u);
          const nv = norm(v);
          return !nu || !nv || nu === nv; // missing = non-conflicting
        };

        const coreOk =
          cmp(m,  best.manufacturer) &&
          cmp(mo, best.model) &&
          cmp(t,  best.type) &&
          cmp(c,  best.caliber);

        const optionalOk =
          (!im || !best.importer || cmp(im, best.importer)) &&
          (!co || !best.country  || cmp(co, best.country));

        if (coreOk && optionalOk) {
          return { ...r, Status: "VERIFIED ✅" };
        }

        return { ...r, Status: "NOT VERIFIED ⚠️" };
      });

      setResults(checked);

      // ---------- debug info ----------
      const unknownWithUPC = checked.filter(
        (r) => String(r.Status).includes("UNKNOWN") && normDigits(firstVal(r, ALIAS.upc)) !== ""
      );

      let duplicateHitCount = 0;
      for (const k of upcMap.keys()) {
        if (upcMap.get(k)?.length > 1) duplicateHitCount++;
      }

      setDebugInfo({
        uploadPreview: previewUploadUPCs,
        catalogPreview: (catalogUpc || []).slice(0, 10).map((c) => ({
          raw: c.upc ?? "",
          digits: normDigits(c.upc ?? ""),
          strict: strip0(normDigits(c.upc ?? "")),
        })),
        unknownUPCCount: unknownWithUPC.length,
        duplicateCatalogUpcKeys: duplicateHitCount,
        atfOnlyRows: rows.filter((r) => !normDigits(firstVal(r, ALIAS.upc))).length,
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
    const rowsCsv = results.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(","));
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
          <button onClick={downloadCSV} style={{ marginBottom: 10, padding: "6px 12px", cursor: "pointer" }}>
            ⬇️ Download Results CSV
          </button>

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
                <div>Catalog UPC keys with duplicates: <strong>{debugInfo.duplicateCatalogUpcKeys}</strong></div>
                <div>Rows verified by ATF-only (no UPC): <strong>{debugInfo.atfOnlyRows}</strong></div>
                <div style={{ marginTop: 8 }}>
                  <div>Uploaded UPCs (first 10):</div>
                  <pre>{JSON.stringify(debugInfo.uploadPreview, null, 2)}</pre>
                </div>
                <div style={{ marginTop: 8 }}>
                  <div>Catalog UPCs (first 10):</div>
                  <pre>{JSON.stringify(debugInfo.catalogPreview, null, 2)}</pre>
                </div>
              </div>
            </details>
          )}
        </div>
      )}
    </main>
  );
}
