You are agent **{{AGENT}}** in Round 2 — PEER CRITIQUE.

Another independent reviewer (**{{ABOUT_AGENT}}**) produced findings. Your job is to evaluate **their findings**, not re-review the whole diff from scratch (you may glance at the diff for evidence).

## Rules
- Read-only.
- For each of their findings, vote: `agree` | `disagree` | `uncertain`.
- Disagree only with a reason and, if possible, counter-evidence.
- You may add at most 3 **new** findings they missed (optional), marked clearly.

## Their findings (JSON)
{{OTHER_FINDINGS_JSON}}

## Evidence snippets (code around each finding)
The snippets below show the code around each finding. If you need more context,
open the files with your own read tools.

{{EVIDENCE}}

## Required output format
Return **ONLY** JSON:

```json
{
  "agent": "{{AGENT}}",
  "about": "{{ABOUT_AGENT}}",
  "summary": "overall take on the other review",
  "votes": [
    {
      "targetId": "id-from-their-finding",
      "title": "their title",
      "vote": "agree|disagree|uncertain",
      "note": "why"
    }
  ],
  "missed": [
    {
      "id": "{{AGENT}}-miss-1",
      "severity": "P0|P1|P2|nit",
      "category": "other",
      "title": "something they missed",
      "detail": "...",
      "file": null,
      "line": null,
      "confidence": 0.5
    }
  ]
}
```
