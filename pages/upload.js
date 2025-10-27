// ---------- verify against Supabase catalog (robust headers + compare-if-both-present) ----------
const verifyData = async () => {
  setLoading(true);
  setError("");
  try {
    const { data: catalog, error: catErr } = await supabase.from("catalog").select("*");
    if (catErr) throw catErr;
    if (!catalog || catalog.length === 0) throw new Error("Catalog is empty or not readable (check RLS / project keys).");

    // Helper to pull first non-empty value from a list of possible column names
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
      caliber: ["Caliber", "caliber", "Cal", "cal"],
    };

    const norm = (s) => (s || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");

    const checked = rows.map((r) => {
      const upcVal = firstVal(r, ALIAS.upc);
      const upc = norm(upcVal);

      const m = firstVal(r, ALIAS.manufacturer);
      const mo = firstVal(r, ALIAS.model);
      const t = firstVal(r, ALIAS.type);
      const c = firstVal(r, ALIAS.caliber);
      const key = norm(`${m}${mo}${t}${c}`);

      // Try UPC match first, then fallback to ATF combined key
      let match = null;
      if (upc) {
        match = catalog.find((cRow) => norm(cRow.upc) === upc);
      }
      if (!match) {
        match = catalog.find(
          (cRow) => norm(`${cRow.manufacturer || ""}${cRow.model || ""}${cRow.type || ""}${cRow.caliber || ""}`) === key
        );
      }

      if (!match) return { ...r, Status: "UNKNOWN ❔" };

      // Compare fields ONLY when both values are present
      const cmpPairs = [
        ["manufacturer", firstVal(r, ALIAS.manufacturer)],
        ["model", firstVal(r, ALIAS.model)],
        ["type", firstVal(r, ALIAS.type)],
        ["caliber", firstVal(r, ALIAS.caliber)],
        ["importer", firstVal(r, ALIAS.importer)],
        ["country", firstVal(r, ALIAS.country)],
      ];

      const mismatches = cmpPairs.filter(([field, uploadVal]) => {
        const u = norm(uploadVal);
        const v = norm(match[field] || "");
        // only a mismatch if BOTH sides have values and they differ
        return u && v && u !== v;
      });

      if (mismatches.length > 0) return { ...r, Status: "NOT VERIFIED ⚠️" };
      return { ...r, Status: "VERIFIED ✅" };
    });

    setResults(checked);
  } catch (e) {
    setError(e.message || "Verification failed.");
  } finally {
    setLoading(false);
  }
};
