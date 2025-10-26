import { useState } from "react";
import Papa from "papaparse";
import { supabase } from "../lib/supabaseClient";

export default function UploadPage() {
  const [rows, setRows] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => setRows(results.data),
      error: (err) => setError(err.message),
    });
  };

  const verifyData = async () => {
    setLoading(true);
    const { data: catalog } = await supabase.from("catalog").select("*");
    if (!catalog) {
      setError("No catalog data found.");
      setLoading(false);
      return;
    }

    const checked = rows.map((r) => {
      const norm = (s) => (s || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
      const upc = norm(r.UPC || r.upc);
      const key = norm(
        (r.Manufacturer || "") +
          (r.Model || "") +
          (r.Type || "") +
          (r.Caliber || "")
      );

      let match = null;
      if (upc) {
        match = catalog.find((c) => norm(c.upc) === upc);
      } else {
        match = catalog.find(
          (c) =>
            norm(c.manufacturer + c.model + c.type + c.caliber) === key
        );
      }

      if (!match) return { ...r, Status: "UNKNOWN ❔" };

      const fields = ["manufacturer", "model", "type", "caliber", "importer", "country"];
      const mismatches = fields.filter((f) => {
        const uploadVal = norm(r[f] || "");
        const catalogVal = norm(match[f] || "");
        return uploadVal && catalogVal && uploadVal !== catalogVal;
      });

      if (mismatches.length > 0) return { ...r, Status: "NOT VERIFIED ⚠️" };
      return { ...r, Status: "VERIFIED ✅" };
    });

    setResults(checked);
    setLoading(false);
  };

  return (
    <main style={{ fontFamily: "sans-serif", padding: "40px" }}>
      <h1>FFL Verifier — Upload Tool</h1>
      <input type="file" accept=".csv" onChange={handleFile} />
      <button
        onClick={verifyData}
        disabled={rows.length === 0 || loading}
        style={{ marginLeft: "10px", padding: "6px 12px", cursor: "pointer" }}
      >
        {loading ? "Verifying..." : "Run Verification"}
      </button>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {results.length > 0 && (
        <div style={{ marginTop: "20px" }}>
          <h3>Results ({results.length} rows)</h3>
          <table border="1" cellPadding="6" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {Object.keys(results[0]).map((k) =
