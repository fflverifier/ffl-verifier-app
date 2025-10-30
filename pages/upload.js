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
  const [activeStatusFilters, setActiveStatusFilters] = useState(["VERIFIED", "NOT VERIFIED", "UNKNOWN"]);

  // ---------- helpers ----------
  const norm = (s) => (s || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normDigits = (s) => (s || "").toString().replace(/\D/g, ""); // digits only
  const strip0 = (s) => (s || "").replace(/^0+/, "");

  const normModel = (s) => {
    const base = norm(s);
    if (!base) return "";
    return base.replace(/^(MODEL|MOD|MDL)/, "");
  };

  const normManufacturer = (s) => {
    let base = norm(s);
    if (!base) return "";
    let trimmed = base;
    const suffixes = ["LLC", "INC", "LTD", "CORP", "CORPORATION", "LLP", "PLC", "LP"];
    let updated = true;
    while (updated) {
      updated = false;
      for (const suffix of suffixes) {
        if (trimmed.endsWith(suffix) && trimmed.length > suffix.length + 2) {
          trimmed = trimmed.slice(0, -suffix.length);
          updated = true;
          break;
        }
      }
    }
    return trimmed;
  };

  const normType = (s) => {
    const base = norm(s);
    if (!base) return "";
    return base.replace(/(FIREARM|FIREARMS|WEAPON|WEAPONS)/g, "");
  };

  const normCaliber = (s) => {
    const base = norm(s);
    if (!base) return "";
    const trimmedLeadingZero = base.replace(/^0+([0-9])/, "$1");
    const withoutCalTokens = trimmedLeadingZero
      .replace(/^(CALIBER|CAL)/, "")
      .replace(/(CALIBER|CAL)$/, "");
    return withoutCalTokens;
  };

  const hasValue = (v) => String(v ?? "").trim() !== "";

  const comparatorFactory = (normalizer, { allowContain = false } = {}) => {
    return (a, b) => {
      const na = normalizer(a);
      const nb = normalizer(b);
      if (!na || !nb) return na === nb;
      if (na === nb) return true;
      if (!allowContain) return false;
      if (na.length < 3 || nb.length < 3) return false;
      return na.includes(nb) || nb.includes(na);
    };
  };

  const FIELD_COMPARATORS = {
    manufacturer: comparatorFactory(normManufacturer),
    model: comparatorFactory(normModel, { allowContain: true }),
    type: comparatorFactory(normType, { allowContain: true }),
    caliber: comparatorFactory(normCaliber, { allowContain: true }),
    importer: comparatorFactory(norm),
    country: comparatorFactory(norm),
  };

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

  const firstVal = (row, names) => pickField(row, names).value;

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

  // ---------- file parse ----------
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(), // avoid "UPC " vs "UPC"
      complete: (res) => setRows(res.data || []),
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
      const previewUploadUPCs = [];
      const atfManufacturerSet = new Set();

      for (const r of rows) {
        const raw = firstVal(r, ALIAS.upc);
        const d = normDigits(raw);
        if (d) {
          upcKeys.add(d);
          if (previewUploadUPCs.length < 10) {
            previewUploadUPCs.push({ raw, digits: d, strict: strip0(d) });
          }
        } else {
          const manufacturerRaw = firstVal(r, ALIAS.manufacturer);
          if (manufacturerRaw && String(manufacturerRaw).trim() !== "") {
            atfManufacturerSet.add(manufacturerRaw);
          }
        }
      }

      // ---- 1) Fetch only UPCs we need (fast path)
      const selectColumns = "id, upc, manufacturer, model, type, caliber, importer, country";
      let catalogUpc = [];
      if (upcKeys.size > 0) {
        const { data, error: upcErr } = await supabase
          .from("catalog")
          .select(selectColumns)
          .in("upc", Array.from(upcKeys))
          .limit(10000);
        if (upcErr) throw upcErr;
        catalogUpc = data || [];
      }

      // Build maps from UPC subset
      const upcMap = new Map(); // UPC digits -> array of catalog rows (handle duplicates)

      const previewCatalogUPCs = [];
      for (const cRow of catalogUpc) {
        const d = normDigits(cRow?.upc ?? "");
        if (!d) continue;

        if (!upcMap.has(d)) upcMap.set(d, []);
        upcMap.get(d).push(cRow);

        if (previewCatalogUPCs.length < 10) {
          previewCatalogUPCs.push({ raw: cRow.upc ?? "", digits: d, strict: strip0(d) });
        }
      }

      const atfCandidateMap = new Map();
      if (atfManufacturerSet.size > 0) {
        const { data: atfData, error: atfErr } = await supabase
          .from("catalog")
          .select(selectColumns)
          .in("manufacturer", Array.from(atfManufacturerSet))
          .limit(10000);
        if (atfErr) throw atfErr;
        for (const row of atfData || []) {
          const key = `${normManufacturer(row?.manufacturer)}::${normModel(row?.model)}`;
          if (!atfCandidateMap.has(key)) atfCandidateMap.set(key, []);
          atfCandidateMap.get(key).push(row);
        }
      }

      // ---------- scoring to pick best candidate when duplicates exist ----------
      const normalizeCell = (val) => (val === undefined || val === null ? "" : String(val).trim());

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

        const normalizedCore = {
          manufacturer: normManufacturer(m),
          model: normModel(mo),
          type: normType(t),
          caliber: normCaliber(c),
        };

        const toCanonical = {
          manufacturer: "Manufacturer",
          model: "Model",
          type: "Type",
          caliber: "Caliber",
        };

        const collectMeta = (meta, canonicalKey, pick, expectedValue, reason) => {
          const actualStr = pick.value === undefined || pick.value === null ? "" : String(pick.value).trim();
          const expectedStr = expectedValue === undefined || expectedValue === null ? "" : String(expectedValue).trim();
          meta[canonicalKey] = {
            state: "mismatch",
            expected: expectedStr,
            actual: actualStr,
            reason: reason || "Mismatch",
          };
        };

        let candidates = [];
        if (d) {
          candidates = upcMap.get(d) || [];
        } else {
          const comboKey = `${normalizedCore.manufacturer}::${normalizedCore.model}`;
          candidates = atfCandidateMap.get(comboKey) || [];
        }

        if (!candidates || candidates.length === 0) {
          const meta = {};
          collectMeta(meta, "Manufacturer", manufacturerPick, "", "No catalog record with this manufacturer/model");
          collectMeta(meta, "Model", modelPick, "", "No catalog record with this manufacturer/model");
          return {
            ...baseRow,
            Status: "NOT VERIFIED ⚠️ (Manufacturer, Model)",
            [META_KEY]: meta,
          };
        }

        const compareField = (actual, expected, comparator) => {
          const actualStr = normalizeCell(actual);
          const expectedStr = normalizeCell(expected);
          const hasActual = actualStr !== "";
          const hasExpected = expectedStr !== "";
          let match = true;
          let reason = "";

          if (!hasActual && hasExpected) {
            match = false;
            reason = "Missing value";
          } else if (hasActual && hasExpected) {
            const comparatorFn = comparator || ((a, b) => norm(a) === norm(b));
            match = comparatorFn(actualStr, expectedStr);
            if (!match) {
              reason = `Expected "${expectedStr}"`;
            }
          }

          return { match, reason, actualStr, expectedStr };
        };

        const matchesCore = (row) =>
          normalizedCore.manufacturer === normManufacturer(row?.manufacturer) &&
          normalizedCore.model === normModel(row?.model) &&
          normalizedCore.type === normType(row?.type) &&
          normalizedCore.caliber === normCaliber(row?.caliber);

        if (normalizedCore.manufacturer.includes("PALMETTO") && normalizedCore.model.includes("PA15")) {
          console.log(
            "Palmetto candidates",
            candidates.map((row) => ({
              manufacturer: row?.manufacturer,
              model: row?.model,
              type: row?.type,
              caliber: row?.caliber,
              upc: row?.upc,
            }))
          );
          console.log(
            "Palmetto exact core matches",
            candidates.filter(matchesCore).map((row) => ({
              manufacturer: row?.manufacturer,
              model: row?.model,
              type: row?.type,
              caliber: row?.caliber,
              upc: row?.upc,
            }))
          );
        }

        const coreFields = [
          { key: "manufacturer", pick: manufacturerPick, comparator: FIELD_COMPARATORS.manufacturer },
          { key: "model", pick: modelPick, comparator: FIELD_COMPARATORS.model },
          { key: "type", pick: typePick, comparator: FIELD_COMPARATORS.type },
          { key: "caliber", pick: caliberPick, comparator: FIELD_COMPARATORS.caliber },
        ];

        if (d) {
          const upcCandidates = candidates;
          if (!upcCandidates || upcCandidates.length === 0) {
            const meta = {};
            collectMeta(meta, "UPC", upcPick, "", "No catalog record with this UPC");
            return {
              ...baseRow,
              Status: "NOT VERIFIED ⚠️ (UPC)",
              [META_KEY]: meta,
            };
          }

          const exactMatch = upcCandidates.find(matchesCore);
          const best = exactMatch ?? upcCandidates[0];
          const meta = {};
          const mismatchedCanonicals = [];

          coreFields.forEach(({ key, pick, comparator }) => {
            const { match } = compareField(pick.value, best?.[key], comparator);
            if (!match) {
              const label = toCanonical[key];
              mismatchedCanonicals.push(label);
              collectMeta(meta, label, pick, best?.[key], "Catalog value differs");
            }
          });

          const status =
            mismatchedCanonicals.length === 0
              ? "VERIFIED ✅ (UPC & ATF match)"
              : `NOT VERIFIED ⚠️ (${mismatchedCanonicals.join(", ")})`;

          return {
            ...baseRow,
            Status: status,
            [META_KEY]: meta,
          };
        }

        // ATF-only validation (no UPC)
        const exactMatches = candidates.filter(matchesCore);

        if (exactMatches.length === 1) {
          return {
            ...baseRow,
            Status: "VERIFIED ✅ (ATF match)",
            [META_KEY]: {},
          };
        }

        if (exactMatches.length > 1) {
          return {
            ...baseRow,
            Status: "NOT VERIFIED ⚠️ (Ambiguous ATF match)",
            [META_KEY]: {},
          };
        }

        const annotateFields = (fieldsToFlag, referenceRow, reason) => {
          const meta = {};
          fieldsToFlag.forEach((fieldKey) => {
            const label = toCanonical[fieldKey];
            const pick =
              fieldKey === "manufacturer"
                ? manufacturerPick
                : fieldKey === "model"
                ? modelPick
                : fieldKey === "type"
                ? typePick
                : caliberPick;
            collectMeta(meta, label, pick, referenceRow?.[fieldKey], reason);
          });
          return meta;
        };

        const bestPartial = candidates
          .map((row) => {
            const matchingKeys = coreFields
              .filter(({ key, pick, comparator }) => compareField(pick.value, row?.[key], comparator).match)
              .map(({ key }) => key);
            return { row, matchingKeys };
          })
          .sort((a, b) => b.matchingKeys.length - a.matchingKeys.length)[0];

        const matchedCount = bestPartial?.matchingKeys.length ?? 0;
        const unmatchedFields = coreFields
          .map(({ key }) => key)
          .filter((key) => !(bestPartial?.matchingKeys || []).includes(key));

        const mismatchLabels = unmatchedFields.map((key) => toCanonical[key]);
        const meta = annotateFields(unmatchedFields, bestPartial?.row, matchedCount > 0 ? "Closest catalog match differs" : "No catalog match");

        const status =
          mismatchLabels.length > 0
            ? `NOT VERIFIED ⚠️ (${mismatchLabels.join(", ")})`
            : "NOT VERIFIED ⚠️ (No matching catalog record)";

        return {
          ...baseRow,
          Status: status,
          [META_KEY]: meta,
        };
      });

      setResults(checked);

      // ---------- debug info ----------
      const unknownWithUPC = checked.filter((r) => String(r.Status).includes("UNKNOWN") && normDigits(r.UPC) !== "");

      let duplicateHitCount = 0;
      for (const k of upcMap.keys()) {
        if ((upcMap.get(k) || []).length > 1) duplicateHitCount++;
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

  const statusKeyForRow = (status) => {
    const text = String(status || "");
    if (text.includes("NOT VERIFIED")) return "NOT VERIFIED";
    if (text.includes("VERIFIED ✅")) return "VERIFIED";
    return "UNKNOWN";
  };

  const toggleStatusFilter = (key) => {
    setActiveStatusFilters((prev) => {
      const isActive = prev.includes(key);
      if (isActive) {
        if (prev.length === 1) return prev;
        return prev.filter((item) => item !== key);
      }
      return [...prev, key];
    });
  };

  const resetStatusFilters = () => setActiveStatusFilters(["VERIFIED", "NOT VERIFIED", "UNKNOWN"]);

  const filteredResults = results.filter((row) => activeStatusFilters.includes(statusKeyForRow(row.Status)));

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
          <h3>Results ({filteredResults.length} of {results.length} rows)</h3>

          {/* Summary bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              margin: "8px 0 6px 0",
              fontSize: 14,
            }}
          >
            {[
              {
                key: "VERIFIED",
                label: `VERIFIED: ${stats.verified} (${stats.pv}%)`,
                baseStyle: { background: "#e8f5e9", border: "1px solid #c8e6c9" },
              },
              {
                key: "NOT VERIFIED",
                label: `NOT VERIFIED: ${stats.notVerified} (${stats.pnv}%)`,
                baseStyle: { background: "#fff8e1", border: "1px solid #ffe082" },
              },
              {
                key: "UNKNOWN",
                label: `UNKNOWN: ${stats.unknown} (${stats.pu}%)`,
                baseStyle: { background: "#eeeeee", border: "1px solid #cccccc" },
              },
            ].map(({ key, label, baseStyle }) => {
              const isActive = activeStatusFilters.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleStatusFilter(key)}
                  aria-pressed={isActive}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 14,
                    fontWeight: isActive ? 600 : 400,
                    opacity: isActive ? 1 : 0.45,
                    transition: "opacity 0.15s ease",
                    background: baseStyle.background,
                    border: baseStyle.border,
                  }}
                >
                  {label}
                </button>
              );
            })}
            <span style={{ padding: "6px 10px", border: "1px dashed #bbb", borderRadius: 6 }}>
              TOTAL: <strong>{stats.total}</strong>
            </span>
            <button
              type="button"
              onClick={resetStatusFilters}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #b0bec5",
                background: "#f5f5f5",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Show all
            </button>
          </div>
          <p style={{ fontSize: 12, margin: "0 0 12px 2px", color: "#555" }}>
            Tip: click a status chip to filter the table below.
          </p>

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
              {filteredResults.map((r, i) => {
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
              {filteredResults.length === 0 && (
                <tr>
                  <td colSpan={tableHeaders.length} style={{ padding: 12, textAlign: "center", fontStyle: "italic", color: "#666" }}>
                    No rows match the selected filters.
                  </td>
                </tr>
              )}
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
