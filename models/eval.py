"""Synthetic Intake evaluation. Uses the same labels as the earlier TS evaluator."""
import json
import os
import re
from pathlib import Path

from intake_app import REQUIRED_KEYS, GeminiIntakeModel, normalize_date, normalize_phone, run_intake

SEEDS = json.loads(Path(__file__).with_name("intake_seeds.json").read_text(encoding="utf-8"))
requested = {x.strip() for x in os.getenv("EVAL_CASE_IDS", "").split(",") if x.strip()}
if requested:
    SEEDS = [s for s in SEEDS if s["id"] in requested]


def baseline(text: str) -> list[dict[str, str]]:
    out=[]
    for match in re.finditer(r"\d[\d\s-]{8,12}\d",text):
        phone=normalize_phone(match.group())
        if phone: out.append({"key":"patient_phone","value":phone}); break
    m=re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b",text)
    if m and (d:=normalize_date(m.group())): out.append({"key":"due_date","value":d})
    patterns=[("source_ref",r"\bSDL-\d+\b"),("ordering_clinician",r"\bDr\.?\s+(?:[A-Z]\.\s*)*[A-Z][a-z]+"),("patient_name",r"(?:Patient:?|Pt:?|Mareez:)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)"),("action_name",r"\b(lipid profile|thyroid test|vitamin B12|vitamin D|ferritin|HbA1c|TSH|ECG|CBC)\b"),("patient_ref",r"\b(?:MRN|Patient\s*Ref)\s*[:#]?\s*([A-Z0-9-]+)\b"),("preferred_language",r"\b(?:preferred language|language)\s*[:=]?\s*(English|Hindi|Bengali|Hinglish)\b")]
    for key,pattern in patterns:
        m=re.search(pattern,text,re.I)
        if m: out.append({"key":key,"value":m.group(1) if key in ("patient_name","patient_ref","preferred_language") else m.group()})
    if re.search(r"\b(ordered|order|likha|likhi|likhe|karana|karwana)\b",text,re.I): out.append({"key":"action_type","value":"ordered_test"})
    elif re.search(r"\b(consultation|consult|appointment)\b",text,re.I):
        out.append({"key":"action_type","value":"consultation"})
        m=re.search(r"\b(consultation|appointment)\b",text,re.I)
        if m: out.append({"key":"action_name","value":m.group()})
    return out


async def main():
    model=GeminiIntakeModel(os.environ["GEMINI_API_KEY"],os.environ["FLASH_LITE_MODEL_ID"]) if os.getenv("GEMINI_API_KEY") and os.getenv("FLASH_LITE_MODEL_ID") else None
    for label in (["regex baseline","gemini"] if model else ["regex baseline"]):
        tp=fp=fn=leaks=missing_ok=spans=valid=0
        for seed in SEEDS:
            if label=="regex baseline": got=baseline(seed["sourceText"])
            else:
                proposal,_,reason=await run_intake(seed["sourceText"],None,None,model)
                got=[{"key":f["key"],"value":f["value"]} for f in proposal["fields"]] if proposal else []
                if not proposal: print(f"gemini fallback {seed['id']}: {(reason or 'unknown')[:240]}")
                elif proposal["warnings"]: print(f"gemini validation {seed['id']}: {' '.join(proposal['warnings'])[:240]}")
                if proposal:
                    spans+=len(proposal["fields"])
                    valid+=sum(seed["sourceText"][f["sourceSpan"]["start"]:f["sourceSpan"]["end"]]==f["sourceSpan"]["quote"] for f in proposal["fields"])
            g={f'{f["key"]}={f["value"]}' for f in got}; e={f'{f["key"]}={f["value"]}' for f in seed["expected"]}
            tp+=len(g&e); fp+=len(g-e); fn+=len(e-g)
            blob=" | ".join(f["value"].casefold() for f in got)
            leaks+=int(any(x.casefold() in blob for x in seed.get("mustNotExtract",[])))
            present={f["key"] for f in got}; missing=sorted(k for k in REQUIRED_KEYS if k not in present)
            missing_ok+=int(missing==sorted(seed["expectedMissing"]))
            if g!=e: print(f"{label} {seed['id']}: unexpected={sorted(g-e)} missing={sorted(e-g)}")
        pct=lambda n,d:f"{n/d*100:.1f}%" if d else "n/a"
        print(f"\n== {label} ({len(SEEDS)} cases) ==")
        print(f"precision {pct(tp,tp+fp)} | recall {pct(tp,tp+fn)} | extra {fp} | forbidden leaks {leaks} | missing correct {pct(missing_ok,len(SEEDS))}")
        if label=="gemini": print(f"span validity {pct(valid,spans)}")
    if not model: print("\n(skipping Gemini: set GEMINI_API_KEY and FLASH_LITE_MODEL_ID)")


if __name__=="__main__":
    import asyncio
    asyncio.run(main())
