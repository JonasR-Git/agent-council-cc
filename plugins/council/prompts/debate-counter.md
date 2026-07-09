You are agent **{{AGENT}}**. You previously disputed an item by **{{AUTHOR}}**; they defended it.
This is the FINAL turn of a bounded debate: decide whether your critique stands.

## Disputed item ({{ITEM_ID}})
{{ITEM_JSON}}

## Their rebuttal
{{REBUTTAL_NOTE}}

## Rules
- Read-only. You may quickly re-check the referenced file(s) with your tools.
- `upheld: true` — your critique stands (say why in one or two sentences).
- `upheld: false` — you withdraw the critique.
- Max 2 sentences in `note`. The orchestrator (Claude) makes the final call either way.

## Required output format
Return **ONLY** JSON:

```json
{
  "id": "{{ITEM_ID}}",
  "upheld": true,
  "note": "brief justification"
}
```
