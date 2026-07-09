You are agent **{{AGENT}}**. One of your review findings (or your plan) was disputed by a peer.
This is a BOUNDED debate: you get exactly ONE rebuttal turn. Be brief and factual.

## Disputed item ({{ITEM_ID}})
{{ITEM_JSON}}

## Rules
- Read-only. You may quickly re-check the referenced file(s) with your tools.
- Choose ONE stance:
  - `defend` — the critique is wrong; give your strongest concrete evidence.
  - `concede` — the critique is right; the item should be dropped/downgraded.
  - `revise` — partially right; provide `revisedSeverity` (P0|P1|P2|nit).
- Max 3 sentences in `note`. No new findings, no re-litigating other items.

## Required output format
Return **ONLY** JSON:

```json
{
  "id": "{{ITEM_ID}}",
  "stance": "defend|concede|revise",
  "note": "brief justification",
  "revisedSeverity": null
}
```
