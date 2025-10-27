// ---------- verify against Supabase catalog (UPC-first via prebuilt map, fallback to ATF) ----------
const verifyData = async () => {
  setLoading(true);
  setError("");
  setDebugInfo(null);
  try {
    const { data: catalog, error: catErr } = await supabase.from("catalog").select("*");
    if (catErr) throw catErr;
    if (!catalog || catalog.length === 0) throw new Error("Catalog is empty or not readable (check RLS / project keys).");

    // Helpers
    const norm = (s) => (s || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const digits = (s) => (s || "").toString().replace(/\D/g, "");
    const strip0 = (s) => s.replace(/^0+/, "");

    // Build fast UPC lookup maps from catalog
    const upcMap = new Map();       // digits
    const upcStrictMap = new Map(); // digits with leading zeros stripped
    for (const cRow of catalog) {
      const raw = cRow?.upc ?? "";
      const d = digits(String(raw).trim());
      if (!d) continue;
      if (!upcMap.has(d)) upcMap.set(d, cRow);
      const s0 = strip0(d);
      if (!upcStrictMap.has(s0)) upcStrictMap.set(s0, cRow);
    }

    // ATF key normalizer for catalog rows
    const catKey = (cRow) => norm(`${cRow.manufacturer || ""}${cRow.model || ""}${cRow.type || ""}${cRow.caliber || ""}`);

    const checked = rows.map((r) => {
      // Gather upload values (with aliases handled)
      const firstVal = (row, names) => {
        for (const n of names) {
          const v = row[n] ?? row[n?.toLowerCase?.()] ?? row[n?.toUpperCase?.()];
          if (v !== undefined && v !== null && String(v).trim() !== "") return v;
        }
        return "";
      };

      const ALIAS = {
        upc: ["UPC", "upc", "Upc", "EAN", "ean", "Barcode", "barcode"],
        manufacturer: ["Manufacturer", "manufacturer", "MFR", "mfr", "Brand", "brand", "Maker", "maker"],
        importer: ["Importer", "importer"],
        country: ["Country of Manufacture", "country", "Country", "CountryOfManufacture"],
        model: ["Model", "model"],
        type: ["Type", "type", "Category", "category"],
        caliber: ["Caliber", "caliber", "Cal", "cal"],
      };

      const upcRaw = firstVal(r, ALIAS.upc);
      const upcD = digits(upcRaw);
      const upcS = strip0(upcD);

      const m = firstVal(r, ALIAS.manufacturer);
      const mo = firstVal(r, ALIAS.model);
      const t = firstVal(r, ALIAS.type);
      const c = firstVal(r, ALIAS.caliber);
      const key = norm(`${m}${mo}${t}${c}`);

      // 1) UPC-first using maps
      let match = null;
      if (upcD) match = upcMap.get(upcD) || upcStrictMap.get(upcS);

      // 2) Fallback to ATF combined key if no UPC match
      if (!match) {
        match = catalog.find((cRow) => catKey(cRow) === key);
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
        return u && v && u !== v;
      });

      if (mismatches.length > 0) return { ...r, Status: "NOT VERIFIED ⚠️" };
      return { ...r, Status: "VERIFIED ✅" };
    });

    setResults(checked);

    // Simple debug panel info (optional)
    const uploadUPCs = rows.slice(0, 10).map((r) => {
      const raw = (r.UPC ?? r.upc ?? r.Upc ?? "").toString();
      const d = digits(raw);
      const s0 = strip0(d);
      return { raw, digits: d, strict: s0 };
    });
    const catalogUPCs = catalog.slice(0, 10).map((c) => {
      const raw = c.upc ?? "";
      const d = digits(String(raw));
      const s0 = strip0(d);
      return { raw, digits: d, strict: s0 };
    });
    const unknownWithUPC = checked.filter(
      (r) => String(r.Status).includes("UNKNOWN") && digits((r.UPC ?? r.upc ?? r.Upc ?? "").toString()) !== ""
    );
    setDebugInfo({
      uploadPreview: uploadUPCs,
      catalogPreview: catalogUPCs,
      unknownUPCCount: unknownWithUPC.length,
    });
  } catch (e) {
    setError(e.message || "Verification failed.");
  } finally {
    setLoading(false);
  }
};
