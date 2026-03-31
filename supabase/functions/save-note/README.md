# save-note

Saves a reviewer note to a vetting result.

- **Endpoint:** `POST /functions/v1/save-note`
- **Auth:** Supabase anon key via Authorization header
- **Content-Type:** `application/json`

## Request body

```json
{
  "result_id": "uuid",
  "note": "string"
}
```

## What it does

Updates the `reviewer_notes` field on the specified `vetting_results` row. Used by the dashboard to let reviewers add manual comments or override rationale on any applicant's vetting result.
