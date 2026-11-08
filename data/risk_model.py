"""Building fire risk model trained on CAL FIRE Damage Inspection (DINS) records.

    data/.venv/bin/python data/risk_model.py

Inputs  data/raw/dins_structures.csv (fetch_data.py), data/neighborhood.json
Outputs data/out/risk_model.json     coefficients, AUC, sample sizes, honest pitch stats
        data/out/building_risk.json  per building: baseRisk (0-100), top risk drivers, riskDrop per fix

Model: logistic regression, target = "Destroyed (>50%)" vs anything less, among inspected residential /
commercial structures (sheds and infrastructure dropped, "Inaccessible" dropped).

Design choices forced by how DINS is recorded (inspectors fill the form AFTER the fire):
  * Features: roof, eaves, vents, siding, windows + year-built band (2008+ = California's Chapter 7A WUI
    code; year comes from the pre-fire parcel record). Attached fence / deck / patio cover are DROPPED:
    on destroyed homes they burn away and get logged as "none" (raw data says homes with NO fence burned
    more often — that's the recording artifact, not physics).
  * Complete cases only (all six features known): "Unknown" is itself a strong destroyed signal.
  * Neighbourhood fixed effects (fire × ~1 km lat/lon cell), so every coefficient compares buildings on
    the same streets in the same fire — not "the Camp Fire destroyed everything".
  * Complete cases over-represent survivors, so the intercept is re-calibrated (prior correction): mean
    predicted P over the Eaton Fire's structures = the Eaton Fire's true destroyed rate.

risk = 100 · P(destroyed | an Eaton-like fire reaches the building). A fix's riskDrop = risk(before) −
risk(with that one change). Defensible space ("Clear brush to 30 ft") is not in DINS: its riskDrop comes
from the fire simulation instead (data/sim/calibrate.ts) and is labelled that way.

Caveat (say it out loud in the pitch): DINS only covers structures inside fire perimeters and this is an
observational association, not a controlled experiment.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupShuffleSplit, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT / "out"

KEEP_CATEGORIES = {"Single Residence", "Multiple Residence", "Mixed Commercial/Residential", "Nonresidential Commercial"}
FEATURES = ["roof", "eaves", "vents", "siding", "windows", "yearBand"]
ALL_FEATURES = FEATURES + ["deckGrade", "deckElevated", "patio", "fence"]
LABELS = {
    "roof": "roof", "eaves": "eaves", "vents": "vents", "siding": "siding", "windows": "windows",
    "deckGrade": "deck", "deckElevated": "balconies/raised deck", "patio": "patio cover", "fence": "attached fence",
    "yearBand": "year built",
}


def norm_roof(v: str) -> str:
    v = (v or "").strip()
    if v in ("Wood", "Combustible"):
        return "Wood/Combustible"
    if v in ("Tile", "Concrete"):
        return "Tile/Concrete"
    if v in ("Asphalt", "Metal", "Fire Resistant", "Other"):
        return v
    return "Unknown"


def norm_eaves(v: str) -> str:
    v = (v or "").strip()
    return v if v in ("Enclosed", "Unenclosed", "No Eaves") else "Unknown"


def norm_vents(v: str) -> str:
    v = (v or "").strip()
    return {
        'Mesh Screen <= 1/8"': "Fine mesh (<=1/8in)",
        'Mesh Screen > 1/8"': "Coarse mesh (>1/8in)",
        "Screened": "Screened (size unknown)",
        "Unscreened": "Unscreened",
        "No Vents": "No vents",
    }.get(v, "Unknown")


def norm_siding(v: str) -> str:
    v = (v or "").strip()
    if v in ("Wood", "Combustible", "Vinyl"):
        return "Wood/Combustible"
    if v in ("Ignition Resistant", "Fire Resistant"):
        return "Ignition resistant"
    if v in ("Stucco Brick Cement", "Stucco/Brick/Cement"):
        return "Stucco/Brick/Cement"
    if v in ("Metal", "Other"):
        return v
    return "Unknown"


def norm_windows(v: str) -> str:
    v = (v or "").strip()
    return v if v in ("Single Pane", "Multi Pane", "No Windows") else "Unknown"


def norm_deck(v: str) -> str:
    v = (v or "").strip()
    if v in ("Wood", "Composite"):
        return "Combustible"
    if v in ("Masonry/Concrete", "Metal"):
        return "Non-combustible"
    if v == "No Deck/Porch":
        return "None"
    return "Unknown"


def norm_attach(v: str, none_label: str) -> str:
    v = (v or "").strip()
    if v == "Combustible":
        return "Combustible"
    if v == "Non Combustible":
        return "Non-combustible"
    if v == none_label:
        return "None"
    return "Unknown"


def year_band(y) -> str:
    try:
        y = int(y)
    except (TypeError, ValueError):
        return "Unknown"
    if y < 1850 or y > 2025:
        return "Unknown"
    if y < 1960:
        return "before 1960"
    if y < 1990:
        return "1960-1989"
    if y < 2008:
        return "1990-2007"
    return "2008+ (WUI code)"


def featurize(raw: dict) -> dict:
    """Neighborhood features (DINS vocabulary) → model features."""
    return {
        "roof": norm_roof(raw["roof"]),
        "eaves": norm_eaves(raw["eaves"]),
        "vents": norm_vents(raw["vents"]),
        "siding": norm_siding(raw["siding"]),
        "windows": norm_windows(raw["windows"]),
        "deckGrade": norm_deck(raw["deckGrade"]),
        "deckElevated": norm_deck(raw["deckElevated"]),
        "patio": norm_attach(raw["patio"], "No Patio Cover/Carport"),
        "fence": norm_attach(raw["fence"], "No Fence"),
        "yearBand": year_band(raw["yearBuilt"]),
    }


def load_dins() -> pd.DataFrame:
    d = pd.read_csv(RAW / "dins_structures.csv", low_memory=False, dtype=str, keep_default_na=False).fillna("")
    d = d[d.STRUCTURECATEGORY.isin(KEEP_CATEGORIES) & ~d.DAMAGE.isin(["Inaccessible", ""])].copy()
    d["destroyed"] = (d.DAMAGE == "Destroyed (>50%)").astype(int)
    d["roof"] = d.ROOFCONSTRUCTION.map(norm_roof)
    d["eaves"] = d.EAVES.map(norm_eaves)
    d["vents"] = d.VENTSCREEN.map(norm_vents)
    d["siding"] = d.EXTERIORSIDING.map(norm_siding)
    d["windows"] = d.WINDOWPANE.map(norm_windows)
    d["deckGrade"] = d.DECKPORCHONGRADE.map(norm_deck)
    d["deckElevated"] = d.DECKPORCHELEVATED.map(norm_deck)
    d["patio"] = d.PATIOCOVERCARPORT.map(lambda v: norm_attach(v, "No Patio Cover/Carport"))
    d["fence"] = d.FENCEATTACHEDTOSTRUCTURE.map(lambda v: norm_attach(v, "No Fence"))
    d["yearBand"] = d.YEARBUILT.map(year_band)
    d["incident"] = d.INCIDENTNAME.fillna("unknown").str.strip()
    counts = d.incident.value_counts()
    small = counts[counts < 150].index
    d.loc[d.incident.isin(small), "incident"] = "other (small fires)"
    lat = pd.to_numeric(d.LATITUDE, errors="coerce").round(2)
    lon = pd.to_numeric(d.LONGITUDE, errors="coerce").round(2)
    d["zone"] = d.incident + "|" + lat.astype(str) + "|" + lon.astype(str)
    return d


def build_model(fe: str | None = "zone") -> Pipeline:
    cols = FEATURES + ([fe] if fe else [])
    pre = ColumnTransformer([("oh", OneHotEncoder(handle_unknown="ignore", sparse_output=True), cols)])
    return Pipeline([("pre", pre), ("lr", LogisticRegression(C=1.0, max_iter=5000))])


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def rate(df: pd.DataFrame, mask) -> tuple[float, int]:
    sub = df[mask]
    return (float(sub.destroyed.mean()) if len(sub) else float("nan"), int(len(sub)))


def pitch_stats(d: pd.DataFrame) -> list[dict]:
    """Raw (unadjusted) destroyed rates — the honest numbers we can say out loud."""
    out = []
    for scope, df in [("Eaton Fire", d[d.incident == "Eaton"]), ("all CA fires since 2013", d)]:
        contrasts = [
            ("vents", "Fine mesh (<=1/8in)", ["Unscreened", "Coarse mesh (>1/8in)"], "ember-resistant vents (≤1/8\" mesh)", "unscreened or coarse vents"),
            ("yearBand", "2008+ (WUI code)", ["before 1960"], "built 2008+ under the WUI fire code", "built before 1960"),
            ("roof", "Tile/Concrete", ["Wood/Combustible"], "tile/concrete roofs", "wood or combustible roofs"),
            ("fence", "None", ["Combustible"], "no attached fence", "a combustible fence attached"),
            ("eaves", "Enclosed", ["Unenclosed"], "enclosed eaves", "open eaves"),
            ("windows", "Multi Pane", ["Single Pane"], "multi-pane windows", "single-pane windows"),
        ]
        for feat, good, bad, good_txt, bad_txt in contrasts:
            g, ng = rate(df, df[feat] == good)
            b, nb = rate(df, df[feat].isin(bad))
            out.append({
                "scope": scope, "feature": feat, "good": good_txt, "bad": bad_txt,
                "destroyedPctGood": round(100 * g, 1), "nGood": ng,
                "destroyedPctBad": round(100 * b, 1), "nBad": nb,
                "sentence": f"In Cal Fire's records for the {scope}, buildings with {bad_txt} were destroyed {100 * b:.0f}% of the time vs {100 * g:.0f}% with {good_txt} (n={nb:,} vs {ng:,}).",
            })
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    full = load_dins()
    d = full[(full[FEATURES] != "Unknown").all(axis=1)].copy()
    X, y = d[FEATURES + ["zone"]], d.destroyed

    # Holdout 1: random 20% (with neighbourhood effects).
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=7, stratify=y)
    auc_random = roc_auc_score(yte, build_model().fit(Xtr, ytr).predict_proba(Xte)[:, 1])
    # Holdout 2: construction only, on whole fires the model never saw.
    gss = GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=7)
    tr_idx, te_idx = next(gss.split(X, y, groups=d.incident))
    m_fx = build_model(None).fit(X.iloc[tr_idx], y.iloc[tr_idx])
    auc_unseen = roc_auc_score(y.iloc[te_idx], m_fx.predict_proba(X.iloc[te_idx])[:, 1])

    model = build_model().fit(X, y)  # final model on every complete case
    enc: OneHotEncoder = model.named_steps["pre"].named_transformers_["oh"]
    coefs = model.named_steps["lr"].coef_[0]
    table: dict[str, dict[str, float]] = {}
    i = 0
    for feat, cats in zip(FEATURES + ["zone"], enc.categories_):
        if feat == "zone":
            break
        table[feat] = {str(c): float(coefs[i + k]) for k, c in enumerate(cats)}
        i += len(cats)

    def logit_features(f: dict) -> float:
        return sum(table[k].get(f[k], 0.0) for k in FEATURES)

    # Prior correction: pick c so mean P over Eaton structures equals Eaton's true destroyed rate.
    eaton_all = full[full.incident == "Eaton"]
    eaton_rate = float(eaton_all.destroyed.mean())
    eaton_cc = d[d.incident == "Eaton"]
    xb = np.array([logit_features(r) for r in eaton_cc[FEATURES].to_dict("records")])
    lo, hi = -10.0, 10.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if sigmoid(xb + mid).mean() < eaton_rate:
            lo = mid
        else:
            hi = mid
    c_eaton = (lo + hi) / 2

    def predict(f: dict) -> float:
        return float(sigmoid(logit_features(f) + c_eaton))

    nb = json.loads((ROOT / "neighborhood.json").read_text())
    buildings_out = {}
    for b in nb["buildings"]:
        base_raw = b["features"]
        f = featurize(base_raw)
        p0 = predict(f)
        drivers = []
        for feat in FEATURES:
            known = {k: v for k, v in table[feat].items() if k != "Unknown"}
            best_val = min(known, key=known.get)
            add = table[feat].get(f[feat], 0.0) - known[best_val]
            drivers.append({"feature": feat, "label": LABELS[feat], "value": f[feat], "safest": best_val, "logitAboveSafest": round(add, 3)})
        drivers.sort(key=lambda r: -r["logitAboveSafest"])
        fixes = {}
        for fx in nb["fixes"]:
            if fx.get("source") != "dins":
                fixes[fx["key"]] = {"applicable": True, "riskDrop": None, "source": fx.get("source", "none")}
                continue
            changed = {**base_raw, **fx["changes"]}
            if featurize(changed) == f:
                fixes[fx["key"]] = {"applicable": False, "riskDrop": 0.0, "source": "dins"}
                continue
            p1 = predict(featurize(changed))
            fixes[fx["key"]] = {"applicable": True, "riskDrop": round(100 * (p0 - p1), 1), "riskAfter": round(100 * p1, 1), "source": "dins"}
        buildings_out[str(b["id"])] = {
            "name": b["name"],
            "modelFeatures": f,
            "otherFeatures": {k: featurize(base_raw).get(k) for k in []} or {k: base_raw.get(k) for k in ["deckGrade", "deckElevated", "patio", "fence"]},
            "baseRisk": round(100 * p0, 1),
            "topDrivers": drivers[:3],
            "fixes": fixes,
        }

    result = {
        "trainedOn": "CAL FIRE DINS (POSTFIRE_MASTER_DATA_SHARE): residential + commercial structures with all six features recorded",
        "nStructuresAll": int(len(full)),
        "nStructuresTrained": int(len(d)),
        "nFires": int(d.incident.nunique()),
        "nNeighbourhoods": int(d.zone.nunique()),
        "features": FEATURES,
        "eatonStructures": int(len(eaton_all)),
        "eatonDestroyedRate": round(eaton_rate, 3),
        "eatonCalibratedIntercept": round(c_eaton, 4),
        "aucRandomHoldout": round(float(auc_random), 3),
        "aucUnseenFiresConstructionOnly": round(float(auc_unseen), 3),
        "coefficients": table,
        "pitchStats": pitch_stats(full),
    }
    (OUT / "risk_model.json").write_text(json.dumps(result, indent=2))
    (OUT / "building_risk.json").write_text(json.dumps(buildings_out, indent=2))

    print(f"{len(full):,} structures; trained on {len(d):,} complete cases from {d.incident.nunique()} fires / {d.zone.nunique():,} neighbourhoods")
    print(f"Eaton destroyed {eaton_rate:.1%} (n={len(eaton_all):,}); calibrated intercept {c_eaton:+.3f}")
    print(f"AUC random holdout {auc_random:.3f} | construction-only on unseen fires {auc_unseen:.3f}")
    for feat in FEATURES:
        items = sorted(table[feat].items(), key=lambda kv: kv[1])
        print(f"  {feat:9s} " + "  ".join(f"{k}={v:+.2f}" for k, v in items))
    print()
    for r in buildings_out.values():
        fx = "  ".join(f"{k}:{v['riskDrop']:+.1f}" for k, v in r["fixes"].items() if v["applicable"] and v["source"] == "dins")
        drv = ", ".join(f"{x['label']}={x['value']}" for x in r["topDrivers"] if x["logitAboveSafest"] > 0.05)
        print(f"  {r['name']:15s} risk {r['baseRisk']:5.1f}  {fx:28s} drivers: {drv}")
    print()
    for s_ in result["pitchStats"]:
        if s_["scope"] == "Eaton Fire":
            print("  " + s_["sentence"])


if __name__ == "__main__":
    main()
