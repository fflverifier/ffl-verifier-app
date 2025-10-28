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
  const pickField = (row, names) => {
    for (const n of names) {
      const key = n;
      const candidates = [key, key?.toLowerCase?.(), key?.toUpperCase?.()].filter(Boolean);
      for (const candidate of candidates) {
        const value = row[candidate];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          return { value, key: candidate };
        }
      }
    }
    return { value: "", key: null };
  };

  const firstVal = (row, names) => {
    return pickField(row, names).value;
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

  const META_KEY = "__meta";

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
        const upcPick = pickField(r, ALIAS.upc);
        const manufacturerPick = pickField(r, ALIAS.manufacturer);
        const modelPick = pickField(r, ALIAS.model);
        const typePick = pickField(r, ALIAS.type);
        const caliberPick = pickField(r, ALIAS.caliber);
        const importerPick = pickField(r, ALIAS.importer);
        const countryPick = pickField(r, ALIAS.country);

        const upcRaw = upcPick.value;
        const m = manufacturerPick.value;
        const mo = modelPick.value;
        const t = typePick.value;
        const c = caliberPick.value;
        const im = importerPick.value;
        const co = countryPick.value;

        const d = normDigits(upcRaw);
        const mk = buildAtfKey({ manufacturer: m, model: mo, type: t, caliber: c });

        const baseRow = {
          ...r,
          UPC: upcRaw,
          Manufacturer: m,
          Model: mo,
          Type: t,
          Caliber: c,
          Importer: im,
          Country: co,
        };

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
          return { ...baseRow, Status: "UNKNOWN ❔", __meta: {} };
        }

        // Choose the best candidate by score
        const best = candidates
          .map((cRow) => ({ cRow, score: scoreCandidate(r, cRow) }))
          .sort((a, b) => b.score - a.score)[0]?.cRow;

        if (!best) return { ...baseRow, Status: "UNKNOWN ❔", __meta: {} };

        const meta = {};
        const mismatchedCanonicals = new Set();
        const toStr = (val) => {
          if (val === undefined || val === null) return "";
          return String(val);
        };

        const evaluateField = ({ canonicalKey, pick, expected, comparator }) => {
          const actualStr = toStr(pick.value).trim();
          const expectedStr = toStr(expected).trim();
          const hasActual = actualStr !== "";
          const hasExpected = expectedStr !== "";

          let match = true;
          let reason = "";

          if (!hasActual && !hasExpected) {
            match = true;
          } else if (!hasActual && hasExpected) {
            match = false;
            reason = "Missing value";
          } else if (hasActual && hasExpected) {
            const comparatorFn = comparator || ((a, b) => norm(a) === norm(b));
            match = comparatorFn(actualStr, expectedStr);
            if (!match) {
              reason = `Expected "${expectedStr}"`;
            }
          } else if (hasActual && !hasExpected) {
            match = true; // Nothing reliable to compare against
          }

          if (!match) {
            const keysToMark = new Set();
            if (canonicalKey) keysToMark.add(canonicalKey);
            if (pick.key && pick.key !== canonicalKey) keysToMark.add(pick.key);
            if (keysToMark.size === 0) keysToMark.add(canonicalKey || pick.key || "Field");

            mismatchedCanonicals.add(canonicalKey || pick.key || "Field");
            keysToMark.forEach((key) => {
              meta[key] = {
                state: "mismatch",
                expected: expectedStr,
                actual: actualStr,
                reason: reason || "Mismatch",
              };
            });
          }
        };

        if (d) {
          evaluateField({
            canonicalKey: "UPC",
            pick: upcPick,
            expected: best.upc,
            comparator: (a, b) => normDigits(a) === normDigits(b),
          });
        }

        [
          { canonicalKey: "Manufacturer", pick: manufacturerPick, expected: best.manufacturer },
          { canonicalKey: "Model", pick: modelPick, expected: best.model },
          { canonicalKey: "Type", pick: typePick, expected: best.type },
          { canonicalKey: "Caliber", pick: caliberPick, expected: best.caliber },
          { canonicalKey: "Importer", pick: importerPick, expected: best.importer },
          { canonicalKey: "Country", pick: countryPick, expected: best.country },
        ].forEach((config) => evaluateField(config));

        const mismatchSummary = Array.from(mismatchedCanonicals);
        const status =
          mismatchSummary.length === 0
            ? (d ? "VERIFIED ✅ (UPC & ATF match)" : "VERIFIED ✅ (ATF match)")
            : `NOT VERIFIED ⚠️ (${mismatchSummary.join(", ")})`;

        return {
          ...baseRow,
          Status: status,
          __meta: meta,
        };
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
    const headers = Object.keys(results[0]).filter((h) => h !== META_KEY);
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

  const tableHeaders = results.length ? Object.keys(results[0]).filter((k) => k !== META_KEY) : [];

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
                {tableHeaders.map((k) => (
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
                const rowMeta = r[META_KEY] || {};
                return (
                  <tr key={i} style={{ background: bg }}>
                    {tableHeaders.map((header) => {
                      const cellMeta = rowMeta[header];
                      const isMismatch = cellMeta?.state === "mismatch";
                      const tooltipParts = [];
                      if (cellMeta?.reason) tooltipParts.push(cellMeta.reason);
                      if (cellMeta?.expected) tooltipParts.push(`Expected: ${cellMeta.expected}`);
                      const title = tooltipParts.length > 0 ? tooltipParts.join(" • ") : undefined;
                      const cellStyle = isMismatch
                        ? {
                            background: "#ffebee",
                            fontWeight: 600,
                            border: "1px solid #ef9a9a",
                          }
                        : undefined;
                      return (
                        <td key={header} style={cellStyle} title={title}>
                          {String(r[header] ?? "")}
                        </td>
                      );
                    })}
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
