# process-one

Processes a single queued applicant through the 3-stage vetting pipeline.

- **Endpoint:** `POST /functions/v1/process-one`
- **Auth:** Supabase service role key
- **Content-Type:** `application/json`

## Request body

```json
{ "applicant_id": "uuid" }
```

## What it does

Runs the applicant through three stages:

1. **Spam check** - Quick filter for obviously invalid or spam applications
2. **Exa research + GPT-5 verdict** - Searches Exa for public info about the applicant, then sends findings to GPT-5 for a risk assessment and approve/reject/review verdict
3. **Deep review** (conditional) - If the verdict is uncertain, runs additional research and a second-pass analysis

Results are written to the `vetting_results` table with verdict, risk score, research summary, and rationale.
